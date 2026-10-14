import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdaptiveAgent } from "../src/agent/adaptiveAgent.js";
import { extractExplicitPlanDayNumber, isSessionRecordingIntent, normalizeToolArguments } from "../src/agent/normalizer.js";
import { parseGroqToolCallArguments } from "../src/providers/groqProvider.js";
import { adaptPlan, calculateDaysRemaining, createPlan, recordSession, resolvePlanDayDate } from "../studypilot-server/planner.js";
import { McpClientManager } from "../src/mcp/mcpClient.js";

const start = new Date("2026-10-14T00:00:00.000Z");
const plan = createPlan({
    planId: "date-fixture", subjects: ["DBMS"], durationDays: 7,
    dailyAvailableHours: 2, referenceDate: start
});

// Inclusive goal-plan dates: the start day is Day 1 and the final day is Day 7.
assert.equal(plan.startDate, "2026-10-14");
assert.equal(plan.goalEndDate, "2026-10-20");
assert.equal(plan.daysRemaining, 7);
assert.equal(resolvePlanDayDate(plan, 1), "2026-10-14");
assert.equal(resolvePlanDayDate(plan, 2), "2026-10-15");
assert.equal(resolvePlanDayDate(plan, 7), "2026-10-20");
assert.equal(resolvePlanDayDate({ ...plan, startDate: undefined }, 2), "2026-10-15",
    "Existing plans without startDate derive it from createdAt");
assert.throws(() => resolvePlanDayDate(plan, 0), /between 1 and 7/);
assert.throws(() => resolvePlanDayDate(plan, 8), /between 1 and 7/);

assert.equal(calculateDaysRemaining("2026-10-20", start, { includeReferenceDate: true }), 7,
    "At the start of Day 1, all seven inclusive plan days remain");
assert.equal(calculateDaysRemaining("2026-10-20", new Date("2026-10-17T12:00:00.000Z"), { includeReferenceDate: true }), 4,
    "Mid-plan remaining days include the current plan day");
assert.equal(calculateDaysRemaining("2026-10-20", new Date("2026-10-20T23:59:00.000Z"), { includeReferenceDate: true }), 1,
    "The final plan day remains available through its UTC calendar day");
assert.equal(calculateDaysRemaining("2026-10-20", new Date("2026-10-14T23:59:59.999Z"), { includeReferenceDate: true }), 7,
    "The date-only boundary changes at UTC midnight, independent of local timezone");
assert.equal(calculateDaysRemaining("2026-10-20", new Date("2026-10-15T00:00:00.000Z"), { includeReferenceDate: true }), 6);

const adaptedPlan = structuredClone(plan);
const adaptation = adaptPlan(adaptedPlan, { reason: "date fixture", referenceDate: start });
assert.equal(adaptation.adaptation.daysRemaining, 7);
assert.equal(adaptedPlan.goalEndDate, "2026-10-20");
assert.equal(adaptedPlan.dailyAvailableHours, 2);
for (const [date, expected] of [["2026-10-17T12:00:00.000Z", 4], ["2026-10-20T12:00:00.000Z", 1]]) {
    const atDate = adaptPlan(structuredClone(plan), { reason: "boundary fixture", referenceDate: new Date(date) });
    assert.equal(atDate.adaptation.daysRemaining, expected);
}
const examPlan = createPlan({
    planId: "exam-date-compatibility", subjects: ["Physics"], examDate: "2026-10-20",
    dailyAvailableHours: 2, referenceDate: start
});
assert.equal(examPlan.daysRemaining, 6, "Exam plans retain the pre-existing exclusive days-until calculation");
assert.equal(adaptPlan(structuredClone(examPlan), { reason: "exam compatibility", referenceDate: start }).adaptation.daysRemaining, 6,
    "Exam-date adaptations retain their prior daysRemaining behavior");

