import { McpClientManager } from "./mcpClient.js";

let defaultMcpClient = null;

/**
 * Get or create the shared McpClientManager instance
 * @param {Object} [config]
 * @returns {McpClientManager}
 */
export function getMcpClient(config) {
    if (!defaultMcpClient || config) {
        defaultMcpClient = new McpClientManager(config);
    }
    return defaultMcpClient;
}

export { McpClientManager };
