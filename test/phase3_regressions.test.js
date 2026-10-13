import assert from "node:assert/strict";
import {
    extractExplicitPlanId,
    normalizeToolArguments,
    shouldOmitSessionDate,
    isRetrievalIntent,
    isPlanListingIntent
} from "../src/agent/normalizer.js";
import { validateToolArguments, verifyToolResult } from "../src/agent/validator.js";
import { verifyFinalAnswerConsistency, formatGroundedRetrievalSummary } from "../src/agent/consistencyChecker.js";
import { AdaptiveAgent } from "../src/agent/adaptiveAgent.js";
import { McpClientManager } from "../src/mcp/mcpClient.js";
import { createPlan, recordSession, correctSessionRecord, getActiveSessionCount, adaptPlan } from "../studypilot-server/planner.js";

const adaptTool = {
    name: "adapt_study_plan",
    inputSchema: { type: "object", properties: {
        planId: { type: "string", description: "Unique plan ID; defaults to 'default'" },
        reason: { type: "string" }, newExamDate: { type: "string" }, newDailyAvailableHours: { type: "number" }
    } }
};
const getTool = {
    name: "get_study_plan",
    inputSchema: { type: "object", properties: {
        planId: { type: "string", description: "Unique plan ID; defaults to 'default'" }
    } }
};
const createTool = {
    name: "create_study_plan",
    inputSchema: { type: "object", properties: {
        planId: { type: "string", description: "Unique plan ID; defaults to 'default'" },
        subjects: { type: "array" }, examDate: { type: "string" }, durationDays: { type: "integer" },
        dailyAvailableHours: { type: "number" }
    }, required: ["subjects"] }
};
const recordTool = {
    name: "record_study_session",
    inputSchema: { type: "object", properties: {
        planId: { type: "string", description: "Unique plan ID; defaults to 'default'" },
        subject: { type: "string" }, hoursSpent: { type: "number" }, missedHours: { type: "number" },
        scheduledHours: { type: "number" }, status: { type: "string" }, date: { type: "string" }
    }, required: ["subject", "hoursSpent", "status"] }
};

// Explicit latest-turn identifiers must override conflicting model output and older results.
assert.equal(extractExplicitPlanId("Adapt study plan these because I have 1 hour per day"), null, "A generic reference must not become a plan ID");
assert.equal(extractExplicitPlanId("Retrieve study plan these"), null, "A generic reference must not become a plan ID");
assert.equal(extractExplicitPlanId("Retrieve plan ID: these"), "these", "Explicitly labeled IDs remain valid even when their value is an ordinary word");
assert.equal(isPlanListingIntent("give all my plans"), true);
assert.equal(isPlanListingIntent("give all plans that created"), true);
assert.equal(isPlanListingIntent("create a plan for 10 days"), false, "Plan creation must not be routed to catalog listing");
assert.equal(extractExplicitPlanId("Create a study plan for Mathematics"), null, "A plan subject is not a plan ID");
assert.equal(extractExplicitPlanId("Show me my study plan for mutation-test-oct12"), "mutation-test-oct12");
assert.equal(extractExplicitPlanId("Adapt study plan adaptive-demo"), "adaptive-demo");
const exactPlanIdRequest = "Show me the complete study plan with ID 2, including subject allocations, completed hours, remaining hours, and progress.";
assert.equal(isPlanListingIntent(exactPlanIdRequest), false, "A full-plan retrieval is not a catalog request");
assert.equal(extractExplicitPlanId(exactPlanIdRequest), "2", "The value after the plan ID label is the explicit ID");
assert.equal(extractExplicitPlanId("Retrieve the study plan with ID 2."), "2", "The value after 'plan with ID' is explicit");
assert.equal(normalizeToolArguments(getTool, { planId: "2" }, { message: "Show the plan with ID 2." }).planId, "2");
assert.equal(extractExplicitPlanId("Show me plan ID"), null, "An unfilled ID label is not an identifier");
assert.equal(extractExplicitPlanId("Show my study plan for ID"), null, "A descriptive ID label is not an identifier");
assert.equal(normalizeToolArguments(getTool, { planId: "adaptive-demo" }, { message: exactPlanIdRequest }).planId, "2", "Latest explicit numeric-looking ID wins over model output");
assert.equal(normalizeToolArguments(getTool, { planId: "2" }, { message: "Show the plan with plan ID adaptive-demo." }).planId, "adaptive-demo");
assert.equal(normalizeToolArguments(getTool, { planId: "adaptive-demo" }, { message: "Show my study plan for plan ID." }).planId, undefined, "Ambiguous placeholder text cannot preserve a model ID");
assert.equal(validateToolArguments(getTool, { planId: "ID" }, { userMessage: "Show me plan ID" }).valid, false, "Placeholder IDs are rejected at validation");
const ambiguousPlanArgs = normalizeToolArguments(getTool, { planId: "ID" }, { message: "Show me plan ID" });
assert.equal(validateToolArguments(getTool, ambiguousPlanArgs, { userMessage: "Show me plan ID" }).valid, false, "An unfilled ID label cannot fall through to a default plan");
assert.equal(validateToolArguments(createTool, { subjects: ["Physics"] }, { userMessage: "Create a plan with plan ID" }).valid, false, "An unfilled explicit ID label cannot create or overwrite the default plan");
assert.equal(validateToolArguments(getTool, { planId: "default" }, { userMessage: "Show the study plan with ID 2" }).valid, false, "A conflicting model default cannot override an explicit ID");
assert.equal(extractExplicitPlanId('Use planId "may" and verify the exam date December 15, 2026'), "may", "Date filtering must not erase a valid explicit identifier");
assert.equal(extractExplicitPlanId("Retrieve study plan December 15, 2026"), null);
assert.equal(extractExplicitPlanId("What is my exam date?"), null);
assert.equal(extractExplicitPlanId("Retrieve the exam date for December 15, 2026"), null);
const staleContext = [{ role: "tool", content: JSON.stringify({ planId: "adaptive-demo" }) }];
assert.equal(extractExplicitPlanId("Adapt study plan current-plan", staleContext), "current-plan");
assert.equal(extractExplicitPlanId("", [{ role: "assistant", content: 'Study plan "stale-plan" created successfully' }]), null);
assert.equal(extractExplicitPlanId("Adapt my plan", [
    { role: "tool", content: JSON.stringify({ planId: "stale-plan" }) },
    { role: "assistant", content: "Plan retrieved." },
    { role: "user", content: "Tell me a joke." }
]), null, "Tool IDs from before an unrelated user turn are stale context");
assert.equal(extractExplicitPlanId("Show my plan", [
    { role: "user", content: "Record a session against plan with ID 2" },
    { role: "tool", content: JSON.stringify({ planId: "2", session: { subject: "JavaScript" } }) },
    { role: "user", content: "Show my plan" }
]), "2", "A verified plan ID returned by a prior tool call remains available in the next user turn");

