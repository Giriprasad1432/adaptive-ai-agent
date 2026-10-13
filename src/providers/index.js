import { BaseProvider } from "./baseProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { GroqProvider } from "./groqProvider.js";

/**
 * Provider registry mapping provider identifiers to their implementation classes.
 * Groq or other providers can be registered here easily.
 */
const providerRegistry = {
    ollama: OllamaProvider,
    groq: GroqProvider
};

/**
 * Register a new provider implementation (e.g. for future Groq integration)
 * @param {string} name - Provider identifier
 * @param {typeof BaseProvider} ProviderClass - Class extending BaseProvider
 */
export function registerProvider(name, ProviderClass) {
    if (!name || typeof name !== "string") {
        throw new Error("Provider name must be a non-empty string");
    }
    if (!ProviderClass || !(ProviderClass.prototype instanceof BaseProvider)) {
        throw new Error("Provider class must extend BaseProvider");
    }
    providerRegistry[name.toLowerCase()] = ProviderClass;
}

/**
 * Get an instance of the configured provider
 * @param {string} [name] - Provider name (defaults to AI_PROVIDER env var or 'ollama')
 * @param {Object} [config] - Optional configuration overrides
 * @returns {BaseProvider}
 */
export function getProvider(name = process.env.AI_PROVIDER || "ollama", config = {}) {
    const key = name.toLowerCase();
    const ProviderClass = providerRegistry[key];

    if (!ProviderClass) {
        const supported = Object.keys(providerRegistry).join(", ");
        throw new Error(`Unsupported AI provider: "${name}". Available providers: ${supported}`);
    }

    return new ProviderClass(config);
}

export { BaseProvider, OllamaProvider, GroqProvider };
