import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeToolArguments, cleanStringArray, cleanStringItem, cleanObject, parsePythonDictOrRelaxedJson, extractExplicitPlanId, isToolNameLike, shouldOmitAdaptationExamDate, shouldOmitSessionDate, userExplicitlyKeptExamDateUnchanged, isDateAssociatedWithSession, isRetrievalIntent, isAdaptationIntent, isSessionRecordingIntent } from "../src/agent/normalizer.js";
import { validateToolArguments, verifyToolResult } from "../src/agent/validator.js";
import {
    detectDailyScheduleOverrun,
    verifyFinalAnswerConsistency,
    stripMetaPreamble,
    detectPlanWideTotalRemainingHoursContradiction,
    detectBlanketRecentSessionDateContradiction,
    detectIncorrectSubjectInformation,
    isExamDateRequested,
    formatGroundedPlanSummary,
    formatGroundedAdaptationSummary,
    formatGroundedRetrievalSummary,
    formatGroundedSessionSummary,
    normalizeDateToISO,
    isValidCalendarDate,
    extractCanonicalDates,
    isExamDateContradicted,
    replyMentionsSubject,
    escapeRegex,
    getRequiredSubjects
} from "../src/agent/consistencyChecker.js";
import { McpClientManager } from "../src/mcp/mcpClient.js";
import { AdaptiveAgent } from "../src/agent/adaptiveAgent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure all tests run with an isolated temporary data directory protecting shared production/demo data
const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studypilot-norm-test-"));
process.env.STUDYPILOT_DATA_DIR = isolatedDataDir;

