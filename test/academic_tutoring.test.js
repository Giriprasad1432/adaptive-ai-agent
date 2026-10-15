import assert from "node:assert/strict";
import { AdaptiveAgent } from "../src/agent/adaptiveAgent.js";
import { isEducationalTutoringIntent, isRetrievalIntent } from "../src/agent/normalizer.js";

console.log("=== Testing Phase 3: Academic Tutoring & Request Understanding ===");

// 1. Classification Tests
const educationalQueries = [
    "Explain recursion with a C++ example",
    "Explain recursion in simple terms.",
    "Teach me operating-system deadlocks.",
    "What is the difference between BFS and DFS?",
    "Compare BFS and DFS.",
    "How does deadlock prevention work in operating systems?",
    "Write a python function for binary search",
    "Help me understand eigenvalues and eigenvectors",
    "Compare and contrast processes versus threads",
    "Explain dynamic programming with the Fibonacci sequence",
    "Generate Java programming exercises.",
    "Help me debug this program.",
    "Why does this give a NullPointerException in Java?",
    "Explain DBMS normalization and the difference between 2NF and 3NF.",
    "Solve this step-by-step problem on permutations and combinations.",
    "Explain TCP versus UDP for beginners."
];

for (const q of educationalQueries) {
    assert.equal(isEducationalTutoringIntent(q), true, `Should be educational: ${q}`);
    assert.equal(isRetrievalIntent(q), false, `Should NOT be retrieval intent: ${q}`);
}

const operationalAndQuizQueries = [
    "Create a study plan for JavaScript",
    "Show my study plan",
    "Show my saved study plan.",
    "How is my study plan progress?",
    "Record 2 hours of Math session",
    "Adapt my schedule after missed sessions",
    "Create a quiz on DBMS normalization.",
    "Generate a practice quiz on Operating Systems"
];

for (const q of operationalAndQuizQueries) {
    assert.equal(isEducationalTutoringIntent(q), false, `Should NOT be passive educational: ${q}`);
}


// 2. Direct AI answer without MCP tool calls for educational question
let calledTools = [];
const educationalProvider = {
    async chat({ messages }) {
        const lastUser = messages.findLast(m => m.role === "user")?.content || "";
        if (lastUser.includes("recursion")) {
            return {
                role: "assistant",
                content: "Recursion is when a function calls itself. In C++:\n```cpp\nint fact(int n) { return n <= 1 ? 1 : n * fact(n-1); }\n```",
                toolCalls: []
            };
        }
        return { role: "assistant", content: "General answer", toolCalls: [] };
    }
};

const mockMcpClient = {
    listTools: () => [
        { name: "create_study_plan", inputSchema: { type: "object" } },
        { name: "get_study_plan", inputSchema: { type: "object" } }
    ],
    async callTool(name, args) {
        calledTools.push({ name, args });
        return { isError: false, content: "{}" };
    }
};

const agent = new AdaptiveAgent({
    provider: educationalProvider,
    mcpClient: mockMcpClient
});

const result = await agent.run({ message: "Explain recursion with a C++ example" });
assert.equal(result.success, true);
assert.match(result.reply, /Recursion is when a function calls itself/);
assert.equal(calledTools.length, 0, "No tools should be invoked for educational tutoring questions");

// 3. Multi-turn Conversation Context Preservation
const multiTurnMessages = [
    { role: "user", content: "I want to study Java and DBMS" },
    { role: "assistant", content: "Great! How many days do you want to study for?" },
    { role: "user", content: "Plan for 10 days" },
    { role: "assistant", content: "How many hours per day can you study?" }
];

let multiTurnToolCalled = null;
const multiTurnProvider = {
    async chat({ messages }) {
        const hasToolResult = messages.some(m => m.role === "tool");
        if (hasToolResult) {
            return {
                role: "assistant",
                content: "I have created your 10-day study plan for Java and DBMS with 3 hours daily.",
                toolCalls: []
            };
        }
        // AI model recognizes accumulated information from prior messages
        const fullContext = messages.map(m => m.content).join(" ");
        if (fullContext.includes("Java") && fullContext.includes("10 days")) {
            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: "call_multiturn",
                        name: "create_study_plan",
                        arguments: {
                            subjects: ["Java", "DBMS"],
                            durationDays: 10,
                            dailyAvailableHours: 3
                        }
                    }
                ]
            };
        }
        return { role: "assistant", content: "Could you specify the details?", toolCalls: [] };
    }
};

