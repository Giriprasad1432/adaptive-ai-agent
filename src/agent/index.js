import { AdaptiveAgent } from "./adaptiveAgent.js";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import { getProvider } from "../providers/index.js";
import { getMcpClient } from "../mcp/index.js";

/**
 * Factory helper to construct an AdaptiveAgent instance
 */
export function createAgent(options = {}) {
    const provider = options.provider || getProvider();
    const mcpClient = options.mcpClient || getMcpClient();

    return new AdaptiveAgent({
        provider,
        mcpClient,
        maxRounds: options.maxRounds,
        systemPrompt: options.systemPrompt
    });
}

export { AdaptiveAgent, DEFAULT_SYSTEM_PROMPT };
