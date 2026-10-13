import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdaptiveAgent } from "../src/agent/adaptiveAgent.js";
import { McpClientManager } from "../src/mcp/mcpClient.js";
import {
    formatGroundedAdaptationSummary,
    formatGroundedPlanSummary,
    formatGroundedRetrievalSummary,
    formatGroundedSessionSummary
} from "../src/agent/consistencyChecker.js";
import { isAdaptationIntent, isRetrievalIntent } from "../src/agent/normalizer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studypilot-agent-eval-"));
const serverPath = path.join(root, "studypilot-server", "server.js");
const mcp = new McpClientManager({
    command: process.execPath,
    args: [serverPath],
    env: { MCP_TRANSPORT: "stdio", STUDYPILOT_DATA_DIR: isolatedDataDir },
    toolTimeoutMs: 10_000
});

function parsedToolResult(agentResult, expectedTool) {
    const executing = agentResult.steps.find(step => step.type === "tool_executing");
    assert.ok(executing, `Expected ${expectedTool} to execute`);
    assert.equal(executing.tool, expectedTool);
    const result = agentResult.steps.find(step => step.type === "tool_result" && step.tool === expectedTool);
    assert.ok(result, `Expected a result for ${expectedTool}`);
    return { executing, result: result.isError ? null : JSON.parse(result.content) };
}

function makeAgent(toolName, arguments_, finalResponse) {
    const provider = {
        calls: 0,
        async chat({ messages }) {
            this.calls++;
            if (this.calls === 1) {
                return { toolCalls: [{ name: toolName, arguments: arguments_ }], content: "" };
            }
            const lastToolMessage = [...messages].reverse().find(message => message.role === "tool");
            let data = null;
            try { data = JSON.parse(lastToolMessage?.content || "null"); } catch { }
            return { toolCalls: [], content: finalResponse(data) };
        }
    };
    return new AdaptiveAgent({ provider, mcpClient: mcp, maxRounds: 2 });
}