for (const name of ["adapt_study_plan", "get_study_plan", "record_study_session"]) {
    const schema = name === "adapt_study_plan" ? adaptTool : name === "get_study_plan" ? getTool : recordTool;
    const args = normalizeToolArguments(schema, { planId: "adaptive-demo" }, {
        message: name === "get_study_plan" ? "Retrieve study plan these-plan" : "Adapt study plan these-plan because I have 1 hour per day"
    });
    assert.equal(args.planId, "these-plan", `${name} must pass the latest explicit ID`);
}
assert.equal(normalizeToolArguments(adaptTool, { planId: "adaptive-demo" }, { message: "Adapt study plan adaptive-demo" }).planId, "adaptive-demo");
{
    let providerCalls = 0;
    const toolCalls = [];
    const plans = Array.from({ length: 182 }, (_, index) => ({
        planId: `subject-${index + 1}`,
        subjects: [`Subject ${index + 1}`],
        examDate: null,
        durationDays: 10,
        dailyAvailableHours: 2,
        overallProgress: "0%",
        totalRemainingHours: 20
    }));
    const agent = new AdaptiveAgent({
        provider: { async chat() { providerCalls++; throw new Error("Plan listing should not call the model"); } },
        mcpClient: {
            listTools: () => [
                { name: "list_study_plans", inputSchema: { type: "object", properties: {} } },
                createTool
            ],
            async callTool(name) {
                toolCalls.push(name);
                return { isError: false, content: JSON.stringify({ plans, count: plans.length }) };
            }
        }
    });
    for (const message of ["give all my plans", "give all plans that created"]) {
        const result = await agent.run({ message });
        assert.equal(result.success, true, `${message} should return the verified catalog`);
        assert.match(result.reply, /182 saved study plans/);
        assert.match(result.reply, /subject-182/);
    }
    assert.equal(providerCalls, 0, "Large plan catalogs must not be sent back through an LLM round");
    assert.deepEqual(toolCalls, ["list_study_plans", "list_study_plans"], "Listing must never trigger create_study_plan");
}
{
    let calledArgs;
    const agent = new AdaptiveAgent({
        provider: { calls: 0, async chat() {
            this.calls++;
            return this.calls === 1
                ? { toolCalls: [{ name: "get_study_plan", arguments: { planId: "2" } }], content: "" }
                : { toolCalls: [], content: "The complete plan has 14 remaining hours." };
        } },
        mcpClient: {
            listTools: () => [getTool],
            async callTool(_name, args) {
                calledArgs = args;
                return { isError: false, content: JSON.stringify({ planId: "2", subjects: { Physics: { allocatedHours: 14, completedHours: 0, remainingHours: 14, progressPercentage: 0 } }, totalAllocatedHours: 14, totalCompletedHours: 0, totalRemainingHours: 14 }) };
            }
        }
    });
    const result = await agent.run({ message: exactPlanIdRequest });
    assert.equal(calledArgs.planId, "2", "MCP execution must receive the exact numeric-looking user ID");
    const requestedTrace = result.steps.find(step => step.type === "tool_calls_requested");
    const executingTrace = result.steps.find(step => step.type === "tool_executing");
    assert.equal(requestedTrace?.toolCalls[0].arguments.planId, "2");
    assert.equal(executingTrace?.arguments.planId, "2", "The user ID must survive to tool execution unchanged");
    assert.equal(result.success, true);
}
{
    const wrongPlanAgent = new AdaptiveAgent({
        provider: { calls: 0, async chat() {
            this.calls++;
            return this.calls === 1
                ? { toolCalls: [{ name: "get_study_plan", arguments: { planId: "2" } }], content: "" }
                : { toolCalls: [], content: "JavaScript has 147 hours remaining." };
        } },
        mcpClient: {
            listTools: () => [getTool],
            async callTool() {
                return { isError: false, content: JSON.stringify({ planId: "default", subjects: { Mathematics: { remainingHours: 147 } } }) };
            }
        }
    });
    const result = await wrongPlanAgent.run({ message: "Show me study plan with ID 2." });
    assert.equal(result.success, false, "A mismatched plan result must not be reported as success");
    assert.match(result.reply, /Action Failed/i);
    assert.doesNotMatch(result.reply, /JavaScript has 147/i);
}
for (const name of ["get_study_plan", "adapt_study_plan"]) {
    let calledArgs;
    const toolDef = name === "get_study_plan" ? getTool : adaptTool;
    const agent = new AdaptiveAgent({
        provider: { count: 0, async chat() {
            this.count++;
            return this.count === 1
                ? { toolCalls: [{ name, arguments: { planId: "adaptive-demo", newDailyAvailableHours: 1 } }], content: "" }
                : { toolCalls: [], content: name === "get_study_plan" ? "Plan retrieved." : "Plan adapted at 1 hour daily." };
        } },
        mcpClient: {
            listTools: () => [toolDef],
            async callTool(_name, args) {
                calledArgs = args;
                const payload = name === "get_study_plan"
                    ? { planId: "these-plan", subjects: {}, totalRemainingHours: 0, totalSessionsRecorded: 0 }
                    : { planId: "these-plan", daysRemaining: 7, recommendedDailyHours: 1, reason: "User reduced availability", adjustedSubjectAllocations: { JavaScript: { allocatedHours: 7, completedHours: 0, remainingHours: 7, progress: "0%" } } };
                return { isError: false, content: JSON.stringify(payload) };
            }
        }
    });
    const result = await agent.run({ message: name === "get_study_plan" ? "Retrieve study plan these-plan" : "Adapt study plan these-plan to 1 hour per day" });
    assert.equal(calledArgs.planId, "these-plan", `${name} call must use the latest explicit plan ID`);
    assert.equal(result.success, true);
}
const unresolved = normalizeToolArguments(adaptTool, { planId: "invented-plan" }, { message: "Adapt my study plan" });
assert.equal(Object.hasOwn(unresolved, "planId"), false);
assert.match(validateToolArguments(adaptTool, unresolved, { userMessage: "Adapt my study plan" }).error, /choose by subject or description/i);
const sanitizer = new McpClientManager();
assert.equal(sanitizer.sanitizeArguments({ planId: "unknown-explicit-plan" }, getTool.inputSchema, { toolName: "get_study_plan" }).planId, "unknown-explicit-plan");
assert.equal(sanitizer.sanitizeArguments({ planId: "unknown-explicit-plan" }, getTool.inputSchema, { toolName: "get_study_plan", trustedPlanId: true }).planId, "unknown-explicit-plan");
{
    const outgoing = [];
    sanitizer.connected = true;
    sanitizer.tools = [getTool];
    sanitizer.client = { async callTool(request) {
        outgoing.push(request.arguments);
        return { isError: false, content: [{ type: "text", text: JSON.stringify({ planId: "2", subjects: { JavaScript: {} } }) }] };
    } };
    const call = await sanitizer.callTool("get_study_plan", { planId: "2" }, { trustedPlanId: true });
    assert.equal(call.isError, false);
    assert.deepEqual(outgoing[0], { planId: "2" }, "MCP client must forward plan ID unchanged");
}
assert.equal(shouldOmitSessionDate("2024-12-31", "Record a 1-hour JavaScript session", [
    { role: "user", content: "My exam is 2024-12-31" }
]), true);
const exactMissedRequest = "For study plan ID 2, record a missed 1-hour JavaScript study session for October 14, 2026.";
const exactMissedNormalized = normalizeToolArguments(recordTool, {
    planId: "2", subject: "JavaScript", hoursSpent: 1, missedHours: 2, scheduledHours: 2,
    date: "2026-10-13", status: "missed"
}, { message: exactMissedRequest });
assert.deepEqual({
    planId: exactMissedNormalized.planId,
    subject: exactMissedNormalized.subject,
    hoursSpent: exactMissedNormalized.hoursSpent,
    missedHours: exactMissedNormalized.missedHours,
    scheduledHours: exactMissedNormalized.scheduledHours,
    date: exactMissedNormalized.date,
    status: exactMissedNormalized.status
}, {
    planId: "2", subject: "JavaScript", hoursSpent: 0, missedHours: 1,
    scheduledHours: 1, date: "2026-10-14", status: "missed"
});
assert.equal(validateToolArguments(recordTool, exactMissedNormalized, { userMessage: exactMissedRequest }).valid, true);
assert.equal(validateToolArguments(recordTool, { ...exactMissedNormalized, date: "2026-10-13" }, { userMessage: exactMissedRequest }).valid, false,
    "Validation must reject a session date that differs from the user's explicit natural-language date");
