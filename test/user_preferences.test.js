import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getUserPreferences, saveUserPreferences } from "../studypilot-server/storage.js";

console.log("=== Testing User Personalization & Preferences ===");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "studypilot-prefs-test-"));
const testPrefsFile = path.join(tempDir, "studypilot_preferences.json");

// 1. Storage Unit Tests
// 1.1 Defaults
const defaultPrefs = getUserPreferences("student_1", testPrefsFile);
assert.equal(defaultPrefs.userId, "student_1");
assert.equal(defaultPrefs.preferredExplanationStyle, "detailed");
assert.equal(defaultPrefs.preferredLanguage, "JavaScript");
assert.equal(defaultPrefs.defaultDailyAvailableHours, 2);

// 1.2 Save preferences
const updated = saveUserPreferences("student_1", {
    preferredExplanationStyle: "short",
    preferredLanguage: "Python",
    defaultDailyAvailableHours: 3,
    targetDifficulty: "advanced",
    customNotes: "Prefers concise code-first explanations"
}, testPrefsFile);

assert.equal(updated.userId, "student_1");
assert.equal(updated.preferredExplanationStyle, "short");
assert.equal(updated.preferredLanguage, "Python");
assert.equal(updated.defaultDailyAvailableHours, 3);
assert.equal(updated.targetDifficulty, "advanced");
assert.ok(updated.updatedAt);

// 1.3 Verify retrieval
const retrieved = getUserPreferences("student_1", testPrefsFile);
assert.equal(retrieved.preferredExplanationStyle, "short");
assert.equal(retrieved.preferredLanguage, "Python");

// 1.4 User isolation
const student2Prefs = getUserPreferences("student_2", testPrefsFile);
assert.equal(student2Prefs.userId, "student_2");
assert.equal(student2Prefs.preferredExplanationStyle, "detailed", "Student 2 should have default preferences, isolated from Student 1");

// 2. Integration via MCP Client Transport
const serverScript = path.resolve(__dirname, "../studypilot-server/server.js");
const client = new Client({ name: "prefs-tester", version: "1.0.0" });
const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: { ...process.env, STUDYPILOT_DATA_DIR: tempDir }
});

await client.connect(transport);

const { tools } = await client.listTools();
const toolNames = tools.map(t => t.name);
assert.ok(toolNames.includes("get_user_preferences"), "get_user_preferences tool should be exposed");
assert.ok(toolNames.includes("update_user_preferences"), "update_user_preferences tool should be exposed");

// 2.1 Update via MCP
const updateResult = await client.callTool({
    name: "update_user_preferences",
    arguments: {
        userId: "alexa_user",
        preferredExplanationStyle: "intuitive",
        preferredLanguage: "C++",
        defaultDailyAvailableHours: 1.5,
        targetDifficulty: "intermediate"
    }
});
assert.equal(updateResult.isError, false);
const updateParsed = JSON.parse(updateResult.content[0].text);
assert.equal(updateParsed.preferences.preferredExplanationStyle, "intuitive");
assert.equal(updateParsed.preferences.preferredLanguage, "C++");

// 2.2 Retrieve via MCP
const getResult = await client.callTool({
    name: "get_user_preferences",
    arguments: { userId: "alexa_user" }
});
assert.equal(getResult.isError, false);
const getParsed = JSON.parse(getResult.content[0].text);
assert.equal(getParsed.preferredExplanationStyle, "intuitive");
assert.equal(getParsed.preferredLanguage, "C++");

await client.close();
fs.rmSync(tempDir, { recursive: true, force: true });

console.log("✓ User Personalization & Preferences verified successfully!");
