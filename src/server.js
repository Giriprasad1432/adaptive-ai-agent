import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getProvider } from "./providers/index.js";
import { getMcpClient } from "./mcp/index.js";
import { AdaptiveAgent } from "./agent/index.js";

dotenv.config({ override: true });

/** Build the HTTP API with injectable dependencies for deterministic contract tests. */
export function createApp({ provider, mcpClient, agent } = {}) {
    const resolvedProvider = provider || getProvider();
    const resolvedMcpClient = mcpClient || getMcpClient();
    const resolvedAgent = agent || new AdaptiveAgent({ provider: resolvedProvider, mcpClient: resolvedMcpClient });
    const app = express();
    const activePlansByConversation = new Map();
    app.use(cors());
    app.use(express.json({ limit: "1mb" }));

    app.get("/api/health", async (req, res) => {
        const providerHealth = await resolvedProvider.checkHealth().catch(err => ({
            available: false,
            error: err.message
        }));

        res.json({
            status: "running",
            provider: providerHealth.provider || process.env.AI_PROVIDER || "groq",
            model: providerHealth.model || resolvedProvider.model || process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
            providerStatus: providerHealth,
            mcp: resolvedMcpClient.getStatus()
        });
    });

    app.get("/api/tools", (req, res) => {
        try {
            const status = resolvedMcpClient.getStatus();
            res.json({
                connected: status.connected,
                toolCount: status.toolCount,
                tools: resolvedMcpClient.listTools()
            });
        } catch (error) {
            res.status(500).json({ error: `Failed to retrieve tools: ${error.message}` });
        }
    });

    const invokeMcpTool = async (res, toolName, args = {}) => {
        if (!resolvedMcpClient || typeof resolvedMcpClient.callTool !== "function") {
            return res.status(503).json({ error: "MCP tool client is not configured for direct execution." });
        }
        try {
            const result = await resolvedMcpClient.callTool(toolName, args, { trustedPlanId: true });
            if (result.isError) {
                return res.status(400).json({ error: result.content || "MCP tool reported an error." });
            }
            try {
                const parsed = JSON.parse(result.content);
                return res.json(parsed);
            } catch {
                return res.json({ result: result.content });
            }
        } catch (err) {
            return res.status(500).json({ error: `MCP tool execution failed: ${err.message}` });
        }
    };

    app.get("/api/plans", async (req, res) => {
        await invokeMcpTool(res, "list_study_plans", {});
    });

    app.get("/api/plans/:id", async (req, res) => {
        await invokeMcpTool(res, "get_study_plan", { planId: req.params.id });
    });

    app.post("/api/plans", async (req, res) => {
        await invokeMcpTool(res, "create_study_plan", req.body);
    });

    app.post("/api/plans/:id/sessions", async (req, res) => {
        await invokeMcpTool(res, "record_study_session", { ...req.body, planId: req.params.id });
    });

    app.post("/api/plans/:id/adapt", async (req, res) => {
        await invokeMcpTool(res, "adapt_study_plan", { ...req.body, planId: req.params.id });
    });

    app.get("/api/progress", async (req, res) => {
        const planId = typeof req.query.planId === "string" ? req.query.planId : undefined;
        await invokeMcpTool(res, "get_study_progress", planId ? { planId } : {});
    });

    app.get("/api/weak-topics", async (req, res) => {
        const planId = typeof req.query.planId === "string" ? req.query.planId : undefined;
        const subject = typeof req.query.subject === "string" ? req.query.subject : undefined;
        const args = {};
        if (planId) args.planId = planId;
        if (subject) args.subject = subject;
        await invokeMcpTool(res, "get_weak_topics", args);
    });

    app.get("/api/preferences", async (req, res) => {
        const userId = typeof req.query.userId === "string" ? req.query.userId : "default";
        await invokeMcpTool(res, "get_user_preferences", { userId });
    });

    app.post("/api/preferences", async (req, res) => {
        await invokeMcpTool(res, "update_user_preferences", req.body);
    });

    app.post("/api/reset", async (req, res) => {
        const userId = typeof req.body?.userId === "string" ? req.body.userId : "default";
        await invokeMcpTool(res, "reset_learning_data", { confirm: true, userId });
    });

    app.post("/api/chat", async (req, res) => {
        try {
            const { message, messages, conversationId } = req.body;
            if (!message || typeof message !== "string") {
                return res.status(400).json({ error: "A valid message is required." });
            }

            const sessionId = typeof conversationId === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(conversationId)
                ? conversationId
                : randomUUID();
            const agentOptions = { message, messages };
            const previousActivePlanId = activePlansByConversation.get(sessionId);
            if (previousActivePlanId) agentOptions.activePlanId = previousActivePlanId;
            const result = await resolvedAgent.run(agentOptions);
            if (result.activePlanId) activePlansByConversation.set(sessionId, result.activePlanId);
            const responsePayload = {
                reply: result.reply,
                success: result.success,
                partialSuccess: Boolean(result.partialSuccess),
                rounds: result.rounds,
                steps: result.steps,
                conversationId: sessionId
            };
            if (Array.isArray(result.quickReplies) && result.quickReplies.length > 0) {
                responsePayload.quickReplies = result.quickReplies;
            }
            if (result.planPreview) {
                responsePayload.planPreview = result.planPreview;
            }
            res.json(responsePayload);
        } catch (error) {
            console.error("[Server] Chat processing error:", error.message);
            res.status(500).json({ error: `Unable to process request: ${error.message}` });
        }
    });

    return app;
}

export function startServer({ port = process.env.PORT || 3000 } = {}) {
    const provider = getProvider();
    const mcpClient = getMcpClient();
    const app = createApp({ provider, mcpClient });
    const server = app.listen(port, async () => {
        console.log(`Adaptive AI Agent backend running on port ${port}`);
        if (mcpClient.isConfigured()) {
            try {
                await mcpClient.connect();
            } catch (err) {
                console.error(`[Server] MCP server startup connection notice: ${err.message}`);
            }
        } else {
            console.log("[Server] No MCP server command configured. Set MCP_SERVER_COMMAND to enable tools.");
        }
    });

    const shutdown = async () => {
        console.log("\n[Server] Shutting down gracefully...");
        await mcpClient.disconnect();
        server.close(() => {
            console.log("[Server] Closed HTTP server.");
            process.exit(0);
        });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return { app, server, provider, mcpClient };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    startServer();
}