assert.equal(validateToolArguments(recordTool, { ...exactMissedNormalized, missedHours: 2 }, { userMessage: exactMissedRequest }).valid, false,
    "Validation must reject a missed amount that differs from the user's stated duration");
assert.equal(isRetrievalIntent("Create a study plan for JavaScript"), false);

// Goal plans have no exam date, use their duration as capacity, and use bounded recommendations.
const ref = new Date("2026-10-01T12:00:00.000Z");
const sevenDay = createPlan({
    planId: "js-7-day", subjects: ["JavaScript"], durationDays: 7,
    dailyAvailableHours: 2, referenceDate: ref
});
assert.equal(sevenDay.examDate, null);
assert.equal(sevenDay.durationDays, 7);
assert.equal(sevenDay.dailyAvailableHours, 2);
assert.equal(sevenDay.totalAvailableHours, 14);
assert.equal(sevenDay.totalAllocatedHours, 14);
assert.equal(sevenDay.totalRemainingHours, 14);
assert.equal(sevenDay.overallProgressPercentage, 0, "A new plan with remaining hours begins at 0% progress");
assert.equal(sevenDay.dailyHoursSource, "user");
assert.equal(sevenDay.durationSource, "user");

const thirtyDay = createPlan({ planId: "react-30-day", subjects: ["React"], durationDays: 30, referenceDate: ref });
assert.equal(thirtyDay.examDate, null);
assert.equal(thirtyDay.durationDays, 30);
assert.equal(thirtyDay.dailyHoursSource, "recommended");
assert.equal(thirtyDay.durationSource, "user");
assert.ok(thirtyDay.dailyAvailableHours >= 0.5 && thirtyDay.dailyAvailableHours <= 12);
assert.equal(thirtyDay.totalAvailableHours, thirtyDay.dailyAvailableHours * 30);

