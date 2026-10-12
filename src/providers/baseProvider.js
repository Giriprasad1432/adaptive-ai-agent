/**
 * Base AI Provider Interface
 * All AI providers (Ollama, Groq, OpenAI, etc.) must implement this class.
 */
export class BaseProvider {
    constructor(config = {}) {
        this.config = config;
    }

    /**
     * Check if the provider is reachable and operational
     * @returns {Promise<{ available: boolean, details?: any, error?: string }>}
     */
    async checkHealth() {
        throw new Error("checkHealth() must be implemented by provider");
    }

    /**
     * Convert MCP tool definitions to provider-specific function calling schema
     * @param {Array} tools - MCP tool objects from listTools()
     * @returns {Array} Provider-formatted tool definitions
     */
    formatTools(tools) {
        throw new Error("formatTools() must be implemented by provider");
    }

    /**
     * Generate chat completion given messages and tools
     * @param {Object} params
     * @param {Array} params.messages - Conversation history
     * @param {Array} [params.tools] - Formatted tools
     * @param {Object} [params.options] - Provider-specific options
     * @returns {Promise<{ role: string, content: string | null, toolCalls: Array, rawMessage?: any }>}
     */
    async chat({ messages, tools, options }) {
        throw new Error("chat() must be implemented by provider");
    }
}
