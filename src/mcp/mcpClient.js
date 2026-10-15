import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeToolArguments } from "../agent/normalizer.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class McpClientManager {
    constructor(config = {}) {
        this.clientName = config.name || "adaptive-ai-agent-client";
        this.clientVersion = config.version || "1.0.0";
        this.url = config.url || process.env.MCP_SERVER_URL || null;

        // Connection settings from config or environment
        this.command = config.command || process.env.MCP_SERVER_COMMAND || null;

        let args = config.args;
        if (!args && process.env.MCP_SERVER_ARGS) {
            args = process.env.MCP_SERVER_ARGS.trim().split(/\s+/);
        }
        this.args = args || null;
        this.env = config.env || null;

        // Configurable tool execution timeout in milliseconds (default: 20 seconds)
        this.toolTimeoutMs = typeof config.toolTimeoutMs === "number"
            ? config.toolTimeoutMs
            : (Number(process.env.MCP_TOOL_TIMEOUT_MS) || 20000);

        this.authToken = config.authToken || process.env.MCP_AUTH_TOKEN || null;

        this.client = null;
        this.transport = null;
        this.tools = [];
        this.connected = false;
        this.lastError = null;
    }

    /**
     * Checks whether an MCP server target has been configured
     */
    isConfigured() {
        return Boolean(this.url || this.command);
    }

    /**
     * Resolve relative file paths in server args
     */
    resolveArgs() {
        if (!this.args) return [];

        return this.args.map(arg => {
            // Check if argument represents a script file
            if (arg.endsWith(".js") || arg.endsWith(".mjs") || arg.endsWith(".ts")) {
                const candidates = [
                    path.resolve(process.cwd(), arg),
                    path.resolve(__dirname, "../../", arg),
                    path.resolve(__dirname, "../../../mcp-server", path.basename(arg))
                ];

                for (const candidate of candidates) {
                    if (fs.existsSync(candidate)) {
                        return candidate;
                    }
                }
            }
            return arg;
        });
    }

    /**
     * Connect to the configured MCP server
     */
    async connect() {
        if (!this.isConfigured()) {
            console.log("[MCP] No MCP server command configured. Operating in tool-free mode.");
            this.connected = false;
            this.tools = [];
            return {
                connected: false,
                reason: "No MCP server configured in environment (MCP_SERVER_COMMAND not set)."
            };
        }

        if (this.connected && this.client) {
            return {
                connected: true,
                tools: this.tools
            };
        }

        const resolvedArgs = this.resolveArgs();
        let serverCwd = process.env.MCP_SERVER_CWD || process.cwd();
        for (const arg of resolvedArgs) {
            if (fs.existsSync(arg) && (arg.endsWith(".js") || arg.endsWith(".mjs") || arg.endsWith(".ts"))) {
                serverCwd = path.dirname(arg);
                break;
            }
        }

        try {
            this.client = new Client({
                name: this.clientName,
                version: this.clientVersion
            });

            const appNodeModules = path.resolve(__dirname, "../../node_modules");
            if (this.url) {
                const authToken = this.authToken || process.env.MCP_AUTH_TOKEN;
                const transportOpts = authToken
                    ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } }
                    : {};
                this.transport = new StreamableHTTPClientTransport(
                    new URL(this.url),
                    transportOpts
                );

                console.log(
                    `[MCP] Connecting to Streamable HTTP server: ${this.url}`
                );
            } else {
                console.log(`[MCP] Connecting to server: ${this.command} ${resolvedArgs.join(" ")} (cwd: ${serverCwd})`);
                this.transport = new StdioClientTransport({
                    command: this.command,
                    args: resolvedArgs,
                    cwd: serverCwd,
                    env: {
                        ...process.env,
                        NODE_PATH: appNodeModules,
                        ...(this.env || {})
                    }
                });
            }

            await this.client.connect(this.transport);
            this.connected = true;
            this.lastError = null;

            // Discover and cache available tools
            const listResult = await this.client.listTools();
            this.tools = listResult.tools || [];

            console.log(
                `[MCP] Connected successfully. Discovered ${this.tools.length} tool(s): ` +
                `[${this.tools.map(t => t.name).join(", ")}]`
            );

            return {
                connected: true,
                tools: this.tools
            };
        } catch (error) {
            this.connected = false;
            this.client = null;
            this.transport = null;
            this.tools = [];
            this.lastError = error.message;

            console.error(`[MCP] Connection failed: ${error.message}`);
            return {
                connected: false,
                error: error.message
            };
        }
    }

    /**
     * Disconnect from the MCP server
     */
    async disconnect() {
        if (this.client) {
            try {
                await this.client.close();
            } catch (err) {
                console.error("[MCP] Error during disconnect:", err.message);
            }
        }
        this.connected = false;
        this.client = null;
        this.transport = null;
        this.tools = [];
        console.log("[MCP] Disconnected from server.");
    }

    /**
     * Return list of available tools
     */
    listTools() {
        return this.tools;
    }

    /**
     * Return connection and server status
     */
    getStatus() {
        return {
            configured: this.isConfigured(),
            connected: this.connected,
            command: this.command,
            args: this.args,
            toolCount: this.tools.length,
            tools: this.tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema
            })),
            lastError: this.lastError
        };
    }

    /**
     * Coerce arguments against tool schema (arrays, objects, numbers)
     */
    sanitizeArguments(rawArgs = {}, schema = null, options = {}) {
        return normalizeToolArguments({ name: options.toolName, inputSchema: schema }, rawArgs, {
            // The adaptive agent validates model-originated IDs before this boundary;
            // direct MCP client calls already supply tool arguments intentionally.
            trustedPlanId: options.trustedPlanId !== false
        });
    }

    /**
     * Call an MCP tool through the official SDK
     * Never fakes or simulates tool execution.
     * @param {string} name - Tool name
     * @param {Object} [rawArgs={}] - Tool arguments
     * @param {Object} [options={}] - Execution options including timeout and signal
     * @returns {Promise<{ isError: boolean, content: string, rawResult?: Object }>}
     */
    async callTool(name, rawArgs = {}, options = {}) {
        if (!this.connected || !this.client) {
            return {
                isError: true,
                content: `Cannot execute tool "${name}": MCP client is not connected to any server.`
            };
        }

        const tool = this.tools.find(t => t.name === name);
        if (!tool) {
            return {
                isError: true,
                content: `Tool "${name}" is not registered on the MCP server. Available tools: [${this.tools.map(t => t.name).join(", ")}]`
            };
        }

        const args = this.sanitizeArguments(rawArgs, tool.inputSchema, {
            toolName: name,
            trustedPlanId: options.trustedPlanId
        });
        const timeoutMs = typeof options.timeout === "number" ? options.timeout : this.toolTimeoutMs;

        const abortController = new AbortController();
        let timeoutTimer = null;
        let didTimeout = false;

        if (options.signal) {
            if (options.signal.aborted) {
                abortController.abort(options.signal.reason);
            } else {
                options.signal.addEventListener("abort", () => {
                    abortController.abort(options.signal.reason);
                }, { once: true });
            }
        }

        try {
            console.log(`[MCP] Calling tool "${name}" with args:`, JSON.stringify(args), `(timeout: ${timeoutMs}ms)`);

            const timeoutPromise = new Promise((_, reject) => {
                if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
                    timeoutTimer = setTimeout(() => {
                        didTimeout = true;
                        abortController.abort(new Error(`Tool "${name}" execution timed out after ${timeoutMs}ms.`));
                        reject(new Error(`Tool "${name}" execution timed out after ${timeoutMs}ms.`));
                    }, timeoutMs);
                }
            });

            // Call tool using official SDK client with native RequestOptions (timeout, signal)
            const callPromise = this.client.callTool(
                { name, arguments: args },
                undefined,
                { timeout: timeoutMs, signal: abortController.signal }
            );

            const result = await Promise.race([callPromise, timeoutPromise]);
            if (timeoutTimer) clearTimeout(timeoutTimer);

            // Extract textual content from result
            let formattedContent = "";
            if (result.content && Array.isArray(result.content)) {
                formattedContent = result.content
                    .map(item => (typeof item.text === "string" ? item.text : JSON.stringify(item)))
                    .join("\n");
            } else if (typeof result.content === "string") {
                formattedContent = result.content;
            } else {
                formattedContent = JSON.stringify(result);
            }

            const isError = Boolean(result.isError);

            return {
                isError,
                content: formattedContent,
                rawResult: result
            };
        } catch (error) {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            const isTimeoutError = didTimeout ||
                error.message?.includes("timed out") ||
                error.code === "RequestTimeout" ||
                error.code === -32000;

            const errorMessage = isTimeoutError
                ? `Tool "${name}" timed out after ${timeoutMs}ms.`
                : `Tool "${name}" failed with error: ${error.message}`;

            console.error(`[MCP] Execution error calling tool "${name}":`, errorMessage);
            return {
                isError: true,
                content: errorMessage
            };
        }
    }
}