const datedPlan = createPlan({
    planId: "exam-plan", subjects: ["Biology"], examDate: "2026-11-15",
    dailyAvailableHours: 2, referenceDate: ref
});
assert.equal(datedPlan.examDate, "2026-11-15");
assert.throws(() => createPlan({ subjects: ["Biology"], examDate: "2026-09-30", referenceDate: ref }), /past/i);
assert.throws(() => createPlan({ subjects: ["Biology"], examDate: "2026-02-30", referenceDate: ref }), /invalid exam date/i);
const distinctMissedPlan = createPlan({ planId: "missed-semantics", subjects: ["JavaScript"], durationDays: 7, dailyAvailableHours: 2, referenceDate: ref });
const distinctMissed = recordSession(distinctMissedPlan, {
    subject: "JavaScript", hoursSpent: 0, missedHours: 1, scheduledHours: 2,
    status: "missed", date: "2026-10-14"
});
assert.equal(distinctMissed.session.hoursSpent, 0);
assert.equal(distinctMissed.session.missedHours, 1);
assert.equal(distinctMissed.session.scheduledHours, 2);
assert.equal(distinctMissed.session.date, "2026-10-14");
assert.equal(distinctMissedPlan.totalMissedHours, 1);
assert.throws(() => recordSession(distinctMissedPlan, {
    subject: "JavaScript", hoursSpent: 1, missedHours: 1, scheduledHours: 2, status: "missed"
}), /hoursSpent must be 0/i);