// Legacy stored end dates are read as stored; no automatic migration occurs.
const legacyPlan = structuredClone(plan);
legacyPlan.goalEndDate = "2026-10-21";
legacyPlan.startDate = undefined;
const legacyAdaptation = adaptPlan(legacyPlan, { reason: "legacy fixture", referenceDate: start });
assert.equal(legacyPlan.goalEndDate, "2026-10-21");
assert.equal(legacyAdaptation.adaptation.daysRemaining, 8,
    "An existing October 21 inclusive end date remains authoritative and is not rewritten");
assert.equal(resolvePlanDayDate(legacyPlan, 7), "2026-10-20",
    "Legacy Day N mapping uses createdAt plus duration even when the stored end date conflicts");
assert.throws(() => resolvePlanDayDate(legacyPlan, 8), /between 1 and 7/);

const recordTool = {
    name: "record_study_session",
    inputSchema: {
        type: "object",
        properties: {
            subject: { type: "string" }, hoursSpent: { type: "number" }, status: { type: "string" },
            date: { type: "string" }, dayNumber: { type: "integer" }, planId: { type: "string" }
        },
        required: ["subject", "hoursSpent", "status"]
    }
};
assert.equal(extractExplicitPlanDayNumber("Day 2 missed yaar"), 2);
const dayArgs = normalizeToolArguments(recordTool, {
    planId: "date-fixture", subject: "DBMS", hoursSpent: 0, status: "missed", date: "2099-01-01"
}, { message: "Day 2 missed yaar" });
assert.equal(dayArgs.dayNumber, 2);
assert.equal(dayArgs.date, undefined, "A model-invented date cannot override the user's plan-day reference");
const clarifiedDayArgs = normalizeToolArguments(recordTool, {
    planId: "date-fixture", subject: "DBMS", hoursSpent: 1, status: "completed"
}, {
    message: "equally",
    messages: [{ role: "user", content: "Day 1 completed for the week course" }, { role: "user", content: "equally" }]
});
assert.equal(clarifiedDayArgs.dayNumber, 1, "A short clarification keeps the most recent plan-day reference in context");
const unrelatedSessionArgs = normalizeToolArguments(recordTool, {
    planId: "date-fixture", subject: "DBMS", hoursSpent: 1, status: "completed", dayNumber: 1
}, {
    message: "Record a new DBMS session today.",
    messages: [{ role: "user", content: "Day 1 completed" }, { role: "assistant", content: "Recorded." }]
});
assert.equal(unrelatedSessionArgs.dayNumber, undefined, "An old Day N mention is not reused for a new session request");
const explicitDateArgs = normalizeToolArguments(recordTool, {
    planId: "date-fixture", subject: "DBMS", hoursSpent: 0, status: "missed", dayNumber: 2, date: "2099-01-01"
}, { message: "Record Day 2's missed DBMS session on October 18, 2026." });
assert.equal(explicitDateArgs.date, "2026-10-18");
assert.equal(explicitDateArgs.dayNumber, undefined, "Explicit calendar date takes precedence over inferred plan day");
assert.equal(normalizeToolArguments(recordTool, { dayNumber: 2 }, { trustedPlanId: true }).dayNumber, 2,
    "The MCP client's context-free second normalization preserves the agent's resolved Day N argument");
assert.equal(isSessionRecordingIntent("I missed Day 2"), true, "A missed plan day is recognized as a recording request");

const missed = recordSession(plan, {
    subject: "DBMS", hoursSpent: 0, missedHours: 1, scheduledHours: 2,
    status: "missed", date: resolvePlanDayDate(plan, 2)
});
assert.deepEqual(
    { date: missed.session.date, hoursSpent: missed.session.hoursSpent, missedHours: missed.session.missedHours, scheduledHours: missed.session.scheduledHours },
    { date: "2026-10-15", hoursSpent: 0, missedHours: 1, scheduledHours: 2 },
    "Day-mapped missed sessions retain their explicit scheduled duration"
);
const todayDefaultedSession = recordSession(structuredClone(plan), {
    subject: "DBMS", hoursSpent: 1, status: "completed"
});
assert.match(todayDefaultedSession.session.date, /^\d{4}-\d{2}-\d{2}$/, "Existing calls without day/date continue to default to today");