async function runNormalizationSuite() {
    console.log("=== Adaptive AI Agent: Tool Argument Normalization & Result Verification Suite ===");

    const studyPlanSchema = {
        name: "create_study_plan",
        inputSchema: {
            type: "object",
            properties: {
                subjects: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of subjects"
                },
                examDate: {
                    type: "string",
                    description: "Target exam date in YYYY-MM-DD format"
                },
                dailyAvailableHours: {
                    type: "number",
                    description: "Daily study hours"
                },
                priorities: {
                    type: "object",
                    additionalProperties: { type: "string" },
                    description: "Subject priorities"
                },
                planId: {
                    type: "string",
                    description: "Plan identifier"
                }
            },
            required: ["subjects", "examDate", "dailyAvailableHours"]
        }
    };

    // -------------------------------------------------------------
    // Test 1: Unit tests for normalizeToolArguments
    // -------------------------------------------------------------
    console.log("\n--- Test 1: Unit Tests for normalizeToolArguments ---");

    const rawReproductionArgs = {
        examDate: "2026-11-30",
        dailyAvailableHours: "3",
        priorities: "{\"Mathematics\":\"high\",\"Physics\":\"medium\",\"Chemistry\":\"low\"}",
        subjects: "[\"Mathematics\",\"Physics\",\"Chemistry\"]",
        planId: "default"
    };

    const normalized = normalizeToolArguments(studyPlanSchema, rawReproductionArgs);

    // 1.1 Check subjects array
    assert.ok(Array.isArray(normalized.subjects), "subjects should be normalized to an Array");
    assert.deepEqual(
        normalized.subjects,
        ["Mathematics", "Physics", "Chemistry"],
        "subjects should be parsed into clean string array without JSON quotes or brackets"
    );
    console.log("✓ JSON-stringified array normalized:", normalized.subjects);

    // 1.2 Check dailyAvailableHours
    assert.equal(typeof normalized.dailyAvailableHours, "number", "dailyAvailableHours should be converted to number");
    assert.equal(normalized.dailyAvailableHours, 3, "dailyAvailableHours should equal numeric 3");
    console.log("✓ Numeric string normalized to number:", normalized.dailyAvailableHours);

    // 1.3 Check priorities object
    assert.equal(typeof normalized.priorities, "object", "priorities should be normalized to an Object");
    assert.equal(normalized.priorities.Mathematics, "high", "Mathematics priority should be high");
    assert.equal(normalized.priorities.Physics, "medium", "Physics priority should be medium");
    assert.equal(normalized.priorities.Chemistry, "low", "Chemistry priority should be low");
    console.log("✓ JSON-stringified object normalized:", normalized.priorities);

    // 1.4 Check preserved string fields
    assert.equal(typeof normalized.examDate, "string", "examDate should remain a string");
    assert.equal(normalized.examDate, "2026-11-30", "examDate value should be preserved exactly");
    assert.equal(normalized.planId, "default", "planId string should be preserved");
    console.log("✓ String values preserved without coercion:", normalized.examDate, normalized.planId);

    // 1.5 Edge cases: Malformed array items with stray brackets and quotes
    const malformedArray = ['["Mathematics"', '"Physics"', 'Chemistry]'];
    const cleanedArray = cleanStringArray(malformedArray);
    assert.deepEqual(cleanedArray, ["Mathematics", "Physics", "Chemistry"]);
    console.log("✓ Malformed array elements cleaned:", cleanedArray);

    // 1.6 Numeric string for string property must NOT be converted to number
    const stringOnlySchema = {
        inputSchema: {
            properties: {
                postalCode: { type: "string" },
                code: { type: "string" }
            }
        }
    };
    const preservedResult = normalizeToolArguments(stringOnlySchema, { postalCode: "01234", code: "42" });
    assert.equal(typeof preservedResult.postalCode, "string");
    assert.equal(preservedResult.postalCode, "01234");
    assert.equal(typeof preservedResult.code, "string");
    assert.equal(preservedResult.code, "42");
    console.log("✓ Numeric string for string schema preserved as string:", preservedResult);

    // 1.7 Parse exact Python-style dictionary string for priorities
    const pythonDictStr = "{'Mathematics': 'high', 'Physics': 'medium', 'Chemistry': 'low'}";
    const parsedPythonDict = parsePythonDictOrRelaxedJson(pythonDictStr);
    assert.ok(parsedPythonDict && typeof parsedPythonDict === "object", "Python-style dict should parse into an object");
    assert.equal(parsedPythonDict.Mathematics, "high");
    assert.equal(parsedPythonDict.Physics, "medium");
    assert.equal(parsedPythonDict.Chemistry, "low");

    const normalizedPythonArgs = normalizeToolArguments(studyPlanSchema, {
        subjects: "[\"Mathematics\", \"Physics\", \"Chemistry\"]",
        dailyAvailableHours: "3",
        examDate: "2026-11-30",
        priorities: pythonDictStr
    });
    assert.equal(typeof normalizedPythonArgs.priorities, "object");
    assert.deepEqual(normalizedPythonArgs.priorities, {
        Mathematics: "high",
        Physics: "medium",
        Chemistry: "low"
    });
    console.log("✓ Exact Python-style dictionary string normalized into object:", normalizedPythonArgs.priorities);

    // 1.8 Rejecting malformed or unsafe object strings
    assert.equal(parsePythonDictOrRelaxedJson("{'Mathematics': "), null, "Malformed unclosed object string must return null");
    assert.equal(parsePythonDictOrRelaxedJson("__import__('os').system('ls')"), null, "Unsafe expression must return null");
    assert.equal(parsePythonDictOrRelaxedJson("{'a': eval('1')}"), null, "Unsafe eval expression must return null");

    const malformedObjectNormalized = normalizeToolArguments(studyPlanSchema, {
        priorities: "{'Mathematics': "
    });
    assert.equal(typeof malformedObjectNormalized.priorities, "string", "Unparseable string must not be converted to invalid object");
    const malformedValidation = validateToolArguments(studyPlanSchema, malformedObjectNormalized);
    assert.equal(malformedValidation.valid, false, "Malformed object string must fail schema validation");
    console.log("✓ Malformed and unsafe object strings safely rejected");

    // -------------------------------------------------------------
    // Test 2: Unit tests for validateToolArguments
    // -------------------------------------------------------------
    console.log("\n--- Test 2: Unit Tests for validateToolArguments ---");

    // 2.1 Valid normalized arguments should pass
    const validCheck = validateToolArguments(studyPlanSchema, normalized);
    assert.equal(validCheck.valid, true, "Valid normalized arguments must pass validation");
    console.log("✓ Normalized arguments passed validation");

    // 2.2 Missing required field should fail with actionable message
    const missingCheck = validateToolArguments(studyPlanSchema, {
        subjects: ["Mathematics"],
        dailyAvailableHours: 3
    });
    assert.equal(missingCheck.valid, false);
    assert.ok(missingCheck.error.includes('Missing required parameter "examDate"'));
    console.log("✓ Missing required parameter flagged:", missingCheck.error);

    // 2.3 Malformed artifacts in subject names should fail
    const corruptedSubjectCheck = validateToolArguments(studyPlanSchema, {
        subjects: ['["Mathematics"', 'Physics'],
        examDate: "2026-11-30",
        dailyAvailableHours: 3
    });
    assert.equal(corruptedSubjectCheck.valid, false);
    assert.ok(corruptedSubjectCheck.error.includes("quotation, bracket, or escape artifacts"));
    console.log("✓ Malformed subject names rejected with actionable feedback:", corruptedSubjectCheck.error);

    // -------------------------------------------------------------
    // Test 3: Unit tests for verifyToolResult
    // -------------------------------------------------------------
    console.log("\n--- Test 3: Unit Tests for verifyToolResult ---");

    // 3.1 Result with malformed subject names should be rejected
    const malformedResult = {
        isError: false,
        content: JSON.stringify({
            message: "Study plan created",
            subjectAllocations: {
                '["Mathematics"': { priority: "medium", allocatedHours: 10 },
                '"Physics"': { priority: "medium", allocatedHours: 10 },
                'Chemistry]': { priority: "medium", allocatedHours: 10 }
            }
        })
    };
    const malformedVerification = verifyToolResult("create_study_plan", normalized, malformedResult);
    assert.equal(malformedVerification.valid, false, "Result with malformed subject names must fail verification");
    assert.ok(malformedVerification.error.includes("malformed subject names"));
    console.log("✓ Rejected malformed subjects in tool result:", malformedVerification.error);

    // 3.2 Result with incorrect priorities should be rejected
    const wrongPriorityResult = {
        isError: false,
        content: JSON.stringify({
            message: "Study plan created",
            subjectAllocations: {
                Mathematics: { priority: "medium", allocatedHours: 10 },
                Physics: { priority: "medium", allocatedHours: 10 },
                Chemistry: { priority: "medium", allocatedHours: 10 }
            }
        })
    };
    const wrongPrioVerification = verifyToolResult("create_study_plan", normalized, wrongPriorityResult);
    assert.equal(wrongPrioVerification.valid, false, "Result with mismatched priorities must fail verification");
    assert.ok(wrongPrioVerification.error.includes("Priority mismatch for subject \"Mathematics\""));
    console.log("✓ Rejected incorrect priorities in tool result:", wrongPrioVerification.error);

    // 3.3 Valid result with correct priorities should pass
    const correctResult = {
        isError: false,
        content: JSON.stringify({
            message: "Study plan created",
            subjectAllocations: {
                Mathematics: { priority: "high", allocatedHours: 30 },
                Physics: { priority: "medium", allocatedHours: 20 },
                Chemistry: { priority: "low", allocatedHours: 10 }
            }
        })
    };
    const correctVerification = verifyToolResult("create_study_plan", normalized, correctResult);
    assert.equal(correctVerification.valid, true, "Clean result with correct priorities must pass verification");
    console.log("✓ Verified clean result with correct priorities passed verification");

    // -------------------------------------------------------------
    // Test 4: Real MCP Tool Integration Test with Exact Reproduction Args
    // -------------------------------------------------------------
    console.log("\n--- Test 4: Real MCP Execution with Exact Reproduction Arguments ---");

    const serverScript = path.resolve(__dirname, "../studypilot-server/server.js");
    const mcpManager = new McpClientManager({
        command: "node",
        args: [serverScript],
        env: {
            STUDYPILOT_DATA_DIR: isolatedDataDir
        }
    });

    const conn = await mcpManager.connect();
    assert.equal(conn.connected, true, "MCP client must connect successfully");

    const reproductionPlanId = `repro_plan_${Date.now()}`;
    const mcpCallResult = await mcpManager.callTool("create_study_plan", {
        examDate: "2026-11-30",
        dailyAvailableHours: "3",
        priorities: "{\"Mathematics\":\"high\",\"Physics\":\"medium\",\"Chemistry\":\"low\"}",
        subjects: "[\"Mathematics\",\"Physics\",\"Chemistry\"]",
        planId: reproductionPlanId
    });

    assert.equal(Boolean(mcpCallResult.isError), false, "Tool call should succeed without error");
    const planSummary = JSON.parse(mcpCallResult.content);

    // Assert clean subject names
    const createdSubjects = Object.keys(planSummary.subjectAllocations);
    assert.deepEqual(createdSubjects, ["Mathematics", "Physics", "Chemistry"]);
    for (const sub of createdSubjects) {
        assert.ok(!sub.includes('"') && !sub.includes("[") && !sub.includes("]") && !sub.includes("\\"),
            `Subject "${sub}" must be completely clean without quote/bracket artifacts`
        );
    }
    console.log("✓ MCP execution created clean subjects:", createdSubjects);

    // Assert correct priorities assigned
    assert.equal(planSummary.subjectAllocations.Mathematics.priority, "high");
    assert.equal(planSummary.subjectAllocations.Physics.priority, "medium");
    assert.equal(planSummary.subjectAllocations.Chemistry.priority, "low");
    console.log("✓ MCP execution assigned exact requested priorities: Math=high, Physics=medium, Chem=low");

    // Assert allocated hours correspond to priorities: Math > Physics > Chem
    const mathHours = planSummary.subjectAllocations.Mathematics.allocatedHours;
    const physHours = planSummary.subjectAllocations.Physics.allocatedHours;
    const chemHours = planSummary.subjectAllocations.Chemistry.allocatedHours;
    assert.ok(mathHours > physHours, `Math (${mathHours}h) should receive more hours than Physics (${physHours}h)`);
    assert.ok(physHours > chemHours, `Physics (${physHours}h) should receive more hours than Chem (${chemHours}h)`);
    console.log(`✓ Hours allocated by priority: Math=${mathHours}h, Physics=${physHours}h, Chem=${chemHours}h`);

    // -------------------------------------------------------------
    // Test 5: End-to-End Test with AdaptiveAgent Loop (Live Python-style Priorities Reproduction)
    // -------------------------------------------------------------
    console.log("\n--- Test 5: End-to-End Test with AdaptiveAgent (Python-style Priorities String) ---");

    // Mock Provider mimicking model returning Python-style priorities string from confirmed live reproduction
    const mockProvider = {
        turn: 0,
        async chat({ messages, tools }) {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "create_study_plan",
                            arguments: {
                                examDate: "2026-11-30",
                                dailyAvailableHours: "3",
                                priorities: "{'Mathematics': 'high', 'Physics': 'medium', 'Chemistry': 'low'}",
                                subjects: "[\"Mathematics\", \"Physics\", \"Chemistry\"]",
                                planId: `agent_e2e_${Date.now()}`
                            }
                        }
                    ],
                    content: "I will create your study plan."
                };
            }
            return {
                toolCalls: [],
                content: "I have successfully created your study plan for Mathematics (high priority), Physics (medium priority), and Chemistry (low priority)."
            };
        }
    };

    const agent = new AdaptiveAgent({
        provider: mockProvider,
        mcpClient: mcpManager,
        maxRounds: 4
    });

    const agentResult = await agent.run({
        message: "Create a study plan for Mathematics, Physics, and Chemistry, exam date 2026-11-30, 3 daily hours, priorities high/medium/low."
    });

    assert.equal(agentResult.success, true, "Agent run should succeed with Python-style priorities string");
    assert.ok(agentResult.reply.includes("Mathematics") && agentResult.reply.includes("Physics"));
    console.log("✓ AdaptiveAgent normalized Python-style priorities, executed tool end-to-end, and reported valid success");

    // -------------------------------------------------------------
    // Test 6: Agent Refusal to Claim Success when Tool Validation Fails
    // -------------------------------------------------------------
    console.log("\n--- Test 6: Agent Clearly Reports Failure and Suppresses Invented Plans on Tool Failure ---");

    const faultyProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "create_study_plan",
                            arguments: {
                                // Missing required fields
                                subjects: []
                            }
                        }
                    ]
                };
            }
            // Model attempts to falsely claim success and invent a plan despite tool validation error
            return {
                toolCalls: [],
                content: "I can create a study plan for you. Here's a plan tailored to your needs:\n\n**Days 1-50**\n\n* 9:00 - 12:00: Mathematics (3 hours)"
            };
        }
    };

    const strictAgent = new AdaptiveAgent({
        provider: faultyProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const strictResult = await strictAgent.run({
        message: "Create an empty plan."
    });

    assert.equal(strictResult.success, false, "Agent must NOT report success when tool validation failed");
    assert.ok(strictResult.reply.startsWith("Action Failed:"), "Failure explanation must be placed first");
    assert.ok(strictResult.reply.includes("could not be completed successfully"), "Agent reply must communicate the failure");
    assert.ok(!strictResult.reply.includes("Here's a plan tailored to your needs"), "Reply must NOT return an invented completed plan");
    assert.ok(!strictResult.reply.includes("9:00 - 12:00"), "Reply must NOT return an invented daily schedule");
    console.log("✓ AdaptiveAgent put failure explanation first and suppressed invented plan/schedule");

    // -------------------------------------------------------------
    // Test 7: Unit tests for detectDailyScheduleOverrun
    // -------------------------------------------------------------
    console.log("\n--- Test 7: Unit Tests for detectDailyScheduleOverrun ---");

    // 7.1 Exact reproduction output: 3h Math + 1h Physics + 0.5h Chem = 4.5h > 3h
    const reproductionOutput = `Based on the study plan, here is a suggested daily schedule:

**Days 1-50**

* 9:00 - 12:00: Mathematics (3 hours)
* 1:00 - 2:00: Physics (1 hour)
* 2:00 - 2:30: Chemistry (0.5 hours)

Adjust as needed for your learning style.`;

    const overrunCheck = detectDailyScheduleOverrun(reproductionOutput, 3);
    assert.equal(overrunCheck.exceeds, true, "Should detect daily schedule exceeding 3-hour limit");
    assert.equal(overrunCheck.detectedHours, 4.5, "Should correctly calculate total scheduled daily hours as 4.5h");
    console.log(`✓ Detected schedule overrun: ${overrunCheck.detectedHours}h > 3h limit (${overrunCheck.details})`);

    // 7.2 Explicit statement of daily total
    const explicitText = "Your daily schedule requires a total of 4.5 hours per day.";
    const explicitOverrun = detectDailyScheduleOverrun(explicitText, 3);
    assert.equal(explicitOverrun.exceeds, true);
    assert.equal(explicitOverrun.detectedHours, 4.5);
    console.log("✓ Detected explicit daily total overrun:", explicitOverrun.details);

    // 7.3 Valid schedule within limits
    const validScheduleText = `Study Plan Summary:
- Mathematics (High Priority): 75 hours total (~1.5 hrs/day)
- Physics (Medium Priority): 50 hours total (~1.0 hr/day)
- Chemistry (Low Priority): 25 hours total (~0.5 hrs/day)
Total daily study time: 3 hours/day.`;

    const validCheckOverrun = detectDailyScheduleOverrun(validScheduleText, 3);
    assert.equal(validCheckOverrun.exceeds, false, "Valid schedule within 3h must not be flagged");
    console.log("✓ Valid schedule within 3h daily limit accepted cleanly");

    // -------------------------------------------------------------
    // Test 8: Agent Regression Test: Proving Agent Cannot Return Schedule Exceeding Available Hours
    // -------------------------------------------------------------
    console.log("\n--- Test 8: Agent Regression Test: Blocking Schedules Exceeding Daily Limit ---");

    // Provider that attempts to return the flawed 4.5-hour schedule after creating a 3-hour plan
    const overcommittingProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "create_study_plan",
                            arguments: {
                                examDate: "2026-11-30",
                                dailyAvailableHours: "3",
                                priorities: "{\"Mathematics\":\"high\",\"Physics\":\"medium\",\"Chemistry\":\"low\"}",
                                subjects: "[\"Mathematics\",\"Physics\",\"Chemistry\"]",
                                planId: `repro_agent_guard_${Date.now()}`
                            }
                        }
                    ],
                    content: "Creating your plan."
                };
            }
            // Model generates the flawed schedule from reproduction
            return {
                toolCalls: [],
                content: `Based on the study plan, here is a suggested daily schedule:

**Days 1-50**

* 9:00 - 12:00: Mathematics (3 hours)
* 1:00 - 2:00: Physics (1 hour)
* 2:00 - 2:30: Chemistry (0.5 hours)

Adjust as needed for your learning style.`
            };
        }
    };

    const guardedAgent = new AdaptiveAgent({
        provider: overcommittingProvider,
        mcpClient: mcpManager,
        maxRounds: 4
    });

    const guardedResult = await guardedAgent.run({
        message: "Create a study plan for Mathematics, Physics, and Chemistry. Exam date 2026-11-30, 3 hours per day."
    });

    assert.equal(guardedResult.success, true, "Agent run should succeed");
    
    // Assert the reply does NOT suggest 4.5 hours or violate the 3-hour limit
    assert.ok(!/\b4\.5\s*(?:hours|hrs)/i.test(guardedResult.reply), "Reply must not suggest 4.5 hours per day");
    assert.ok(!guardedResult.reply.includes("9:00 - 12:00: Mathematics (3 hours)"), "Reply must not contain the contradictory micro-schedule");

    // Assert the reply is grounded in verified tool results
    assert.ok(guardedResult.reply.includes("3 hours/day"), "Reply must state the verified 3 hours/day limit");
    assert.ok(guardedResult.reply.includes("Mathematics"), "Reply must state Mathematics");
    assert.ok(guardedResult.reply.includes("Physics"), "Reply must state Physics");
    assert.ok(guardedResult.reply.includes("Chemistry"), "Reply must state Chemistry");

    // Assert the agent recorded a final_answer_grounded step
    const groundedStep = guardedResult.steps.find(s => s.type === "final_answer_grounded");
    assert.ok(groundedStep, "Agent must record a final_answer_grounded step when correcting the reply");
    assert.ok(groundedStep.reason.includes("exceeds"), "Reason must cite exceeding the daily limit");
    console.log("✓ Guarded agent successfully intercepted contradictory 4.5h schedule and replaced it with verified grounded summary!");
    console.log(`  Grounded step recorded: "${groundedStep.reason}"`);

    // -------------------------------------------------------------
    // Test 9: Explicit Plan Identifier Preservation & Unknown Plan Handling
    // -------------------------------------------------------------
    console.log("\n--- Test 9: Explicit Plan Identifier Preservation & Unknown Plan Handling ---");

    // 9.1 Unit tests for extractExplicitPlanId
    console.log("\n[Test 9.1] Unit tests for extractExplicitPlanId with various user phrasing");
    assert.equal(extractExplicitPlanId('Record a missed Mathematics session for planId "adaptive-demo"'), "adaptive-demo");
    assert.equal(extractExplicitPlanId('Record a missed Mathematics session for planId adaptive-demo'), "adaptive-demo");
    assert.equal(extractExplicitPlanId('Record a missed Mathematics session for planId: custom-fall-2026'), "custom-fall-2026");
    assert.equal(extractExplicitPlanId('In study plan "biology-prep", mark session completed'), "biology-prep");
    assert.equal(extractExplicitPlanId('Please adapt study plan for plan physics-intensive'), "physics-intensive");
    assert.equal(extractExplicitPlanId('Please record session', [
        { role: "assistant", content: 'Study plan "history-101" created successfully!' }
    ]), "history-101");
    // Does not match tool names
    assert.equal(extractExplicitPlanId('Please invoke adapt_study_plan'), null);
    assert.equal(extractExplicitPlanId('Just record my study session'), null);
    console.log("✓ extractExplicitPlanId successfully extracts explicit identifiers without hardcoding");

    // Tool schemas
    const recordSessionSchema = {
        name: "record_study_session",
        inputSchema: {
            type: "object",
            properties: {
                subject: { type: "string" },
                hoursSpent: { type: "number" },
                status: { type: "string" },
                planId: { type: "string" }
            },
            required: ["subject", "hoursSpent", "status"]
        }
    };

    const getPlanSchema = {
        name: "get_study_plan",
        inputSchema: {
            type: "object",
            properties: {
                planId: { type: "string" }
            }
        }
    };

    const adaptPlanSchema = {
        name: "adapt_study_plan",
        inputSchema: {
            type: "object",
            properties: {
                planId: { type: "string" },
                reason: { type: "string" },
                newExamDate: { type: "string" },
                newDailyAvailableHours: { type: "number" }
            }
        }
    };

    // 9.2 Regression: record_study_session preserves explicit planId when model outputs adapt_study_plan
    console.log("\n[Test 9.2] Regression: record_study_session preserves explicit planId when model generates tool name");
    const rawRecordArgsWithToolName = {
        subject: "Mathematics",
        hoursSpent: "0",
        status: "missed",
        planId: "adapt_study_plan"
    };
    const normRecord = normalizeToolArguments(recordSessionSchema, rawRecordArgsWithToolName, {
        message: "Record a missed Mathematics session for planId 'adaptive-demo'",
        knownTools: ["record_study_session", "adapt_study_plan", "get_study_plan", "create_study_plan"]
    });
    assert.equal(normRecord.planId, "adaptive-demo", "Explicit planId 'adaptive-demo' must be preserved, replacing tool name 'adapt_study_plan'");
    console.log("✓ record_study_session normalized planId:", normRecord.planId);

    // 9.3 Regression: get_study_plan preserves explicit planId when model outputs get_study_plan or omits planId
    console.log("\n[Test 9.3] Regression: get_study_plan preserves explicit planId when model generates tool name");
    const rawGetArgsWithToolName = {
        planId: "get_study_plan"
    };
    const normGet = normalizeToolArguments(getPlanSchema, rawGetArgsWithToolName, {
        message: "Get study plan for planId 'custom-prep-42'",
        knownTools: ["record_study_session", "adapt_study_plan", "get_study_plan", "create_study_plan"]
    });
    assert.equal(normGet.planId, "custom-prep-42", "Explicit planId 'custom-prep-42' must be preserved");
    console.log("✓ get_study_plan normalized planId:", normGet.planId);

    // 9.4 Regression: adapt_study_plan preserves explicit planId when model outputs adapt_study_plan
    console.log("\n[Test 9.4] Regression: adapt_study_plan preserves explicit planId when model generates tool name");
    const rawAdaptArgsWithToolName = {
        planId: "adapt_study_plan",
        reason: "Missed Mathematics session"
    };
    const normAdapt = normalizeToolArguments(adaptPlanSchema, rawAdaptArgsWithToolName, {
        message: "Please adapt study plan for planId 'finals-rush'",
        knownTools: ["record_study_session", "adapt_study_plan", "get_study_plan", "create_study_plan"]
    });
    assert.equal(normAdapt.planId, "finals-rush", "Explicit planId 'finals-rush' must be preserved");
    console.log("✓ adapt_study_plan normalized planId:", normAdapt.planId);

    // 9.5 End-to-End Agent: Multi-turn plan creation followed by session recording with buggy model argument
    console.log("\n[Test 9.5] E2E Agent: Multi-turn explicit planId preserved across live MCP execution");
    const customTestPlanId = `adaptive_regress_${Date.now()}`;
    
    // Step A: Create the plan using real MCP client
    const createRes = await mcpManager.callTool("create_study_plan", {
        planId: customTestPlanId,
        subjects: ["Mathematics", "Physics"],
        examDate: "2026-11-30",
        dailyAvailableHours: 3
    });
    assert.equal(createRes.isError, false, "Test plan creation should succeed");

    // Step B: Agent executes record_study_session with model generating planId: 'adapt_study_plan'
    const buggyRecordProvider = {
        callCount: 0,
        async chat({ messages }) {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [
                        {
                            name: "record_study_session",
                            arguments: {
                                subject: "Mathematics",
                                hoursSpent: 0,
                                status: "missed",
                                planId: "adapt_study_plan" // Buggy model output from reproduction!
                            }
                        }
                    ],
                    content: ""
                };
            }
            return {
                toolCalls: [],
                content: `Successfully recorded missed Mathematics session for plan ${customTestPlanId}.`
            };
        }
    };

    const preservationAgent = new AdaptiveAgent({
        provider: buggyRecordProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const preservationResult = await preservationAgent.run({
        message: `Record a missed Mathematics session for planId "${customTestPlanId}"`
    });

    assert.equal(preservationResult.success, true, "Agent run must succeed by preserving explicit planId");
    const preservedStep = preservationResult.steps.find(s => s.type === "identifier_preserved");
    assert.ok(preservedStep, "Agent must record an identifier_preserved step");
    assert.equal(preservedStep.preservedValue, customTestPlanId, "Preserved value must match user planId");
    assert.equal(preservedStep.rawArgument, "adapt_study_plan", "Raw argument was adapt_study_plan");
    console.log(`✓ Agent intercepted buggy 'adapt_study_plan' and successfully recorded session into "${customTestPlanId}"!`);

    // 9.6 Unknown plan ID fails honestly without being coerced to 'default'
    console.log("\n[Test 9.6] Unknown plan ID fails honestly without being silently replaced with 'default'");
    const unknownPlanId = "nonexistent_plan_404_xyz";
    const unknownProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [
                        {
                            name: "get_study_plan",
                            arguments: { planId: unknownPlanId }
                        }
                    ],
                    content: ""
                };
            }
            return {
                toolCalls: [],
                content: "Here is your plan data."
            };
        }
    };

    const unknownAgent = new AdaptiveAgent({
        provider: unknownProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const unknownResult = await unknownAgent.run({
        message: `Get study plan for planId "${unknownPlanId}"`
    });

    assert.equal(unknownResult.success, false, "Unknown plan ID must result in success=false");
    assert.ok(unknownResult.reply.includes("Action Failed") || unknownResult.reply.includes(unknownPlanId), "Reply must indicate honest failure");
    assert.ok(!unknownResult.reply.includes('Study plan "default"'), "Must never claim default plan was retrieved");
    console.log("✓ Unknown plan ID failed honestly without defaulting:", unknownResult.reply.split("\n")[0]);

    // 9.7 Tool name generated WITHOUT explicit user planId is strictly rejected by validator
    console.log("\n[Test 9.7] Tool name generated without explicit user planId is strictly rejected by validator");
    const noIdProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [
                        {
                            name: "record_study_session",
                            arguments: {
                                subject: "Mathematics",
                                hoursSpent: 2,
                                status: "completed",
                                planId: "adapt_study_plan" // Hallucinated tool name, but user did NOT specify any planId
                            }
                        }
                    ],
                    content: ""
                };
            }
            return {
                toolCalls: [],
                content: "Done."
            };
        }
    };

    const noIdAgent = new AdaptiveAgent({
        provider: noIdProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const noIdResult = await noIdAgent.run({
        message: "Record a 2-hour session for Mathematics." // No planId specified by user
    });

    assert.equal(noIdResult.success, false, "Must fail because adapt_study_plan cannot be used as planId");
    assert.ok(
        noIdResult.reply.includes("cannot be used as a plan ID") || noIdResult.reply.includes("Action Failed"),
        "Honest validation error must be reported"
    );
    console.log("✓ Tool name without user plan ID strictly rejected without falling back to 'default'");

    // -------------------------------------------------------------
    // Test 10: adapt_study_plan Optional Argument Normalization & Field Preservation Suite
    // -------------------------------------------------------------
    console.log("\n--- Test 10: adapt_study_plan Optional Argument Normalization & Field Preservation Suite ---");

    // 10.1 Exam date unchanged: omit newExamDate
    console.log("\n[Test 10.1] Exam date unchanged: omit newExamDate and newDailyAvailableHours when empty/unspecified");
    const adaptRawUnchanged = {
        planId: "adaptive-demo",
        reason: "Missed Mathematics session",
        newExamDate: "",
        newDailyAvailableHours: ""
    };
    const normUnchanged = normalizeToolArguments(adaptPlanSchema, adaptRawUnchanged, {
        message: "Adapt study plan for planId 'adaptive-demo'. Keep exam date unchanged.",
        knownTools: ["adapt_study_plan", "create_study_plan", "get_study_plan", "record_study_session"]
    });
    assert.equal("newExamDate" in normUnchanged, false, "newExamDate must be completely omitted when empty");
    assert.equal("newDailyAvailableHours" in normUnchanged, false, "newDailyAvailableHours must be completely omitted when empty");
    assert.equal(normUnchanged.planId, "adaptive-demo", "planId must be preserved");
    assert.equal(normUnchanged.reason, "Missed Mathematics session", "reason must be preserved");
    
    // Check validation of omitted optional fields passes
    const valUnchanged = validateToolArguments(adaptPlanSchema, normUnchanged);
    assert.equal(valUnchanged.valid, true, "Validation must pass when optional newExamDate and newDailyAvailableHours are omitted");
    console.log("✓ Omitted optional fields cleanly excluded from normalized arguments and passed validation");

    // 10.2 Valid new exam date: accept it
    console.log("\n[Test 10.2] Valid new exam date: accept and preserve");
    const adaptRawValidDate = {
        planId: "adaptive-demo",
        reason: "Exam postponed by school",
        newExamDate: "2026-12-25"
    };
    const normValidDate = normalizeToolArguments(adaptPlanSchema, adaptRawValidDate);
    assert.equal(normValidDate.newExamDate, "2026-12-25", "newExamDate must be preserved when provided");
    const valValidDate = validateToolArguments(adaptPlanSchema, normValidDate, { referenceDate: "2026-10-15" });
    assert.equal(valValidDate.valid, true, "Validation must pass for valid future YYYY-MM-DD date");
    console.log("✓ Valid newExamDate accepted:", normValidDate.newExamDate);

    // 10.3 Invalid nonempty exam date: reject it
    console.log("\n[Test 10.3] Invalid nonempty exam date: reject with clear error");
    const adaptRawInvalidDate = {
        planId: "adaptive-demo",
        reason: "Exam changed",
        newExamDate: "not-a-valid-date"
    };
    const normInvalidDate = normalizeToolArguments(adaptPlanSchema, adaptRawInvalidDate);
    assert.equal(normInvalidDate.newExamDate, "not-a-valid-date", "Invalid date string must not be erased so it can be validated");
    const valInvalidDate = validateToolArguments(adaptPlanSchema, normInvalidDate);
    assert.equal(valInvalidDate.valid, false, "Validation must fail for invalid date format");
    assert.ok(valInvalidDate.error.includes("YYYY-MM-DD"), "Error message must require YYYY-MM-DD format");

    // Past date rejection
    const adaptRawPastDate = {
        planId: "adaptive-demo",
        newExamDate: "2020-01-01"
    };
    const normPastDate = normalizeToolArguments(adaptPlanSchema, adaptRawPastDate);
    const valPastDate = validateToolArguments(adaptPlanSchema, normPastDate, { referenceDate: "2026-10-15" });
    assert.equal(valPastDate.valid, false, "Validation must fail for past date");
    assert.ok(valPastDate.error.includes("past"), "Error must cite past date");
    console.log("✓ Invalid and past dates strictly rejected by validator");

    // 10.4 Empty optional date: normalize it to omission, or reject it clearly before tool execution if unnormalized
    console.log("\n[Test 10.4] Empty optional date: normalize to omission or reject clearly if unnormalized");
    // Normalization to omission
    const normNullDate = normalizeToolArguments(adaptPlanSchema, { newExamDate: "null", newDailyAvailableHours: "undefined" });
    assert.equal("newExamDate" in normNullDate, false, "'null' string normalized to omission");
    assert.equal("newDailyAvailableHours" in normNullDate, false, "'undefined' string normalized to omission");
    assert.notEqual(normNullDate.newExamDate, "", "Never converts to empty string");
    assert.notEqual(normNullDate.newExamDate, "null", "Never converts to string 'null'");
    assert.notEqual(normNullDate.newExamDate, "undefined", "Never converts to string 'undefined'");

    // Clear rejection if unnormalized empty string is directly passed to validator
    const valRawEmpty = validateToolArguments(adaptPlanSchema, { newExamDate: "" });
    assert.equal(valRawEmpty.valid, false, "Direct empty string to validator must be rejected");
    assert.ok(valRawEmpty.error.includes("YYYY-MM-DD"), "Validator must clearly reject empty string date");
    console.log("✓ Empty date normalized to omission and rejected clearly before tool execution if unnormalized");

    // Unit checks for date inference prevention
    assert.equal(userExplicitlyKeptExamDateUnchanged("Keep my exam date unchanged and my daily availability at 3 hours."), true);
    assert.equal(userExplicitlyKeptExamDateUnchanged("Without changing the exam date, rebalance my hours."), true);
    assert.equal(userExplicitlyKeptExamDateUnchanged("Change exam date to 2026-12-25"), false);

    assert.equal(isDateAssociatedWithSession("2026-10-11", "I missed my Mathematics study session on 2026-10-11."), true);
    assert.equal(isDateAssociatedWithSession("2026-12-25", "Change exam date to 2026-12-25."), false);

    const normSessionDateOmitted = normalizeToolArguments(
        adaptPlanSchema,
        { planId: "adaptive-demo", newExamDate: "2026-10-11", newDailyAvailableHours: "3", reason: "Missed Mathematics session" },
        { message: "Adapt study plan adaptive-demo because I missed my Mathematics study session on 2026-10-11. Keep my exam date unchanged and my daily availability at 3 hours. Preserve all subject priorities." }
    );
    assert.equal("newExamDate" in normSessionDateOmitted, false, "newExamDate must be omitted when user keeps exam date unchanged");
    assert.equal(normSessionDateOmitted.newDailyAvailableHours, 3, "newDailyAvailableHours must be preserved as 3");
    assert.equal(normSessionDateOmitted.planId, "adaptive-demo", "planId must remain 'adaptive-demo'");
    console.log("✓ Unit test: newExamDate omitted when user keeps exam date unchanged; hours and planId preserved");

    // 10.5 Existing plan ID and daily availability preservation end-to-end
    console.log("\n[Test 10.5] E2E: Existing plan ID and daily availability preservation with live MCP server");
    const livePreservePlanId = `adapt_preserve_${Date.now()}`;
    const initialExamDate = "2026-11-30";
    const initialDailyHours = 3;

    // Step A: Create plan with initial date and hours
    const createLiveRes = await mcpManager.callTool("create_study_plan", {
        planId: livePreservePlanId,
        subjects: ["Mathematics", "Physics"],
        examDate: initialExamDate,
        dailyAvailableHours: initialDailyHours
    });
    assert.equal(createLiveRes.isError, false, "Plan creation must succeed");

    // Step B: Record a missed Mathematics session
    const recordLiveRes = await mcpManager.callTool("record_study_session", {
        planId: livePreservePlanId,
        subject: "Mathematics",
        hoursSpent: 0,
        status: "missed"
    });
    assert.equal(recordLiveRes.isError, false, "Recording missed session must succeed");

    // Step C: Run AdaptiveAgent adapting the plan where the model emits empty optional fields
    // and copies the old description example with physics
    const adaptBuggyProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [
                        {
                            name: "adapt_study_plan",
                            arguments: {
                                planId: "adapt_study_plan", // Buggy model output: tool name
                                reason: "Recovering missed physics study session", // Buggy model output: wrong subject from description
                                newExamDate: "", // Buggy model output: empty string
                                newDailyAvailableHours: "" // Buggy model output: empty string
                            }
                        }
                    ],
                    content: ""
                };
            }
            return {
                toolCalls: [],
                content: `Study plan ${livePreservePlanId} successfully adapted with schedule rebalanced.`
            };
        }
    };

    const adaptLiveAgent = new AdaptiveAgent({
        provider: adaptBuggyProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const adaptLiveResult = await adaptLiveAgent.run({
        message: `Adapt study plan for planId "${livePreservePlanId}": missed Mathematics session. Keep exam date unchanged.`
    });

    assert.equal(adaptLiveResult.success, true, "Agent adaptation run must succeed");

    // Step D: Retrieve adapted plan via MCP and verify preservation
    const getAdaptedRes = await mcpManager.callTool("get_study_plan", { planId: livePreservePlanId });
    assert.equal(getAdaptedRes.isError, false, "Retrieving adapted plan must succeed");
    const adaptedPlanData = JSON.parse(getAdaptedRes.content);

    assert.equal(adaptedPlanData.planId, livePreservePlanId, "planId must remain unchanged");
    assert.equal(adaptedPlanData.examDate, initialExamDate, "examDate must remain unchanged");
    assert.equal(adaptedPlanData.dailyStudyHours, initialDailyHours, "dailyStudyHours must remain unchanged");
    assert.ok(adaptedPlanData.recentAdaptations.length > 0, "Adaptation must be recorded in history");
    assert.ok(
        adaptedPlanData.recentAdaptations[0].reason.includes("Mathematics"),
        `Reason must reflect Mathematics, not physics. Received: "${adaptedPlanData.recentAdaptations[0].reason}"`
    );
    console.log("✓ Live MCP plan verified: examDate and dailyStudyHours preserved, reason faithfully updated to Mathematics!");

    // 10.6 Exact live reproduction: user mentions session date (2026-10-11) and requests keeping exam date unchanged
    console.log("\n[Test 10.6] Exact live reproduction: session date 2026-10-11 with exam date unchanged instruction");
    const demoPlanId = "adaptive-demo";
    const demoExamDate = "2026-11-30";
    const demoDailyHours = 3;

    // Step A: Setup the initial study plan adaptive-demo with all 3 subjects
    const createDemoRes = await mcpManager.callTool("create_study_plan", {
        planId: demoPlanId,
        subjects: ["Mathematics", "Physics", "Chemistry"],
        examDate: demoExamDate,
        dailyAvailableHours: demoDailyHours,
        priorities: { Mathematics: "high", Physics: "medium", Chemistry: "low" }
    });
    assert.equal(createDemoRes.isError, false, "Initial plan creation for adaptive-demo must succeed");

    // Step B: Model reproduces the exact buggy tool call with session date 2026-10-11 as newExamDate
    const liveBuggyReproProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [
                        {
                            name: "adapt_study_plan",
                            arguments: {
                                planId: "adaptive-demo",
                                newExamDate: "2026-10-11", // Bug: falsely inferred from missed session date
                                newDailyAvailableHours: "3",
                                reason: "Missed Mathematics study session"
                            }
                        }
                    ],
                    content: ""
                };
            }
            return {
                toolCalls: [],
                content: `Study plan ${demoPlanId} successfully adapted with schedule rebalanced.`
            };
        }
    };

    const liveReproAgent = new AdaptiveAgent({
        provider: liveBuggyReproProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const liveUserPrompt = "Adapt study plan adaptive-demo because I missed my Mathematics study session on 2026-10-11. Keep my exam date unchanged and my daily availability at 3 hours. Preserve all subject priorities.";
    const reproResult = await liveReproAgent.run({
        message: liveUserPrompt
    });

    // Requirement 8: This assertion MUST FAIL before the fix and PASS after the fix!
    assert.equal(reproResult.success, true, `Agent adaptation run must succeed. Reply: ${reproResult.reply}`);

    // Step C: Verify the saved plan via MCP get_study_plan
    const getDemoRes = await mcpManager.callTool("get_study_plan", { planId: demoPlanId });
    assert.equal(getDemoRes.isError, false, "Retrieving adaptive-demo must succeed");
    const demoPlanData = JSON.parse(getDemoRes.content);

    assert.equal(demoPlanData.planId, "adaptive-demo", "planId must remain 'adaptive-demo'");
    assert.equal(demoPlanData.examDate, "2026-11-30", "examDate must remain 2026-11-30");
    assert.equal(demoPlanData.dailyStudyHours, 3, "dailyStudyHours must remain 3");
    assert.ok(demoPlanData.subjects.Chemistry, "Chemistry must remain present in adaptive-demo");
    assert.equal(demoPlanData.subjects.Chemistry.priority, "low", "Chemistry priority must remain low");
    assert.ok(demoPlanData.recentAdaptations.length > 0, "Adaptation must be recorded in history");
    assert.ok(
        demoPlanData.recentAdaptations[0].reason.toLowerCase().includes("mathematics"),
        `Reason must reflect Mathematics. Received: "${demoPlanData.recentAdaptations[0].reason}"`
    );
    console.log("✓ Live pipeline reproduction verified: newExamDate omitted, examDate remains 2026-11-30, hours=3, reason preserved!");

    // -------------------------------------------------------------
    // Test 11: Intent-Based Tool Selection, Grounding & Plan Fidelity Suite
    // -------------------------------------------------------------
    console.log("\n--- Test 11: Intent-Based Tool Selection, Grounding & Plan Fidelity Suite ---");

    // 11.1: Intent detection helpers
    const liveRetrievalPrompt = "Retrieve study plan adaptive-demo. Report every subject, its priority, allocated hours, completed hours, remaining hours, recorded study sessions, missed hours, exam date, daily availability, and overall progress.";
    const liveAdaptPrompt = "Adapt study plan adaptive-demo because I need to rebalance my schedule.";

    assert.equal(isRetrievalIntent(liveRetrievalPrompt), true, "isRetrievalIntent must detect retrieval prompt");
    assert.equal(isAdaptationIntent(liveRetrievalPrompt), false, "retrieval prompt must NOT be considered adaptation intent");
    assert.equal(isRetrievalIntent(liveAdaptPrompt), false, "adaptation prompt must NOT be considered retrieval intent");
    assert.equal(isAdaptationIntent(liveAdaptPrompt), true, "isAdaptationIntent must detect adaptation prompt");

    // 11.2: Explicit plan ID preservation for retrieval requests
    const extractedRetrievalId = extractExplicitPlanId(liveRetrievalPrompt);
    assert.equal(extractedRetrievalId, "adaptive-demo", "Explicit planId 'adaptive-demo' must be extracted from retrieval prompt");

    // 11.3: Tool validation rejects adapt_study_plan when invoked with retrieval reason or retrieval intent
    const adaptToolDef = {
        name: "adapt_study_plan",
        inputSchema: {
            type: "object",
            properties: {
                planId: { type: "string" },
                reason: { type: "string" },
                newExamDate: { type: "string" },
                newDailyAvailableHours: { type: "number" }
            }
        }
    };
    const invalidAdaptVal = validateToolArguments(adaptToolDef, {
        planId: "adaptive-demo",
        reason: liveRetrievalPrompt
    }, { userMessage: liveRetrievalPrompt });
    assert.equal(invalidAdaptVal.valid, false, "Validation must reject adapt_study_plan with retrieval prompt");
    assert.ok(invalidAdaptVal.error.includes("get_study_plan"), "Error must advise using get_study_plan instead");

    // 11.4: False success prevention: wrong tool or failed retrieval cannot report success
    const fakeWrongToolProvider = {
        async chat() {
            return {
                toolCalls: [],
                content: "Study plan adaptive-demo retrieved successfully! Everything looks great."
            };
        }
    };
    const wrongToolAgent = new AdaptiveAgent({
        provider: fakeWrongToolProvider,
        mcpClient: mcpManager,
        maxRounds: 2
    });
    const wrongToolRes = await wrongToolAgent.run({ message: liveRetrievalPrompt });
    assert.equal(wrongToolRes.success, false, "Retrieval without executing get_study_plan MUST fail");
    assert.ok(wrongToolRes.reply.includes("Action Failed"), "Reply must state action failed");

    // 11.5: End-to-end intent redirection: retrieval request invoking adapt_study_plan gets redirected to get_study_plan
    // Setup adaptive-demo with 3 subjects and recorded study sessions
    await mcpManager.callTool("create_study_plan", {
        planId: "adaptive-demo",
        subjects: ["Mathematics", "Physics", "Chemistry"],
        examDate: "2026-11-30",
        dailyAvailableHours: 3,
        priorities: { Mathematics: "high", Physics: "medium", Chemistry: "low" }
    });
    await mcpManager.callTool("record_study_session", {
        planId: "adaptive-demo",
        subject: "Mathematics",
        hoursSpent: 1.5,
        status: "completed",
        notes: "Calculus practice"
    });
    await mcpManager.callTool("record_study_session", {
        planId: "adaptive-demo",
        subject: "Chemistry",
        hoursSpent: 0,
        status: "missed",
        notes: "Lab session cancelled"
    });

    const liveRetrievalBugReproProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                // Simulates the observed live bug: LLM incorrectly chooses adapt_study_plan with retrieval prompt as reason
                return {
                    toolCalls: [
                        {
                            name: "adapt_study_plan",
                            arguments: {
                                planId: "adaptive-demo",
                                reason: liveRetrievalPrompt
                            }
                        }
                    ],
                    content: ""
                };
            }
            return {
                toolCalls: [],
                content: "Here is your retrieved study plan report."
            };
        }
    };

    const retrievalAgent = new AdaptiveAgent({
        provider: liveRetrievalBugReproProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const retrievalResult = await retrievalAgent.run({ message: liveRetrievalPrompt });
    assert.equal(retrievalResult.success, true, `Retrieval agent run must succeed: ${retrievalResult.reply}`);
    // Verify tool execution step redirected to get_study_plan
    const toolExecStep = retrievalResult.steps.find(s => s.type === "tool_executing");
    assert.ok(toolExecStep, "Must have executed a tool");
    assert.equal(toolExecStep.tool, "get_study_plan", "Must execute get_study_plan, NEVER adapt_study_plan");
    assert.equal(toolExecStep.arguments.planId, "adaptive-demo", "Must preserve planId 'adaptive-demo'");

    // 11.6: Retrieval response grounding verification
    const replyText = retrievalResult.reply;
    assert.ok(replyText.includes("adaptive-demo"), "Reply must include planId");
    assert.ok(replyText.includes("2026-11-30"), "Reply must include exam date 2026-11-30");
    assert.ok(/Mathematics/i.test(replyText), "Reply must include Mathematics");
    assert.ok(/Physics/i.test(replyText), "Reply must include Physics");
    assert.ok(/Chemistry/i.test(replyText), "Reply must include Chemistry");
    assert.ok(/HIGH/i.test(replyText) || /high/i.test(replyText), "Reply must report high priority");
    assert.ok(/MEDIUM/i.test(replyText) || /medium/i.test(replyText), "Reply must report medium priority");
    assert.ok(/LOW/i.test(replyText) || /low/i.test(replyText), "Reply must report low priority");
    assert.ok(/3\s*(?:hours?|hrs?)/i.test(replyText), "Reply must report daily availability of 3 hours");
    assert.ok(/session/i.test(replyText), "Reply must report recorded sessions");

    // 11.7: Adapting a three-subject plan preserves Chemistry, all priorities, exam date, and sessions
    const adaptPlanRes = await mcpManager.callTool("adapt_study_plan", {
        planId: "adaptive-demo",
        reason: "Rebalance schedule after missed Chemistry session"
    });
    assert.equal(adaptPlanRes.isError, false, "Live adaptation of adaptive-demo must succeed");
    const adaptData = JSON.parse(adaptPlanRes.content);
    assert.equal(adaptData.examDate, "2026-11-30", "Exam date must be returned and remain 2026-11-30");
    assert.equal(adaptData.dailyStudyHours, 3, "Daily study hours must remain 3");
    assert.ok(adaptData.adjustedSubjectAllocations.Chemistry, "Chemistry must be in adjusted allocations");
    assert.equal(adaptData.adjustedSubjectAllocations.Chemistry.priority, "low", "Chemistry priority must be 'low'");
    assert.equal(adaptData.adjustedSubjectAllocations.Mathematics.priority, "high", "Mathematics priority must be 'high'");
    assert.equal(adaptData.adjustedSubjectAllocations.Physics.priority, "medium", "Physics priority must be 'medium'");

    // Verify live MCP get_study_plan after adaptation
    const verifyPlanRes = await mcpManager.callTool("get_study_plan", { planId: "adaptive-demo" });
    assert.equal(verifyPlanRes.isError, false, "Retrieving adaptive-demo after adaptation must succeed");
    const verifiedPlan = JSON.parse(verifyPlanRes.content);
    assert.equal(verifiedPlan.planId, "adaptive-demo");
    assert.equal(verifiedPlan.examDate, "2026-11-30", "Persisted examDate must remain 2026-11-30");
    assert.equal(verifiedPlan.dailyStudyHours, 3, "Persisted dailyStudyHours must remain 3");
    assert.ok(verifiedPlan.subjects.Chemistry, "Persisted subjects must include Chemistry");
    assert.equal(verifiedPlan.subjects.Chemistry.priority, "low", "Persisted Chemistry priority must remain low");
    assert.equal(verifiedPlan.subjects.Mathematics.priority, "high", "Persisted Mathematics priority must remain high");
    assert.equal(verifiedPlan.subjects.Physics.priority, "medium", "Persisted Physics priority must remain medium");
    assert.equal(verifiedPlan.totalSessionsRecorded, 2, "Recorded session history must be preserved (2 sessions)");
    assert.ok(verifiedPlan.totalMissedHours > 0 || verifiedPlan.recentSessions.some(s => s.status === "missed"), "Missed session history must be preserved");

    console.log("✓ Test 11 PASSED: Intent-based tool selection, planId preservation, grounding, and plan fidelity verified!");

    // -------------------------------------------------------------
    // Test 12: Final-Answer Consistency Checker Exam Date Normalization Suite
    // -------------------------------------------------------------
    console.log("\n--- Test 12: Final-Answer Consistency Checker Exam Date Normalization Suite ---");

    // 12.1 Unit tests for strict calendar validation
    assert.equal(isValidCalendarDate(2026, 11, 30), true, "2026-11-30 is valid");
    assert.equal(isValidCalendarDate(2026, 2, 29), false, "2026-02-29 is not leap year");
    assert.equal(isValidCalendarDate(2024, 2, 29), true, "2024-02-29 is leap year");
    assert.equal(isValidCalendarDate(2026, 11, 31), false, "November 31 does not exist");
    assert.equal(isValidCalendarDate(2026, 13, 1), false, "Month 13 does not exist");
    console.log("✓ Strict calendar validation verified (leap years, month bounds, overflow prevention)");

    // 12.2 Unit tests for normalizeDateToISO
    assert.equal(normalizeDateToISO("2026-11-30"), "2026-11-30", "ISO format YYYY-MM-DD");
    assert.equal(normalizeDateToISO("2026/11/30"), "2026-11-30", "Slash-delimited YYYY/MM/DD");
    assert.equal(normalizeDateToISO("November 30, 2026"), "2026-11-30", "Full month Month DD, YYYY");
    assert.equal(normalizeDateToISO("November 30th, 2026"), "2026-11-30", "Ordinal Month DDth, YYYY");
    assert.equal(normalizeDateToISO("November 30 2026"), "2026-11-30", "Month DD YYYY without comma");
    assert.equal(normalizeDateToISO("Nov 30, 2026"), "2026-11-30", "Abbreviated month Nov DD, YYYY");
    assert.equal(normalizeDateToISO("Nov. 30, 2026"), "2026-11-30", "Abbreviated month with period Nov. DD, YYYY");
    assert.equal(normalizeDateToISO("Nov. 30th, 2026"), "2026-11-30", "Abbreviated month with ordinal Nov. DDth, YYYY");
    assert.equal(normalizeDateToISO("30 November 2026"), "2026-11-30", "Day-first format DD Month YYYY");
    assert.equal(normalizeDateToISO("30th November 2026"), "2026-11-30", "Day-first ordinal DDth Month YYYY");
    assert.equal(normalizeDateToISO("30th of November, 2026"), "2026-11-30", "Day-first with 'of' DDth of Month, YYYY");
    assert.equal(normalizeDateToISO("11/30/2026"), "2026-11-30", "Numeric MM/DD/YYYY");
    assert.equal(normalizeDateToISO("not-a-date"), null, "Invalid date string returns null");
    assert.equal(normalizeDateToISO("November 31, 2026"), null, "Invalid calendar date returns null");
    console.log("✓ Date parser accurately normalizes equivalent representations to canonical ISO YYYY-MM-DD");

    // 12.3 Unit tests for isExamDateContradicted
    assert.equal(isExamDateContradicted("Your exam date is 2026-11-30.", "2026-11-30"), false);
    assert.equal(isExamDateContradicted("Your exam date is November 30, 2026.", "2026-11-30"), false);
    assert.equal(isExamDateContradicted("Your exam date is November 30th, 2026.", "2026-11-30"), false);
    assert.equal(isExamDateContradicted("Your target exam date is Nov 30, 2026.", "2026-11-30"), false);
    assert.equal(isExamDateContradicted("The exam is scheduled for 30 November 2026.", "2026-11-30"), false);
    assert.equal(isExamDateContradicted("The exam is scheduled for 30th of November, 2026.", "2026-11-30"), false);
    assert.equal(isExamDateContradicted("Your exam date is December 25, 2026.", "2026-11-30"), true);
    assert.equal(isExamDateContradicted("Your study plan has Mathematics, Physics, and Chemistry.", "2026-11-30"), false);
    console.log("✓ isExamDateContradicted accepts equivalent representations, ignores omitted dates, and rejects contradictory dates");

    // 12.4 verifyFinalAnswerConsistency: Regression tests for equivalent formats (Retrieval intent)
    const mockRetrievalTools = [
        {
            toolName: "get_study_plan",
            isError: false,
            parsedData: {
                planId: "adaptive-demo",
                examDate: "2026-11-30",
                dailyStudyHours: 3,
                daysRemaining: 49,
                subjects: {
                    Mathematics: { allocatedHours: 74, priority: "high" },
                    Physics: { allocatedHours: 49, priority: "medium" },
                    Chemistry: { allocatedHours: 25.9, priority: "low" }
                },
                recentSessions: [
                    { subject: "Mathematics", hoursSpent: 1.5, status: "completed" },
                    { subject: "Chemistry", hoursSpent: 0, status: "missed" }
                ],
                totalSessionsRecorded: 2,
                totalMissedHours: 2
            }
        }
    ];
    const userRetrievalMessage = "Retrieve study plan adaptive-demo. Report every subject, exam date, daily availability.";

    // Equivalent Format A: "2026-11-30" (exact ISO)
    const replyIso = `Here is your study plan details for "adaptive-demo":
- Exam Date: 2026-11-30
- Daily Available Study Time: 3 hours/day
- Subjects: Mathematics (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkIso = verifyFinalAnswerConsistency(replyIso, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkIso.valid, true, "Exact ISO format '2026-11-30' must pass consistency check");

    // Equivalent Format B: "November 30, 2026" (Full month natural language)
    const replyNaturalFull = `Here is your study plan details for "adaptive-demo":
- Exam Date: November 30, 2026
- Daily Available Study Time: 3 hours/day
- Subjects: Mathematics (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkNaturalFull = verifyFinalAnswerConsistency(replyNaturalFull, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkNaturalFull.valid, true, "Equivalent format 'November 30, 2026' must pass without false positive");

    // Equivalent Format C: "November 30th, 2026" (Ordinal natural language)
    const replyOrdinal = `Here is your study plan details for "adaptive-demo":
- Exam Date: November 30th, 2026
- Daily Available Study Time: 3 hours/day
- Subjects: Mathematics (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkOrdinal = verifyFinalAnswerConsistency(replyOrdinal, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkOrdinal.valid, true, "Equivalent format 'November 30th, 2026' must pass without false positive");

    // Equivalent Format D: "Nov 30, 2026" (Abbreviated month)
    const replyAbbrev = `Here is your study plan details for "adaptive-demo":
- Exam Date: Nov 30, 2026
- Daily Available Study Time: 3 hours/day
- Subjects: Mathematics (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkAbbrev = verifyFinalAnswerConsistency(replyAbbrev, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkAbbrev.valid, true, "Equivalent format 'Nov 30, 2026' must pass without false positive");

    // Equivalent Format E: "30 November 2026" (Day-first natural language)
    const replyDayFirst = `Here is your study plan details for "adaptive-demo":
- Exam Date: 30 November 2026
- Daily Available Study Time: 3 hours/day
- Subjects: Mathematics (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkDayFirst = verifyFinalAnswerConsistency(replyDayFirst, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkDayFirst.valid, true, "Equivalent format '30 November 2026' must pass without false positive");

    console.log("✓ Regression tests PASSED for equivalent date formats: 2026-11-30, November 30, 2026, November 30th, 2026, Nov 30, 2026, 30 November 2026");

    // 12.5 Negative tests: Genuinely incorrect exam date
    const replyWrongDateNatural = `Here is your study plan details for "adaptive-demo":
- Exam Date: December 25, 2026
- Daily Available Study Time: 3 hours/day
- Subjects: Mathematics (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkWrongDateNatural = verifyFinalAnswerConsistency(replyWrongDateNatural, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkWrongDateNatural.valid, false, "Genuinely incorrect date 'December 25, 2026' must be rejected");
    assert.equal(checkWrongDateNatural.reason, 'Final reply omitted or contradicted exam date "2026-11-30".');
    console.log("✓ Negative test PASSED: Genuinely incorrect date 'December 25, 2026' correctly flagged");

    const replyWrongDateIso = `Here is your study plan details for "adaptive-demo":
- Exam Date: 2026-12-15
- Daily Available Study Time: 3 hours/day
- Subjects: Mathematics (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkWrongDateIso = verifyFinalAnswerConsistency(replyWrongDateIso, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkWrongDateIso.valid, false, "Genuinely incorrect ISO date '2026-12-15' must be rejected");
    assert.equal(checkWrongDateIso.reason, 'Final reply omitted or contradicted exam date "2026-11-30".');
    console.log("✓ Negative test PASSED: Genuinely incorrect ISO date '2026-12-15' correctly flagged");

    // 12.6 Negative tests: Omitted exam date
    const replyOmittedDate = `Here is your study plan details for "adaptive-demo":
- Daily Available Study Time: 3 hours/day
- Subjects: Mathematics (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkOmittedDate = verifyFinalAnswerConsistency(replyOmittedDate, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkOmittedDate.valid, false, "Omission of exam date must be rejected");
    assert.equal(checkOmittedDate.reason, 'Final reply omitted or contradicted exam date "2026-11-30".');
    console.log("✓ Negative test PASSED: Omitted exam date correctly flagged");

    // 12.7 Negative tests: Contradictory stated exam date when another date exists in text
    const replyContradictoryWithOtherDate = `Here is your study plan details for "adaptive-demo":
- Exam Date: December 25, 2026
- Daily Available Study Time: 3 hours/day
- Subjects: Mathematics (high priority), Physics (medium priority), Chemistry (low priority)
- A study session was recorded on 2026-11-30.`;
    const checkContradictoryWithOtherDate = verifyFinalAnswerConsistency(replyContradictoryWithOtherDate, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkContradictoryWithOtherDate.valid, false, "Stated exam date of 2026-12-25 contradicting target 2026-11-30 must be rejected even if 2026-11-30 appears elsewhere");
    assert.equal(checkContradictoryWithOtherDate.reason, 'Final reply omitted or contradicted exam date "2026-11-30".');
    console.log("✓ Negative test PASSED: Explicit contradiction with secondary session date correctly flagged");

    // 12.8 Consistency verification without userMessage (Section 2 tool verification fallback)
    const checkSection2Equivalent = verifyFinalAnswerConsistency(replyNaturalFull, mockRetrievalTools);
    assert.equal(checkSection2Equivalent.valid, true, "Section 2 fallback must accept equivalent format 'November 30, 2026'");

    const checkSection2Wrong = verifyFinalAnswerConsistency(replyWrongDateNatural, mockRetrievalTools);
    assert.equal(checkSection2Wrong.valid, false, "Section 2 fallback must reject wrong exam date");
    assert.equal(checkSection2Wrong.reason, 'Final reply omitted or contradicted exam date "2026-11-30".');
    console.log("✓ Section 2 tool consistency fallback verified for equivalent and contradictory dates");

    // -------------------------------------------------------------
    // Test 13: Final-Answer Consistency Checker Subject Omission & Focused Retrieval Suite
    // -------------------------------------------------------------
    console.log("\n--- Test 13: Final-Answer Consistency Checker Subject Omission & Focused Retrieval Suite ---");

    // 13.1 Unit tests for replyMentionsSubject: exact name, aliases (Math/Maths), case-insensitivity, boundary checks
    assert.equal(replyMentionsSubject("Mathematics has 74 hours allocated.", "Mathematics"), true, "Matches exact name");
    assert.equal(replyMentionsSubject("Math has 74 hours allocated.", "Mathematics"), true, "Matches Math alias");
    assert.equal(replyMentionsSubject("Maths has 74 hours allocated.", "Mathematics"), true, "Matches Maths alias");
    assert.equal(replyMentionsSubject("math: 74 hours allocated.", "Mathematics"), true, "Matches lowercase math alias");
    assert.equal(replyMentionsSubject("MATHS: 74 hours allocated.", "Mathematics"), true, "Matches uppercase MATHS alias");
    assert.equal(replyMentionsSubject("- **Math** (HIGH): 74h", "Mathematics"), true, "Matches markdown formatted **Math**");
    assert.equal(replyMentionsSubject("- **Maths** (HIGH): 74h", "Mathematics"), true, "Matches markdown formatted **Maths**");
    assert.equal(replyMentionsSubject("In the aftermath of the test", "Mathematics"), false, "Must not match 'aftermath'");
    assert.equal(replyMentionsSubject("A polymath approach to study", "Mathematics"), false, "Must not match 'polymath'");
    console.log("✓ replyMentionsSubject correctly matches Mathematics, Math, Maths, and avoids false substrings");

    // 13.2 Unit tests for replyMentionsSubject: regex-special-character subjects (C++, R&D, etc.)
    assert.equal(replyMentionsSubject("I study C++ every day.", "C++"), true, "Matches C++ in sentence");
    assert.equal(replyMentionsSubject("- **C++**: 50 hours allocated.", "C++"), true, "Matches markdown formatted **C++**");
    assert.equal(replyMentionsSubject("What about C++?", "C++"), true, "Matches C++ before punctuation");
    assert.equal(replyMentionsSubject("What about C++programming?", "C++"), false, "Does not match C++ inside C++programming token");
    assert.equal(replyMentionsSubject("Project R&D has 40 hours.", "R&D"), true, "Matches R&D safely without regex error");
    assert.equal(replyMentionsSubject("Math (Advanced) is high priority.", "Math (Advanced)"), true, "Matches subject with parentheses safely");
    console.log("✓ replyMentionsSubject safely handles subjects with regex metacharacters (C++, R&D, Math (Advanced))");

    // 13.3 Integration: verifyFinalAnswerConsistency with Math and Maths aliases (Full-plan retrieval)
    const replyWithMathAlias = `Here is your study plan details for "adaptive-demo":
- Exam Date: 2026-11-30
- Daily Available Study Time: 3 hours/day
- Subjects: Math (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkMathAlias = verifyFinalAnswerConsistency(replyWithMathAlias, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkMathAlias.valid, true, "Full plan reply with 'Math' alias must pass consistency check without false positive");

    const replyWithMathsAlias = `Here is your study plan details for "adaptive-demo":
- Exam Date: 2026-11-30
- Daily Available Study Time: 3 hours/day
- Subjects: Maths (high priority), Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkMathsAlias = verifyFinalAnswerConsistency(replyWithMathsAlias, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkMathsAlias.valid, true, "Full plan reply with 'Maths' alias must pass consistency check without false positive");
    console.log("✓ Full-plan retrieval accepts 'Math' and 'Maths' aliases without false positive omission");

    // 13.4 Integration: verifyFinalAnswerConsistency with regex-special-character subjects
    const mockSpecialCharTools = [
        {
            toolName: "get_study_plan",
            isError: false,
            parsedData: {
                planId: "special-plan",
                examDate: "2026-11-30",
                dailyStudyHours: 3,
                subjects: {
                    "C++": { allocatedHours: 60, priority: "high" },
                    "R&D": { allocatedHours: 40, priority: "medium" }
                }
            }
        }
    ];
    const replySpecialChars = `Study plan details for "special-plan":
- Exam Date: 2026-11-30
- Subjects: C++ (high priority), R&D (medium priority)`;
    const checkSpecialChars = verifyFinalAnswerConsistency(replySpecialChars, mockSpecialCharTools, "Retrieve study plan special-plan.");
    assert.equal(checkSpecialChars.valid, true, "Subjects with metacharacters (C++, R&D) must be checked safely without regex errors");
    console.log("✓ Retrieval consistency safely handles plans containing metacharacters (C++, R&D)");

    // 13.5 Genuine omissions in full-plan retrieval
    const replyOmittedMath = `Here is your study plan details for "adaptive-demo":
- Exam Date: 2026-11-30
- Daily Available Study Time: 3 hours/day
- Subjects: Physics (medium priority), Chemistry (low priority)
- 2 recorded study sessions.`;
    const checkOmittedMath = verifyFinalAnswerConsistency(replyOmittedMath, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkOmittedMath.valid, false, "Genuinely omitted subject Mathematics must be flagged");
    assert.equal(checkOmittedMath.reason, 'Final reply omitted subject "Mathematics" from retrieved plan.');
    assert.ok(checkOmittedMath.correctedReply.includes("Mathematics"), "Grounded fallback summary must include omitted subject");

    // Generic filler response omitting all subjects
    const replyGenericFiller = "Here is your retrieved study plan report.";
    const checkGenericFiller = verifyFinalAnswerConsistency(replyGenericFiller, mockRetrievalTools, userRetrievalMessage);
    assert.equal(checkGenericFiller.valid, false, "Generic filler reply omitting subjects must be flagged");
    assert.equal(checkGenericFiller.reason, 'Final reply omitted subject "Mathematics" from retrieved plan.');
    console.log("✓ Genuine omissions in full-plan retrieval correctly intercepted and grounded");

    // 13.6 Focused retrieval questions: Single-subject intent does NOT require all subjects
    const focusedChemMessage = "How many hours do I have for Chemistry in adaptive-demo?";
    const replyFocusedChem = `In adaptive-demo, you have 25.9 hours allocated for Chemistry (low priority). Your exam date is 2026-11-30.`;
    const checkFocusedChem = verifyFinalAnswerConsistency(replyFocusedChem, mockRetrievalTools, focusedChemMessage);
    assert.equal(checkFocusedChem.valid, true, "Focused retrieval asking for Chemistry only must NOT require Mathematics or Physics");

    const focusedMathMessage = "What is my progress in Math?";
    const replyFocusedMath = `In Math, you have completed 1.5 hours out of 74 allocated hours. Exam date: 2026-11-30.`;
    const checkFocusedMath = verifyFinalAnswerConsistency(replyFocusedMath, mockRetrievalTools, focusedMathMessage);
    assert.equal(checkFocusedMath.valid, true, "Focused retrieval asking for Math only must pass using Math alias without requiring Physics or Chemistry");

    // Focused retrieval where the requested subject IS omitted
    const replyFocusedOmission = "Here is your progress report. Exam date: 2026-11-30.";
    const checkFocusedOmission = verifyFinalAnswerConsistency(replyFocusedOmission, mockRetrievalTools, focusedChemMessage);
    assert.equal(checkFocusedOmission.valid, false, "Focused retrieval omitting the requested subject must be flagged");
    assert.equal(checkFocusedOmission.reason, 'Final reply omitted subject "Chemistry" from retrieved plan.');

    // Full-plan retrieval intent with single-subject reply MUST fail
    const checkFullPlanSingleSub = verifyFinalAnswerConsistency(replyFocusedChem, mockRetrievalTools, "Retrieve study plan adaptive-demo. Report all subjects.");
    assert.equal(checkFullPlanSingleSub.valid, false, "Full-plan retrieval request with only Chemistry in reply must fail for omitting Mathematics");
    assert.equal(checkFullPlanSingleSub.reason, 'Final reply omitted subject "Mathematics" from retrieved plan.');
    console.log("✓ Focused vs. full-plan retrieval correctly distinguished based on user intent");

    // =========================================================================
    // SECTION 14: Mutation Response Generation, Grounding & Integrity Verification
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- SECTION 14: Mutation Response Generation & Grounding ---");
    console.log("=======================================================");

    const mockSessionResultData = {
        message: 'Study session for "Mathematics" recorded successfully (completed).',
        session: {
            id: "session-abc-123",
            subject: "Mathematics",
            hoursSpent: 2,
            status: "completed",
            date: "2026-10-12",
            notes: "Calculus practice"
        },
        subjectProgress: {
            subject: "Mathematics",
            completedHours: 2,
            missedHours: 0,
            remainingHours: 10,
            progressPercentage: "16.7%"
        },
        overallPlanProgress: "16.7%"
    };

    const mockSessionTools = [
        {
            toolName: "record_study_session",
            toolArgs: {
                planId: "adaptive-demo",
                subject: "Mathematics",
                hoursSpent: 2,
                status: "completed"
            },
            isError: false,
            content: JSON.stringify(mockSessionResultData),
            parsedData: mockSessionResultData
        }
    ];

    // 14.1 formatGroundedSessionSummary formats all required fields accurately
    const formattedSession = formatGroundedSessionSummary(mockSessionResultData, { subject: "Mathematics" });
    assert.ok(formattedSession.includes("Study session recorded successfully!"), "Header must confirm success");
    assert.ok(formattedSession.includes("**Subject:** Mathematics"), "Must include subject");
    assert.ok(formattedSession.includes("**Status:** Completed"), "Must include status");
    assert.ok(formattedSession.includes("**Hours Spent:** 2 hours"), "Must include hours spent");
    assert.ok(formattedSession.includes("**Completed Hours:** 2h"), "Must include completed hours");
    assert.ok(formattedSession.includes("**Remaining Hours:** 10h"), "Must include remaining hours");
    assert.ok(formattedSession.includes("**Missed Hours:** 0h"), "Must include missed hours");
    assert.ok(formattedSession.includes("**Subject Progress:** 16.7%"), "Must include progress percentage");
    assert.ok(formattedSession.includes("**Overall Plan Progress:** 16.7%"), "Must include overall plan progress");
    assert.ok(formattedSession.includes("**Notes:** Calculus practice"), "Must include session notes");
    console.log("✓ formatGroundedSessionSummary verified with all required fields");

    // 14.2 Generic unhelpful final reply after record_study_session is intercepted and grounded
    const genericSessionReply = "I have processed your Mathematics request.";
    const checkGenericSession = verifyFinalAnswerConsistency(genericSessionReply, mockSessionTools, "Record that I completed 2 hours of Mathematics for plan adaptive-demo.");
    assert.equal(checkGenericSession.valid, false, "Generic final reply must be flagged as invalid");
    assert.equal(checkGenericSession.reason, "Final reply was generic or omitted verified session hours and progress metrics.");
    assert.ok(checkGenericSession.correctedReply.includes("**Completed Hours:** 2h"), "Corrected reply must contain completed hours");
    assert.ok(checkGenericSession.correctedReply.includes("**Remaining Hours:** 10h"), "Corrected reply must contain remaining hours");
    console.log("✓ Generic unhelpful reply after record_study_session intercepted and grounded with verified metrics");

    // 14.3 Reply omitting subject after record_study_session is intercepted
    const replyOmittedSubject = "Recorded a 2-hour study session with 16.7% progress.";
    const checkSubjectOmission = verifyFinalAnswerConsistency(replyOmittedSubject, mockSessionTools, "Record that I completed 2 hours of Mathematics.");
    assert.equal(checkSubjectOmission.valid, false, "Reply omitting subject must be flagged");
    assert.equal(checkSubjectOmission.reason, 'Final reply omitted subject "Mathematics" from recorded session confirmation.');

    // Completely generic reply omitting both subject and metrics
    const checkTotallyGeneric = verifyFinalAnswerConsistency("I have processed your request.", mockSessionTools, "Record that I completed 2 hours of Mathematics.");
    assert.equal(checkTotallyGeneric.valid, false, "Completely generic reply must be flagged");
    assert.ok(checkTotallyGeneric.correctedReply.includes("**Subject:** Mathematics"), "Grounded summary must supply subject");
    console.log("✓ Subject omission in recorded session confirmation intercepted");

    // 14.4 Missed session grounded confirmation
    const mockMissedResultData = {
        message: 'Study session for "Mathematics" recorded successfully (missed).',
        session: {
            id: "session-missed-1",
            subject: "Mathematics",
            hoursSpent: 0,
            status: "missed",
            date: "2026-10-12",
            notes: "Missed due to illness"
        },
        subjectProgress: {
            subject: "Mathematics",
            completedHours: 2,
            missedHours: 2,
            remainingHours: 10,
            progressPercentage: "16.7%"
        },
        overallPlanProgress: "16.7%"
    };
    const mockMissedTools = [
        {
            toolName: "record_study_session",
            toolArgs: { subject: "Mathematics", hoursSpent: 0, status: "missed" },
            isError: false,
            content: JSON.stringify(mockMissedResultData),
            parsedData: mockMissedResultData
        }
    ];
    const formattedMissed = formatGroundedSessionSummary(mockMissedResultData, { subject: "Mathematics" });
    assert.ok(formattedMissed.includes("**Status:** Missed"), "Must report Missed status");
    assert.ok(formattedMissed.includes("**Hours Spent:** 0 hours"), "Must report 0 hours spent");
    assert.ok(formattedMissed.includes("**Missed Hours:** 2h"), "Must report updated missed hours");

    // Check false completion detection: reply falsely claims missed session was completed
    const falseCompletedReply = "Successfully completed 2 hours of Mathematics study session.";
    const checkFalseCompletion = verifyFinalAnswerConsistency(falseCompletedReply, mockMissedTools, "Log missed Mathematics session");
    assert.equal(checkFalseCompletion.valid, false, "Falsely claiming completed when session was missed must be flagged");
    assert.equal(checkFalseCompletion.reason, "Final reply claimed session was completed when it was recorded as missed.");
    console.log("✓ Missed session formatted properly and false-completion contradiction detected");

    // 14.5 Valid detailed reply is preserved without unnecessary overwrite
    const accurateReply = "Recorded 2 hours for Mathematics. Completed: 2h, Remaining: 10h, Progress: 16.7%.";
    const checkAccurateReply = verifyFinalAnswerConsistency(accurateReply, mockSessionTools, "Record 2 hours of Mathematics");
    assert.equal(checkAccurateReply.valid, true, "Already accurate reply must pass without being overwritten");

    // Valid reply using 'Math' alias passes
    const mathAliasReply = "Logged 2 hours for Math study session. Progress is now 16.7%.";
    const checkMathAliasSession = verifyFinalAnswerConsistency(mathAliasReply, mockSessionTools, "Record 2 hours of Mathematics");
    assert.equal(checkMathAliasSession.valid, true, "Accurate reply using Math alias must pass");
    console.log("✓ Accurate and alias-based session confirmations safely preserved");

    // 14.6 adapt_study_plan grounded confirmation on generic reply
    const mockAdaptData = {
        message: "Study plan adapted successfully!",
        planId: "adaptive-demo",
        examDate: "2026-11-30",
        dailyStudyHours: 3,
        daysRemaining: 49,
        recommendedDailyHours: 4,
        capacityWarning: "Recommended daily study exceeds available time",
        reason: "Missed Mathematics session recovery",
        adjustedSubjectAllocations: {
            Mathematics: { priority: "high", allocatedHours: 160, completedHours: 2, remainingHours: 158, progress: "1.3%" },
            Physics: { priority: "medium", allocatedHours: 106.7, completedHours: 0, remainingHours: 106.7, progress: "0%" }
        }
    };
    const mockAdaptTools = [
        {
            toolName: "adapt_study_plan",
            toolArgs: { planId: "adaptive-demo", reason: "Missed Mathematics session recovery" },
            isError: false,
            content: JSON.stringify(mockAdaptData),
            parsedData: mockAdaptData
        }
    ];
    const genericAdaptReply = "I have adapted your study plan.";
    const checkGenericAdapt = verifyFinalAnswerConsistency(genericAdaptReply, mockAdaptTools, "Adapt study plan adaptive-demo");
    assert.equal(checkGenericAdapt.valid, false, "Generic reply after adapt_study_plan must be flagged");
    assert.equal(checkGenericAdapt.reason, "Final reply was generic or omitted verified plan adaptation details.");
    assert.ok(checkGenericAdapt.correctedReply.includes("**Recommended Daily Pace:** 4 hours/day"), "Must report recommended daily pace");
    assert.ok(checkGenericAdapt.correctedReply.includes("Mathematics"), "Must report Mathematics adjustment");
    assert.ok(checkGenericAdapt.correctedReply.includes("158h remaining"), "Must report remaining hours");
    assert.ok(checkGenericAdapt.correctedReply.includes("Recommended daily study exceeds available time"), "Must report capacity warning");
    console.log("✓ Generic reply after adapt_study_plan intercepted and grounded with adaptation details");

    // 14.7 Missing or incomplete tool results caught by verifyToolResult
    const incompleteSessionNoSession = verifyToolResult("record_study_session", { subject: "Mathematics" }, {
        isError: false,
        content: JSON.stringify({ message: "Done" }) // missing session and subjectProgress
    });
    assert.equal(incompleteSessionNoSession.valid, false, "Result missing session must fail verification");
    assert.ok(incompleteSessionNoSession.error.includes("missing recorded session details"));

    const incompleteSessionNoProgress = verifyToolResult("record_study_session", { subject: "Mathematics" }, {
        isError: false,
        content: JSON.stringify({ message: "Done", session: { subject: "Mathematics", hoursSpent: 2, status: "completed" } })
    });
    assert.equal(incompleteSessionNoProgress.valid, false, "Result missing subjectProgress must fail verification");
    assert.ok(incompleteSessionNoProgress.error.includes("missing updated subject progress"));

    const subjectMismatchResult = verifyToolResult("record_study_session", { subject: "Mathematics" }, {
        isError: false,
        content: JSON.stringify({
            session: { subject: "Physics", hoursSpent: 2, status: "completed" },
            subjectProgress: { subject: "Physics", completedHours: 2, remainingHours: 10 }
        })
    });
    assert.equal(subjectMismatchResult.valid, false, "Subject mismatch must fail verification");
    assert.ok(subjectMismatchResult.error.includes("subject mismatch"));

    const incompleteAdaptResult = verifyToolResult("adapt_study_plan", { planId: "adaptive-demo" }, {
        isError: false,
        content: JSON.stringify({ message: "Adapted", adjustedSubjectAllocations: {} })
    });
    assert.equal(incompleteAdaptResult.valid, false, "Empty allocations in adapt result must fail verification");
    console.log("✓ Incomplete or mismatched tool results strictly caught by verifyToolResult");

    // 14.8 False-success prevention: User intent without tool execution
    const checkNoToolSession = verifyFinalAnswerConsistency("I have recorded your 2 hours of Mathematics.", [], "Record that I completed 2 hours of Mathematics");
    assert.equal(checkNoToolSession.valid, false, "False success claiming session recorded without executing tool must fail");
    assert.equal(checkNoToolSession.failure, true, "Must flag failure: true");
    assert.ok(checkNoToolSession.correctedReply.includes("Action Failed:"), "Corrected reply must report Action Failed");

    const checkNoToolAdapt = verifyFinalAnswerConsistency("I have adapted your study plan schedule.", [], "Adapt study plan adaptive-demo");
    assert.equal(checkNoToolAdapt.valid, false, "False success claiming adaptation without executing tool must fail");
    assert.equal(checkNoToolAdapt.failure, true, "Must flag failure: true");
    assert.ok(checkNoToolAdapt.correctedReply.includes("Action Failed:"), "Corrected reply must report Action Failed");
    console.log("✓ False-success detection verified for mutation intents without tool execution");

    // 14.9 End-to-end agent execution with live MCP: generic LLM response grounded
    try {
        const e2eTestPlanId = `e2e_mutation_${Date.now()}`;
        const createPlanRes = await mcpManager.callTool("create_study_plan", {
            planId: e2eTestPlanId,
            subjects: ["Mathematics", "Physics"],
            examDate: "2026-11-30",
            dailyAvailableHours: 3
        });
        assert.equal(createPlanRes.isError, false, "E2E test plan creation must succeed");

        const liveGenericSessionProvider = {
            callCount: 0,
            async chat() {
                this.callCount++;
                if (this.callCount === 1) {
                    return {
                        toolCalls: [
                            {
                                name: "record_study_session",
                                arguments: {
                                    planId: e2eTestPlanId,
                                    subject: "Mathematics",
                                    hoursSpent: 2,
                                    status: "completed"
                                }
                            }
                        ],
                        content: ""
                    };
                }
                return {
                    toolCalls: [],
                    content: "I have processed your request." // Generic unhelpful model response!
                };
            }
        };

        const liveSessionAgent = new AdaptiveAgent({
            provider: liveGenericSessionProvider,
            mcpClient: mcpManager,
            maxRounds: 3
        });

        const liveAgentResult = await liveSessionAgent.run({
            message: `Record that I completed a 2-hour study session in Mathematics for plan "${e2eTestPlanId}".`
        });

        assert.equal(liveAgentResult.success, true, "Agent run must succeed");
        assert.ok(liveAgentResult.reply.includes("Study session recorded successfully!"), "Reply must be grounded in verified summary");
        assert.ok(liveAgentResult.reply.includes("**Subject:** Mathematics"), "Reply must confirm Mathematics");
        assert.ok(liveAgentResult.reply.includes("**Completed Hours:**"), "Reply must report completed hours");
        assert.ok(liveAgentResult.reply.includes("**Remaining Hours:**"), "Reply must report remaining hours");
        assert.ok(liveAgentResult.reply.includes("**Overall Plan Progress:**"), "Reply must report overall plan progress");
        assert.ok(!liveAgentResult.reply.includes("I have processed your request."), "Generic model response must be replaced by grounded summary");
        const liveMutationGroundedStep = liveAgentResult.steps.find(s => s.type === "final_answer_grounded");
        assert.ok(liveMutationGroundedStep, "Agent must record final_answer_grounded step in trajectory");
        console.log("✓ End-to-end live agent test verified: generic model reply replaced by concise grounded confirmation with progress metrics!");
    } finally {
        await mcpManager.disconnect();
    }

    // =========================================================================
    // SECTION 15: Postman Regression Suite: Duplicate Mutation Protection,
    // Session Date Grounding & Grounded Final Response Hardening
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- SECTION 15: Duplicate Protection, Date & Grounding ---");
    console.log("=======================================================");

    // 15.1 Session Date Grounding: Relative "today" omitted so server default applies
    const mockSessionToolDef = {
        name: "record_study_session",
        inputSchema: {
            type: "object",
            required: ["subject", "hoursSpent", "status"],
            properties: {
                subject: { type: "string" },
                hoursSpent: { type: "number" },
                status: { type: "string" },
                date: { type: "string" },
                planId: { type: "string" }
            }
        }
    };

    const normDateToday = normalizeToolArguments(mockSessionToolDef, {
        subject: "Mathematics",
        hoursSpent: "2",
        status: "completed",
        date: "today"
    }, { message: "Record that I completed a 2-hour study session today in Mathematics." });
    assert.equal(normDateToday.date, undefined, "Relative date 'today' must be omitted so server default applies");
    assert.equal(normDateToday.hoursSpent, 2, "hoursSpent normalized to number");

    // 15.2 Session Date Grounding: Fabricated historical date (e.g. 2024-01-01) omitted when user requested "today"
    const normDateFabricatedToday = normalizeToolArguments(mockSessionToolDef, {
        subject: "Mathematics",
        hoursSpent: 2,
        status: "completed",
        date: "2024-01-01"
    }, { message: "Record that I completed a 2-hour study session today in Mathematics." });
    assert.equal(normDateFabricatedToday.date, undefined, "Fabricated date 2024-01-01 must be omitted when user requested today");

    // 15.3 Session Date Grounding: Fabricated historical date omitted when no date was requested
    const normDateFabricatedOmitted = normalizeToolArguments(mockSessionToolDef, {
        subject: "Mathematics",
        hoursSpent: 2,
        status: "completed",
        date: "2024-01-01"
    }, { message: "Record that I completed a 2-hour study session in Mathematics." });
    assert.equal(normDateFabricatedOmitted.date, undefined, "Fabricated date 2024-01-01 must be omitted when no date was in user message");

    // 15.4 Session Date Grounding: Explicit user date preserved
    const normDateExplicit = normalizeToolArguments(mockSessionToolDef, {
        subject: "Mathematics",
        hoursSpent: 2,
        status: "completed",
        date: "2026-10-09"
    }, { message: "Record that I completed a 2-hour study session on 2026-10-09 in Mathematics." });
    assert.equal(normDateExplicit.date, "2026-10-09", "Explicit date 2026-10-09 from user message must be preserved");

    // 15.5 Session Date Grounding: User gave explicit date in message, model generated 'today'
    const normDateExplicitRestored = normalizeToolArguments(mockSessionToolDef, {
        subject: "Mathematics",
        hoursSpent: 2,
        status: "completed",
        date: "today"
    }, { message: "Record that I completed a 2-hour study session on 2026-10-09 in Mathematics." });
    assert.equal(normDateExplicitRestored.date, "2026-10-09", "Explicit date 2026-10-09 restored from user message even if model said today");
    console.log("✓ Session date grounding verified: relative 'today' and fabricated dates omitted; explicit dates preserved");

    // 15.6 Grounded Final Responses: Raw JSON study plan dump intercepted
    const mockSessionResult = {
        message: 'Study session for "Mathematics" recorded successfully (completed).',
        session: { subject: "Mathematics", hoursSpent: 2, status: "completed", date: "2026-10-12" },
        subjectProgress: { subject: "Mathematics", completedHours: 2, missedHours: 0, remainingHours: 10, progressPercentage: "16.7%" },
        overallPlanProgress: "16.7%"
    };
    const executedSessionTools = [{
        toolName: "record_study_session",
        toolArgs: { subject: "Mathematics", hoursSpent: 2, status: "completed" },
        isError: false,
        content: JSON.stringify(mockSessionResult),
        parsedData: mockSessionResult
    }];

    const rawJsonPlanReply = JSON.stringify({
        planId: "adaptive-demo",
        examDate: "2024-10-31",
        subjects: { Mathematics: { allocatedHours: 60 } },
        sessions: []
    });
    const checkRawJsonPlan = verifyFinalAnswerConsistency(rawJsonPlanReply, executedSessionTools, "Record 2 hours Mathematics");
    assert.equal(checkRawJsonPlan.valid, false, "Raw JSON plan object must be flagged as invalid");
    assert.equal(checkRawJsonPlan.reason, "Final reply was a raw JSON object or code block instead of a grounded session confirmation.");
    assert.ok(checkRawJsonPlan.correctedReply.includes("Study session recorded successfully!"), "Corrected reply must be grounded session summary");

    // 15.7 Grounded Final Responses: Markdown fabricating unrelated exam date intercepted
    const replyFabricatedExamDate = "Here is your update for Mathematics. Exam date: 2024-10-31. Completed 2 hours of study session with 16.7% progress.";
    const checkFabricatedExamDate = verifyFinalAnswerConsistency(replyFabricatedExamDate, executedSessionTools, "Record 2 hours Mathematics");
    assert.equal(checkFabricatedExamDate.valid, false, "Reply fabricating exam date after session recording must be flagged");
    assert.equal(checkFabricatedExamDate.reason, "Final reply presented unrelated study plan details (e.g. exam date) instead of a grounded session confirmation.");
    assert.ok(checkFabricatedExamDate.correctedReply.includes("**Completed Hours:** 2h"), "Corrected reply must provide verified metrics");

    // 15.8 Grounded Final Responses: Markdown fabricating full study plan details intercepted
    const replyFabricatedPlanDetails = "Study plan details: daily available study time: 3 hours/day. Recorded session in Mathematics completed.";
    const checkFabricatedPlanDetails = verifyFinalAnswerConsistency(replyFabricatedPlanDetails, executedSessionTools, "Record 2 hours Mathematics");
    assert.equal(checkFabricatedPlanDetails.valid, false, "Reply fabricating study plan details overview must be flagged");
    assert.equal(checkFabricatedPlanDetails.reason, "Final reply presented unrelated study plan details (e.g. exam date) instead of a grounded session confirmation.");

    // 15.9 Grounded Final Responses: Accurate session confirmation passes
    const validSessionReply = "Recorded your 2-hour study session for Mathematics. Completed hours: 2h, remaining: 10h, progress: 16.7%.";
    const checkValidSessionReply = verifyFinalAnswerConsistency(validSessionReply, executedSessionTools, "Record 2 hours Mathematics");
    assert.equal(checkValidSessionReply.valid, true, "Accurate session confirmation must pass without modification");
    console.log("✓ Grounded final response hardening verified: raw JSON and fabricated plan fields intercepted");

    // 15.10 Duplicate Mutation Protection: Single round parallel duplicate calls
    let mcpCalls = [];
    const mockMcpForDup = {
        listTools: () => [mockSessionToolDef],
        callTool: async (name, args) => {
            mcpCalls.push({ name, args });
            return {
                isError: false,
                content: JSON.stringify({
                    message: `Study session for "${args.subject}" recorded successfully (${args.status}).`,
                    session: { subject: args.subject, hoursSpent: args.hoursSpent, status: args.status, date: "2026-10-12" },
                    subjectProgress: { subject: args.subject, completedHours: args.hoursSpent, missedHours: 0, remainingHours: 10, progressPercentage: "16.7%" },
                    overallPlanProgress: "16.7%"
                })
            };
        }
    };

    const duplicateParallelProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [
                        { name: "record_study_session", arguments: { subject: "Mathematics", hoursSpent: 2, status: "completed" } },
                        { name: "record_study_session", arguments: { subject: "Mathematics", hoursSpent: 2, status: "completed" } }
                    ],
                    content: ""
                };
            }
            return { toolCalls: [], content: "Recorded 2 hours of Mathematics session." };
        }
    };

    mcpCalls = [];
    const dupParallelAgent = new AdaptiveAgent({
        provider: duplicateParallelProvider,
        mcpClient: mockMcpForDup,
        maxRounds: 3
    });
    const dupParallelRes = await dupParallelAgent.run({ message: "Record 2 hours of Mathematics" });
    assert.equal(dupParallelRes.success, true, "Agent run must succeed");
    assert.equal(mcpCalls.length, 1, "Duplicate parallel mutation call must be executed only once against MCP");
    const dupSkippedStep = dupParallelRes.steps.find(s => s.type === "duplicate_mutation_skipped");
    assert.ok(dupSkippedStep, "Must record duplicate_mutation_skipped step");

    // 15.11 Duplicate Mutation Protection: Cross-round duplicate calls
    const duplicateAcrossRoundsProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [{ name: "record_study_session", arguments: { subject: "Mathematics", hoursSpent: 2, status: "completed" } }],
                    content: ""
                };
            }
            if (this.callCount === 2) {
                // Model confuses itself and repeats the identical tool call in Round 2
                return {
                    toolCalls: [{ name: "record_study_session", arguments: { subject: "Mathematics", hoursSpent: 2, status: "completed" } }],
                    content: ""
                };
            }
            return { toolCalls: [], content: "Recorded 2 hours of Mathematics session." };
        }
    };

    mcpCalls = [];
    const dupRoundsAgent = new AdaptiveAgent({
        provider: duplicateAcrossRoundsProvider,
        mcpClient: mockMcpForDup,
        maxRounds: 4
    });
    const dupRoundsRes = await dupRoundsAgent.run({ message: "Record 2 hours of Mathematics" });
    assert.equal(dupRoundsRes.success, true, "Agent run must succeed");
    assert.equal(mcpCalls.length, 1, "Duplicate cross-round mutation call must not re-execute against MCP");

    // 15.12 Duplicate Mutation Protection: Legitimate distinct calls are NOT blocked
    const distinctCallsProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [
                        { name: "record_study_session", arguments: { subject: "Mathematics", hoursSpent: 2, status: "completed" } },
                        { name: "record_study_session", arguments: { subject: "Physics", hoursSpent: 1, status: "completed" } }
                    ],
                    content: ""
                };
            }
            return { toolCalls: [], content: "Recorded Mathematics and Physics sessions." };
        }
    };

    mcpCalls = [];
    const distinctAgent = new AdaptiveAgent({
        provider: distinctCallsProvider,
        mcpClient: mockMcpForDup,
        maxRounds: 3
    });
    const distinctRes = await distinctAgent.run({ message: "Record 2h Mathematics and 1h Physics" });
    assert.equal(distinctRes.success, true, "Agent run must succeed");
    assert.equal(mcpCalls.length, 2, "Distinct calls for different subjects must both execute");
    assert.equal(mcpCalls[0].args.subject, "Mathematics");
    assert.equal(mcpCalls[1].args.subject, "Physics");

    // 15.13 Duplicate Mutation Protection: Retry after failure is NOT blocked
    let failFirstAttempt = true;
    const retryMcp = {
        listTools: () => [mockSessionToolDef],
        callTool: async (name, args) => {
            if (failFirstAttempt) {
                failFirstAttempt = false;
                return { isError: true, content: "Database busy, temporary lock failure" };
            }
            return { isError: false, content: JSON.stringify(mockSessionResult) };
        }
    };

    const retryProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [{ name: "record_study_session", arguments: { subject: "Mathematics", hoursSpent: 2, status: "completed" } }],
                    content: ""
                };
            }
            if (this.callCount === 2) {
                // Model retries following failure
                return {
                    toolCalls: [{ name: "record_study_session", arguments: { subject: "Mathematics", hoursSpent: 2, status: "completed" } }],
                    content: ""
                };
            }
            return { toolCalls: [], content: "Recorded 2 hours of Mathematics session." };
        }
    };

    const retryAgent = new AdaptiveAgent({
        provider: retryProvider,
        mcpClient: retryMcp,
        maxRounds: 4
    });
    const retryRes = await retryAgent.run({ message: "Record 2 hours of Mathematics" });
    assert.equal(retryRes.success, true, "Retry must succeed on second attempt");
    assert.equal(retryRes.rounds, 3, "Took 3 rounds (fail -> retry success -> final answer)");
    console.log("✓ Duplicate mutation protection verified: parallel duplicates deduplicated, cross-round duplicates skipped, distinct calls preserved, retries on failure permitted");

    // =========================================================================
    // SECTION 16: Model-Generated Meta-Preamble Sanitization & Grounding Invariants
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- SECTION 16: Meta-Preamble Sanitization & Invariants ---");
    console.log("=======================================================");

    const samplePlanSummary = `Study Plan Details: "mutation-test-oct12"

**Overview:**
- **Exam Date:** 2026-11-30 (49 days remaining)
- **Daily Available Study Time:** 3 hours/day
- **Overall Progress:** 19%
- **Total Hours:** 28h completed, 0h missed, 119h remaining

**Subject Breakdown:**
- **Mathematics** (HIGH Priority): 88.2h allocated, 28h completed, 60.2h remaining, 0h missed (32% progress)
- **Physics** (MEDIUM Priority): 58.8h allocated, 0h completed, 58.8h remaining, 0h missed (0% progress)`;

    // 16.1 Exact Postman phrase removed: "Here is the final answer to the original user question:"
    const preamble1 = `Here is the final answer to the original user question:\n\n${samplePlanSummary}`;
    assert.equal(stripMetaPreamble(preamble1), samplePlanSummary, "Preamble 'Here is the final answer to the original user question:' must be stripped");

    // 16.2 "Here is the final answer:" removed
    const preamble2 = `Here is the final answer:\n\n${samplePlanSummary}`;
    assert.equal(stripMetaPreamble(preamble2), samplePlanSummary, "Preamble 'Here is the final answer:' must be stripped");

    // 16.3 "Based on the tool results, here is the final answer:" removed
    const preamble3 = `Based on the tool results, here is the final answer:\n\n${samplePlanSummary}`;
    assert.equal(stripMetaPreamble(preamble3), samplePlanSummary, "Preamble 'Based on the tool results, here is the final answer:' must be stripped");

    // 16.4 Case-insensitivity: lowercase and uppercase stripped
    const preambleLower = `here is the final answer to the original user question:\n\n${samplePlanSummary}`;
    assert.equal(stripMetaPreamble(preambleLower), samplePlanSummary, "Lowercase preamble must be stripped");

    const preambleUpper = `HERE IS THE FINAL ANSWER TO THE ORIGINAL USER QUESTION:\n\n${samplePlanSummary}`;
    assert.equal(stripMetaPreamble(preambleUpper), samplePlanSummary, "Uppercase preamble must be stripped");

    // 16.5 Markdown bold formatting stripped
    const preambleBold = `**Here is the final answer to the original user question:**\n\n${samplePlanSummary}`;
    assert.equal(stripMetaPreamble(preambleBold), samplePlanSummary, "Bold markdown preamble must be stripped");

    // 16.6 Plain reply without preamble remains completely unchanged
    assert.equal(stripMetaPreamble(samplePlanSummary), samplePlanSummary, "Reply without preamble must remain 100% unchanged");

    // 16.7 Meaningful introductory prose preserved
    const meaningfulIntro1 = `Here is your updated study plan for Mathematics and Physics:\n- Math: 10h\n- Physics: 5h`;
    assert.equal(stripMetaPreamble(meaningfulIntro1), meaningfulIntro1, "Meaningful intro 'Here is your updated study plan' must NOT be stripped");

    const meaningfulIntro2 = `Here is an overview of your schedule before the exam on 2026-11-30:\n- Daily hours: 3h`;
    assert.equal(stripMetaPreamble(meaningfulIntro2), meaningfulIntro2, "Meaningful intro 'Here is an overview of your schedule' must NOT be stripped");

    const meaningfulIntro3 = `Based on your exam date, you have 49 days remaining. Total hours allocated: 147h.`;
    assert.equal(stripMetaPreamble(meaningfulIntro3), meaningfulIntro3, "Meaningful intro 'Based on your exam date' must NOT be stripped");

    // 16.8 Sanitization does not allow contradictory exam date to pass consistency validation
    const mockRetrievalPlan = {
        planId: "mutation-test-oct12",
        examDate: "2026-11-30",
        daysRemaining: 49,
        dailyAvailableHours: 3,
        totalCompletedHours: 28,
        totalMissedHours: 0,
        totalRemainingHours: 119,
        subjects: {
            Mathematics: { allocatedHours: 88.2, completedHours: 28, remainingHours: 60.2, priority: "high" },
            Physics: { allocatedHours: 58.8, completedHours: 0, remainingHours: 58.8, priority: "medium" }
        },
        sessions: [{ subject: "Mathematics", hoursSpent: 2, status: "completed", date: "2026-10-12" }],
        totalSessionsRecorded: 1,
        recentSessions: [{ subject: "Mathematics", hoursSpent: 2, status: "completed", date: "2026-10-12" }]
    };
    const executedRetrievalTools = [{
        toolName: "get_study_plan",
        toolArgs: { planId: "mutation-test-oct12" },
        isError: false,
        content: JSON.stringify(mockRetrievalPlan),
        parsedData: mockRetrievalPlan
    }];

    // Contradictory exam date with preamble must still FAIL consistency check
    const contradictoryDateReply = `Here is the final answer to the original user question: Exam date is 2020-01-01 for Mathematics and Physics. Total hours: 147h.`;
    const checkContradictory = verifyFinalAnswerConsistency(contradictoryDateReply, executedRetrievalTools, "Show me my plan");
    assert.equal(checkContradictory.valid, false, "Sanitized reply with contradictory exam date must still fail consistency check");
    assert.ok(checkContradictory.reason.includes("exam date"), "Reason must report exam date contradiction");

    // 16.9 Sanitization does not allow false "no sessions" claim to pass consistency check
    const falseNoSessionsReply = `Here is the final answer: Mathematics and Physics are scheduled for 2026-11-30, but you have no sessions recorded.`;
    const checkFalseNoSessions = verifyFinalAnswerConsistency(falseNoSessionsReply, executedRetrievalTools, "Show me my plan");
    assert.equal(checkFalseNoSessions.valid, false, "Sanitized reply with false 'no sessions' claim must still fail consistency check");

    // 16.10 Preamble-only reply (empty after stripping) fails consistency check and triggers grounded summary
    const preambleOnlyReply = `Here is the final answer to the original user question:`;
    const checkPreambleOnly = verifyFinalAnswerConsistency(preambleOnlyReply, executedRetrievalTools, "Show me my plan");
    assert.equal(checkPreambleOnly.valid, false, "Preamble-only response must fail consistency check");
    assert.ok(checkPreambleOnly.correctedReply.includes("Study Plan Details:"), "Must provide grounded retrieval summary");

    // 16.11 Valid retrieval reply with preamble passes consistency check and returns cleanly sanitized
    const validPreambleReply = `Here is the final answer to the original user question:\n\nStudy Plan Details: "mutation-test-oct12"\n\n**Overview:**\n- **Exam Date:** 2026-11-30\n- **Subjects:** Mathematics (HIGH Priority), Physics (MEDIUM Priority)`;
    const checkValidPreamble = verifyFinalAnswerConsistency(validPreambleReply, executedRetrievalTools, "Show me my plan");
    assert.equal(checkValidPreamble.valid, true, "Accurate retrieval reply with preamble must pass consistency check");

    // 16.12 End-to-end agent run: Preamble is stripped from agent final reply
    const preambleAgentProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [{ name: "get_study_plan", arguments: { planId: "mutation-test-oct12" } }],
                    content: ""
                };
            }
            return {
                toolCalls: [],
                content: `Here is the final answer to the original user question:\n\nStudy Plan Details: "mutation-test-oct12"\n- **Exam Date:** 2026-11-30\n- **Subjects:** Mathematics and Physics`
            };
        }
    };

    const mockMcpForPreamble = {
        listTools: () => [{ name: "get_study_plan", inputSchema: { type: "object", properties: { planId: { type: "string" } } } }],
        callTool: async () => ({ isError: false, content: JSON.stringify(mockRetrievalPlan) })
    };

    const preambleAgent = new AdaptiveAgent({
        provider: preambleAgentProvider,
        mcpClient: mockMcpForPreamble,
        maxRounds: 3
    });

    const agentPreambleRes = await preambleAgent.run({ message: "Show me my study plan for mutation-test-oct12" });
    assert.equal(agentPreambleRes.success, true, "Agent run must succeed");
    assert.ok(!agentPreambleRes.reply.startsWith("Here is the final answer"), "Agent reply must NOT have leading meta-preamble");
    assert.ok(agentPreambleRes.reply.startsWith("Study Plan Details:"), "Agent reply must start directly with clean answer content");
    assert.ok(agentPreambleRes.reply.includes("2026-11-30"), "Agent reply must preserve all content");
    console.log("✓ Meta-preamble sanitization verified: preambles cleanly stripped, meaningful prose preserved, grounding invariants enforced");

    // =========================================================================
    // SECTION 17: Retrieval Summary Accuracy & Plan-Wide vs Subject Grounding
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- SECTION 17: Retrieval Summary Accuracy & Grounding ---");
    console.log("=======================================================");

    const mockOct12Plan = {
        planId: "mutation-test-oct12",
        examDate: "2026-11-30",
        daysRemaining: 49,
        dailyAvailableHours: 3,
        totalCompletedHours: 28,
        totalMissedHours: 0,
        totalRemainingHours: 119,
        totalAllocatedHours: 147,
        totalAvailableHours: 147,
        availableCapacityHours: 147,
        overallProgress: "19%",
        subjects: {
            Mathematics: { allocatedHours: 88.2, completedHours: 28, remainingHours: 60.2, missedHours: 0, priority: "high", progressPercentage: 32 },
            Physics: { allocatedHours: 58.8, completedHours: 0, remainingHours: 58.8, missedHours: 0, priority: "medium", progressPercentage: 0 }
        },
        totalSessionsRecorded: 5,
        recentSessions: [
            { id: "s1", date: "2024-01-01", subject: "Mathematics", hoursSpent: 2, status: "completed" },
            { id: "s2", date: "2026-10-12", subject: "Mathematics", hoursSpent: 2, status: "completed" },
            { id: "s3", date: "2026-10-12", subject: "Mathematics", hoursSpent: 2, status: "completed" },
            { id: "s4", date: "2026-10-12", subject: "Mathematics", hoursSpent: 2, status: "completed" },
            { id: "s5", date: "2026-10-12", subject: "Mathematics", hoursSpent: 2, status: "completed" }
        ]
    };
    const executedOct12RetrievalTools = [{
        toolName: "get_study_plan",
        toolArgs: { planId: "mutation-test-oct12" },
        isError: false,
        content: JSON.stringify(mockOct12Plan),
        parsedData: mockOct12Plan
    }];

    // 17.1: Incorrect plan-wide total (119 expected, 60.2 claimed) is rejected and replaced by a grounded summary
    const incorrectTotalReply = `Study Plan Details: "mutation-test-oct12"

**Overview:**
- **Exam Date:** 2026-11-30
- Total remaining hours: 60.2
**Subject Breakdown:**
- **Mathematics** (HIGH Priority): 60.2h remaining
- **Physics** (MEDIUM Priority): 58.8h remaining`;
    const checkIncorrectTotal = verifyFinalAnswerConsistency(incorrectTotalReply, executedOct12RetrievalTools, "Show me my plan");
    assert.equal(checkIncorrectTotal.valid, false, "Substituted subject remaining hours (60.2) for plan-wide total (119) must fail consistency check");
    assert.ok(checkIncorrectTotal.reason.includes("total remaining hours"), "Reason must cite total remaining hours contradiction");
    assert.ok(checkIncorrectTotal.correctedReply.includes("119h remaining"), "Corrected reply must provide grounded total of 119h remaining");

    // 17.2: Correct plan-wide total of 119 is accepted
    const correctTotalReply = `Study Plan Details: "mutation-test-oct12"

**Overview:**
- **Exam Date:** 2026-11-30
- Total remaining hours: 119
**Subject Breakdown:**
- **Mathematics** (HIGH Priority): 60.2h remaining
- **Physics** (MEDIUM Priority): 58.8h remaining`;
    const checkCorrectTotal = verifyFinalAnswerConsistency(correctTotalReply, executedOct12RetrievalTools, "Show me my plan");
    assert.equal(checkCorrectTotal.valid, true, "Accurate plan-wide total of 119 must pass consistency check");

    // 17.3: Subject-specific values of 60.2 and 58.8 without a contradictory plan-wide claim are accepted
    const subjectOnlyReply = `Study Plan Details: "mutation-test-oct12"

**Overview:**
- **Exam Date:** 2026-11-30
**Subject Breakdown:**
- **Mathematics** (HIGH Priority): 60.2h remaining
- **Physics** (MEDIUM Priority): 58.8h remaining`;
    const checkSubjectOnly = verifyFinalAnswerConsistency(subjectOnlyReply, executedOct12RetrievalTools, "Show me my plan");
    assert.equal(checkSubjectOnly.valid, true, "Subject-specific values without a contradictory plan-wide total claim must pass consistency check");

    // 17.4: A blanket claim that all recent sessions occurred on October 12, 2026 is rejected when records include both 2024-01-01 and 2026-10-12
    const falseBlanketDateReply = `Study Plan Details: "mutation-test-oct12"

**Overview:**
- **Exam Date:** 2026-11-30
- Total remaining hours: 119
The most recent sessions were all completed on October 12, 2026.
**Subject Breakdown:**
- **Mathematics** (HIGH Priority): 60.2h remaining
- **Physics** (MEDIUM Priority): 58.8h remaining`;
    const checkFalseBlanket = verifyFinalAnswerConsistency(falseBlanketDateReply, executedOct12RetrievalTools, "Show me my plan");
    assert.equal(checkFalseBlanket.valid, false, "False blanket claim that all recent sessions were on October 12 must fail consistency check when 2024-01-01 session exists");
    assert.ok(checkFalseBlanket.reason.includes("distinct dates") || checkFalseBlanket.reason.includes("October 12, 2026"), "Reason must identify false blanket session date claim");
    assert.ok(checkFalseBlanket.correctedReply.includes("2024-01-01"), "Corrected reply must include actual session dates");

    // 17.5: The same blanket claim is accepted when all recent sessions actually match that date
    const allOct12Plan = {
        ...mockOct12Plan,
        recentSessions: [
            { id: "s2", date: "2026-10-12", subject: "Mathematics", hoursSpent: 2, status: "completed" },
            { id: "s3", date: "2026-10-12", subject: "Mathematics", hoursSpent: 2, status: "completed" }
        ]
    };
    const executedAllOct12Tools = [{
        toolName: "get_study_plan",
        toolArgs: { planId: "mutation-test-oct12" },
        isError: false,
        content: JSON.stringify(allOct12Plan),
        parsedData: allOct12Plan
    }];
    const checkValidBlanket = verifyFinalAnswerConsistency(falseBlanketDateReply, executedAllOct12Tools, "Show me my plan");
    assert.equal(checkValidBlanket.valid, true, "Blanket claim must pass consistency check when all recent sessions actually match that date");

    // 17.6: End-to-end agent verification where the provider returns the flawed response (substituting 60.2 and claiming all sessions on Oct 12), and the agent triggers grounded correction
    const flawedPostmanProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [{ name: "get_study_plan", arguments: { planId: "mutation-test-oct12" } }],
                    content: ""
                };
            }
            return {
                toolCalls: [],
                content: `Study Plan Details: "mutation-test-oct12"

**Overview:**
- **Exam Date:** 2026-11-30
- Total remaining hours: 60.2
The most recent sessions were all completed on October 12, 2026.
**Subject Breakdown:**
- **Mathematics** (HIGH Priority): 60.2h remaining
- **Physics** (MEDIUM Priority): 58.8h remaining`
            };
        }
    };
    const mockMcpForOct12 = {
        listTools: () => [{ name: "get_study_plan", inputSchema: { type: "object", properties: { planId: { type: "string" } } } }],
        callTool: async () => ({ isError: false, content: JSON.stringify(mockOct12Plan) })
    };
    const oct12Agent = new AdaptiveAgent({
        provider: flawedPostmanProvider,
        mcpClient: mockMcpForOct12,
        maxRounds: 3
    });
    const agentOct12Res = await oct12Agent.run({ message: "Show me my study plan for mutation-test-oct12" });
    assert.equal(agentOct12Res.success, true, "Agent run must succeed");
    assert.ok(agentOct12Res.reply.includes("119h remaining"), "Agent reply must report grounded total remaining hours (119h)");
    assert.ok(agentOct12Res.reply.includes("2024-01-01"), "Agent reply must include older session date 2024-01-01");
    assert.ok(!agentOct12Res.reply.includes("were all completed on October 12"), "Agent reply must not contain false blanket statement");
    console.log("✓ Retrieval summary accuracy verified: plan-wide totals distinguished, recent session dates validated, grounding enforced");

    // =========================================================================
    // SECTION 18: Exam-Date Consistency Check & False Positive Prevention
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- SECTION 18: Exam-Date Consistency & Omission Distinction ---");
    console.log("=======================================================");

    const mockExamDatePlan = {
        planId: "mutation-test-oct12",
        examDate: "2026-11-30",
        daysRemaining: 49,
        dailyAvailableHours: 3,
        totalCompletedHours: 28,
        totalMissedHours: 0,
        totalRemainingHours: 119,
        totalAllocatedHours: 147,
        totalAvailableHours: 147,
        overallProgress: "19%",
        subjects: {
            Mathematics: { allocatedHours: 88.2, completedHours: 28, remainingHours: 60.2, missedHours: 0, priority: "high", progressPercentage: 32 },
            Physics: { allocatedHours: 58.8, completedHours: 0, remainingHours: 58.8, missedHours: 0, priority: "medium", progressPercentage: 0 }
        },
        totalSessionsRecorded: 1,
        recentSessions: [
            { id: "s1", date: "2026-10-12", subject: "Mathematics", hoursSpent: 2, status: "completed" }
        ]
    };
    const executedExamDateTools = [{
        toolName: "get_study_plan",
        toolArgs: { planId: "mutation-test-oct12" },
        isError: false,
        content: JSON.stringify(mockExamDatePlan),
        parsedData: mockExamDatePlan
    }];

    // 18.1: A concise hours-only answer with no exam date (live Postman reproduction) must pass without false positive
    const livePostmanReply = "The total remaining hours for the entire plan are 119 hours. The total remaining hours for each subject are: Mathematics: 60.2 hours; Physics: 58.8 hours.";
    const checkLivePostman = verifyFinalAnswerConsistency(livePostmanReply, executedExamDateTools, "What are the total remaining hours for mutation-test-oct12?");
    assert.equal(checkLivePostman.valid, true, "Concise hours-only answer without exam date must pass consistency check without false positive");

    // 18.2: A correct exam date must pass
    const correctExamDateReply = `Study Plan Details: "mutation-test-oct12"
**Overview:**
- **Exam Date:** 2026-11-30
- Total remaining hours: 119
**Subject Breakdown:**
- **Mathematics** (HIGH Priority): 60.2h remaining
- **Physics** (MEDIUM Priority): 58.8h remaining`;
    const checkCorrectExamDate = verifyFinalAnswerConsistency(correctExamDateReply, executedExamDateTools, "Show me my study plan");
    assert.equal(checkCorrectExamDate.valid, true, "Reply with correct exam date must pass consistency check");

    // 18.3: An explicitly requested exam date that is omitted must fail consistency check
    const examDateRequestedPrompt = "Retrieve study plan mutation-test-oct12. Report the exam date and remaining hours.";
    const checkOmittedRequestedExamDate = verifyFinalAnswerConsistency(livePostmanReply, executedExamDateTools, examDateRequestedPrompt);
    assert.equal(checkOmittedRequestedExamDate.valid, false, "Omission of exam date when explicitly requested by user must fail consistency check");
    assert.ok(checkOmittedRequestedExamDate.reason.includes("exam date"), "Reason must identify omitted exam date");
    assert.ok(checkOmittedRequestedExamDate.correctedReply.includes("2026-11-30"), "Corrected reply must provide grounded exam date 2026-11-30");

    // 18.4: A conflicting exam date must fail consistency check
    const conflictingExamDateReply = `Study Plan Details: "mutation-test-oct12"
**Overview:**
- **Exam Date:** 2026-12-25
- Total remaining hours: 119
**Subject Breakdown:**
- **Mathematics** (HIGH Priority): 60.2h remaining
- **Physics** (MEDIUM Priority): 58.8h remaining`;
    const checkConflictingExamDate = verifyFinalAnswerConsistency(conflictingExamDateReply, executedExamDateTools, "Show me my study plan");
    assert.equal(checkConflictingExamDate.valid, false, "Reply with conflicting exam date must fail consistency check");
    assert.ok(checkConflictingExamDate.reason.includes("exam date"), "Reason must cite exam date contradiction");
    assert.ok(checkConflictingExamDate.correctedReply.includes("2026-11-30"), "Corrected reply must provide grounded exam date 2026-11-30");

    // 18.5: A retrieval answer that still has incorrect total remaining hours (even without exam date) must fail
    const wrongHoursNoExamDateReply = "The total remaining hours for the entire plan are 60.2 hours. The total remaining hours for each subject are: Mathematics: 60.2 hours; Physics: 58.8 hours.";
    const checkWrongHoursNoExamDate = verifyFinalAnswerConsistency(wrongHoursNoExamDateReply, executedExamDateTools, "What are the remaining hours?");
    assert.equal(checkWrongHoursNoExamDate.valid, false, "Incorrect total remaining hours without exam date must still fail consistency check");
    assert.ok(checkWrongHoursNoExamDate.reason.includes("total remaining hours"), "Reason must cite total remaining hours contradiction");
    assert.ok(checkWrongHoursNoExamDate.correctedReply.includes("119h remaining"), "Corrected reply must provide grounded total of 119h remaining");

    console.log("✓ Exam-date consistency check verified: false positive eliminated, explicit requests enforced, contradictions caught");

    // =========================================================================
    // SECTION 19: Subject Consistency False-Positive Elimination & Precision Suite
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- SECTION 19: Subject Consistency False-Positive Elimination ---");
    console.log("=======================================================");

    const mockPlanForSection19 = {
        planId: "default",
        examDate: "2026-11-30",
        daysRemaining: 49,
        dailyAvailableHours: 3,
        totalCompletedHours: 28,
        totalMissedHours: 0,
        totalRemainingHours: 119,
        totalAllocatedHours: 147,
        totalAvailableHours: 147,
        overallProgress: "19%",
        subjects: {
            Mathematics: { allocatedHours: 88.2, completedHours: 28, remainingHours: 60.2, missedHours: 0, priority: "high", progressPercentage: 32 },
            Physics: { allocatedHours: 58.8, completedHours: 0, remainingHours: 58.8, missedHours: 0, priority: "medium", progressPercentage: 0 }
        },
        totalSessionsRecorded: 1,
        recentSessions: [
            { id: "s1", date: "2026-10-12", subject: "Mathematics", hoursSpent: 2, status: "completed" }
        ]
    };
    const executedSection19Tools = [{
        toolName: "get_study_plan",
        toolArgs: { planId: "default" },
        isError: false,
        content: JSON.stringify(mockPlanForSection19),
        parsedData: mockPlanForSection19
    }];

    // 19.1 Concise progress summary without the exam date or subject-by-subject breakdown (Reproduction fix)
    const conciseProgressPrompt = "Briefly tell me how my study plan is progressing. Keep it concise. Use planId default.";
    const conciseProgressReply = "You are making steady progress on your study plan with 28 completed hours out of 147 total hours, leaving 119 remaining hours.";
    const checkConciseProgress = verifyFinalAnswerConsistency(conciseProgressReply, executedSection19Tools, conciseProgressPrompt);
    assert.equal(checkConciseProgress.valid, true, "Concise progress summary without exam date or subject breakdown must pass consistency check without false positive");

    // 19.2 Exam-date-only request returning the correct date without a full-plan dump
    const examDateOnlyPrompt = "What is my exam date for plan default?";
    const examDateOnlyReply = "Your exam date for plan default is November 30, 2026.";
    const checkExamDateOnly = verifyFinalAnswerConsistency(examDateOnlyReply, executedSection19Tools, examDateOnlyPrompt);
    assert.equal(checkExamDateOnly.valid, true, "Exam-date-only request with correct exam date must pass without requiring subjects or dumping the full plan");

    // 19.3 Explicit exam-date request where the response omits the date
    const omittedDateReply = "Your study plan has 119 remaining hours across all subjects.";
    const checkOmittedDateOnRequest = verifyFinalAnswerConsistency(omittedDateReply, executedSection19Tools, examDateOnlyPrompt);
    assert.equal(checkOmittedDateOnRequest.valid, false, "Response omitting explicitly requested exam date must fail consistency check");
    assert.ok(checkOmittedDateOnRequest.reason.includes("exam date"), "Reason must identify omitted exam date");
    assert.ok(checkOmittedDateOnRequest.correctedReply.includes("2026-11-30"), "Corrected reply must provide grounded exam date");

    // 19.4 Incorrect exam date in a response
    const wrongDateReply = "Your exam is scheduled for December 25, 2026.";
    const checkWrongDate = verifyFinalAnswerConsistency(wrongDateReply, executedSection19Tools, conciseProgressPrompt);
    assert.equal(checkWrongDate.valid, false, "Response with contradictory exam date must fail consistency check");
    assert.ok(checkWrongDate.reason.includes("exam date"), "Reason must cite exam date contradiction");
    assert.ok(checkWrongDate.correctedReply.includes("2026-11-30"), "Corrected reply must provide grounded exam date");

    // 19.5 Incorrect subject information in a response
    // 19.5a Contradictory subject priority
    const wrongSubjectPriorityReply = "You are progressing well with 28 completed hours. Mathematics is low priority.";
    const checkWrongPriority = verifyFinalAnswerConsistency(wrongSubjectPriorityReply, executedSection19Tools, conciseProgressPrompt);
    assert.equal(checkWrongPriority.valid, false, "Response asserting contradictory subject priority must fail consistency check");
    assert.ok(checkWrongPriority.reason.includes("Mathematics"), "Reason must cite conflicting subject");
    assert.ok(checkWrongPriority.reason.includes("priority"), "Reason must cite priority contradiction");
    assert.ok(checkWrongPriority.correctedReply.includes("HIGH Priority"), "Corrected reply must restore verified priority");

    // 19.5b Fabricated / Nonexistent subject claimed in study plan
    const fabricatedSubjectReply = "You are progressing well. Your plan includes History (high priority) with 30 hours.";
    const checkFabricatedSubject = verifyFinalAnswerConsistency(fabricatedSubjectReply, executedSection19Tools, conciseProgressPrompt);
    assert.equal(checkFabricatedSubject.valid, false, "Response claiming a nonexistent subject must fail consistency check");
    assert.ok(checkFabricatedSubject.reason.includes("History"), "Reason must identify fabricated subject");

    // 19.5c Contradictory subject remaining hours
    const wrongSubjectHoursReply = "Mathematics: 20 hours remaining; Physics: 58.8 hours remaining.";
    const checkWrongSubjectHours = verifyFinalAnswerConsistency(wrongSubjectHoursReply, executedSection19Tools, "Show me my subjects");
    assert.equal(checkWrongSubjectHours.valid, false, "Response asserting contradictory remaining hours for a subject must fail");
    assert.ok(checkWrongSubjectHours.reason.includes("Mathematics"), "Reason must cite Mathematics");
    assert.ok(checkWrongSubjectHours.reason.includes("remaining hours"), "Reason must cite remaining hours contradiction");

    // 19.6 Full-plan request that must preserve the required subject breakdown
    const fullPlanPrompt = "Retrieve study plan default. Report all subjects.";
    const omittedSubjectInFullPlanReply = "Here is your study plan: Physics (medium priority): 58.8 hours remaining.";
    const checkOmittedSubjectInFullPlan = verifyFinalAnswerConsistency(omittedSubjectInFullPlanReply, executedSection19Tools, fullPlanPrompt);
    assert.equal(checkOmittedSubjectInFullPlan.valid, false, "Full plan request omitting a required subject must fail consistency check");
    assert.equal(checkOmittedSubjectInFullPlan.reason, 'Final reply omitted subject "Mathematics" from retrieved plan.');
    assert.ok(checkOmittedSubjectInFullPlan.correctedReply.includes("Mathematics"), "Corrected reply must provide full grounded summary");

    // 19.7 Both retrieval and get_study_plan tool intents where applicable
    // 19.7a Latest successful tool get_study_plan fallback path (without userMessage trigger)
    const checkToolOnlyConcise = verifyFinalAnswerConsistency(conciseProgressReply, executedSection19Tools, "Brief progress update");
    assert.equal(checkToolOnlyConcise.valid, true, "get_study_plan tool check with brief progress update must pass");

    // 19.7b End-to-end agent execution preserving concise progress reply without full plan dump
    const conciseAgentProvider = {
        callCount: 0,
        async chat() {
            this.callCount++;
            if (this.callCount === 1) {
                return {
                    toolCalls: [{ name: "get_study_plan", arguments: { planId: "default" } }],
                    content: ""
                };
            }
            return {
                toolCalls: [],
                content: conciseProgressReply
            };
        }
    };
    const mockMcpForSection19 = {
        listTools: () => [{ name: "get_study_plan", inputSchema: { type: "object", properties: { planId: { type: "string" } } } }],
        callTool: async () => ({ isError: false, content: JSON.stringify(mockPlanForSection19) })
    };
    const conciseAgent = new AdaptiveAgent({
        provider: conciseAgentProvider,
        mcpClient: mockMcpForSection19,
        maxRounds: 3
    });
    const conciseAgentRes = await conciseAgent.run({ message: conciseProgressPrompt });
    assert.equal(conciseAgentRes.success, true, "Agent run must succeed");
    assert.equal(conciseAgentRes.reply, conciseProgressReply, "Concise answer must be preserved directly without full plan dump replacement");
    assert.ok(!conciseAgentRes.steps.some(s => s.type === "final_answer_grounded"), "Agent must NOT trigger final_answer_grounded for concise progress reply");

    // 19.8 Mixed-intent subject breakdown requests vs concise and single-subject requests
    const mixedBreakdownPrompt = "Show my progress and the full subject-wise breakdown";
    const subBySubPrompt = "Show my progress with a subject-by-subject breakdown";
    const planSubjectList = ["Mathematics", "Physics"];

    // 19.8a Explicit requests for subject breakdown must require all subjects
    assert.deepEqual(
        getRequiredSubjects(planSubjectList, mixedBreakdownPrompt),
        planSubjectList,
        "Request with 'full subject-wise breakdown' must require all subjects despite containing 'progress'"
    );
    assert.deepEqual(
        getRequiredSubjects(planSubjectList, subBySubPrompt),
        planSubjectList,
        "Request with 'subject-by-subject breakdown' must require all subjects"
    );

    // 19.8b Concise progress requests must not require every subject
    assert.deepEqual(
        getRequiredSubjects(planSubjectList, "Briefly summarize my progress"),
        [],
        "Concise progress request must not require any individual subjects"
    );

    // 19.8c Requests for one named subject must only require that subject
    assert.deepEqual(
        getRequiredSubjects(planSubjectList, "Show Mathematics progress only"),
        ["Mathematics"],
        "Request specifying Mathematics only must not require unrelated subjects"
    );

    // 19.8d Omitting a subject from a subject-wise breakdown response must fail consistency check
    const partialBreakdownReply = "Here is your progress: Mathematics (high priority): 60.2 hours remaining.";
    const checkPartialBreakdown = verifyFinalAnswerConsistency(partialBreakdownReply, executedSection19Tools, mixedBreakdownPrompt);
    assert.equal(checkPartialBreakdown.valid, false, "Subject-wise breakdown reply omitting Physics must fail consistency check");
    assert.equal(checkPartialBreakdown.reason, 'Final reply omitted subject "Physics" from retrieved plan.');

    // 19.9 Multi-claim single-line cross-sentence subject information matching
    // 19.9a Multi-claim on one line with correct data across sentences must pass without false cross-sentence contradictions
    const multiClaimCorrectPriority = "Mathematics is high priority. Physics has medium priority.";
    const checkMultiPriority = detectIncorrectSubjectInformation(multiClaimCorrectPriority, mockPlanForSection19.subjects);
    assert.equal(checkMultiPriority.contradicted, false, "Multi-claim single-line correct priorities must not trigger cross-sentence contradiction");

    const multiClaimCorrectHours = "Mathematics has 60.2 hours remaining. Physics has 58.8 hours remaining.";
    const checkMultiHours = detectIncorrectSubjectInformation(multiClaimCorrectHours, mockPlanForSection19.subjects);
    assert.equal(checkMultiHours.contradicted, false, "Multi-claim single-line correct remaining hours must not trigger cross-sentence contradiction");

    // 19.9b Multi-claim on one line with genuine incorrect priority must be caught for the specific failing subject
    const multiClaimWrongMathPriority = "Mathematics is low priority. Physics has medium priority.";
    const checkWrongMathPriority = detectIncorrectSubjectInformation(multiClaimWrongMathPriority, mockPlanForSection19.subjects);
    assert.equal(checkWrongMathPriority.contradicted, true, "Must catch incorrect Mathematics priority on multi-claim line");
    assert.equal(checkWrongMathPriority.subject, "Mathematics", "Contradicted subject must be Mathematics");

    const multiClaimWrongPhysicsPriority = "Mathematics is high priority. Physics has high priority.";
    const checkWrongPhysicsPriority = detectIncorrectSubjectInformation(multiClaimWrongPhysicsPriority, mockPlanForSection19.subjects);
    assert.equal(checkWrongPhysicsPriority.contradicted, true, "Must catch incorrect Physics priority on multi-claim line");
    assert.equal(checkWrongPhysicsPriority.subject, "Physics", "Contradicted subject must be Physics");

    // 19.9c Multi-claim on one line with genuine incorrect remaining hours must be caught for the specific failing subject
    const multiClaimWrongMathHours = "Mathematics has 20 hours remaining. Physics has 58.8 hours remaining.";
    const checkWrongMathHours = detectIncorrectSubjectInformation(multiClaimWrongMathHours, mockPlanForSection19.subjects);
    assert.equal(checkWrongMathHours.contradicted, true, "Must catch incorrect Mathematics remaining hours on multi-claim line");
    assert.equal(checkWrongMathHours.subject, "Mathematics", "Contradicted subject must be Mathematics");

    const multiClaimWrongPhysicsHours = "Mathematics has 60.2 hours remaining. Physics has 99 hours remaining.";
    const checkWrongPhysicsHours = detectIncorrectSubjectInformation(multiClaimWrongPhysicsHours, mockPlanForSection19.subjects);
    assert.equal(checkWrongPhysicsHours.contradicted, true, "Must catch incorrect Physics remaining hours on multi-claim line");
    assert.equal(checkWrongPhysicsHours.subject, "Physics", "Contradicted subject must be Physics");

    console.log("✓ Section 19 verified: concise progress & exam-date false positives eliminated, strict validation preserved for conflicting dates/subjects, full-plan subject breakdowns enforced");

    console.log("\n===============================================================================");
    console.log("ALL NORMALIZATION, VALIDATION, MCP & E2E AGENT TESTS PASSED! (100%)");
    console.log("===============================================================================");
}

runNormalizationSuite()
    .finally(() => {
        try {
            fs.rmSync(isolatedDataDir, { recursive: true, force: true });
        } catch {
            // ignore cleanup failure on Windows temp
        }
    })
    .catch(err => {
        console.error("Test execution failed:", err);
        process.exit(1);
    });