const correctionPlan = createPlan({ planId: "correction-fixture", subjects: ["JavaScript"], durationDays: 7, dailyAvailableHours: 2, referenceDate: ref });
recordSession(correctionPlan, { subject: "JavaScript", hoursSpent: 2, status: "completed", date: "2026-10-13" });
const originalMissed = recordSession(correctionPlan, {
    subject: "JavaScript", hoursSpent: 0, missedHours: 2, scheduledHours: 2, status: "missed", date: "2026-10-13"
}).session;
const correctionInput = {
    sessionId: originalMissed.id,
    expectedOriginal: { date: "2026-10-13", subject: "JavaScript", hoursSpent: 0, missedHours: 2, scheduledHours: 2, status: "missed" },
    correctionId: "correction_sess_1791902494724_xqvh",
    correctedAt: "2026-10-13T15:00:00.000Z",
    correctedSession: { date: "2026-10-14", subject: "JavaScript", hoursSpent: 0, missedHours: 1, scheduledHours: 1, status: "missed" }
};
const correctedSessionResult = correctSessionRecord(correctionPlan, correctionInput);
assert.equal(correctedSessionResult.alreadyApplied, false);
assert.equal(correctionPlan.sessions.length, 3, "Correction retains the original and adds one corrected record");
assert.equal(getActiveSessionCount(correctionPlan), 2, "Superseded history remains stored but is excluded from active session count");
assert.equal(correctedSessionResult.original.date, "2026-10-13");
assert.equal(correctedSessionResult.original.missedHours, 2);
assert.equal(correctedSessionResult.original.correction.originalValues.missedHours, 2, "Audit snapshot preserves the original value");
assert.equal(correctedSessionResult.original.supersededBy, correctedSessionResult.session.id);
assert.equal(correctedSessionResult.session.date, "2026-10-14");
assert.equal(correctedSessionResult.session.hoursSpent, 0);
assert.equal(correctedSessionResult.session.missedHours, 1);
assert.equal(correctedSessionResult.session.scheduledHours, 1);
assert.equal(correctionPlan.subjects.JavaScript.completedHours, 2);
assert.equal(correctionPlan.subjects.JavaScript.missedHours, 1);
assert.equal(correctionPlan.totalCompletedHours, 2);
assert.equal(correctionPlan.totalMissedHours, 1);
assert.equal(correctionPlan.overallProgressPercentage, 14);
const repeatedCorrection = correctSessionRecord(correctionPlan, correctionInput);
assert.equal(repeatedCorrection.alreadyApplied, true);
assert.equal(correctionPlan.sessions.length, 3, "Repeated correction must not duplicate a session");

const explicitCreate = normalizeToolArguments(createTool, {
    subjects: ["JavaScript"], examDate: "2024-12-31", dailyAvailableHours: 9, durationDays: 30
}, { message: "Create a 7-day JavaScript study plan with 2 hours per day." });
assert.equal(explicitCreate.examDate, undefined, "An unmentioned stale model date must be omitted");
assert.equal(explicitCreate.durationDays, 7, "Explicit duration must override model duration");
assert.equal(explicitCreate.dailyAvailableHours, 2, "Explicit daily hours must override model suggestion");
const explicitExam = normalizeToolArguments(createTool, {
    subjects: ["Biology"], examDate: "2027-01-01"
}, { message: "Create exam preparation for Biology by November 15, 2026." });
assert.equal(explicitExam.examDate, "2026-11-15");
const explicitPastDate = normalizeToolArguments(createTool, {
    subjects: ["Biology"], examDate: "2027-01-01"
}, { message: "Create exam preparation for Biology with exam date 2024-12-31." });
assert.equal(explicitPastDate.examDate, "2024-12-31");
assert.equal(validateToolArguments(createTool, explicitPastDate, { userMessage: "Create exam preparation for Biology" }).valid, false);
assert.equal(validateToolArguments(createTool, { subjects: ["Biology"] }, { userMessage: "Create an exam preparation plan for Biology" }).valid, false);
assert.equal(validateToolArguments(createTool, { subjects: ["React"], durationDays: 30 }, { userMessage: "Create a 30-day React learning plan" }).valid, true);
assert.equal(validateToolArguments(createTool, { subjects: ["React"], dailyAvailableHours: 13 }).valid, false);
for (const statedHours of [0, -2]) {
    const invalidHours = normalizeToolArguments(createTool, {
        subjects: ["JavaScript"], dailyAvailableHours: 3
    }, { message: `Create a JavaScript plan with ${statedHours} hours per day.` });
    assert.equal(invalidHours.dailyAvailableHours, statedHours, "Invalid explicit hours must reach validation rather than silently trigger a recommendation");
    assert.equal(validateToolArguments(createTool, invalidHours).valid, false);
}