// Malformed provider output is rejected by Groq argument parsing, before tools.
assert.throws(() => parseGroqToolCallArguments('{"hoursSpent": 1,}', "record_study_session"), error => {
    assert.match(error.message, /invalid arguments/i);
    assert.equal(error.code, "MALFORMED_TOOL_CALL_JSON");
    return true;
});

const malformedProviderError = () => Object.assign(new Error("400 Failed to parse tool call arguments as JSON"), {
    status: 400,
    error: { code: "tool_use_failed", message: "Failed to parse tool call arguments as JSON" }
});
const successToolResult = {
    planId: "recovery-plan",
    session: { date: "2026-10-14", subject: "Mathematics", hoursSpent: 1, missedHours: 0, scheduledHours: 1, status: "completed" },
    subjectProgress: { subject: "Mathematics", completedHours: 1, missedHours: 0, remainingHours: 9, progressPercentage: "10%" }
};
const makeRecoveryAgent = ({ failBeforeTool, failAfterTool, invalidCorrection = false, retryMalformedAgain = false } = {}) => {
    let providerCalls = 0;
    let toolCalls = 0;
    const provider = {
        async chat({ messages }) {
            providerCalls++;
            if (failBeforeTool && (providerCalls === 1 || (retryMalformedAgain && providerCalls === 2))) throw malformedProviderError();
            if (failAfterTool && providerCalls === 2) throw malformedProviderError();
            if (providerCalls === 1 || (failBeforeTool && providerCalls === 2)) {
                return {
                    toolCalls: [{ name: "record_study_session", arguments: invalidCorrection
                        ? { planId: "recovery-plan", hoursSpent: 1, status: "completed" }
                        : { planId: "recovery-plan", subject: "Mathematics", hoursSpent: 1, status: "completed" } }],
                    content: ""
                };
            }
            return { toolCalls: [], content: "Recorded one hour of Mathematics." };
        }
    };
    const mcpClient = {
        listTools: () => [recordTool],
        async callTool(name, args) {
            toolCalls++;
            assert.equal(name, "record_study_session");
            assert.equal(args.planId, "recovery-plan");
            return { isError: false, content: JSON.stringify(successToolResult) };
        }
    };
    const agent = new AdaptiveAgent({ provider, mcpClient, maxRounds: 5 });
    return { agent, get providerCalls() { return providerCalls; }, get toolCalls() { return toolCalls; } };
};

const recovered = makeRecoveryAgent({ failBeforeTool: true });
const recoveredResult = await recovered.agent.run({ message: "Record 1 hour of Mathematics for plan ID recovery-plan." });
assert.equal(recoveredResult.success, true, recoveredResult.reply);
assert.equal(recovered.toolCalls, 1, "A corrected provider response executes the mutation exactly once");
assert.ok(recoveredResult.steps.some(step => step.type === "provider_tool_call_correction"));

const rejectedCorrection = makeRecoveryAgent({ failBeforeTool: true, invalidCorrection: true });
const rejectedResult = await rejectedCorrection.agent.run({ message: "Record 1 hour of Mathematics for plan ID recovery-plan." });
assert.equal(rejectedCorrection.toolCalls, 0, "Corrected arguments still pass through the original schema validation");
assert.ok(rejectedResult.steps.some(step => step.type === "tool_validation_error"));

const malformedTwice = makeRecoveryAgent({ failBeforeTool: true, retryMalformedAgain: true });
const malformedTwiceResult = await malformedTwice.agent.run({ message: "Record 1 hour of Mathematics for plan ID recovery-plan." });
assert.equal(malformedTwice.toolCalls, 0, "Repeated malformed JSON is rejected before any MCP execution");
assert.equal(malformedTwice.providerCalls, 2, "Only one correction attempt is made");
assert.equal(malformedTwiceResult.success, false);

