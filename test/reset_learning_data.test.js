import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyToolResult } from "../src/agent/validator.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "../studypilot-server/server.js");
const dataDir = fs.mkdtempSync(path.join(testDir, ".reset-learning-data-test-"));
const plansFile = path.join(dataDir, "studypilot_data.json");
const preferencesFile = path.join(dataDir, "studypilot_preferences.json");
const quizzesFile = path.join(dataDir, "studypilot_quizzes.json");

const initialPlans = {
    "plan-for-user-a": { planId: "plan-for-user-a", subjects: { Java: {} }, sessions: [{ id: "session-a1", subject: "Java", hoursSpent: 1 }] },
    "plan-for-user-b": { planId: "plan-for-user-b", subjects: { DBMS: {} }, sessions: [{ id: "session-b1", subject: "DBMS", hoursSpent: 2 }] }
};
const initialPreferences = {
    userA: { userId: "userA", preferredLanguage: "Java" },
    userB: { userId: "userB", preferredLanguage: "Python" }
};
const initialQuizzes = {
    quizzes: { quizA: { quizId: "quizA" }, quizB: { quizId: "quizB" } },
    results: [{ resultId: "resultA" }, { resultId: "resultB" }]
};

fs.writeFileSync(plansFile, JSON.stringify(initialPlans));
fs.writeFileSync(preferencesFile, JSON.stringify(initialPreferences));
fs.writeFileSync(quizzesFile, JSON.stringify(initialQuizzes));

const client = new Client({ name: "reset-learning-data-test", version: "1.0.0" });
const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: { ...process.env, STUDYPILOT_DATA_DIR: dataDir }
});

try {
    await client.connect(transport);

    const refusedDelete = await client.callTool({
        name: "delete_study_plan",
        arguments: { planId: "plan-for-user-a", confirm: false }
    });
    assert.equal(refusedDelete.isError, true, "A plan deletion without confirmation must be rejected");
    assert.deepEqual(JSON.parse(fs.readFileSync(plansFile, "utf8")), initialPlans);

    const missingPlanDelete = await client.callTool({
        name: "delete_study_plan",
        arguments: { planId: "missing-plan", confirm: true }
    });
    assert.equal(missingPlanDelete.isError, true, "An unknown plan ID must not delete another plan");
    assert.deepEqual(JSON.parse(fs.readFileSync(plansFile, "utf8")), initialPlans);

    const deleteResult = await client.callTool({
        name: "delete_study_plan",
        arguments: { planId: "plan-for-user-a", confirm: true }
    });
    assert.notEqual(deleteResult.isError, true);
    const deletedSummary = JSON.parse(deleteResult.content[0].text);
    assert.equal(deletedSummary.deleted, true);
    assert.equal(deletedSummary.planId, "plan-for-user-a");
    assert.equal(deletedSummary.deletedSessionCount, 1);
    const plansAfterSingleDelete = { "plan-for-user-b": initialPlans["plan-for-user-b"] };
    assert.deepEqual(JSON.parse(fs.readFileSync(plansFile, "utf8")), plansAfterSingleDelete);
    assert.deepEqual(JSON.parse(fs.readFileSync(preferencesFile, "utf8")), initialPreferences);
    assert.deepEqual(JSON.parse(fs.readFileSync(quizzesFile, "utf8")), initialQuizzes);

    assert.equal(verifyToolResult("delete_study_plan", { planId: "plan-for-user-b" }, {
        content: JSON.stringify({ deleted: true, planId: "plan-for-user-a" })
    }).valid, false, "A mismatched delete result must not be treated as success");

    const declined = await client.callTool({
        name: "reset_learning_data",
        arguments: { confirm: false }
    });
    assert.equal(declined.isError, true, "An unconfirmed reset must be rejected");
    assert.deepEqual(JSON.parse(fs.readFileSync(plansFile, "utf8")), plansAfterSingleDelete);
    assert.deepEqual(JSON.parse(fs.readFileSync(preferencesFile, "utf8")), initialPreferences);
    assert.deepEqual(JSON.parse(fs.readFileSync(quizzesFile, "utf8")), initialQuizzes);

    const confirmed = await client.callTool({
        name: "reset_learning_data",
        arguments: { confirm: true }
    });
    assert.equal(confirmed.isError, false, "A confirmed global reset should succeed");
    assert.deepEqual(JSON.parse(fs.readFileSync(plansFile, "utf8")), {});
    assert.deepEqual(JSON.parse(fs.readFileSync(preferencesFile, "utf8")), {});
    assert.deepEqual(JSON.parse(fs.readFileSync(quizzesFile, "utf8")), { quizzes: {}, results: [] });

    console.log("✓ Specific plan deletion is scoped and confirmed; global reset requires separate confirmation");
} finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
}
