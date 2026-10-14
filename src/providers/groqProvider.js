
import Groq from "groq-sdk";
import { BaseProvider } from "./baseProvider.js";

/** Parse a Groq tool-call argument payload without allowing malformed data through. */
export function parseGroqToolCallArguments(args, toolName = "unknown") {
    if (typeof args !== "string") return args || {};
    try {
        return JSON.parse(args);
    } catch {
        const error = new Error(`Groq returned invalid arguments for tool "${toolName}".`);
        error.code = "MALFORMED_TOOL_CALL_JSON";
        throw error;
    }
}

export class GroqProvider extends BaseProvider {
    constructor(config = {}) {
        super(config);

        const apiKey = config.apiKey || process.env.GROQ_API_KEY;

        if (!apiKey) {
            throw new Error(
                "GROQ_API_KEY is missing. Add it to your root .env file."
            );
        }

        this.model =
            config.model ||
            process.env.GROQ_MODEL ||
            "openai/gpt-oss-120b";

        this.client = new Groq({ apiKey });
    }

    async checkHealth() {
        try {
            const model = await this.client.models.retrieve(this.model);

            return {
                available: true,
                provider: "groq",
                model: model.id || this.model
            };
        } catch (error) {
            return {
                available: false,
                provider: "groq",
                model: this.model,
                error: error.message
            };
        }
    }

    formatTools(tools = []) {
        if (!Array.isArray(tools) || tools.length === 0) {
            return [];
        }

        return tools.map(tool => ({
            type: "function",
            function: {
                name: tool.name,
                description: tool.description || "",
                parameters: tool.inputSchema || {
                    type: "object",
                    properties: {}
                }
            }
        }));
    }

    async chat({ messages, tools = [], options = {} }) {
        const payloadMessages = messages.map(msg => {
            const normalized = {
                role: msg.role,
                content:
                    msg.content !== undefined && msg.content !== null
                        ? String(msg.content)
                        : ""
            };

            if (msg.tool_calls) {
                normalized.tool_calls = msg.tool_calls;
            }

            // Groq expects tool responses to reference the original call ID.
            if (msg.role === "tool") {
                normalized.tool_call_id = msg.tool_call_id;
                delete normalized.tool_name;
            }

            return normalized;
        });

        const formattedTools = this.formatTools(tools);

        const response = await this.client.chat.completions.create({
            model: options.model || this.model,
            messages: payloadMessages,
            ...(formattedTools.length > 0
                ? { tools: formattedTools }
                : {}),
            parallel_tool_calls: false
        });

        const assistantMessage = response.choices?.[0]?.message;

        if (!assistantMessage) {
            throw new Error("Groq returned an empty chat response.");
        }

        const toolCalls = (assistantMessage.tool_calls || []).map(
            (call, index) => {
                const args = parseGroqToolCallArguments(call.function?.arguments || {}, call.function?.name);

                return {
                    id: call.id || `groq_call_${index}_${Date.now()}`,
                    name: call.function?.name,
                    arguments: args
                };
            }
        );

        return {
            role: "assistant",
            content: assistantMessage.content || "",
            toolCalls,
            rawMessage: assistantMessage
        };
    }
}
