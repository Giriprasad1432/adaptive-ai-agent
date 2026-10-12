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

        console.log("\n========================================================");
        console.log("ALL 6 DETERMINISTIC TESTS PASSED SUCCESSFULLY! (100%)");
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
