import assert from "node:assert/strict";
import { AdaptiveAgent } from "../src/agent/adaptiveAgent.js";
import { isMultiDayCompletionStatement } from "../src/agent/normalizer.js";
import { formatGroundedSessionSummary } from "../src/agent/consistencyChecker.js";

const multiDayMessage = "5 days completed of dbms";
assert.equal(isMultiDayCompletionStatement(multiDayMessage), true);
assert.equal(isMultiDayCompletionStatement("Day 5 completed for DBMS"), false,
    "A single plan day is not treated as a batch completion");

let providerCalls = 0;
let mcpCalls = 0;
const clarificationAgent = new AdaptiveAgent({
    provider: { async chat() { providerCalls++; return { content: "", toolCalls: [] }; } },
    mcpClient: {
        listTools() { return [{ name: "record_study_session", inputSchema: { type: "object", properties: {} } }]; },
        async callTool() { mcpCalls++; return { isError: false, content: "{}" }; }
    }
});
const clarification = await clarificationAgent.run({ message: multiDayMessage });
assert.equal(clarification.needsClarification, true);
assert.equal(clarification.success, false);
assert.match(clarification.reply, /one plan day.*hours/i);
assert.equal(providerCalls, 0, "Ambiguous batch claims are clarified without relying on model guesses");
assert.equal(mcpCalls, 0, "No session is written until per-day details are provided");

const clarificationHistory = [
    { role: "user", content: "the dbms plan 5 days completed" },
    { role: "assistant", content: "Please tell me one plan day and the hours you studied (for example, ‘Day 5: 2 hours’), and I’ll log it." }
];
const followUpAgent = new AdaptiveAgent({
    provider: { async chat() { providerCalls++; return { content: "", toolCalls: [] }; } },
    mcpClient: {
        listTools() { return [{ name: "record_study_session", inputSchema: { type: "object", properties: {} } }]; },
        async callTool() { mcpCalls++; return { isError: false, content: "{}" }; }
    }
});
const followUpClarification = await followUpAgent.run({
    message: "yah each day completed successfully",
    messages: clarificationHistory
});
assert.equal(followUpClarification.needsClarification, true,
    "A batch-completion confirmation must remain a clarification instead of becoming a malformed tool call");
assert.match(followUpClarification.reply, /confirm the hours for each day/i);
assert.match(followUpClarification.reply, /Nothing has been recorded yet/i);
assert.equal(followUpClarification.rounds, 0);
assert.equal(providerCalls, 0, "Ambiguous batch follow-ups are handled without another model/tool attempt");
assert.equal(mcpCalls, 0, "Ambiguous batch follow-ups never write sessions");

const multipleDayDetails = await followUpAgent.run({
    message: "day1 2 hrs day2 3 hrs",
    messages: clarificationHistory
});
assert.equal(multipleDayDetails.needsClarification, true,
    "Multiple day entries must be handled one at a time instead of being sent as a single session call");
assert.match(multipleDayDetails.reply, /one day at a time/i);
assert.equal(providerCalls, 0);
assert.equal(mcpCalls, 0);

let recordedContinuationArgs = null;
let continuationProviderCalls = 0;
const detailedClarificationHistory = [
    { role: "user", content: "the dbms plan completed 2 days successfully 2h each" },
    { role: "assistant", content: "Please tell me one plan day and the hours you studied (for example, ‘Day 5: 2 hours’), and I’ll log it." }
];
const recordSessionTool = {
    name: "record_study_session",
    inputSchema: {
        type: "object",
        properties: {
            planId: { type: "string" }, subject: { type: "string" }, hoursSpent: { type: "number" },
            status: { type: "string", enum: ["completed", "missed"] }, dayNumber: { type: "integer" }
        },
        required: ["subject", "hoursSpent", "status"]
    }
};
const oneDayContinuationAgent = new AdaptiveAgent({
    provider: {
        async chat() {
            continuationProviderCalls++;
            if (continuationProviderCalls === 1) {
                return { content: "", toolCalls: [{ name: "get_study_plan", arguments: {} }] };
            }
            return { content: "Recorded 2h for DBMS (status: completed).", toolCalls: [] };
        }
    },
    mcpClient: {
        listTools() { return [{ name: "list_study_plans", inputSchema: { type: "object", properties: {} } }, recordSessionTool]; },
        async callTool(name, args) {
            if (name === "list_study_plans") {
                return { isError: false, content: JSON.stringify({ plans: [{ planId: "dbms-fixture", subjects: ["DBMS"] }] }) };
            }
            assert.equal(name, "record_study_session");
            recordedContinuationArgs = args;
            return { isError: false, content: JSON.stringify({
                planId: "dbms-fixture",
                session: { date: "2026-10-14", subject: "DBMS", hoursSpent: 2, missedHours: 0, scheduledHours: 2, status: "completed" },
                subjectProgress: { subject: "DBMS", completedHours: 2, missedHours: 0, remainingHours: 12, progressPercentage: "14%" },
                overallPlanProgress: "14%"
            }) };
        }
    },
    maxRounds: 2
});
const oneDayResult = await oneDayContinuationAgent.run({
    message: "Day 1 completed",
    messages: detailedClarificationHistory
});
assert.equal(recordedContinuationArgs?.planId, "dbms-fixture",
    "A specific answer to a pending session clarification resolves the saved plan before execution");
