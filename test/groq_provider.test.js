import assert from "node:assert/strict";
import {
    GroqProvider,
    sanitizeErrorMessage,
    parseGroqToolCallArguments
} from "../src/providers/groqProvider.js";

console.log("=== Testing GroqProvider Production Hardening ===");

// 1. Missing API Key validation
assert.throws(() => {
    new GroqProvider({ apiKey: "" });
}, /GROQ_API_KEY is missing/);

// 2. Sensitive API Key sanitization
const secretKey = "gsk_test_secret_key_1234567890abcdef";
const errorWithKey = `Failed to authenticate with key ${secretKey} at https://api.groq.com/openai/v1`;
const sanitized = sanitizeErrorMessage(errorWithKey, secretKey);
assert.equal(sanitized.includes(secretKey), false, "Secret key must be completely redacted");
assert.match(sanitized, /\[REDACTED_API_KEY\]/);

// Also test pattern redaction without explicit key passed
const patternRedacted = sanitizeErrorMessage("Authorization: Bearer gsk_randomalphanumerictoken999888777666555444");
assert.equal(patternRedacted.includes("gsk_randomalphanumerictoken"), false);
assert.match(patternRedacted, /\[REDACTED_API_KEY\]/);

// 3. parseGroqToolCallArguments
assert.deepEqual(parseGroqToolCallArguments('{"planId": "test-1"}'), { planId: "test-1" });
assert.deepEqual(parseGroqToolCallArguments({ already: "parsed" }), { already: "parsed" });
assert.deepEqual(parseGroqToolCallArguments(null), {});
assert.throws(() => {
    parseGroqToolCallArguments("{ malformed: json, }", "test_tool");
}, err => {
    assert.equal(err.code, "MALFORMED_TOOL_CALL_JSON");
    assert.match(err.message, /test_tool/);
    return true;
});

// 4. formatTools
const testTools = [
    {
        name: "get_study_plan",
        description: "Fetch a plan",
        inputSchema: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] }
    }
];
const provider = new GroqProvider({
    apiKey: "dummy-key-for-unit-test",
    client: { chat: { completions: {} }, models: {} }
});
const formatted = provider.formatTools(testTools);
assert.equal(formatted.length, 1);
assert.equal(formatted[0].type, "function");
assert.equal(formatted[0].function.name, "get_study_plan");
assert.deepEqual(formatted[0].function.parameters, testTools[0].inputSchema);

// 5. Chat with direct answer (no tool calls)
const mockChatClient = {
    chat: {
        completions: {
            async create({ messages, tools, model }) {
                return {
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "Recursion is a programming technique where a function calls itself."
                            }
                        }
                    ]
                };
            }
        }
    },
    models: {
        async retrieve(model) {
            return { id: model };
        }
    }
};

const directProvider = new GroqProvider({
    apiKey: "dummy-key-for-unit-test",
    client: mockChatClient
});

const directResponse = await directProvider.chat({
    messages: [{ role: "user", content: "What is recursion?" }]
});
assert.equal(directResponse.role, "assistant");
assert.match(directResponse.content, /Recursion is a programming technique/);
assert.equal(directResponse.toolCalls.length, 0);