const noRetryAfterSuccess = makeRecoveryAgent({ failAfterTool: true });
const noRetryResult = await noRetryAfterSuccess.agent.run({ message: "Record 1 hour of Mathematics for plan ID recovery-plan." });
assert.equal(noRetryAfterSuccess.toolCalls, 1, "A later provider JSON failure cannot retrigger an already successful mutation");
assert.equal(noRetryAfterSuccess.providerCalls, 2, "No correction attempt occurs after a successful tool execution");
assert.equal(noRetryResult.success, false);

const listTool = { name: "list_study_plans", inputSchema: { type: "object", properties: {} } };
const twoPlansResult = { plans: [
    { planId: "dbms-plan", subjects: ["DBMS"] },
    { planId: "java-plan", subjects: ["Java"] }
], count: 2 };
let selectedPlanArgs;
let selectionProviderCalls = 0;
const selectionAgent = new AdaptiveAgent({
    provider: { async chat() {
        selectionProviderCalls++;
        if (selectionProviderCalls === 1) return { toolCalls: [{
            name: "record_study_session",
            arguments: { planId: "dbms-plan", subject: "Java", hoursSpent: 0, missedHours: 1, scheduledHours: 2, status: "missed" }
        }], content: "" };
        return { toolCalls: [], content: "The missed Java session was recorded." };
    } },
    mcpClient: {
        listTools: () => [listTool, recordTool],
        async callTool(name, args) {
            if (name === "list_study_plans") return { isError: false, content: JSON.stringify(twoPlansResult) };
            selectedPlanArgs = args;
            return { isError: false, content: JSON.stringify({
                planId: "java-plan",
                session: { date: "2026-10-15", subject: "Java", hoursSpent: 0, missedHours: 1, scheduledHours: 2, status: "missed" },
                subjectProgress: { subject: "Java", completedHours: 0, missedHours: 1, remainingHours: 7, progressPercentage: "0%" }
            }) };
        }
    }
});
const selectedPlanResult = await selectionAgent.run({ message: "I missed Day 2 for Java." });
assert.equal(selectedPlanResult.success, true, selectedPlanResult.reply);
assert.equal(selectedPlanArgs.planId, "java-plan", "A uniquely mentioned subject selects its matching plan, overriding the model proposal");
assert.equal(selectedPlanArgs.dayNumber, 2);

let ambiguousProviderCalls = 0;
let ambiguousRecordCalls = 0;
const ambiguousAgent = new AdaptiveAgent({
    provider: { async chat() { ambiguousProviderCalls++; return { toolCalls: [], content: "I recorded it." }; } },
    mcpClient: {
        listTools: () => [listTool, recordTool],
        async callTool(name) {
            if (name === "list_study_plans") return { isError: false, content: JSON.stringify(twoPlansResult) };
            ambiguousRecordCalls++;
            return { isError: false, content: "{}" };
        }
    }
});
const ambiguousResult = await ambiguousAgent.run({ message: "I missed Day 2." });
assert.equal(ambiguousResult.success, false);
assert.match(ambiguousResult.reply, /more than one saved study plan/i);
assert.equal(ambiguousProviderCalls, 0, "Ambiguous plan choice stops before model tool selection");
assert.equal(ambiguousRecordCalls, 0, "Ambiguous plan references cannot mutate any plan");