assert.equal(recordedContinuationArgs?.dayNumber, 1,
    "The selected plan-day detail survives clarification continuation");
assert.equal(oneDayResult.success, true, oneDayResult.reply);

let nextDayArgs = null;
const recentSessionHistory = [
    { role: "user", content: "day 1 completed 2hrs" },
    { role: "assistant", content: "Recorded 2h for DBMS (status: completed). Overall plan progress: 14%. Subject remaining hours: 12h." },
    { role: "user", content: "day 2 only 1 hr" },
    { role: "assistant", content: "I'm here to help with your studies! You can ask me to record a session." }
];
const nextDayAgent = new AdaptiveAgent({
    provider: { async chat() { throw new Error("A clear next-day session should not need model intent classification"); } },
    mcpClient: {
        listTools() { return [{ name: "list_study_plans", inputSchema: { type: "object", properties: {} } }, recordSessionTool]; },
        async callTool(name, args) {
            if (name === "list_study_plans") {
                return { isError: false, content: JSON.stringify({ plans: [{ planId: "dbms-next-day-fixture", subjects: ["DBMS"] }] }) };
            }
            assert.equal(name, "record_study_session");
            nextDayArgs = args;
            return { isError: false, content: JSON.stringify({
                planId: "dbms-next-day-fixture",
                session: { date: "2026-10-15", subject: "DBMS", hoursSpent: 1, missedHours: 0, scheduledHours: 1, status: "completed" },
                subjectProgress: { subject: "DBMS", completedHours: 3, missedHours: 0, remainingHours: 11, progressPercentage: "21%" },
                overallPlanProgress: "21%"
            }) };
        }
    },
    maxRounds: 2
});
const nextDayResult = await nextDayAgent.run({ message: "add day 2 1 hr", messages: recentSessionHistory });
assert.deepEqual({ planId: nextDayArgs?.planId, subject: nextDayArgs?.subject, hoursSpent: nextDayArgs?.hoursSpent, status: nextDayArgs?.status, dayNumber: nextDayArgs?.dayNumber }, {
    planId: "dbms-next-day-fixture", subject: "DBMS", hoursSpent: 1, status: "completed", dayNumber: 2
}, "A terse next-day follow-up resolves the prior subject and records only the supplied day and hours");
assert.equal(nextDayResult.success, true, nextDayResult.reply);