function localDateAfter(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

try {
    const connected = await mcp.connect();
    assert.equal(connected.connected, true, `MCP Stdio connection failed: ${connected.error || mcp.lastError}`);

    // Prompt variations are routed to the expected retrieval/adaptation intent.
    const retrievalPrompts = [
        "Show me the study plan with ID 2.",
        "Retrieve the study plan with ID 2.",
        "Report on the study plan with ID 2."
    ];
    for (const prompt of retrievalPrompts) assert.equal(isRetrievalIntent(prompt), true, prompt);
    for (const prompt of ["Adapt plan 2", "Adjust plan 2", "Rebalance plan 2"]) {
        assert.equal(isAdaptationIntent(prompt), true, prompt);
    }

    // Create a dated plan using an explicit numeric-looking string ID. A conflicting
    // model default must not displace the user's plan ID.
    const examDate = localDateAfter(60);
    const createMessage = `Create an exam-preparation study plan for JavaScript with plan ID 2, exam date ${examDate}, and 2 hours daily.`;
    const createAgent = makeAgent("create_study_plan", {
        planId: "default", subjects: ["JavaScript"], examDate, dailyAvailableHours: 2
    }, data => formatGroundedPlanSummary(data));
    const createResult = await createAgent.run({ message: createMessage });
    assert.equal(createResult.success, true, createResult.reply);
    const created = parsedToolResult(createResult, "create_study_plan");
    assert.equal(created.executing.arguments.planId, "2");
    assert.equal(created.result.planId, "2");
    assert.equal(created.result.overallProgressPercentage, 0);

    // A terse answer to a creation clarification keeps the original intent and
    // parameters. A model-proposed retrieval tool and "3hrs" ID are corrected.
    const clarifiedHistory = [
        { role: "assistant", content: "Your previous study plan was created successfully. Plan ID: default." },
        { role: "user", content: "Create a plan for a week for one subject." },
        { role: "assistant", content: "Which subject would you like, and how many hours per day?" },
        { role: "user", content: "DBMS" },
        { role: "assistant", content: "Could you provide the plan ID you would like to use?" }
    ];
    let clarificationCall = 0;
    const clarifiedAgent = new AdaptiveAgent({
        provider: {
            async chat({ messages }) {
                clarificationCall++;
                if (clarificationCall === 1) return { toolCalls: [{
                    name: "get_study_plan",
                    arguments: { planId: "3hrs", subjects: ["DBMS"], dailyAvailableHours: 5, durationDays: 30 }
                }], content: "" };
                const resultMessage = [...messages].reverse().find(item => item.role === "tool");
                return { toolCalls: [], content: formatGroundedPlanSummary(JSON.parse(resultMessage.content)) };
            }
        },
        mcpClient: mcp,
        maxRounds: 2
    });
    const clarifiedResult = await clarifiedAgent.run({ message: "generate by own", messages: clarifiedHistory });
    assert.equal(clarifiedResult.success, true, clarifiedResult.reply);
    assert.ok(clarifiedResult.steps.some(step => step.type === "intent_tool_redirection" && step.redirectedTool === "create_study_plan"));
    const clarifiedExecution = clarifiedResult.steps.find(step => step.type === "tool_executing");
    assert.equal(clarifiedExecution.tool, "create_study_plan");
    assert.equal(Object.hasOwn(clarifiedExecution.arguments, "dailyAvailableHours"), false,
        "With no stated hours in the creation request, do not reuse a model guess; use the planner recommendation");
    assert.equal(clarifiedExecution.arguments.durationDays, 7);
    assert.equal(Object.hasOwn(clarifiedExecution.arguments, "planId"), false,
        "The MCP server, not the model, assigns the internal plan ID");
    const clarifiedCreated = JSON.parse(clarifiedResult.steps.find(step => step.type === "tool_result").content);
    assert.match(clarifiedCreated.planId, /^DBMS-[a-f0-9]{8}$/i);
    assert.equal(clarifiedCreated.durationDays, 7);
    assert.ok(clarifiedCreated.dailyStudyHours > 0);
    assert.equal(clarifiedResult.activePlanId, clarifiedCreated.planId);

    // Exercise another creation phrasing through the same actual MCP server.
    for (const [verb, id] of [["Build", "eval-build-plan"], ["Make", "eval-make-plan"]]) {
        const message = `${verb} a JavaScript study plan with plan ID ${id}, exam date ${examDate}, and 2 hours daily.`;
        const result = await makeAgent("create_study_plan", {
            planId: "default", subjects: ["JavaScript"], examDate, dailyAvailableHours: 2
        }, data => formatGroundedPlanSummary(data)).run({ message });
        assert.equal(result.success, true, result.reply);
        assert.equal(parsedToolResult(result, "create_study_plan").result.planId, id);
    }

    // Record a completed session. The tool result includes planId so later turns can
    // resolve the same plan from verified context, even if the next user prompt omits it.
    const recordMessage = "Record a completed 2-hour JavaScript session for the study plan with ID 2.";
    const recordResult = await makeAgent("record_study_session", {
        planId: "default", subject: "JavaScript", hoursSpent: 2, status: "completed"
    }, (data, args) => formatGroundedSessionSummary(data, args)).run({ message: recordMessage });
    assert.equal(recordResult.success, true, recordResult.reply);
    const recorded = parsedToolResult(recordResult, "record_study_session");
    assert.equal(recorded.executing.arguments.planId, "2");
    assert.equal(recorded.result.planId, "2");
    assert.equal(recorded.result.session.subject, "JavaScript");
    assert.equal(recorded.result.session.status, "completed");
    assert.equal(recorded.result.session.hoursSpent, 2);

    // Retrieve and validate persistence from the same ID, checking all requested facts.
    const progressMessage = "Show the complete study plan with ID 2, including JavaScript completed hours, remaining hours, progress, and session count.";
    const retrievalResult = await makeAgent("get_study_plan", { planId: "2" }, data =>
        formatGroundedRetrievalSummary(data, progressMessage)
    ).run({ message: progressMessage });
    assert.equal(retrievalResult.success, true, retrievalResult.reply);
    const retrieved = parsedToolResult(retrievalResult, "get_study_plan");
    assert.equal(retrieved.executing.arguments.planId, "2");
    assert.equal(retrieved.result.planId, "2");
    assert.equal(retrieved.result.subjects.JavaScript.completedHours, 2);
    assert.equal(retrieved.result.totalCompletedHours, 2);
    assert.equal(retrieved.result.totalSessionsRecorded, 1);
    assert.equal(retrieved.result.subjects.JavaScript.remainingHours + 2, retrieved.result.subjects.JavaScript.allocatedHours);
    assert.match(retrievalResult.reply, /2.*completed/i);
    assert.doesNotMatch(retrievalResult.reply, /Mathematics|Physics|147/);

    // Retrieval phrasings must redirect a model-proposed adaptation to get_study_plan.
    for (const prompt of retrievalPrompts) {
        const result = await makeAgent("adapt_study_plan", { planId: "2" }, data =>
            formatGroundedRetrievalSummary(data, prompt)
        ).run({ message: prompt });
        assert.equal(result.success, true, result.reply);
        assert.ok(result.steps.some(step => step.type === "intent_tool_redirection" && step.redirectedTool === "get_study_plan"));
        assert.equal(parsedToolResult(result, "get_study_plan").result.planId, "2");
    }

    // A missed session and changed availability trigger adaptation without changing
    // the exam date, even if the model proposes a different date.
    const missedMessage = "Record a missed JavaScript session for the study plan with ID 2.";
    const missedResult = await makeAgent("record_study_session", {
        planId: "2", subject: "JavaScript", hoursSpent: 0, scheduledHours: 2, status: "missed"
    }, (data, args) => formatGroundedSessionSummary(data, args)).run({ message: missedMessage });
    assert.equal(missedResult.success, true, missedResult.reply);
    assert.equal(parsedToolResult(missedResult, "record_study_session").result.session.status, "missed");

    const adaptMessage = "Adjust the study plan with ID 2 because I missed JavaScript; change availability to 1 hour per day and keep the exam date unchanged.";
    const adaptResult = await makeAgent("adapt_study_plan", {
        planId: "default", reason: "Missed JavaScript session", newDailyAvailableHours: 1,
        newExamDate: "2035-12-31"
    }, data => formatGroundedAdaptationSummary(data)).run({ message: adaptMessage });
    assert.equal(adaptResult.success, true, adaptResult.reply);
    const adapted = parsedToolResult(adaptResult, "adapt_study_plan");
    assert.equal(adapted.executing.arguments.planId, "2");
    assert.equal(adapted.executing.arguments.newDailyAvailableHours, 1);
    assert.equal(Object.hasOwn(adapted.executing.arguments, "newExamDate"), false);
    assert.equal(adapted.result.planId, "2");
    assert.equal(adapted.result.examDate, examDate);

    const finalPlanCall = await mcp.callTool("get_study_plan", { planId: "2" });
    assert.equal(finalPlanCall.isError, false);
    const finalPlan = JSON.parse(finalPlanCall.content);
    assert.equal(finalPlan.examDate, examDate);
    assert.equal(finalPlan.dailyStudyHours, 1);
    assert.ok(finalPlan.totalRemainingHours <= finalPlan.availableCapacityHours,
        "Adapted remaining allocation must fit available study capacity");
    assert.equal(finalPlan.totalSessionsRecorded, 2);
    assert.equal(finalPlan.subjects.JavaScript.completedHours, 2);
    assert.equal(finalPlan.subjects.JavaScript.missedHours, 2);

    // Exact Postman reproduction: natural-language session date and one-hour
    // missed duration override stale/model-default arguments at execution time.
    const exactMissedMessage = "For study plan ID 2, record a missed 1-hour JavaScript study session for October 14, 2026.";
    const exactMissedResult = await makeAgent("record_study_session", {
        planId: "2", subject: "JavaScript", hoursSpent: 1, missedHours: 2,
        scheduledHours: 2, date: "2026-10-13", status: "missed"
    }, (data, args) => formatGroundedSessionSummary(data, args)).run({ message: exactMissedMessage });
    assert.equal(exactMissedResult.success, true, exactMissedResult.reply);
    const exactMissed = parsedToolResult(exactMissedResult, "record_study_session");
    assert.deepEqual(exactMissed.executing.arguments, {
        planId: "2", subject: "JavaScript", hoursSpent: 0, missedHours: 1,
        scheduledHours: 1, date: "2026-10-14", status: "missed"
    });
    assert.equal(exactMissed.result.planId, "2");
    assert.equal(exactMissed.result.session.date, "2026-10-14");
    assert.equal(exactMissed.result.session.hoursSpent, 0);
    assert.equal(exactMissed.result.session.missedHours, 1);
    assert.equal(exactMissed.result.session.scheduledHours, 1);
    assert.equal(exactMissed.result.subjectProgress.missedHours, 3);
    assert.match(exactMissedResult.reply, /October 14, 2026|2026-10-14/);
    assert.match(exactMissedResult.reply, /Missed Hours:\*\* 3h/);
    assert.doesNotMatch(exactMissedResult.reply, /October 13, 2026|Missed Hours:\*\* 2h/);
    const afterExactMissedCall = JSON.parse((await mcp.callTool("get_study_plan", { planId: "2" })).content);
    assert.equal(afterExactMissedCall.planId, "2");
    assert.equal(afterExactMissedCall.recentSessions.at(-1).date, "2026-10-14");
    assert.equal(afterExactMissedCall.recentSessions.at(-1).hoursSpent, 0);
    assert.equal(afterExactMissedCall.recentSessions.at(-1).missedHours, 1);
    assert.equal(afterExactMissedCall.recentSessions.at(-1).scheduledHours, 1);
    assert.equal(afterExactMissedCall.totalMissedHours, 3);

    // A missing explicit ID and a nonexistent ID fail without selecting the default.
    const missingIdResult = await makeAgent("get_study_plan", { planId: "default" }, () => "Default plan has JavaScript.")
        .run({ message: "Show me the study plan with ID." });
    assert.equal(missingIdResult.success, false);
    assert.doesNotMatch(missingIdResult.steps.map(step => step.type).join(" "), /tool_executing/);

    const nonexistentPrompt = "Retrieve the study plan with ID evaluation-plan-does-not-exist.";
    const nonexistentResult = await makeAgent("get_study_plan", { planId: "evaluation-plan-does-not-exist" }, () =>
        "The plan has 147 remaining hours."
    ).run({ message: nonexistentPrompt });
    assert.equal(nonexistentResult.success, false);
    assert.match(nonexistentResult.reply, /Action Failed/i);
    assert.doesNotMatch(nonexistentResult.reply, /147 remaining/);

    // Unknown subjects and invalid inputs do not create data or claim successful work.
    const unknownSubject = await makeAgent("record_study_session", {
        planId: "2", subject: "Latin", hoursSpent: 1, status: "completed"
    }, () => "Recorded the Latin session.").run({ message: "Record a completed 1-hour Latin session for plan ID 2." });
    assert.equal(unknownSubject.success, false);
    assert.match(unknownSubject.reply, /Action Failed/i);

    const invalidDate = await makeAgent("create_study_plan", {
        planId: "invalid-date-eval", subjects: ["JavaScript"], examDate: "2030-02-30", dailyAvailableHours: 2
    }, () => "Created the plan.").run({ message: "Create an exam study plan for JavaScript with plan ID invalid-date-eval and exam date 2030-02-30." });
    assert.equal(invalidDate.success, false);
    assert.equal(invalidDate.steps.some(step => step.type === "tool_executing"), false);

    const invalidHours = await makeAgent("create_study_plan", {
        planId: "invalid-hours-eval", subjects: ["JavaScript"], dailyAvailableHours: 3
    }, () => "Created the plan.").run({ message: "Create a JavaScript plan with plan ID invalid-hours-eval and 0 hours per day." });
    assert.equal(invalidHours.success, false);
    assert.equal(invalidHours.steps.some(step => step.type === "tool_executing"), false);

    console.log("✓ Deterministic agent evaluation passed: prompt routing, ID fidelity, create/record/retrieve persistence, adaptation, validation, tool failures, and grounded responses.");
} finally {
    await mcp.disconnect();
    const tempRoot = path.resolve(os.tmpdir());
    const resolvedDataDir = path.resolve(isolatedDataDir);
    if (resolvedDataDir.startsWith(`${tempRoot}${path.sep}`)) {
        fs.rmSync(resolvedDataDir, { recursive: true, force: true });
    }
}