const multiTurnAgent = new AdaptiveAgent({
    provider: multiTurnProvider,
    mcpClient: {
        listTools: () => [{ name: "create_study_plan", inputSchema: { type: "object", properties: { subjects: { type: "array" }, durationDays: { type: "number" }, dailyAvailableHours: { type: "number" } }, required: ["subjects"] } }],
        async callTool(name, args) {
            multiTurnToolCalled = { name, args };
            return {
                isError: false,
                content: JSON.stringify({
                    planId: "multiturn-plan-1",
                    subjects: ["Java", "DBMS"],
                    totalAllocatedHours: 30,
                    subjectAllocations: {
                        Java: { allocatedHours: 15, priority: "high" },
                        DBMS: { allocatedHours: 15, priority: "medium" }
                    }
                })
            };
        }
    }
});

const multiTurnResult = await multiTurnAgent.run({
    message: "3 hours daily",
    messages: multiTurnMessages
});

assert.equal(multiTurnResult.success, true);
assert.notEqual(multiTurnToolCalled, null);
assert.equal(multiTurnToolCalled.name, "create_study_plan");
assert.deepEqual(multiTurnToolCalled.args.subjects, ["Java", "DBMS"]);
assert.equal(multiTurnToolCalled.args.durationDays, 10);
// 4. Direct AI debugging without MCP tool calls
let debugToolCalls = [];
const debugProvider = {
    async chat({ messages }) {
        const lastUser = messages.findLast(m => m.role === "user")?.content || "";
        if (lastUser.includes("NullPointerException")) {
            return {
                role: "assistant",
                content: "A `NullPointerException` occurs when you attempt to dereference a reference variable that points to `null`.\n\n### Fix:\n```java\nif (obj != null) {\n    obj.doSomething();\n}\n```",
                toolCalls: []
            };
        }
        return { role: "assistant", content: "Debugging help", toolCalls: [] };
    }
};

const debugAgent = new AdaptiveAgent({
    provider: debugProvider,
    mcpClient: {
        listTools: () => [{ name: "create_study_plan", inputSchema: { type: "object" } }],
        async callTool(name, args) {
            debugToolCalls.push({ name, args });
            return { isError: false, content: "{}" };
        }
    }
});

const debugResult = await debugAgent.run({ message: "Why does this give a NullPointerException in Java?" });
assert.equal(debugResult.success, true);
assert.match(debugResult.reply, /NullPointerException/);
assert.equal(debugToolCalls.length, 0, "Debugging assistance must not invoke plan tools");

// 5. Direct Step-by-Step Problem Solving without MCP tool calls
let mathToolCalls = [];
const mathProvider = {
    async chat({ messages }) {
        return {
            role: "assistant",
            content: "### Permutations & Combinations Solution\n\n**Step 1:** Identify $n = 5$ and $r = 3$.\n**Step 2:** Apply formula $P(n, r) = \\frac{n!}{(n-r)!} = \\frac{120}{2} = 60$.",
            toolCalls: []
        };
    }
};

const mathAgent = new AdaptiveAgent({
    provider: mathProvider,
    mcpClient: {
        listTools: () => [{ name: "create_study_plan", inputSchema: { type: "object" } }],
        async callTool(name, args) {
            mathToolCalls.push({ name, args });
            return { isError: false, content: "{}" };
        }
    }
});

const mathResult = await mathAgent.run({ message: "Solve this step-by-step problem on permutations and combinations." });
assert.equal(mathResult.success, true);
assert.match(mathResult.reply, /Permutations & Combinations Solution/);
assert.equal(mathToolCalls.length, 0, "Math problem solving must not invoke plan tools");

console.log("✓ Phase 3: Academic Tutoring & Request Understanding verified successfully!");