// Adaptation changes only supplied fields and preserves sessions, subjects, and exam date.
const preservePlan = createPlan({
    planId: "these-plan", subjects: ["JavaScript", "React"], examDate: "2026-11-15",
    dailyAvailableHours: 2, referenceDate: ref
});
recordSession(preservePlan, { subject: "JavaScript", hoursSpent: 1, status: "completed", date: "2026-10-02" });
const beforeSubjects = Object.keys(preservePlan.subjects);
const beforeSession = preservePlan.sessions[0];
adaptPlan(preservePlan, { newDailyAvailableHours: 1, reason: "Reduced daily availability", referenceDate: ref });
assert.equal(preservePlan.planId, "these-plan");
assert.equal(preservePlan.examDate, "2026-11-15");
assert.equal(preservePlan.dailyAvailableHours, 1);
assert.deepEqual(Object.keys(preservePlan.subjects), beforeSubjects);
assert.deepEqual(preservePlan.sessions[0], beforeSession);
adaptPlan(preservePlan, { newExamDate: "2026-12-01", reason: "Explicit deadline change", referenceDate: ref });
assert.equal(preservePlan.examDate, "2026-12-01");

const historicalSessionArgs = normalizeToolArguments(recordTool, {
    subject: "JavaScript", hoursSpent: 1, status: "completed", date: "2024-12-31", planId: "default"
}, { message: "Record a 1-hour JavaScript study session", messages: [{ role: "user", content: "My exam is 2024-12-31" }] });
assert.equal(Object.hasOwn(historicalSessionArgs, "date"), false);

// The consistency checker accepts successful creation without a follow-up retrieval,
// permits requested extra fields, and corrects only a contradictory date.
const createResult = {
    toolName: "create_study_plan", toolArgs: { subjects: ["React"] }, isError: false,
    parsedData: { planId: "react-30-day", examDate: null, durationDays: 30, dailyStudyHours: 1.5, totalAllocatedHours: 45, subjectAllocations: { React: { allocatedHours: 45 } } }
};
assert.equal(isRetrievalIntent("Create a 30-day React study plan"), false);
assert.equal(verifyFinalAnswerConsistency("Study plan created for React, with 30 days and 45 allocated hours.", [createResult], "Create a 30-day React study plan").valid, true);
const newPlanProgressResult = {
    toolName: "create_study_plan", toolArgs: { subjects: ["JavaScript"] }, isError: false,
    parsedData: {
        planId: "new-plan", examDate: null, durationDays: 7, dailyStudyHours: 2,
        totalAllocatedHours: 14, totalCompletedHours: 0, totalRemainingHours: 14,
        overallProgressPercentage: 0,
        subjectAllocations: { JavaScript: { allocatedHours: 14, completedHours: 0, remainingHours: 14, progressPercentage: 0 } }
    }
};
const falseCreationProgress = verifyFinalAnswerConsistency(
    "Your new study plan is 100% complete with 14 hours remaining.",
    [newPlanProgressResult],
    "Create a 7-day JavaScript study plan"
);
assert.equal(falseCreationProgress.valid, false, "A false 100% completion claim must fail grounding");
assert.match(falseCreationProgress.correctedReply, /Overall Progress:\*\* 0%/);
assert.doesNotMatch(falseCreationProgress.correctedReply, /100%/);

