import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runDeterministicTests() {
    console.log("=== StudyPilot MCP Deterministic Test Suite ===");

    const serverScript = path.resolve(__dirname, "../studypilot-server/server.js");
    console.log(`Connecting to StudyPilot MCP server: ${serverScript}`);

    const client = new Client({
        name: "studypilot-test-client",
        version: "1.0.0"
    });

    const transport = new StdioClientTransport({
        command: "node",
        args: [serverScript]
    });

    try {
        // Step 1: Connect to server
        await client.connect(transport);
        console.log("✓ Connected to StudyPilot MCP server via STDIO");

        // Step 2: Discover and verify tools
        const { tools } = await client.listTools();
        const toolNames = tools.map(t => t.name);
        console.log(`✓ Discovered ${tools.length} tools: [${toolNames.join(", ")}]`);

        const expectedTools = [
            "create_study_plan",
            "get_study_plan",
            "record_study_session",
            "adapt_study_plan"
        ];

        for (const expected of expectedTools) {
            assert.ok(toolNames.includes(expected), `Missing expected tool: ${expected}`);
        }
        console.log("✓ Tool catalog verified: all 4 StudyPilot tools registered");

        const testPlanId = `test_plan_${Date.now()}`;

        // Step 3: Test create_study_plan
        console.log(`\n--- Test 1: create_study_plan (planId: ${testPlanId}) ---`);
        const createResult = await client.callTool({
            name: "create_study_plan",
            arguments: {
                planId: testPlanId,
                subjects: ["Mathematics", "Physics", "Chemistry"],
                examDate: "2026-12-31",
                dailyAvailableHours: 4,
                priorities: {
                    Mathematics: "high",
                    Physics: "medium",
                    Chemistry: "low"
                }
            }
        });

        assert.equal(Boolean(createResult.isError), false, "create_study_plan returned an error");
        const createText = createResult.content[0].text;
        const createData = JSON.parse(createText);
        assert.ok(createData.subjectAllocations.Mathematics, "Mathematics should be allocated");
        assert.ok(createData.subjectAllocations.Physics, "Physics should be allocated");
        assert.ok(createData.subjectAllocations.Chemistry, "Chemistry should be allocated");
        assert.ok(
            createData.subjectAllocations.Mathematics.allocatedHours > createData.subjectAllocations.Chemistry.allocatedHours,
            "High priority subject (Math) should receive more hours than low priority (Chemistry)"
        );
        console.log("✓ create_study_plan succeeded:");
        console.log(`  Total hours: ${createData.totalAllocatedHours}h across 3 subjects`);
        console.log(`  Allocations: Math=${createData.subjectAllocations.Mathematics.allocatedHours}h, Physics=${createData.subjectAllocations.Physics.allocatedHours}h, Chem=${createData.subjectAllocations.Chemistry.allocatedHours}h`);

        // Step 4: Test get_study_plan
        console.log(`\n--- Test 2: get_study_plan (planId: ${testPlanId}) ---`);
        const getResult1 = await client.callTool({
            name: "get_study_plan",
            arguments: { planId: testPlanId }
        });

        assert.equal(Boolean(getResult1.isError), false, "get_study_plan returned an error");
        const getData1 = JSON.parse(getResult1.content[0].text);
        assert.equal(getData1.planId, testPlanId);
        assert.equal(getData1.totalCompletedHours, 0);
        console.log(`✓ get_study_plan verified: Progress ${getData1.overallProgress}, Remaining: ${getData1.totalRemainingHours}h`);

        // Step 5: Test record_study_session (completed session)
        console.log(`\n--- Test 3: record_study_session (completed 2 hours Chemistry) ---`);
        const compSessionResult = await client.callTool({
            name: "record_study_session",
            arguments: {
                planId: testPlanId,
                subject: "Chemistry",
                hoursSpent: 2,
                status: "completed",
                notes: "Finished organic chemistry review chapter 1"
            }
        });

        assert.equal(Boolean(compSessionResult.isError), false, "record_study_session (completed) failed");
        const compSessionData = JSON.parse(compSessionResult.content[0].text);
        assert.equal(compSessionData.subjectProgress.completedHours, 2);
        console.log(`✓ Completed session recorded: Chemistry completedHours=${compSessionData.subjectProgress.completedHours}h`);

        // Step 6: Test record_study_session (missed session)
        console.log(`\n--- Test 4: record_study_session (missed Mathematics session) ---`);
        const missedSessionResult = await client.callTool({
            name: "record_study_session",
            arguments: {
                planId: testPlanId,
                subject: "Mathematics",
                hoursSpent: 0,
                status: "missed",
                notes: "Missed scheduled session due to urgent meeting"
            }
        });

        assert.equal(Boolean(missedSessionResult.isError), false, "record_study_session (missed) failed");
        const missedSessionData = JSON.parse(missedSessionResult.content[0].text);
        assert.ok(missedSessionData.subjectProgress.missedHours > 0, "Missed hours should be registered");
        console.log(`✓ Missed session recorded: Math missedHours=${missedSessionData.subjectProgress.missedHours}h`);

        // Step 7: Test adapt_study_plan
        console.log(`\n--- Test 5: adapt_study_plan (re-balancing after missed session) ---`);
        const adaptResult = await client.callTool({
            name: "adapt_study_plan",
            arguments: {
                planId: testPlanId,
                reason: "Catch up on missed Mathematics study session"
            }
        });

        assert.equal(Boolean(adaptResult.isError), false, "adapt_study_plan failed");
        const adaptData = JSON.parse(adaptResult.content[0].text);
        assert.ok(adaptData.adaptationId, "Should generate an adaptation ID");
        assert.ok(adaptData.recommendedDailyHours > 0, "Should compute recommended daily study hours");
        console.log("✓ adapt_study_plan succeeded:");
        console.log(`  Reason: ${adaptData.reason}`);
        console.log(`  Recommended daily study pace: ${adaptData.recommendedDailyHours}h/day`);

        // Step 8: Test get_study_plan verifying updated status
        console.log(`\n--- Test 6: get_study_plan (verifying final adapted state) ---`);
        const getFinalResult = await client.callTool({
            name: "get_study_plan",
            arguments: { planId: testPlanId }
        });

        assert.equal(Boolean(getFinalResult.isError), false, "get_study_plan (final) failed");
        const finalData = JSON.parse(getFinalResult.content[0].text);
        assert.equal(finalData.totalSessionsRecorded, 2, "Should have 2 recorded sessions in history");
        assert.ok(finalData.recentAdaptations.length >= 1, "Should have adaptation history recorded");
        console.log("✓ Final adapted study plan state verified:");
        console.log(`  Sessions recorded: ${finalData.totalSessionsRecorded}`);
        console.log(`  Adaptations recorded: ${finalData.recentAdaptations.length}`);
        console.log(`  Total completed: ${finalData.totalCompletedHours}h, Total remaining: ${finalData.totalRemainingHours}h`);

        // Step 9: Regression Suite for Study-Plan Accounting and Adaptation Consistency (adaptive-demo)
        console.log(`\n--- Test 7: Regression: Accounting & Adaptation Consistency for "adaptive-demo" ---`);
        const demoPlanId = "adaptive-demo";

        // 7.1 Create plan
        const createDemoRes = await client.callTool({
            name: "create_study_plan",
            arguments: {
                planId: demoPlanId,
                subjects: ["Mathematics", "Physics", "Chemistry"],
                examDate: "2026-11-30",
                dailyAvailableHours: 3,
                priorities: { Mathematics: "high", Physics: "medium", Chemistry: "low" }
            }
        });
        assert.equal(Boolean(createDemoRes.isError), false, "create_study_plan failed for adaptive-demo");

        // 7.2 Record completed Mathematics session (1.5 hours)
        const recordMathRes = await client.callTool({
            name: "record_study_session",
            arguments: {
                planId: demoPlanId,
                subject: "Mathematics",
                hoursSpent: 1.5,
                status: "completed",
                notes: "Calculus practice"
            }
        });
        assert.equal(Boolean(recordMathRes.isError), false, "record Math session failed");

        // 7.3 Record missed Chemistry session (0 hours spent)
        const recordChemRes = await client.callTool({
            name: "record_study_session",
            arguments: {
                planId: demoPlanId,
                subject: "Chemistry",
                hoursSpent: 0,
                status: "missed",
                notes: "Lab session cancelled"
            }
        });
        assert.equal(Boolean(recordChemRes.isError), false, "record Chemistry missed session failed");
        const chemSessionData = JSON.parse(recordChemRes.content[0].text);
        assert.equal(chemSessionData.session.hoursSpent, 0, "Missed session actual hoursSpent must be 0");
        assert.equal(chemSessionData.session.missedHours, 2, "Missed session missedHours must be explicitly recorded as 2");
        assert.equal(chemSessionData.subjectProgress.missedHours, 2, "Chemistry missedHours must be 2");

        // 7.4 Adapt study plan
        const adaptDemoRes = await client.callTool({
            name: "adapt_study_plan",
            arguments: {
                planId: demoPlanId,
                reason: "Rebalance schedule after missed Chemistry session"
            }
        });
        assert.equal(Boolean(adaptDemoRes.isError), false, "adapt_study_plan failed for adaptive-demo");
        const adaptDemoData = JSON.parse(adaptDemoRes.content[0].text);

        // Verification of adaptation calculations
        assert.equal(adaptDemoData.daysRemaining, 49, "Days remaining must be 49");
        assert.equal(adaptDemoData.recommendedDailyHours, 3.1, "Recommended daily pace must be 3.1h/day when over capacity");
        assert.ok(adaptDemoData.capacityWarning, "Capacity warning must be present when workload exceeds capacity");
        assert.ok(
            adaptDemoData.capacityWarning.includes("exceeds available capacity (147h)"),
            `Warning must mention 147h available capacity: "${adaptDemoData.capacityWarning}"`
        );
        assert.ok(
            adaptDemoData.capacityWarning.includes("Recommended daily hours: 3.1h"),
            `Warning must recommend 3.1h: "${adaptDemoData.capacityWarning}"`
        );

        // Verify adjusted allocations preserve priorities and do not exceed capacity (147h)
        const allocations = adaptDemoData.adjustedSubjectAllocations;
        assert.ok(allocations.Mathematics, "Mathematics must be present");
        assert.ok(allocations.Physics, "Physics must be present");
        assert.ok(allocations.Chemistry, "Chemistry must be present");
        assert.equal(allocations.Mathematics.priority, "high");
        assert.equal(allocations.Physics.priority, "medium");
        assert.equal(allocations.Chemistry.priority, "low");

        // High priority Math has higher allocation than medium Physics, which has higher than low Chem
        assert.ok(allocations.Mathematics.remainingHours > allocations.Physics.remainingHours, "Math remaining > Physics remaining");
        assert.ok(allocations.Physics.remainingHours > allocations.Chemistry.remainingHours, "Physics remaining > Chemistry remaining");

        const remainingSum = Math.round((allocations.Mathematics.remainingHours + allocations.Physics.remainingHours + allocations.Chemistry.remainingHours) * 10) / 10;
        assert.equal(remainingSum, 147.0, `Remaining hours sum (${remainingSum}) must equal available capacity (147.0h), never exceeding it`);

        // 7.5 Retrieve plan via get_study_plan and verify complete accounting invariants & persistence
        const getDemoRes = await client.callTool({
            name: "get_study_plan",
            arguments: { planId: demoPlanId }
        });
        assert.equal(Boolean(getDemoRes.isError), false, "get_study_plan failed for adaptive-demo");
        const retrievedPlan = JSON.parse(getDemoRes.content[0].text);

        assert.equal(retrievedPlan.planId, "adaptive-demo");
        assert.equal(retrievedPlan.examDate, "2026-11-30");
        assert.equal(retrievedPlan.daysRemaining, 49);
        assert.equal(retrievedPlan.dailyStudyHours, 3);
        assert.equal(retrievedPlan.availableCapacityHours, 147);
        assert.equal(retrievedPlan.totalRemainingHours, 147);
        assert.equal(retrievedPlan.totalCompletedHours, 1.5);
        assert.equal(retrievedPlan.totalMissedHours, 2);
        assert.equal(retrievedPlan.totalAllocatedHours, 148.5);
        assert.equal(retrievedPlan.totalSessionsRecorded, 2);

        // Verify recent sessions list contains explicit data for both sessions
        assert.equal(retrievedPlan.recentSessions.length, 2);
        const mathSess = retrievedPlan.recentSessions.find(s => s.subject === "Mathematics");
        const chemSess = retrievedPlan.recentSessions.find(s => s.subject === "Chemistry");
        assert.ok(mathSess, "Math session must be in recentSessions");
        assert.equal(mathSess.hoursSpent, 1.5);
        assert.equal(mathSess.missedHours, 0);
        assert.equal(mathSess.status, "completed");

        assert.ok(chemSess, "Chemistry session must be in recentSessions");
        assert.equal(chemSess.hoursSpent, 0);
        assert.equal(chemSess.missedHours, 2, "Chemistry missed session must explicitly document 2 missedHours");
        assert.equal(chemSess.status, "missed");

        // Verify accounting invariants on subject level
        for (const [sName, sData] of Object.entries(retrievedPlan.subjects)) {
            const expectedAllocated = Math.round((sData.completedHours + sData.remainingHours) * 10) / 10;
            assert.equal(sData.allocatedHours, expectedAllocated, `Subject ${sName}: allocatedHours must equal completedHours + remainingHours`);
        }

        console.log("✓ Test 7 PASSED: Study-plan accounting invariants, missed session tracking, and capacity-constrained adaptation verified!");

        console.log("\n========================================================");
        console.log("ALL 7 DETERMINISTIC & REGRESSION TESTS PASSED! (100%)");
        console.log("========================================================");

        await client.close();
        process.exit(0);
    } catch (error) {
        console.error("\n❌ Test failure:", error);
        try {
            await client.close();
        } catch { }
        process.exit(1);
    }
}

runDeterministicTests();
