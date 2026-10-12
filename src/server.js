import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { getProvider } from "./providers/index.js";
import { getMcpClient } from "./mcp/index.js";
import { AdaptiveAgent } from "./agent/index.js";

dotenv.config({ override: true });

// Adaptive AI Agent Server - StudyPilot Enabled
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize Provider and MCP Client
const provider = getProvider();
const mcpClient = getMcpClient();
const agent = new AdaptiveAgent({ provider, mcpClient });

// Health check endpoint (preserves existing response contract)
app.get("/api/health", async (req, res) => {
    const providerHealth = await provider.checkHealth().catch(err => ({
        available: false,
        error: err.message
    }));

    res.json({
        status: "running",
        provider: process.env.AI_PROVIDER || "ollama",
        model: process.env.OLLAMA_MODEL || "llama3.2",
        providerStatus: providerHealth,
        mcp: mcpClient.getStatus()
    });
});

// List discovered MCP tools
app.get("/api/tools", (req, res) => {
    try {
        const status = mcpClient.getStatus();
        res.json({
            connected: status.connected,
            toolCount: status.toolCount,
            tools: mcpClient.listTools()
        });
    } catch (error) {
        res.status(500).json({
            error: `Failed to retrieve tools: ${error.message}`
        });
    }
});

// Chat endpoint with adaptive reasoning and tool execution
app.post("/api/chat", async (req, res) => {
    try {
        const { message, messages } = req.body;

        if (!message || typeof message !== "string") {
            return res.status(400).json({
                error: "A valid message is required."
            });
        }

        const result = await agent.run({
            message,
            messages
        });

        res.json({
            reply: result.reply,
            success: result.success,
            partialSuccess: Boolean(result.partialSuccess),
            rounds: result.rounds,
            steps: result.steps
        });
    } catch (error) {
        console.error("[Server] Chat processing error:", error.message);

        res.status(500).json({
            error: `Unable to process request: ${error.message}`
        });
    }
});

// Start Express server and connect MCP client if configured
const server = app.listen(PORT, async () => {
    console.log(`Adaptive AI Agent backend running on port ${PORT}`);

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

// Graceful cleanup on shutdown
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