const sessionResult = {
    planId: "json-history-fixture",
    session: { date: "2026-10-15", subject: "DBMS", hoursSpent: 1, missedHours: 0, scheduledHours: 1, status: "completed" },
    subjectProgress: { subject: "DBMS", completedHours: 1, missedHours: 0, remainingHours: 13, progressPercentage: "7%" },
    overallPlanProgress: "7%"
};
const tool = {
    name: "record_study_session",
    inputSchema: {
        type: "object",
        properties: {
            planId: { type: "string" }, subject: { type: "string" }, hoursSpent: { type: "number" },
            status: { type: "string" }, date: { type: "string" }, missedHours: { type: "number" },
            scheduledHours: { type: "number" }, notes: { type: "string" }
        },
        required: ["subject", "hoursSpent", "status"]
    }
};
let calls = 0;
let historicalToolCall;
const agent = new AdaptiveAgent({
    provider: {
        async chat({ messages }) {
            calls++;
            if (calls === 1) {
                return { content: "", toolCalls: [{ id: "call-json-history", name: "record_study_session", arguments: { subject: "DBMS", hoursSpent: 1, status: "completed" } }] };
            }
            historicalToolCall = messages.find(message => message.role === "assistant" && message.tool_calls)?.tool_calls?.[0];
            const toolMessage = [...messages].reverse().find(message => message.role === "tool");
            return { content: formatGroundedSessionSummary(JSON.parse(toolMessage.content), { subject: "DBMS", hoursSpent: 1, status: "completed", planId: "json-history-fixture" }), toolCalls: [] };
        }
    },
    mcpClient: {
        listTools() { return [tool]; },
        async callTool(name, args) {
            assert.equal(name, "record_study_session");
            assert.equal(args.planId, "json-history-fixture");
            return { isError: false, content: JSON.stringify(sessionResult) };
        }
    },
    maxRounds: 2
});
const result = await agent.run({ message: "Record 1 hour of DBMS today", activePlanId: "json-history-fixture" });
assert.equal(result.success, true, result.reply);
assert.ok(historicalToolCall, "The executed tool call is preserved in conversation history");
assert.equal(historicalToolCall.id, "call-json-history");
assert.equal(historicalToolCall.type, "function");
assert.equal(typeof historicalToolCall.function.arguments, "string",
    "Provider history must encode tool arguments as JSON text, as Groq requires");
assert.deepEqual(JSON.parse(historicalToolCall.function.arguments), {
    subject: "DBMS", hoursSpent: 1, status: "completed"
});

console.log("✓ Multi-day claims request details without mutation; tool history is valid JSON for Groq");

// Regression: Shorthand day session recording (e.g. "add day 2 1 hr", "add day2 1hr", "day 2 only 1 hr")
let shorthandToolCalledWith = null;
const shorthandAgent = new AdaptiveAgent({
    provider: {
        async chat({ messages }) {
            return {
                content: "",
                toolCalls: [{
                    id: "call-shorthand",
                    name: "record_study_session",
                    arguments: { dayNumber: 2, hoursSpent: 1 }
                }]
            };
        }
    },
    mcpClient: {
        listTools() {
            return [
                {
                    name: "list_study_plans",
                    inputSchema: { type: "object", properties: {} }
                },
                tool
            ];
        },
        async callTool(name, args) {
            if (name === "list_study_plans") {
                return {
                    isError: false,
                    content: JSON.stringify({
                        plans: [{
                            planId: "dbms-d5c06cda",
                            subjects: ["DBMS"],
                            durationDays: 7,
                            dailyAvailableHours: 2
                        }]
                    })
                };
            }
            if (name === "record_study_session") {
                shorthandToolCalledWith = args;
                return {
                    isError: false,
                    content: JSON.stringify({
                        ...sessionResult,
                        planId: args.planId,
                        recordedSession: { subject: args.subject, hoursSpent: args.hoursSpent, status: args.status }
                    })
                };
            }
            throw new Error(`Unexpected tool: ${name}`);
        }
    },
    maxRounds: 2
});

const shorthandResult = await shorthandAgent.run({
    message: "add day 2 1 hr",
    messages: [
        { role: "user", content: "day 1 completed 2hrs" },
        { role: "assistant", content: "Recorded 2h for DBMS (status: completed). Overall plan progress: 14%." }
    ]
});
assert.equal(shorthandResult.success, true, shorthandResult.reply);
assert.equal(shorthandToolCalledWith?.planId, "dbms-d5c06cda", "Shorthand day entry must resolve planId from active plan or single saved plan");
assert.equal(shorthandToolCalledWith?.subject, "DBMS", "Shorthand day entry must bind subject from plan or recent session context");
assert.equal(shorthandToolCalledWith?.hoursSpent, 1, "Shorthand day entry must extract 1 hour");
assert.equal(shorthandToolCalledWith?.dayNumber, 2, "Shorthand day entry must extract day number 2");

const shorthandNoSpaceResult = await shorthandAgent.run({
    message: "add day2 1hr",
    messages: [
        { role: "user", content: "day 1 completed 2hrs" },
        { role: "assistant", content: "Recorded 2h for DBMS (status: completed). Overall plan progress: 14%." }
    ]
});
assert.equal(shorthandNoSpaceResult.success, true, shorthandNoSpaceResult.reply);
assert.equal(shorthandToolCalledWith?.dayNumber, 2, "Day number without space (day2) must be extracted correctly");

console.log("✓ Shorthand day session recording (add day 2 1 hr, add day2 1hr) verified successfully!");