const retrievalData = {
    planId: "default", examDate: "2026-11-15", daysRemaining: 45, durationDays: 45,
    dailyStudyHours: 2, overallProgress: "0%", totalCompletedHours: 0,
    totalMissedHours: 0, totalRemainingHours: 90, totalAllocatedHours: 90,
    totalSessionsRecorded: 0, subjects: { Biology: { priority: "medium", allocatedHours: 90, completedHours: 0, remainingHours: 90, missedHours: 0, progressPercentage: 0 } },
    recentSessions: []
};
const retrievalResult = { toolName: "get_study_plan", toolArgs: { planId: "default" }, isError: false, parsedData: retrievalData };
assert.equal(verifyToolResult("get_study_plan", { planId: "2" }, {
    isError: false, content: JSON.stringify({ planId: "default", subjects: { Mathematics: {} } })
}).valid, false, "A result from the default plan cannot satisfy a request for plan 2");
assert.equal(verifyToolResult("get_study_plan", { planId: "2" }, {
    isError: false, content: JSON.stringify({ subjects: { JavaScript: {} } })
}).valid, false, "A malformed retrieval response missing its plan ID cannot pass verification");
assert.equal(verifyToolResult("record_study_session", { planId: "2", subject: "JavaScript", status: "completed" }, {
    isError: false,
    content: JSON.stringify({ planId: "default", session: { subject: "JavaScript", status: "completed" }, subjectProgress: { subject: "JavaScript" } })
}).valid, false, "A session result from another plan cannot be reported as success");
const requestedMissedSession = {
    planId: "2", subject: "JavaScript", hoursSpent: 0, missedHours: 1,
    scheduledHours: 1, date: "2026-10-14", status: "missed"
};
const recordedMissedSession = {
    planId: "2", session: { ...requestedMissedSession },
    subjectProgress: { subject: "JavaScript", completedHours: 0, missedHours: 1, remainingHours: 14 },
    overallPlanProgress: "0%"
};
assert.equal(verifyToolResult("record_study_session", requestedMissedSession, {
    isError: false, content: JSON.stringify({ ...recordedMissedSession, session: { ...recordedMissedSession.session, date: "2026-10-13" } })
}).valid, false, "A successful MCP response cannot hide a recorded session date mismatch");
assert.equal(verifyToolResult("record_study_session", requestedMissedSession, {
    isError: false, content: JSON.stringify({ ...recordedMissedSession, session: { ...recordedMissedSession.session, missedHours: 2, scheduledHours: 2 } })
}).valid, false, "A successful MCP response cannot hide a recorded missed-hours or schedule mismatch");
assert.equal(verifyToolResult("record_study_session", requestedMissedSession, {
    isError: false, content: JSON.stringify({ ...recordedMissedSession, session: { ...recordedMissedSession.session, hoursSpent: 1 } })
}).valid, false, "A successful MCP response cannot hide actual hours spent that contradict the request");
const misleadingSuccessAgent = new AdaptiveAgent({
    provider: {
        calls: 0,
        async chat() {
            this.calls++;
            return this.calls === 1
                ? { toolCalls: [{ name: "record_study_session", arguments: { ...requestedMissedSession, date: "2026-10-13", missedHours: 2, scheduledHours: 2 } }], content: "" }
                : { toolCalls: [], content: "The October 14 missed session was recorded successfully." };
        }
    },
    mcpClient: {
        listTools: () => [recordTool],
        async callTool() {
            return {
                isError: false,
                content: JSON.stringify({
                    ...recordedMissedSession,
                    session: { ...recordedMissedSession.session, date: "2026-10-13", missedHours: 2, scheduledHours: 2 }
                })
            };
        }
    },
    maxRounds: 2
});
const misleadingSuccess = await misleadingSuccessAgent.run({ message: exactMissedRequest });
assert.equal(misleadingSuccess.success, false, "Agent must fail when an MCP success response records the wrong date or missed duration");
assert.match(misleadingSuccess.reply, /Action Failed/i);
assert.doesNotMatch(misleadingSuccess.reply, /recorded successfully/i);
const detailedRequest = "Get the exam date, Biology subject, daily hours, and allocated hours.";
const detailedReply = "The exam date is November 15, 2026. Biology has 90 allocated hours, and the daily study time is 2 hours.";
assert.equal(verifyFinalAnswerConsistency(detailedReply, [retrievalResult], detailedRequest).valid, true);
const omittedDateRequest = "How is my study plan progress?";
assert.equal(verifyFinalAnswerConsistency("Your study plan is at 0% progress. You have completed 0 of 90 allocated hours, with 90 hours remaining. No study sessions have been recorded yet.", [retrievalResult], omittedDateRequest).valid, true);
const proposedDateRequest = "My exam is on December 15, 2026, right?";
const correction = verifyFinalAnswerConsistency("Your exam is December 30, 2026.", [retrievalResult], proposedDateRequest);
assert.equal(correction.valid, false);
assert.equal(correction.correctedReply, "Not quite—your study plan lists November 15, 2026, not December 15, 2026.");
const noDateData = { ...retrievalData, examDate: null, durationDays: 30 };
const noDateReply = formatGroundedRetrievalSummary(noDateData, "What is my exam date?");
assert.match(noDateReply, /goal-based plan with no exam date/i);

