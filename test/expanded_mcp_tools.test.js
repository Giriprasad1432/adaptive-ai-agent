import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    createQuiz,
    saveQuizResult,
    getWeakTopics,
    getStudyProgress
} from "../studypilot-server/quizManager.js";
import { createPlan } from "../studypilot-server/planner.js";
import { saveNewPlan } from "../studypilot-server/storage.js";

console.log("=== Testing Phase 4: Expanded MCP Tools (Quiz, Mastery, Weak Topics, Progress) ===");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "studypilot-expanded-tools-test-"));
process.env.STUDYPILOT_DATA_DIR = tempDir;

// 1. Direct Unit Tests for quizManager
// 1.1 createQuiz
const jsQuiz = createQuiz({ subject: "JavaScript", topic: "Closures & Event Loop", questionCount: 3 });
assert.ok(jsQuiz.quizId.startsWith("quiz-javascript-"));
assert.equal(jsQuiz.subject, "JavaScript");
assert.equal(jsQuiz.questions.length, 3);
assert.ok(jsQuiz.questions[0].options.length >= 4);
assert.equal(typeof jsQuiz.questions[0].correctOptionIndex, "number");

const customQuiz = createQuiz({ subject: "Quantum Computing", topic: "Qubits & Superposition", questionCount: 2 });
assert.equal(customQuiz.subject, "Quantum Computing");
assert.equal(customQuiz.questions.length, 3); // minimum 3 procedural questions

// 1.2 saveQuizResult - High score (Passed)
const passResult = saveQuizResult({
    quizId: jsQuiz.quizId,
    subject: "JavaScript",
    topic: "Closures",
    score: 3,
    totalQuestions: 3
});
assert.equal(passResult.status, "passed");
assert.equal(passResult.percentage, "100%");
assert.equal(passResult.weakTopicDetected, false);

// 1.3 saveQuizResult - Low score (Needs improvement / Weak topic)
const failResult = saveQuizResult({
    subject: "Operating Systems",
    topic: "Deadlocks",
    score: 1,
    totalQuestions: 4
});
assert.equal(failResult.status, "needs_improvement");
assert.equal(failResult.percentage, "25%");
assert.equal(failResult.weakTopicDetected, true);

// 1.4 getWeakTopics
const weakReport = getWeakTopics();
assert.equal(weakReport.count >= 1, true);
const osWeak = weakReport.weakTopics.find(w => w.subject === "Operating Systems");
assert.ok(osWeak, "Operating Systems should be flagged as weak due to 25% quiz score");
assert.match(osWeak.reasons[0], /25%/);

// 1.5 getStudyProgress
// Seed a test plan in temp storage
const samplePlan = createPlan({
    planId: "progress-test-plan",
    subjects: ["Operating Systems", "DBMS"],
    durationDays: 14,
    dailyAvailableHours: 2
});
saveNewPlan("progress-test-plan", samplePlan, path.join(tempDir, "studypilot_data.json"));

const progressSummary = getStudyProgress();
assert.equal(progressSummary.totalPlans >= 1, true);
assert.equal(progressSummary.quizzesTaken >= 2, true);
assert.notEqual(progressSummary.averageQuizScore, "No quizzes taken yet");

// 2. Integration Test via MCP Server Transport
const serverScript = path.resolve(__dirname, "../studypilot-server/server.js");
const client = new Client({ name: "expanded-tools-tester", version: "1.0.0" });
const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: { ...process.env, STUDYPILOT_DATA_DIR: tempDir }
});

await client.connect(transport);
const { tools } = await client.listTools();
const toolNames = tools.map(t => t.name);

// Verify all 9 tools are exposed
const expectedAllTools = [
    "list_study_plans",
    "create_study_plan",
    "get_study_plan",
    "record_study_session",
    "adapt_study_plan",
    "create_quiz",
    "save_quiz_result",
    "get_weak_topics",
    "get_study_progress"
];

for (const exp of expectedAllTools) {
    assert.ok(toolNames.includes(exp), `Expected MCP tool missing: ${exp}`);
}

// 2.1 Call create_quiz over MCP
const mcpQuizResult = await client.callTool({
    name: "create_quiz",
    arguments: { subject: "DBMS", questionCount: 2 }
});
assert.equal(mcpQuizResult.isError, false);
const parsedMcpQuiz = JSON.parse(mcpQuizResult.content[0].text);
assert.equal(parsedMcpQuiz.subject, "DBMS");
assert.equal(parsedMcpQuiz.questions.length >= 2, true);

// 2.2 Call get_weak_topics over MCP
const mcpWeakResult = await client.callTool({
    name: "get_weak_topics",
    arguments: {}
});
assert.equal(mcpWeakResult.isError, false);
const parsedWeak = JSON.parse(mcpWeakResult.content[0].text);
assert.equal(Array.isArray(parsedWeak.weakTopics), true);

// 2.3 Call get_study_progress over MCP
const mcpProgressResult = await client.callTool({
    name: "get_study_progress",
    arguments: {}
});
assert.equal(mcpProgressResult.isError, false);
const parsedProgress = JSON.parse(mcpProgressResult.content[0].text);
assert.equal(parsedProgress.totalPlans >= 1, true);

await client.close();
console.log("✓ All Phase 4 Expanded MCP Tools verified successfully!");