// 6. Chat with single tool call
const mockSingleToolClient = {
    chat: {
        completions: {
            async create() {
                return {
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [
                                    {
                                        id: "call_abc123",
                                        type: "function",
                                        function: {
                                            name: "get_study_plan",
                                            arguments: JSON.stringify({ planId: "active-plan-42" })
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                };
            }
        }
    }
};

const singleToolProvider = new GroqProvider({
    apiKey: "dummy-key-for-unit-test",
    client: mockSingleToolClient
});

const singleToolResponse = await singleToolProvider.chat({
    messages: [{ role: "user", content: "How is my plan going?" }],
    tools: testTools
});
assert.equal(singleToolResponse.toolCalls.length, 1);
assert.equal(singleToolResponse.toolCalls[0].name, "get_study_plan");
assert.deepEqual(singleToolResponse.toolCalls[0].arguments, { planId: "active-plan-42" });
assert.equal(singleToolResponse.toolCalls[0].id, "call_abc123");

// 7. Chat with multiple parallel tool calls
const mockParallelToolClient = {
    chat: {
        completions: {
            async create() {
                return {
                    choices: [
                        {
                            message: {
                                role: "assistant",
                                content: "",
                                tool_calls: [
                                    {
                                        id: "call_1",
                                        type: "function",
                                        function: {
                                            name: "record_study_session",
                                            arguments: JSON.stringify({ planId: "p1", subject: "Math", hoursSpent: 2 })
                                        }
                                    },
                                    {
                                        id: "call_2",
                                        type: "function",
                                        function: {
                                            name: "get_study_plan",
                                            arguments: JSON.stringify({ planId: "p1" })
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                };
            }
        }
    }
};

const parallelProvider = new GroqProvider({
    apiKey: "dummy-key-for-unit-test",
    client: mockParallelToolClient
});
const parallelResponse = await parallelProvider.chat({
    messages: [{ role: "user", content: "Record session and show plan" }],
    tools: testTools
});
assert.equal(parallelResponse.toolCalls.length, 2);
assert.equal(parallelResponse.toolCalls[0].name, "record_study_session");
assert.equal(parallelResponse.toolCalls[1].name, "get_study_plan");

// 7.1 Historical tool calls always use Groq's required JSON-string arguments
let capturedHistory;
const historyProvider = new GroqProvider({
    apiKey: "dummy-key-for-unit-test",
    client: {
        chat: { completions: { async create({ messages }) {
            capturedHistory = messages;
            return { choices: [{ message: { role: "assistant", content: "Continuing." } }] };
        } } }
    }
});
await historyProvider.chat({
    messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "call-history", function: { name: "record_study_session", arguments: { hoursSpent: 1, status: "completed" } } }] },
        { role: "tool", tool_call_id: "call-history", content: "Recorded." },
        { role: "user", content: "Show progress" }
    ]
});
const historicalArguments = capturedHistory[0].tool_calls[0].function.arguments;
assert.equal(typeof historicalArguments, "string");
assert.deepEqual(JSON.parse(historicalArguments), { hoursSpent: 1, status: "completed" });
assert.equal(capturedHistory[0].tool_calls[0].id, "call-history");
assert.equal(capturedHistory[0].tool_calls[0].type, "function");

// 8. Rate limit (429) retry & recovery
let attempts = 0;
const mockRateLimitClient = {
    chat: {
        completions: {
            async create() {
                attempts++;
                if (attempts < 3) {
                    const error = new Error("Rate limit reached. Please retry in 1s.");
                    error.status = 429;
                    throw error;
                }
                return {
                    choices: [{ message: { role: "assistant", content: "Recovered after rate limit!" } }]
                };
            }
        }
    }
};

const retryProvider = new GroqProvider({
    apiKey: "dummy-key-for-unit-test",
    client: mockRateLimitClient,
    maxRetries: 3,
    retryBaseDelayMs: 20
});

const retryResponse = await retryProvider.chat({
    messages: [{ role: "user", content: "Hello" }]
});
assert.equal(attempts, 3, "Provider should have retried until success");
assert.equal(retryResponse.content, "Recovered after rate limit!");

// 9. Rate limit max retries exceeded
let failAttempts = 0;
const mockAlwaysFailClient = {
    chat: {
        completions: {
            async create() {
                failAttempts++;
                const error = new Error(`Rate limit exceeded for key ${secretKey}`);
                error.status = 429;
                throw error;
            }
        }
    }
};

const failProvider = new GroqProvider({
    apiKey: secretKey,
    client: mockAlwaysFailClient,
    maxRetries: 2,
    retryBaseDelayMs: 10
});

await assert.rejects(
    async () => {
        await failProvider.chat({ messages: [{ role: "user", content: "Hello" }] });
    },
    err => {
        assert.equal(failAttempts, 3); // initial attempt + 2 retries
        assert.equal(err.message.includes(secretKey), false, "API key must not leak in error message");
        assert.match(err.message, /\[REDACTED_API_KEY\]/);
        return true;
    }
);

// 10. Timeout safeguard
const mockHangingClient = {
    chat: {
        completions: {
            async create() {
                await new Promise(r => setTimeout(r, 200));
                return { choices: [{ message: { role: "assistant", content: "Too late" } }] };
            }
        }
    }
};

const timeoutProvider = new GroqProvider({
    apiKey: "dummy-key-for-unit-test",
    client: mockHangingClient,
    timeoutMs: 40,
    maxRetries: 0
});

await assert.rejects(
    async () => {
        await timeoutProvider.chat({ messages: [{ role: "user", content: "Fast request" }] });
    },
    /timed out after 40ms/
);

// 11. Health check verification
const healthyProvider = new GroqProvider({
    apiKey: "dummy-key-for-unit-test",
    client: {
        models: {
            async retrieve(id) {
                return { id };
            }
        }
    }
});
const healthResult = await healthyProvider.checkHealth();
assert.equal(healthResult.available, true);
assert.equal(healthResult.provider, "groq");

const unhealthyProvider = new GroqProvider({
    apiKey: secretKey,
    client: {
        models: {
            async retrieve() {
                throw new Error(`Unauthorized access with ${secretKey}`);
            }
        }
    },
    maxRetries: 0
});
const unhealthyResult = await unhealthyProvider.checkHealth();
assert.equal(unhealthyResult.available, false);
assert.equal(unhealthyResult.error.includes(secretKey), false, "Secret key must be redacted in health check error");

// 12. Ollama-first with seamless Groq fallback execution
import { getProvider } from "../src/providers/index.js";

const hybridProvider = getProvider("ollama", {
    host: "http://127.0.0.1:59999", // Unreachable Ollama daemon port
    apiKey: "dummy-key-for-unit-test",
    client: mockChatClient
});

const fallbackResponse = await hybridProvider.chat({
    messages: [{ role: "user", content: "What is recursion?" }]
});
assert.match(fallbackResponse.content, /Recursion is a programming technique/, "When Ollama is unreachable, Groq provider must execute seamlessly");

console.log("✓ All GroqProvider hardening & Ollama-to-Groq fallback unit tests passed successfully!");

