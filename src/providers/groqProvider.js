import Groq from "groq-sdk";
import { BaseProvider } from "./baseProvider.js";

/**
 * Redact API keys and sensitive tokens from error messages or strings.
 */
export function sanitizeErrorMessage(message, apiKey = "") {
    if (typeof message !== "string") {
        message = String(message || "");
    }
    if (apiKey && apiKey.length > 5) {
        message = message.split(apiKey).join("[REDACTED_API_KEY]");
    }
    // Also redact standard Groq API key format (gsk_...)
    message = message.replace(/gsk_[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]");
    return message;
}

/**
 * Parse a Groq tool-call argument payload without allowing malformed data through.
 * Throws with code "MALFORMED_TOOL_CALL_JSON" if JSON is invalid.
 */
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

        this.apiKey = apiKey;
        this.model =
            config.model ||
            process.env.GROQ_MODEL ||
            "llama-3.3-70b-versatile";

        this.timeoutMs = Number(
            config.timeoutMs || process.env.GROQ_TIMEOUT_MS || 20000
        );
        this.maxRetries = Number(
            config.maxRetries !== undefined
                ? config.maxRetries
                : (process.env.GROQ_MAX_RETRIES || 3)
        );
        this.retryBaseDelayMs = Number(
            config.retryBaseDelayMs || 250
        );

        this.client = config.client || new Groq({
            apiKey: this.apiKey,
            timeout: this.timeoutMs
        });
    }

    sanitizeError(error) {
        if (!error) return new Error("Unknown Groq error");
        const cleanMessage = sanitizeErrorMessage(error.message, this.apiKey);
        const sanitized = new Error(cleanMessage);
        if (error.status) sanitized.status = error.status;
        if (error.code) sanitized.code = error.code;
        if (error.error) sanitized.error = error.error;
        return sanitized;
    }

    isRetriableError(error) {
        if (!error) return false;
        const status = error.status || error.statusCode;
        if (status === 429 || status === 503 || status === 500) {
            return true;
        }
        const msg = String(error.message || "").toLowerCase();
        if (
            msg.includes("rate limit") ||
            msg.includes("too many requests") ||
            msg.includes("429") ||
            msg.includes("service unavailable") ||
            msg.includes("503") ||
            msg.includes("etimedout") ||
            msg.includes("timeout") ||
            msg.includes("overloaded")
        ) {
            return true;
        }
        return false;
    }

    getRetryDelay(error, attempt) {
        let retryAfterMs = 0;
        try {
            const retryHeader = error?.headers?.get?.("retry-after") || error?.headers?.["retry-after"];
            if (retryHeader) {
                const parsed = Number(retryHeader);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    retryAfterMs = parsed * 1000;
                }
            }
        } catch {
            // Ignore header parsing errors
        }

        if (retryAfterMs > 0) {
            return retryAfterMs;
        }

        const backoff = this.retryBaseDelayMs * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 50);
        return Math.min(backoff + jitter, 10000);
    }

    async executeWithRetry(operation, context = "Groq request") {
        let lastError = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await Promise.race([
                    operation(),
                    new Promise((_, reject) => {
                        const timer = setTimeout(() => {
                            const timeoutErr = new Error(`${context} timed out after ${this.timeoutMs}ms.`);
                            timeoutErr.code = "ETIMEDOUT";
                            reject(timeoutErr);
                        }, this.timeoutMs);
                        if (typeof timer?.unref === "function") timer.unref();
                    })
                ]);
            } catch (err) {
                lastError = err;
                if (err.code === "MALFORMED_TOOL_CALL_JSON") {
                    throw this.sanitizeError(err);
                }

                if (attempt < this.maxRetries && this.isRetriableError(err)) {
                    const delay = this.getRetryDelay(err, attempt);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                throw this.sanitizeError(err);
            }
        }
        throw this.sanitizeError(lastError);
    }

    async checkHealth() {
        try {
            const model = await this.executeWithRetry(
                () => this.client.models.retrieve(this.model),
                "Groq health check"
            );

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

        const response = await this.executeWithRetry(
            () => this.client.chat.completions.create({
                model: options.model || this.model,
                messages: payloadMessages,
                ...(formattedTools.length > 0
                    ? { tools: formattedTools }
                    : {}),
                parallel_tool_calls: options.parallel_tool_calls !== undefined
                    ? options.parallel_tool_calls
                    : false
            }),
            "Groq chat completion"
        );

        const assistantMessage = response?.choices?.[0]?.message;

        if (!assistantMessage) {
            throw new Error("Groq returned an empty chat response.");
        }

        const toolCalls = (assistantMessage.tool_calls || []).map(
            (call, index) => {
                const args = parseGroqToolCallArguments(
                    call.function?.arguments || {},
                    call.function?.name
                );

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