// Integration through the actual Stdio MCP server and an isolated storage file.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(testDir, "../studypilot-server/server.js");
const tempDataDir = fs.mkdtempSync(path.join(testDir, ".studypilot-day-number-test-"));
const integrationClient = new McpClientManager({
    command: process.execPath,
    args: [serverScript],
    env: { MCP_TRANSPORT: "stdio", STUDYPILOT_DATA_DIR: tempDataDir }
});
try {
    const connected = await integrationClient.connect();
    assert.equal(connected.connected, true, connected.error || "The isolated StudyPilot MCP server must connect");
    const planId = `date-e2e-${process.pid}-${Date.now()}`;
    const created = await integrationClient.callTool("create_study_plan", {
        planId, subjects: ["Java"], durationDays: 7, dailyAvailableHours: 2
    });
    assert.equal(created.isError, false, created.content);
    const otherPlanId = `${planId}-dbms`;
    const otherCreated = await integrationClient.callTool("create_study_plan", {
        planId: otherPlanId, subjects: ["DBMS"], durationDays: 7, dailyAvailableHours: 2
    });
    assert.equal(otherCreated.isError, false, otherCreated.content);
    const storedBefore = JSON.parse(fs.readFileSync(path.join(tempDataDir, "studypilot_data.json"), "utf8"));
    const startDate = storedBefore[planId].startDate;
    const dayTwoDate = resolvePlanDayDate(storedBefore[planId], 2);

    for (const dayNumber of [0, 8]) {
        const invalid = await integrationClient.callTool("record_study_session", {
            planId, subject: "Java", hoursSpent: 0, missedHours: 1, scheduledHours: 2,
            status: "missed", dayNumber
        });
        assert.equal(invalid.isError, true, `Day ${dayNumber} must be rejected`);
    }
    let stored = JSON.parse(fs.readFileSync(path.join(tempDataDir, "studypilot_data.json"), "utf8"));
    assert.equal(stored[planId].sessions.length, 0, "Out-of-range plan days must not persist records");

    let integrationProviderCalls = 0;
    const integratedAgent = new AdaptiveAgent({
        provider: { async chat() {
            integrationProviderCalls++;
            if (integrationProviderCalls === 1) return { toolCalls: [{
                name: "record_study_session",
                arguments: { planId: otherPlanId, subject: "Java", hoursSpent: 0, missedHours: 1, scheduledHours: 2, status: "missed" }
            }], content: "" };
            return { toolCalls: [], content: "The missed Day 2 Java session was recorded." };
        } },
        mcpClient: integrationClient
    });
    const integratedResult = await integratedAgent.run({ message: "I missed Day 2 for Java." });
    assert.equal(integratedResult.success, true, integratedResult.reply);
    assert.equal(integrationProviderCalls, 2);
    const explicitDate = "2030-01-01";
    const explicit = await integrationClient.callTool("record_study_session", {
        planId, subject: "Java", hoursSpent: 0, missedHours: 1, scheduledHours: 2,
        status: "missed", dayNumber: 2, date: explicitDate
    });
    assert.equal(explicit.isError, false, explicit.content);

    stored = JSON.parse(fs.readFileSync(path.join(tempDataDir, "studypilot_data.json"), "utf8"));
    assert.equal(stored[planId].sessions.length, 2);
    assert.equal(stored[planId].sessions[0].date, dayTwoDate, "The Day 2 request maps to the day after plan start through agent, MCP, and storage");
    assert.equal(stored[planId].sessions[1].date, explicitDate, "An explicit date wins over dayNumber at MCP execution");
    assert.ok(dayTwoDate > startDate);
    assert.equal(stored[otherPlanId].sessions.length, 0, "A conflicting model plan ID cannot update the nonmatching subject plan");
    assert.equal(stored[planId].totalCompletedHours, 0, "Missed sessions do not add completed hours");
    assert.equal(stored[planId].totalMissedHours, 2);
    assert.equal(stored[planId].sessions[0].scheduledHours, 2, "Missed-session scheduled hours survive MCP dispatch");
} finally {
    await integrationClient.disconnect();
    const resolvedTestDir = path.resolve(testDir) + path.sep;
    assert.ok(path.resolve(tempDataDir).startsWith(resolvedTestDir), "Temporary MCP test data must stay under the test directory");
    fs.rmSync(tempDataDir, { recursive: true, force: true });
}

console.log("✓ Study-plan inclusive dates, Day N mapping, explicit-date precedence, and bounded malformed-JSON recovery verified");
