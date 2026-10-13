import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

const expectedTools = [{ name: "get_study_plan", inputSchema: { type: "object" } }];
const captured = [];
const provider = { async checkHealth() { return { available: true, model: "test-model" }; } };
const mcpClient = {
    getStatus() { return { connected: true, toolCount: expectedTools.length, tools: expectedTools }; },
    listTools() { return expectedTools; }
};
const agent = {
    async run(input) {
        captured.push(input);
        if (input.message === "simulate failure") return { reply: "Action Failed: plan unavailable.", success: false, partialSuccess: false, rounds: 1, steps: [{ type: "tool_result", isError: true }] };
        if (input.message === "simulate exception") throw new Error("agent unavailable");
        if (input.message === "create active plan") return { reply: "Created.", success: true, activePlanId: "dbms-deadbeef", rounds: 1, steps: [] };
        return { reply: "Your plan is at 0% progress.", success: true, rounds: 2, steps: [{ type: "tool_result", content: "verified fixture" }] };
    }
};

const app = createApp({ provider, mcpClient, agent });
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
});
const base = `http://127.0.0.1:${server.address().port}`;

try {
    const health = await fetch(`${base}/api/health`, { headers: { Origin: "http://localhost:5173" } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await health.json(), {
        status: "running",
        provider: process.env.AI_PROVIDER || "ollama",
        model: "test-model",
        providerStatus: { available: true, model: "test-model" },
        mcp: { connected: true, toolCount: 1, tools: expectedTools }
    });

    const tools = await fetch(`${base}/api/tools`);
    assert.equal(tools.status, 200);
    assert.deepEqual(await tools.json(), { connected: true, toolCount: 1, tools: expectedTools });

    const invalid = await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "" })
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "A valid message is required." });

    const chatInput = { message: "Retrieve plan 2", messages: [{ role: "user", content: "prior context" }], conversationId: "api-session-0001" };
    const chat = await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chatInput)
    });
    assert.equal(chat.status, 200);
    assert.deepEqual(await chat.json(), {
        reply: "Your plan is at 0% progress.", success: true, partialSuccess: false, rounds: 2,
        steps: [{ type: "tool_result", content: "verified fixture" }], conversationId: "api-session-0001"
    });
    assert.deepEqual(captured[0], { message: chatInput.message, messages: chatInput.messages }, "API must pass user message and conversational context unchanged");

    const createActive = await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "create active plan", conversationId: "conversation-test-01" })
    });
    const createActiveData = await createActive.json();
    assert.equal(createActiveData.conversationId, "conversation-test-01");
    const followUp = await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "show my progress", conversationId: "conversation-test-01" })
    });
    assert.equal((await followUp.json()).success, true);
    assert.equal(captured.at(-1).activePlanId, "dbms-deadbeef", "The API must retain the verified active plan per conversation");

    const failedOperation = await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "simulate failure" })
    });
    assert.equal(failedOperation.status, 200);
    assert.equal((await failedOperation.json()).success, false, "A failed agent action must not be returned as success");

    const exception = await fetch(`${base}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "simulate exception" })
    });
    assert.equal(exception.status, 500);
    assert.deepEqual(await exception.json(), { error: "Unable to process request: agent unavailable" });

    const preflight = await fetch(`${base}/api/chat`, {
        method: "OPTIONS", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    console.log("✓ API contracts passed: health, tools, chat success/failure, input errors, and CORS.");
} finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