// An exam-date request for a goal-based plan must not infer an exam date from
// goalEndDate or retain unsupported model dates in the grounding trace.
const goalPlanWithoutExamDate = {
    planId: "2", examDate: null, planningMode: "goal", durationDays: 7,
    goalEndDate: "2026-10-20", daysRemaining: 7, dailyStudyHours: 2,
    totalAllocatedHours: 14, totalCompletedHours: 0, totalRemainingHours: 14,
    overallProgressPercentage: 0, totalSessionsRecorded: 0,
    subjects: { JavaScript: { allocatedHours: 14, completedHours: 0, remainingHours: 14, missedHours: 0, progressPercentage: 0 } },
    sessions: []
};
const unsupportedDateReply = "Your exam date is October 20, 2026, and the verified date is October 27, 2026.";
const noExamDateAgent = new AdaptiveAgent({
    provider: {
        calls: 0,
        async chat() {
            this.calls++;
            return this.calls === 1
                ? { toolCalls: [{ name: "get_study_plan", arguments: { planId: "2" } }], content: "" }
                : { toolCalls: [], content: unsupportedDateReply };
        }
    },
    mcpClient: {
        listTools: () => [getTool],
        async callTool() { return { isError: false, content: JSON.stringify(goalPlanWithoutExamDate) }; }
    },
    maxRounds: 2
});
const noExamDateResult = await noExamDateAgent.run({ message: "What is my exam date for plan ID 2?" });
assert.equal(noExamDateResult.success, true);
assert.equal(noExamDateResult.steps.find(step => step.type === "tool_executing")?.arguments?.planId, "2");
const noExamDateGrounding = noExamDateResult.steps.find(step => step.type === "final_answer_grounded");
assert.ok(noExamDateGrounding, "Unsupported generated dates must trigger grounding");
assert.match(noExamDateGrounding.correctedReply, /no exam date.*duration is 7 days/i);
assert.doesNotMatch(noExamDateGrounding.correctedReply, /October\s+(?:20|27),\s+2026/i);
assert.match(noExamDateGrounding.originalReply, /unsupported exam-date claim/i);
assert.doesNotMatch(noExamDateGrounding.originalReply, /October\s+(?:20|27),\s+2026/i,
    "Grounding events must not expose unsupported model-generated dates as reply claims");
assert.match(noExamDateResult.reply, /no exam date.*duration is 7 days/i);
assert.doesNotMatch(noExamDateResult.reply, /October\s+(?:20|27),\s+2026/i);

// Duplicate session tool calls in one agent turn execute once; failures cannot be
// overwritten by a model claim that the mutation succeeded.
const sessionOutcome = {
    planId: "these-plan",
    session: { id: "session-one", subject: "JavaScript", hoursSpent: 1, status: "completed", date: "2026-10-13" },
    subjectProgress: { subject: "JavaScript", completedHours: 1, remainingHours: 9, missedHours: 0, progressPercentage: "10%" },
    overallPlanProgress: "10%"
};
const sessionTool = { name: "record_study_session", inputSchema: recordTool.inputSchema };
let sessionCalls = 0;
const duplicateAgent = new AdaptiveAgent({
    provider: { count: 0, async chat() {
        this.count++;
        return this.count === 1
            ? { toolCalls: [
                { name: "record_study_session", arguments: { subject: "JavaScript", hoursSpent: 1, status: "completed", planId: "these-plan" } },
                { name: "record_study_session", arguments: { subject: "JavaScript", hoursSpent: 1, status: "completed", planId: "these-plan" } }
            ], content: "" }
            : { toolCalls: [], content: "Recorded the 1-hour JavaScript study session. It is at 10% progress." };
    } },
    mcpClient: {
        listTools: () => [sessionTool],
        async callTool() { sessionCalls++; return { isError: false, content: JSON.stringify(sessionOutcome) }; }
    }
});
const duplicateResult = await duplicateAgent.run({ message: "Record a 1-hour JavaScript study session for plan these-plan." });
assert.equal(sessionCalls, 1);
assert.equal(duplicateResult.success, true);

const failedAgent = new AdaptiveAgent({
    provider: { count: 0, async chat() {
        this.count++;
        return this.count === 1
            ? { toolCalls: [{ name: "record_study_session", arguments: { subject: "JavaScript", hoursSpent: 1, status: "completed", planId: "these-plan" } }], content: "" }
            : { toolCalls: [], content: "The session was recorded successfully." };
    } },
    mcpClient: {
        listTools: () => [sessionTool],
        async callTool() { return { isError: true, content: "No study plan found with ID these-plan" }; }
    }
});
const failedResult = await failedAgent.run({ message: "Record a 1-hour JavaScript study session for plan these-plan." });
assert.equal(failedResult.success, false);
assert.match(failedResult.reply, /Action Failed/i);
assert.doesNotMatch(failedResult.reply, /recorded successfully/i);

console.log("✓ Phase 3 regressions passed (plan IDs, optional dates, duration/capacity, adaptation, consistency, sessions).");
