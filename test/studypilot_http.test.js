import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpClientManager } from "../src/mcp/mcpClient.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "../studypilot-server/server.js");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studypilot-http-test-"));

async function getAvailablePort() {
    const server = createServer();
    await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

const port = await getAvailablePort();
const endpoint = `http://127.0.0.1:${port}/mcp`;
const child = spawn(process.execPath, [serverScript], {
    cwd: path.resolve(testDir, ".."),
    env: { ...process.env, MCP_TRANSPORT: "http", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: String(port), STUDYPILOT_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
});

let serverOutput = "";
child.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
child.stderr.on("data", chunk => { serverOutput += chunk.toString(); });

const client = new Client({ name: "studypilot-http-test-client", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));
const manager = new McpClientManager({ url: endpoint });

try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`HTTP MCP server exited early. Output: ${serverOutput}`);
        try {
            const response = await fetch(endpoint);
            if (response.status === 405) { ready = true; break; }
        } catch { }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, `HTTP MCP server did not become ready. Output: ${serverOutput}`);

    // Verify McpClientManager selects Streamable HTTP and discovers tools.
    await manager.connect();

    assert.equal(
        manager.connected,
        true,
        `McpClientManager should connect over HTTP. Error: ${manager.lastError || "none"}. Server output: ${serverOutput}`
    );

    const managerTools = await manager.listTools();
    assert.ok(
        managerTools.some(tool => tool.name === "get_study_plan"),
        "McpClientManager should discover tools over HTTP"
    );

    console.log("✓ McpClientManager Streamable HTTP connection verified");
    try {
        await client.connect(transport);
    } catch (error) {
        throw new Error(`${error.message}\nHTTP server output: ${serverOutput}`);
    }
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === "create_study_plan"), "tools/list must expose create_study_plan");
    assert.ok(tools.tools.some(tool => tool.name === "get_study_plan"), "tools/list must expose get_study_plan");

    const createResult = await client.callTool({
        name: "create_study_plan",
        arguments: { planId: "http-integration-plan", subjects: ["Mathematics"], examDate: "2035-12-15", dailyAvailableHours: 2 }
    });
    assert.equal(createResult.isError, false, `tools/call failed: ${JSON.stringify(createResult)}`);
    const createdPlan = JSON.parse(createResult.content[0].text);
    assert.match(createdPlan.message, /http-integration-plan/);
    assert.equal(createdPlan.examDate, "2035-12-15");

    const retrieveResult = await client.callTool({ name: "get_study_plan", arguments: { planId: "http-integration-plan" } });
    assert.equal(retrieveResult.isError, false, `get_study_plan failed: ${JSON.stringify(retrieveResult)}`);
    assert.equal(JSON.parse(retrieveResult.content[0].text).examDate, "2035-12-15");

    const malformedResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream"
        },
        body: "{malformed"
    });
    assert.equal(malformedResponse.status, 400, "Malformed JSON must return HTTP 400");
    const malformedBody = await malformedResponse.json();
    assert.equal(malformedBody.error.code, -32700);

    const unsupportedResponse = await fetch(endpoint, { method: "PUT" });
    assert.equal(unsupportedResponse.status, 405, "Unsupported HTTP methods must return HTTP 405");
    console.log("✓ Streamable HTTP MCP initialization, tools/list, tools/call, malformed JSON, and unsupported method verified");

    // Verify Bearer token authorization for remote / Alexa+ security
    const authPort = await getAvailablePort();
    const authEndpoint = `http://127.0.0.1:${authPort}/mcp`;
    const authChild = spawn(process.execPath, [serverScript], {
        cwd: path.resolve(testDir, ".."),
        env: { ...process.env, MCP_TRANSPORT: "http", MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: String(authPort), STUDYPILOT_DATA_DIR: dataDir, MCP_AUTH_TOKEN: "alexa-secret-test-token" },
        stdio: ["ignore", "pipe", "pipe"]
    });

    try {
        let authReady = false;
        for (let a = 0; a < 60; a++) {
            try {
                const res = await fetch(authEndpoint);
                if (res.status === 405) { authReady = true; break; }
            } catch { }
            await new Promise(r => setTimeout(r, 50));
        }
        assert.equal(authReady, true, "Auth-enabled HTTP MCP server failed to become ready");

        // 1. Missing or invalid token returns 401
        const unauthRes = await fetch(authEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        });
        assert.equal(unauthRes.status, 401, "Missing token must return 401");

        // 2. Valid Bearer token succeeds with 200
        const authRes = await fetch(authEndpoint, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "authorization": "Bearer alexa-secret-test-token",
                "accept": "application/json, text/event-stream"
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
        });
        assert.equal(authRes.status, 200, "Valid Bearer token must succeed with HTTP 200");
        console.log("✓ Streamable HTTP Bearer token authorization verified");
    } finally {
        if (authChild.exitCode === null && authChild.signalCode === null) {
            authChild.kill("SIGTERM");
        }
    }
} finally {

    await manager.disconnect().catch(() => {});
    await client.close().catch(() => { });

    if (child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => {
            child.once("exit", resolve);
            child.kill("SIGTERM");

            if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
            }
        });
    }

    fs.rmSync(dataDir, { recursive: true, force: true });
}
