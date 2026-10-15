import { BaseProvider } from "./baseProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { GroqProvider } from "./groqProvider.js";
import { DemoProvider } from "./demoProvider.js";

/** Resilient Groq provider that falls back to built-in demo logic if key is unconfigured */
class ResilientGroqProvider extends BaseProvider {
    constructor(config = {}) {
        super(config);
        const apiKey = config.apiKey || process.env.GROQ_API_KEY;
        this.hasValidKey = Boolean(apiKey && !apiKey.includes("your_groq_api_key") && apiKey.trim().length > 10);
        if (this.hasValidKey) {
            try {
                this.underlying = new GroqProvider(config);
            } catch {
                this.hasValidKey = false;
            }
        }
        this.fallback = new DemoProvider(config);
    }

    async checkHealth() {
        if (this.hasValidKey && this.underlying) {
            const health = await this.underlying.checkHealth();
            if (health.available) return health;
        }
        return {
            available: true,
            provider: "groq (fallback: builtin)",
            model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
            message: "Groq key pending; using built-in study assistant."
        };
    }

    formatTools(tools) {
        return this.underlying ? this.underlying.formatTools(tools) : tools;
    }

    async chat(params) {
        if (this.hasValidKey && this.underlying) {
            try {
                return await this.underlying.chat(params);
            } catch (err) {
                console.warn("[Groq] Call failed, using built-in assistant fallback:", err.message);
            }
        }
        return await this.fallback.chat(params);
    }
}

/** Resilient Ollama provider that tries Ollama first, and seamlessly executes Groq if Ollama fails */
class ResilientOllamaProvider extends OllamaProvider {
    constructor(config = {}) {
        super(config);
        this.groqFallback = new ResilientGroqProvider(config);
        this.demoFallback = new DemoProvider(config);
    }

    async checkHealth() {
        const health = await super.checkHealth().catch(() => ({ available: false }));
        if (health.available) {
            return health;
        }

        const groqHealth = await this.groqFallback.checkHealth();
        if (groqHealth.available && !groqHealth.provider.includes("builtin")) {
            return {
                available: true,
                provider: "ollama (fallback: groq)",
                model: `${this.model} -> ${groqHealth.model}`,
                message: "Ollama not running; using Groq API as active fallback.",
                groqStatus: groqHealth
            };
        }

        return {
            available: true,
            provider: "ollama (fallback: builtin)",
            model: this.model,
            message: "Ollama not running; using built-in study assistant."
        };
    }

    async chat(params) {
        try {
            return await super.chat(params);
        } catch (err) {
            console.warn(`[Ollama] Failed (${err.message}). Seamlessly executing Groq API fallback...`);
            try {
                return await this.groqFallback.chat(params);
            } catch (groqErr) {
                console.warn(`[Groq Fallback] Failed (${groqErr.message}). Using built-in study assistant.`);
                return await this.demoFallback.chat(params);
            }
        }
    }
}

const providerRegistry = {
    ollama: ResilientOllamaProvider,
    groq: ResilientGroqProvider,
    hybrid: ResilientOllamaProvider,
    auto: ResilientOllamaProvider,
    demo: DemoProvider
};

export function registerProvider(name, ProviderClass) {
    if (!name || typeof name !== "string") {
        throw new Error("Provider name must be a non-empty string");
    }
    if (!ProviderClass || !(ProviderClass.prototype instanceof BaseProvider)) {
        throw new Error("Provider class must extend BaseProvider");
    }
    providerRegistry[name.toLowerCase()] = ProviderClass;
}

export function getProvider(name = process.env.AI_PROVIDER || "groq", config = {}) {
    const key = name.toLowerCase();
    const ProviderClass = providerRegistry[key];

    if (!ProviderClass) {
        const supported = Object.keys(providerRegistry).join(", ");
        throw new Error(`Unsupported AI provider: "${name}". Available providers: ${supported}`);
    }

    return new ProviderClass(config);
}

export { BaseProvider, OllamaProvider, GroqProvider, DemoProvider };
