import { Ollama } from "ollama";
import { BaseProvider } from "./baseProvider.js";

export class OllamaProvider extends BaseProvider {
    constructor(config = {}) {
        super(config);
        this.host = config.host || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
        this.model = config.model || process.env.OLLAMA_MODEL || "llama3.2";
        this.client = new Ollama({ host: this.host });
    }

    /**
     * Check if Ollama daemon is reachable and whether configured model is pulled
     */
    async checkHealth() {
        try {
            const list = await this.client.list();
            const models = list.models || [];
            const isModelFound = models.some(m => {
                const name = m.name || m.model || "";
                return name === this.model || name.startsWith(`${this.model}:`);
            });

            return {
                available: true,
                host: this.host,
                model: this.model,
                modelInstalled: isModelFound,
                installedModels: models.map(m => m.name || m.model)
            };
        } catch (error) {
            return {
                available: false,
                host: this.host,
                model: this.model,
                error: error.message
            };
        }
    }

    /**
     * Format MCP tool schemas into Ollama function calling format
     */
    formatTools(tools = []) {
        if (!Array.isArray(tools) || tools.length === 0) return [];

        return tools.map(tool => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description || "",
                parameters: tool.inputSchema || { type: "object", properties: {} }
            }
        }));
    }

    /**
     * Send conversation messages and tool schemas to Ollama
     */
    async chat({ messages, tools = [], options = {} }) {
        const formattedTools = this.formatTools(tools);

        // Normalize messages for Ollama API
        const payloadMessages = messages.map(msg => {
            const normalized = {
                role: msg.role,
                content: msg.content !== undefined && msg.content !== null ? String(msg.content) : ""
            };

            if (msg.tool_calls) {
                normalized.tool_calls = msg.tool_calls;
            }
            if (msg.tool_name) {
                normalized.tool_name = msg.tool_name;
            }

            return normalized;
        });

        const chatPayload = {
            model: options.model || this.model,
            messages: payloadMessages,
            ...(formattedTools.length > 0 ? { tools: formattedTools } : {})
        };

        const response = await this.client.chat(chatPayload);
        const assistantMessage = response.message || {};

        // Parse tool calls if returned
        const rawToolCalls = assistantMessage.tool_calls || [];
        const toolCalls = rawToolCalls.map((call, index) => {
            let parsedArgs = call.function?.arguments || {};
            if (typeof parsedArgs === "string") {
                try {
                    parsedArgs = JSON.parse(parsedArgs);
                } catch {
                    parsedArgs = {};
                }
            }

            return {
                id: `call_${index}_${Date.now()}`,
                name: call.function?.name,
                arguments: parsedArgs
            };
        });

        return {
            role: "assistant",
            content: assistantMessage.content || "",
            toolCalls,
            rawMessage: assistantMessage
        };
    }
}
