import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpClientManager } from "../src/mcp/mcpClient.js";
import { AdaptiveAgent } from "../src/agent/adaptiveAgent.js";
import { validateToolArguments, verifyToolResult } from "../src/agent/validator.js";
import { createPlan, calculateDaysRemaining } from "../studypilot-server/planner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure all failure handling tests run within isolated temporary storage
const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studypilot-failure-test-"));
process.env.STUDYPILOT_DATA_DIR = isolatedDataDir;

async function runFailureHandlingSuite() {
    console.log("=== Adaptive AI Agent + StudyPilot: Failure-Handling Test Suite ===");

    const serverScript = path.resolve(__dirname, "../studypilot-server/server.js");

    // Initialize MCP client for direct tool testing
    const mcpClient = new Client({
        name: "failure-handling-test-client",
        version: "1.0.0"
    });
    const transport = new StdioClientTransport({
        command: "node",
        args: [serverScript],
        env: {
            ...process.env,
            STUDYPILOT_DATA_DIR: isolatedDataDir
        }
    });

    // Initialize McpClientManager for agent-level tests
    const mcpManager = new McpClientManager({
        command: "node",
        args: [serverScript],
        env: {
            STUDYPILOT_DATA_DIR: isolatedDataDir
        }
    });

    try {
        await mcpClient.connect(transport);
        console.log("✓ Connected to StudyPilot MCP server for deterministic tool verification");

        await mcpManager.connect();
        console.log("✓ Connected McpClientManager for agent loop tests");

        const availableTools = mcpManager.listTools();
        const createToolDef = availableTools.find(t => t.name === "create_study_plan");
        const getToolDef = availableTools.find(t => t.name === "get_study_plan");

    // =========================================================================
    // SCENARIO 1: Invalid or Missing Exam Date
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- SCENARIO 1: Invalid or Missing Exam Date ---");
    console.log("=======================================================");

    // 1.1 Tool Result: Missing exam date via MCP tool call
    console.log("\n[Scenario 1.1] Tool Result: Missing examDate rejected by tool");
    const missingDateToolResult = await mcpClient.callTool({
        name: "create_study_plan",
        arguments: {
            subjects: ["Mathematics", "Physics"],
            dailyAvailableHours: 3
        }
    });
    assert.equal(Boolean(missingDateToolResult.isError), true, "Missing examDate must result in isError: true");
    const missingDateText = missingDateToolResult.content?.[0]?.text || "";
    assert.ok(
        missingDateText.toLowerCase().includes("examdate") || missingDateText.toLowerCase().includes("invalid"),
        `Error message must indicate missing/invalid examDate. Received: "${missingDateText}"`
    );
    console.log(`✓ Tool result verified: isError=true, error message: "${missingDateText}"`);

    // 1.2 Tool Result: Invalid exam date format via MCP tool call
    console.log("\n[Scenario 1.2] Tool Result: Invalid examDate format ('not-a-date') rejected by tool");
    const invalidDateToolResult = await mcpClient.callTool({
        name: "create_study_plan",
        arguments: {
            subjects: ["Mathematics", "Physics"],
            examDate: "not-a-date",
            dailyAvailableHours: 3
        }
    });
    assert.equal(Boolean(invalidDateToolResult.isError), true, "Invalid examDate format must return isError: true");
    const invalidDateText = invalidDateToolResult.content?.[0]?.text || "";
    assert.ok(
        invalidDateText.includes("Invalid exam date format") && invalidDateText.includes("YYYY-MM-DD"),
        `Error message must specify YYYY-MM-DD format requirement. Received: "${invalidDateText}"`
    );
    console.log(`✓ Tool result verified: isError=true, error message: "${invalidDateText}"`);

    // 1.3 Tool Result: Non-standard date format ('2026/12/31') rejected by tool
    console.log("\n[Scenario 1.3] Tool Result: Slash date format ('2026/12/31') rejected by tool");
    const slashDateToolResult = await mcpClient.callTool({
        name: "create_study_plan",
        arguments: {
            subjects: ["Mathematics"],
            examDate: "2026/12/31",
            dailyAvailableHours: 3
        }
    });
    assert.equal(Boolean(slashDateToolResult.isError), true, "Slash date format must return isError: true");
    console.log(`✓ Tool result verified: isError=true for non YYYY-MM-DD date`);

    // 1.4 Agent Response & Status: Missing examDate handled safely without fabricating plan
    console.log("\n[Scenario 1.4] Agent Response: Missing examDate results in honest failure, no fabricated plan");
    const missingDateProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Mathematics", "Physics"],
                                dailyAvailableHours: 3
                                // examDate deliberately omitted
                            }
                        }
                    ],
                    content: "Let me create a study plan."
                };
            }
            // Model attempts to invent a successful plan despite missing exam date
            return {
                toolCalls: [],
                content: "Here is your study plan: Mathematics (60 hours), Physics (40 hours). Daily schedule: 3 hours/day."
            };
        }
    };

    const missingDateAgent = new AdaptiveAgent({
        provider: missingDateProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const missingDateAgentResult = await missingDateAgent.run({
        message: "Create a study plan for Mathematics and Physics with 3 hours per day."
    });

    // Verify Success/Failure status
    assert.equal(missingDateAgentResult.success, false, "Agent success status must be false when examDate is missing");
    // Verify Agent response
    assert.ok(
        missingDateAgentResult.reply.startsWith("Action Failed:"),
        `Agent reply must start with 'Action Failed:'. Received: "${missingDateAgentResult.reply}"`
    );
    assert.ok(
        missingDateAgentResult.reply.includes("examDate"),
        `Agent reply must clearly state the missing examDate parameter. Received: "${missingDateAgentResult.reply}"`
    );
    assert.ok(
        !missingDateAgentResult.reply.includes("Mathematics (60 hours)"),
        "Agent must NOT return fabricated subject allocations"
    );
    assert.ok(
        !missingDateAgentResult.reply.includes("Here is your study plan"),
        "Agent must NOT claim a study plan was created"
    );
    console.log("✓ Agent response verified: success=false, honest failure explanation, zero fabricated allocations");

    // 1.5 Agent Response & Status: Invalid date format ('invalid-date') handled safely
    console.log("\n[Scenario 1.5] Agent Response: Invalid date format ('invalid-date') results in honest failure");
    const invalidDateProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Mathematics", "Physics"],
                                examDate: "invalid-date",
                                dailyAvailableHours: 3
                            }
                        }
                    ]
                };
            }
            return {
                toolCalls: [],
                content: "Your plan was created successfully with 50 days remaining!"
            };
        }
    };

    const invalidDateAgent = new AdaptiveAgent({
        provider: invalidDateProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const invalidDateAgentResult = await invalidDateAgent.run({
        message: "Create plan with exam date invalid-date"
    });

    assert.equal(invalidDateAgentResult.success, false, "Agent success status must be false for invalid exam date format");
    assert.ok(invalidDateAgentResult.reply.startsWith("Action Failed:"), "Agent reply must start with 'Action Failed:'");
    assert.ok(invalidDateAgentResult.reply.includes("YYYY-MM-DD"), "Agent reply must state required YYYY-MM-DD date format");
    assert.ok(!invalidDateAgentResult.reply.includes("50 days remaining"), "Agent must NOT invent days remaining");
    console.log("✓ Agent response verified: success=false, clear YYYY-MM-DD requirement, zero hallucinated plan metrics");

    // =========================================================================
    // SCENARIO 2: Invalid Priority Value (such as "urgent")
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- SCENARIO 2: Invalid Priority Value ('urgent') ---");
    console.log("=======================================================");

    // 2.1 Tool Result: Calling create_study_plan with priority "urgent" via MCP
    console.log("\n[Scenario 2.1] Tool Result: Priority 'urgent' rejected with clear error by MCP tool");
    const invalidPriorityToolResult = await mcpClient.callTool({
        name: "create_study_plan",
        arguments: {
            subjects: ["Mathematics", "Physics"],
            examDate: "2026-11-30",
            dailyAvailableHours: 3,
            priorities: {
                Mathematics: "urgent",
                Physics: "medium"
            }
        }
    });

    assert.equal(Boolean(invalidPriorityToolResult.isError), true, "Tool must return isError: true when priority is 'urgent'");
    const invalidPriorityText = invalidPriorityToolResult.content?.[0]?.text || "";
    assert.ok(
        invalidPriorityText.includes("Invalid priority") && invalidPriorityText.includes("urgent"),
        `Error must mention invalid priority "urgent". Received: "${invalidPriorityText}"`
    );
    assert.ok(
        invalidPriorityText.includes("high, medium, low"),
        `Error must state allowed priorities (high, medium, low). Received: "${invalidPriorityText}"`
    );
    console.log(`✓ Tool result verified: isError=true, error message: "${invalidPriorityText}"`);

    // 2.2 Tool Engine Direct Unit Test: createPlan throws clear error on 'urgent'
    console.log("\n[Scenario 2.2] Engine Unit Test: createPlan engine throws explicit Error on 'urgent'");
    assert.throws(
        () => {
            createPlan({
                subjects: ["Mathematics"],
                examDate: "2026-11-30",
                dailyAvailableHours: 3,
                priorities: { Mathematics: "urgent" }
            });
        },
        /Invalid priority "urgent" for subject "Mathematics"/
    );
    console.log("✓ Engine unit test verified: createPlan throws error mentioning subject and allowed priorities");

    // 2.3 Validator Unit Test: validateToolArguments rejects 'urgent' priority
    console.log("\n[Scenario 2.3] Validator Unit Test: validateToolArguments flags 'urgent' priority");
    const validationCheck = validateToolArguments(createToolDef, {
        subjects: ["Mathematics", "Physics"],
        examDate: "2026-11-30",
        dailyAvailableHours: 3,
        priorities: { Mathematics: "urgent", Physics: "medium" }
    });
    assert.equal(validationCheck.valid, false, "validateToolArguments must reject 'urgent' priority");
    assert.ok(
        validationCheck.error.includes("Invalid priority") && validationCheck.error.includes("high, medium, low"),
        `Validator error must specify allowed priorities. Received: "${validationCheck.error}"`
    );
    console.log(`✓ Validator unit test verified: valid=false, error: "${validationCheck.error}"`);

    // 2.4 Agent Response & Status: Model proposing 'urgent' priority receives honest failure response
    console.log("\n[Scenario 2.4] Agent Response: Model proposing 'urgent' priority receives honest failure, no fabricated allocations");
    const invalidPriorityProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Mathematics", "Physics"],
                                examDate: "2026-11-30",
                                dailyAvailableHours: 3,
                                priorities: {
                                    Mathematics: "urgent",
                                    Physics: "medium"
                                }
                            }
                        }
                    ],
                    content: "Setting Mathematics to urgent priority."
                };
            }
            // Model attempts to fabricate allocations despite invalid priority
            return {
                toolCalls: [],
                content: "Your study plan is created! Mathematics (urgent priority) gets 100 hours, Physics (medium priority) gets 40 hours."
            };
        }
    };

    const invalidPriorityAgent = new AdaptiveAgent({
        provider: invalidPriorityProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const invalidPriorityAgentResult = await invalidPriorityAgent.run({
        message: "Create a study plan for Mathematics (urgent) and Physics (medium)."
    });

    // Verify Success/Failure status
    assert.equal(invalidPriorityAgentResult.success, false, "Agent success status must be false when priority is 'urgent'");
    // Verify Agent response
    assert.ok(
        invalidPriorityAgentResult.reply.startsWith("Action Failed:"),
        `Agent reply must start with 'Action Failed:'. Received: "${invalidPriorityAgentResult.reply}"`
    );
    assert.ok(
        invalidPriorityAgentResult.reply.includes("urgent") && invalidPriorityAgentResult.reply.includes("high, medium, low"),
        `Agent reply must explain invalid priority and state allowed priorities. Received: "${invalidPriorityAgentResult.reply}"`
    );
    assert.ok(
        !invalidPriorityAgentResult.reply.includes("gets 100 hours"),
        "Agent must NOT include fabricated hour allocations"
    );
    assert.ok(
        !invalidPriorityAgentResult.reply.includes("Your study plan is created"),
        "Agent must NOT claim study plan was created"
    );
    console.log("✓ Agent response verified: success=false, clear rejection of 'urgent', zero fabricated allocations");

    // =========================================================================
    // SCENARIO 3: MCP Tool Execution Failure
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- SCENARIO 3: MCP Tool Execution Failure ---");
    console.log("=======================================================");

    // 3.1 Tool Result: get_study_plan for non-existent plan ID
    console.log("\n[Scenario 3.1] Tool Result: get_study_plan for non-existent plan ID returns isError: true");
    const nonexistentPlanToolResult = await mcpClient.callTool({
        name: "get_study_plan",
        arguments: { planId: "nonexistent_plan_9999" }
    });
    assert.equal(Boolean(nonexistentPlanToolResult.isError), true, "get_study_plan for non-existent plan must return isError: true");
    const nonexistentPlanText = nonexistentPlanToolResult.content?.[0]?.text || "";
    assert.ok(
        nonexistentPlanText.includes("No study plan found with ID \"nonexistent_plan_9999\""),
        `Error must clearly explain plan does not exist. Received: "${nonexistentPlanText}"`
    );
    console.log(`✓ Tool result verified: isError=true, error message: "${nonexistentPlanText}"`);

    // 3.2 Tool Result: record_study_session for non-existent plan ID
    console.log("\n[Scenario 3.2] Tool Result: record_study_session on non-existent plan returns isError: true");
    const nonexistentSessionResult = await mcpClient.callTool({
        name: "record_study_session",
        arguments: {
            planId: "nonexistent_plan_9999",
            subject: "Mathematics",
            hoursSpent: 2,
            status: "completed"
        }
    });
    assert.equal(Boolean(nonexistentSessionResult.isError), true, "record_study_session for non-existent plan must return isError: true");
    console.log(`✓ Tool result verified: isError=true for session recording on missing plan`);

    // 3.3 Tool Result: adapt_study_plan for non-existent plan ID
    console.log("\n[Scenario 3.3] Tool Result: adapt_study_plan on non-existent plan returns isError: true");
    const nonexistentAdaptResult = await mcpClient.callTool({
        name: "adapt_study_plan",
        arguments: { planId: "nonexistent_plan_9999" }
    });
    assert.equal(Boolean(nonexistentAdaptResult.isError), true, "adapt_study_plan for non-existent plan must return isError: true");
    console.log(`✓ Tool result verified: isError=true for adapting missing plan`);

    // 3.4 Agent Response & Status: MCP tool failure (storage error) suppresses fabricated plan
    console.log("\n[Scenario 3.4] Agent Response: MCP tool execution failure suppresses fabricated plan and allocations");
    
    // Mock MCP Client that simulates a tool execution failure (e.g. disk write failure)
    const failingMcpClient = {
        listTools() {
            return availableTools;
        },
        async callTool(name) {
            return {
                isError: true,
                content: `Error creating study plan: Storage failure - disk full or write permission denied for plan "test_fail".`
            };
        }
    };

    // Provider that attempts to claim success and fabricate a plan after tool failure
    const hallucinatingProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Mathematics", "Physics", "Chemistry"],
                                examDate: "2026-11-30",
                                dailyAvailableHours: 3
                            }
                        }
                    ],
                    content: "Creating your study plan now."
                };
            }
            // Model fabricates allocations and claims success despite tool failure
            return {
                toolCalls: [],
                content: "Study plan created successfully! Here are your allocations: Mathematics: 75h, Physics: 50h, Chemistry: 25h. Daily schedule: 3 hours/day."
            };
        }
    };

    const failingToolAgent = new AdaptiveAgent({
        provider: hallucinatingProvider,
        mcpClient: failingMcpClient,
        maxRounds: 3
    });

    const failingToolAgentResult = await failingToolAgent.run({
        message: "Create a study plan for Mathematics, Physics, and Chemistry."
    });

    // Verify Success/Failure status
    assert.equal(failingToolAgentResult.success, false, "Agent success status must be false when tool execution fails");
    // Verify Agent response
    assert.ok(
        failingToolAgentResult.reply.startsWith("Action Failed:"),
        `Agent reply must start with 'Action Failed:'. Received: "${failingToolAgentResult.reply}"`
    );
    assert.ok(
        failingToolAgentResult.reply.includes("Storage failure") || failingToolAgentResult.reply.includes("disk full"),
        `Agent reply must report the honest tool failure reason. Received: "${failingToolAgentResult.reply}"`
    );
    assert.ok(
        !failingToolAgentResult.reply.includes("Mathematics: 75h"),
        "Agent must NOT include fabricated Mathematics allocation (75h)"
    );
    assert.ok(
        !failingToolAgentResult.reply.includes("Physics: 50h"),
        "Agent must NOT include fabricated Physics allocation (50h)"
    );
    assert.ok(
        !failingToolAgentResult.reply.includes("Chemistry: 25h"),
        "Agent must NOT include fabricated Chemistry allocation (25h)"
    );
    assert.ok(
        !failingToolAgentResult.reply.includes("Study plan created successfully!"),
        "Agent must NOT present a fabricated success claim"
    );
    console.log("✓ Agent response verified: success=false, honest failure reported, all fabricated allocations strictly suppressed");

    // 3.5 Agent Response & Status: Unexpected MCP transport/runtime exception handled honestly
    console.log("\n[Scenario 3.5] Agent Response: Unexpected MCP transport exception caught and reported honestly");
    const throwingMcpClient = {
        listTools() {
            return availableTools;
        },
        async callTool() {
            throw new Error("MCP STDIO connection closed unexpectedly: process terminated with code 1");
        }
    };

    const crashingToolProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Biology"],
                                examDate: "2026-11-30",
                                dailyAvailableHours: 2
                            }
                        }
                    ]
                };
            }
            return {
                toolCalls: [],
                content: "Biology study plan created with 40 allocated hours."
            };
        }
    };

    const crashingAgent = new AdaptiveAgent({
        provider: crashingToolProvider,
        mcpClient: throwingMcpClient,
        maxRounds: 3
    });

    const crashingResult = await crashingAgent.run({
        message: "Create Biology study plan"
    });

    assert.equal(crashingResult.success, false, "Agent success status must be false when tool throws unexpected exception");
    assert.ok(crashingResult.reply.startsWith("Action Failed:"), "Agent reply must start with 'Action Failed:'");
    assert.ok(crashingResult.reply.includes("connection closed unexpectedly"), "Agent reply must report honest exception context");
    assert.ok(!crashingResult.reply.includes("Biology study plan created"), "Agent must NOT invent a created plan");
    console.log("✓ Agent response verified: success=false, transport crash caught gracefully without fabricating plan");

    // 3.6 Agent Response & Status: Non-existent plan retrieval failure handled honestly
    console.log("\n[Scenario 3.6] Agent Response: get_study_plan for non-existent plan reports honest failure");
    const getMissingPlanProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "get_study_plan",
                            arguments: { planId: "nonexistent_plan_xyz" }
                        }
                    ]
                };
            }
            // Model attempts to invent a retrieved plan
            return {
                toolCalls: [],
                content: "Here is your plan: Total completed: 20 hours, Remaining: 40 hours."
            };
        }
    };

    const getMissingAgent = new AdaptiveAgent({
        provider: getMissingPlanProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const getMissingResult = await getMissingAgent.run({
        message: "Show me my study plan nonexistent_plan_xyz"
    });

    assert.equal(getMissingResult.success, false, "Agent success status must be false when retrieved plan does not exist");
    assert.ok(getMissingResult.reply.startsWith("Action Failed:"), "Agent reply must start with 'Action Failed:'");
    assert.ok(
        getMissingResult.reply.includes("No study plan found with ID \"nonexistent_plan_xyz\""),
        "Agent reply must convey that the plan does not exist"
    );
    assert.ok(!getMissingResult.reply.includes("Total completed: 20 hours"), "Agent must NOT invent retrieved metrics");
    console.log("✓ Agent response verified: success=false, retrieval failure handled honestly");

    // =========================================================================
    // GAP FIX 1: Past Exam Date Validation (Controlled / Injectable Reference Date)
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- GAP FIX 1: Past Exam Date Validation ---");
    console.log("=======================================================");

    // 1.A calculateDaysRemaining unit tests with controlled reference date
    const controlledReferenceDate = new Date("2026-10-15T12:00:00Z");
    console.log(`\n[Gap 1.A] Engine Unit Tests with controlled reference date: 2026-10-15`);

    // Past date relative to reference date must throw
    assert.throws(
        () => calculateDaysRemaining("2026-10-10", controlledReferenceDate),
        (err) => {
            assert.equal(err.message, "Exam date cannot be in the past.");
            return true;
        },
        "calculateDaysRemaining must throw 'Exam date cannot be in the past.' for past dates"
    );
    console.log("✓ Past date (2026-10-10 vs ref 2026-10-15) throws: 'Exam date cannot be in the past.'");

    // Today's date relative to reference date must be preserved as 1 day remaining
    const todayDays = calculateDaysRemaining("2026-10-15", controlledReferenceDate);
    assert.equal(todayDays, 1, "Today's date relative to reference date must be preserved with 1 day remaining");
    console.log("✓ Today's date (2026-10-15 vs ref 2026-10-15) preserved: 1 day remaining");

    // Future date relative to reference date must compute exact days
    const futureDays = calculateDaysRemaining("2026-10-25", controlledReferenceDate);
    assert.equal(futureDays, 10, "Future date must return 10 days remaining");
    console.log("✓ Future date (2026-10-25 vs ref 2026-10-15) preserved: 10 days remaining");

    // 1.B validator.js unit tests with controlled reference date
    console.log("\n[Gap 1.B] Validator Unit Tests for past dates");
    const pastValidation = validateToolArguments(createToolDef, {
        subjects: ["Mathematics"],
        dailyAvailableHours: 3,
        examDate: "2020-01-01"
    }, { referenceDate: controlledReferenceDate });
    assert.equal(pastValidation.valid, false, "validateToolArguments must reject past dates");
    assert.equal(pastValidation.error, "Exam date cannot be in the past.");
    console.log("✓ Validator correctly returns: 'Exam date cannot be in the past.'");

    const todayValidation = validateToolArguments(createToolDef, {
        subjects: ["Mathematics"],
        dailyAvailableHours: 3,
        examDate: "2026-10-15"
    }, { referenceDate: controlledReferenceDate });
    assert.equal(todayValidation.valid, true, "validateToolArguments must accept today's date");
    console.log("✓ Validator correctly accepts today's date");

    // 1.C Real MCP Tool Call with past date
    console.log("\n[Gap 1.C] Real MCP tool call with past date (2020-01-01)");
    const pastDateMcpResult = await mcpClient.callTool({
        name: "create_study_plan",
        arguments: {
            subjects: ["Mathematics"],
            examDate: "2020-01-01",
            dailyAvailableHours: 3
        }
    });
    assert.equal(Boolean(pastDateMcpResult.isError), true, "MCP tool must reject past date");
    const pastDateText = pastDateMcpResult.content?.[0]?.text || "";
    assert.ok(
        pastDateText.includes("Exam date cannot be in the past."),
        `MCP tool error must be 'Exam date cannot be in the past.'. Received: "${pastDateText}"`
    );
    console.log(`✓ Real MCP tool call rejected past date: "${pastDateText}"`);

    // 1.D Agent E2E with past date
    console.log("\n[Gap 1.D] Agent E2E rejection of past exam date without fabricating plan");
    const pastDateAgentProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Mathematics"],
                                examDate: "2020-01-01",
                                dailyAvailableHours: 3
                            }
                        }
                    ]
                };
            }
            return {
                toolCalls: [],
                content: "Study plan created with 50 hours for Mathematics!"
            };
        }
    };
    const pastDateAgent = new AdaptiveAgent({
        provider: pastDateAgentProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });
    const pastDateAgentResult = await pastDateAgent.run({
        message: "Create plan for Mathematics with exam date 2020-01-01"
    });
    assert.equal(pastDateAgentResult.success, false, "Agent must report failure for past exam date");
    assert.ok(pastDateAgentResult.reply.startsWith("Action Failed:"), "Agent reply must start with 'Action Failed:'");
    assert.ok(pastDateAgentResult.reply.includes("Exam date cannot be in the past."), "Agent reply must state 'Exam date cannot be in the past.'");
    assert.ok(!pastDateAgentResult.reply.includes("50 hours for Mathematics"), "Agent must NOT invent plan allocations");
    console.log("✓ Agent safely rejected past exam date and suppressed fabricated plan");

    // =========================================================================
    // GAP FIX 2: Parallel Tool-Call Failure Tracking
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- GAP FIX 2: Parallel Tool-Call Failure Tracking ---");
    console.log("=======================================================");

    // 2.A Order A: Failed call followed by Successful call in the same turn
    console.log("\n[Gap 2.A] Parallel Call Order A: [Failed Call, Successful Call]");
    const parallelOrderAProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            // Call 1: FAILS (invalid date format)
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Biology"],
                                examDate: "not-a-date",
                                dailyAvailableHours: 2,
                                planId: `failed_first_${Date.now()}`
                            }
                        },
                        {
                            // Call 2: SUCCEEDS (valid arguments)
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Mathematics", "Physics"],
                                examDate: "2026-11-30",
                                dailyAvailableHours: 3,
                                priorities: { Mathematics: "high", Physics: "medium" },
                                planId: `success_second_${Date.now()}`
                            }
                        }
                    ],
                    content: "Creating your requested plans."
                };
            }
            // Model attempts to gloss over Call 1 and claim full victory
            return {
                toolCalls: [],
                content: "All study plans have been created successfully!"
            };
        }
    };

    const parallelOrderAAgent = new AdaptiveAgent({
        provider: parallelOrderAProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    // Default workflow: allowPartialSuccess is false -> overall success is false, but partialSuccess is true
    const orderAResultDefault = await parallelOrderAAgent.run({
        message: "Create both study plans",
        allowPartialSuccess: false
    });

    assert.equal(orderAResultDefault.success, false, "When allowPartialSuccess=false, overall success must be false");
    assert.equal(orderAResultDefault.partialSuccess, true, "partialSuccess must be true when one call succeeds and one fails");
    assert.ok(
        orderAResultDefault.reply.startsWith("Action Partially Completed:"),
        `Reply must start with 'Action Partially Completed:'. Received: "${orderAResultDefault.reply}"`
    );
    assert.ok(
        orderAResultDefault.reply.includes("not-a-date") || orderAResultDefault.reply.includes("YYYY-MM-DD"),
        "Reply must surface the failure of Call 1 and not hide it behind Call 2"
    );
    assert.ok(
        orderAResultDefault.reply.includes("Mathematics") && orderAResultDefault.reply.includes("Physics"),
        "Reply must present the grounded outcome of the successful Call 2"
    );
    assert.ok(
        !orderAResultDefault.reply.includes("All study plans have been created successfully!"),
        "Fabricated complete success claim must be suppressed"
    );
    console.log("✓ Order A with allowPartialSuccess=false: success=false, partialSuccess=true, failure surfaced first");

    // Workflow explicitly allowing partial success -> overall success is true with partialSuccess=true
    parallelOrderAProvider.turn = 0;
    const orderAResultPermissive = await parallelOrderAAgent.run({
        message: "Create both study plans",
        allowPartialSuccess: true
    });
    assert.equal(orderAResultPermissive.success, true, "When allowPartialSuccess=true, overall success is true");
    assert.equal(orderAResultPermissive.partialSuccess, true, "partialSuccess is true");
    assert.ok(orderAResultPermissive.reply.startsWith("Action Partially Completed:"), "Failure is still surfaced honestly");
    console.log("✓ Order A with allowPartialSuccess=true: success=true, partialSuccess=true, honest reporting");

    // 2.B Order B: Successful call followed by Failed call in the same turn
    console.log("\n[Gap 2.B] Parallel Call Order B: [Successful Call, Failed Call]");
    const parallelOrderBProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            // Call 1: SUCCEEDS (valid arguments)
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Chemistry", "History"],
                                examDate: "2026-11-30",
                                dailyAvailableHours: 3,
                                priorities: { Chemistry: "high", History: "low" },
                                planId: `success_first_${Date.now()}`
                            }
                        },
                        {
                            // Call 2: FAILS (invalid date format)
                            name: "create_study_plan",
                            arguments: {
                                subjects: ["Biology"],
                                examDate: "not-a-date",
                                dailyAvailableHours: 2,
                                planId: `failed_second_${Date.now()}`
                            }
                        }
                    ],
                    content: "Creating your requested plans."
                };
            }
            return {
                toolCalls: [],
                content: "All plans created smoothly!"
            };
        }
    };

    const parallelOrderBAgent = new AdaptiveAgent({
        provider: parallelOrderBProvider,
        mcpClient: mcpManager,
        maxRounds: 3
    });

    const orderBResultDefault = await parallelOrderBAgent.run({
        message: "Create both study plans",
        allowPartialSuccess: false
    });

    assert.equal(orderBResultDefault.success, false, "When allowPartialSuccess=false, overall success must be false");
    assert.equal(orderBResultDefault.partialSuccess, true, "partialSuccess must be true");
    assert.ok(orderBResultDefault.reply.startsWith("Action Partially Completed:"), "Reply must start with 'Action Partially Completed:'");
    assert.ok(
        orderBResultDefault.reply.includes("not-a-date") || orderBResultDefault.reply.includes("YYYY-MM-DD"),
        "Reply must surface the failure of Call 2"
    );
    assert.ok(
        orderBResultDefault.reply.includes("Chemistry") && orderBResultDefault.reply.includes("History"),
        "Reply must present the grounded outcome of the successful Call 1"
    );
    console.log("✓ Order B with allowPartialSuccess=false: success=false, partialSuccess=true, failure surfaced first");

    // 2.C Symmetry Verification: Order invariance
    assert.equal(orderAResultDefault.success, orderBResultDefault.success, "Order A and Order B must have identical success status");
    assert.equal(orderAResultDefault.partialSuccess, orderBResultDefault.partialSuccess, "Order A and Order B must both report partialSuccess=true");
    console.log("✓ Symmetry verified: Failure handling behavior is invariant to execution order within the turn");

    // =========================================================================
    // GAP FIX 3: MCP Tool-Call Timeout
    // =========================================================================
    console.log("\n=======================================================");
    console.log("--- GAP FIX 3: MCP Tool-Call Timeout ---");
    console.log("=======================================================");

    // 3.A McpClientManager deterministic timeout via controlled tool call
    console.log("\n[Gap 3.A] McpClientManager deterministic timeout on slow/hung tool");

    // Create a mock MCP client that simulates a hanging tool
    const slowClientManager = new McpClientManager({
        toolTimeoutMs: 30 // 30ms timeout
    });
    slowClientManager.connected = true;
    slowClientManager.tools = [
        {
            name: "slow_calculation",
            inputSchema: { type: "object", properties: {} }
        }
    ];
    slowClientManager.client = {
        async callTool() {
            // Hung operation that does not resolve within timeout
            return new Promise(resolve => setTimeout(resolve, 500));
        }
    };

    const startTime = Date.now();
    const timeoutResult = await slowClientManager.callTool("slow_calculation", {}, { timeout: 35 });
    const elapsedTime = Date.now() - startTime;

    assert.equal(timeoutResult.isError, true, "Timed-out tool call must return isError: true");
    assert.ok(
        timeoutResult.content.includes("timed out after 35ms"),
        `Error message must indicate timeout. Received: "${timeoutResult.content}"`
    );
    assert.ok(elapsedTime < 250, `Timeout must resolve promptly (took ${elapsedTime}ms, expected ~35ms)`);
    assert.equal(slowClientManager.connected, true, "Client manager must remain connected after timeout");
    console.log(`✓ Tool timed out cleanly in ${elapsedTime}ms with message: "${timeoutResult.content}"`);

    // 3.B AdaptiveAgent handling of timed-out tool without claiming success
    console.log("\n[Gap 3.B] AdaptiveAgent honest failure response on tool timeout");
    const timeoutAgentProvider = {
        turn: 0,
        async chat() {
            this.turn++;
            if (this.turn === 1) {
                return {
                    toolCalls: [
                        {
                            name: "slow_calculation",
                            arguments: {}
                        }
                    ]
                };
            }
            // Model tries to invent that calculation completed
            return {
                toolCalls: [],
                content: "The slow calculation succeeded with result: 42."
            };
        }
    };

    const timeoutAgent = new AdaptiveAgent({
        provider: timeoutAgentProvider,
        mcpClient: slowClientManager,
        maxRounds: 3
    });

    const timeoutAgentResult = await timeoutAgent.run({
        message: "Run slow calculation"
    });

    assert.equal(timeoutAgentResult.success, false, "Agent success status must be false on timeout");
    assert.ok(
        timeoutAgentResult.reply.startsWith("Action Failed:"),
        `Agent reply must start with 'Action Failed:'. Received: "${timeoutAgentResult.reply}"`
    );
    assert.ok(
        timeoutAgentResult.reply.includes("timed out"),
        `Agent reply must report that the tool timed out. Received: "${timeoutAgentResult.reply}"`
    );
    assert.ok(
        !timeoutAgentResult.reply.includes("succeeded with result: 42"),
        "Agent must NOT claim tool succeeded or fabricate results"
    );
    console.log("✓ Agent response on timeout verified: success=false, honest timeout report, zero hallucinated results");

        console.log("\n===============================================================================");
        console.log("ALL FAILURE-HANDLING SCENARIOS & GAP FIXES PASSED DETERMINISTICALLY! (100%)");
        console.log("===============================================================================");
    } finally {
        try {
            await mcpClient.close();
        } catch { }
        try {
            await mcpManager.disconnect();
        } catch { }
        try {
            fs.rmSync(isolatedDataDir, { recursive: true, force: true });
        } catch { }
    }
}

runFailureHandlingSuite().catch(err => {
    console.error("\n❌ Failure handling test suite failed:", err);
    process.exit(1);
});
