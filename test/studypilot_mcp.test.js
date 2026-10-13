import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Ensure module constants (DATA_FILE, LOCK_FILE) initialize within isolated temporary storage
const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "studypilot-mcp-test-"));
process.env.STUDYPILOT_DATA_DIR = isolatedDataDir;

const { DATA_FILE, LOCK_FILE, acquireLock, releaseLock, withFileLock, loadAllPlans, saveAllPlans, savePlan, getPlan, updatePlan } = await import("../studypilot-server/storage.js");
import { recordSession } from "../studypilot-server/planner.js";

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
        command: process.execPath,
        args: [serverScript],
        env: {
            ...process.env,
            STUDYPILOT_DATA_DIR: isolatedDataDir
        }
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
            "list_study_plans",
            "create_study_plan",
            "get_study_plan",
            "record_study_session",
            "adapt_study_plan"
        ];

        for (const expected of expectedTools) {
            assert.ok(toolNames.includes(expected), `Missing expected tool: ${expected}`);
        }
        console.log("✓ Tool catalog verified: all 5 StudyPilot tools registered");

        const testPlanId = `test_plan_${Date.now()}`;

        // An omitted ID is generated uniquely, and the plan can be found without
        // exposing that internal identifier as a user requirement.
        const generatedCreate = await client.callTool({
            name: "create_study_plan",
            arguments: { subjects: ["DBMS"], durationDays: 3, dailyAvailableHours: 2 }
        });
        assert.equal(Boolean(generatedCreate.isError), false);
        const generatedPlan = JSON.parse(generatedCreate.content[0].text);
        assert.match(generatedPlan.planId, /^dbms-[a-f0-9]{8}$/);
        const listedPlans = await client.callTool({ name: "list_study_plans", arguments: {} });
        assert.equal(Boolean(listedPlans.isError), false);
        assert.ok(JSON.parse(listedPlans.content[0].text).plans.some(plan => plan.planId === generatedPlan.planId));

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
        assert.equal(createData.totalCompletedHours, 0, "A newly created plan has no completed hours");
        assert.equal(createData.overallProgressPercentage, 0, "A newly created plan starts at 0% progress");
        assert.ok(createData.totalRemainingHours > 0, "A newly created plan retains uncompleted allocated hours");
        assert.equal(createData.subjectAllocations.Mathematics.completedHours, 0);
        assert.equal(createData.subjectAllocations.Mathematics.progressPercentage, 0);
        assert.ok(
            createData.subjectAllocations.Mathematics.allocatedHours > createData.subjectAllocations.Chemistry.allocatedHours,
            "High priority subject (Math) should receive more hours than low priority (Chemistry)"
        );
        const duplicateCreate = await client.callTool({
            name: "create_study_plan",
            arguments: { planId: testPlanId, subjects: ["History"], durationDays: 9, dailyAvailableHours: 1 }
        });
        assert.equal(Boolean(duplicateCreate.isError), true, "An explicit ID collision must be rejected");
        const duplicateText = duplicateCreate.content?.map(item => item.text).join("\n") || "";
        assert.match(duplicateText, /already exists/i);
        assert.equal(getPlan(testPlanId).subjects.History, undefined, "A duplicate create must not replace the saved plan");
        console.log("✓ create_study_plan succeeded:");
        console.log(`  Total hours: ${createData.totalAllocatedHours}h across 3 subjects`);
        console.log(`  Allocations: Math=${createData.subjectAllocations.Mathematics.allocatedHours}h, Physics=${createData.subjectAllocations.Physics.allocatedHours}h, Chem=${createData.subjectAllocations.Chemistry.allocatedHours}h`);

        // Step 4: Test get_study_plan
        console.log(`\n--- Test 2: get_study_plan (planId: ${testPlanId}) ---`);
        const getResult1 = await client.callTool({
            name: "get_study_plan",
            arguments: { planId: testPlanId }
        });

        if (getResult1.isError) {
            console.error(
                "get_study_plan error:",
                getResult1.content?.map(item => item.text).join("\n") || getResult1.content
            );
        }

        assert.equal(
            Boolean(getResult1.isError),
            false,
            `get_study_plan returned an error: ${getResult1.content?.map(item => item.text).join("\n") || JSON.stringify(getResult1.content)}`
        );
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

        if (compSessionResult.isError) {
            console.error(
                "record_study_session error:",
                compSessionResult.content?.map(item => item.text).join("\n")
            );
        }

        assert.equal(
            Boolean(compSessionResult.isError),
            false,
            "record_study_session (completed) failed"
        );
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
        const demoExamDate = (() => {
            const date = new Date();
            date.setDate(date.getDate() + 49);

            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");

            return `${year}-${month}-${day}`;
        })();

        // 7.1 Create plan
        const createDemoRes = await client.callTool({
            name: "create_study_plan",
            arguments: {
                planId: demoPlanId,
                subjects: ["Mathematics", "Physics", "Chemistry"],
                examDate: demoExamDate,
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
        assert.equal(retrievedPlan.examDate, demoExamDate);
        assert.equal(retrievedPlan.daysRemaining, 49);
        assert.equal(retrievedPlan.dailyStudyHours, 3);
        assert.equal(retrievedPlan.availableCapacityHours, 147);
        assert.equal(
            retrievedPlan.totalAvailableHours,
            147,
            "Total available hours must not increase when completed hours are recorded"
        );
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

        // Step 8: Regression Test for Lock-Release Bug & Lock Ownership Verification
        console.log("\n--- Test 8: Lock-Release Bug Regression & Ownership Verification ---");

        // Ensure data directory exists
        fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

        // 8a. Simulate another process holding the lock file with a foreign token
        const foreignToken = `foreign_process_${Date.now()}_test_token`;
        fs.writeFileSync(LOCK_FILE, foreignToken, "utf-8");
        assert.ok(fs.existsSync(LOCK_FILE), "Simulated foreign lock file must exist on disk");

        // 8b. Verify releaseLock(null) does NOT remove foreign lock file
        releaseLock(null);
        assert.ok(fs.existsSync(LOCK_FILE), "releaseLock(null) must NOT unlink foreign lock file");
        assert.equal(
            fs.readFileSync(LOCK_FILE, "utf-8").trim(),
            foreignToken,
            "Foreign lock token must remain intact after releaseLock(null)"
        );

        // 8c. Verify releaseLock with mismatched token does NOT remove foreign lock file
        releaseLock({ fd: 999999, token: "mismatched_token" });
        assert.ok(fs.existsSync(LOCK_FILE), "releaseLock with mismatched token must NOT unlink foreign lock file");
        assert.equal(
            fs.readFileSync(LOCK_FILE, "utf-8").trim(),
            foreignToken,
            "Foreign lock token must remain intact after releaseLock with mismatched token"
        );

        // 8d. Verify withFileLock times out, throws clear error, and does NOT execute protected function
        let fnExecuted = false;
        let timeoutErrorCaught = false;
        try {
            // Short maxWaitMs (60ms) and retryIntervalMs (15ms)
            withFileLock(() => {
                fnExecuted = true;
            }, 60, 15);
        } catch (err) {
            timeoutErrorCaught = true;
            assert.ok(
                err.message.includes("timed out"),
                `Timeout error message expected. Received: "${err.message}"`
            );
        }

        assert.equal(timeoutErrorCaught, true, "withFileLock must throw when acquireLock times out");
        assert.equal(fnExecuted, false, "Protected function must NOT be executed when lock acquisition times out");

        // 8e. Verify foreign lock remains completely intact after withFileLock timeout and finally block
        assert.ok(fs.existsSync(LOCK_FILE), "Foreign lock file must remain intact after withFileLock timeout");
        assert.equal(
            fs.readFileSync(LOCK_FILE, "utf-8").trim(),
            foreignToken,
            "Foreign lock file contents must remain unmodified after withFileLock timeout"
        );

        // Clean up simulated foreign lock
        try { fs.unlinkSync(LOCK_FILE); } catch {}

        // 8f. Verify normal acquireLock, withFileLock, and releaseLock work cleanly
        let normalFnExecuted = false;
        const result = withFileLock(() => {
            normalFnExecuted = true;
            return "lock_success";
        }, 500, 20);
        assert.equal(normalFnExecuted, true, "Protected function must execute when lock acquired successfully");
        assert.equal(result, "lock_success", "withFileLock must return the result of the protected function");
        assert.ok(!fs.existsSync(LOCK_FILE), "Lock file must be cleanly released and removed on normal exit");

        console.log("✓ Test 8 PASSED: Lock-release bug fixed; foreign lock preserved; timeout error thrown; protected function guarded.");

        // Step 9: Regression Test: Prevent Destructive Writes after Read Failures
        console.log("\n--- Test 9: Prevent Destructive Writes after Read Failures ---");

        // 9a. Verify genuinely new installation returns {} when target file does not exist
        const nonExistentFile = path.join(isolatedDataDir, `nonexistent_${Date.now()}.json`);
        assert.ok(!fs.existsSync(nonExistentFile), "nonExistentFile must not exist initially");
        const emptyPlans = loadAllPlans(1, 5, nonExistentFile);
        assert.deepEqual(emptyPlans, {}, "loadAllPlans must return {} when target file does not exist");
        console.log("✓ New installation behavior preserved: returns {} when file does not exist");

        // 9b. Simulate malformed JSON in a data file and verify savePlan throws and does NOT overwrite
        const testDataFile = path.join(isolatedDataDir, `test_malformed_${Date.now()}.json`);
        const malformedContent = '{"corrupted": true, [malformed_syntax}';
        try {
            fs.writeFileSync(testDataFile, malformedContent, "utf-8");

            // loadAllPlans must throw on malformed JSON
            let loadThrew = false;
            try {
                loadAllPlans(2, 5, testDataFile);
            } catch (err) {
                loadThrew = true;
                assert.ok(
                    err.message.includes("Failed to read storage data file"),
                    `Expected read error message. Received: "${err.message}"`
                );
            }
            assert.equal(loadThrew, true, "loadAllPlans must throw on malformed JSON instead of silently returning {}");

            // savePlan must throw and NOT overwrite the malformed data with an empty fallback
            let saveThrew = false;
            try {
                savePlan("destructive_overwrite_candidate", {
                    planId: "destructive_overwrite_candidate",
                    subjects: { Math: {} }
                }, testDataFile);
            } catch (err) {
                saveThrew = true;
                assert.ok(
                    err.message.includes("Failed to read storage data file"),
                    `savePlan must propagate the read error. Received: "${err.message}"`
                );
            }
            assert.equal(saveThrew, true, "savePlan must throw and abort when loadAllPlans fails");

            // Verify existing file on disk was NOT overwritten by savePlan
            const contentAfterFailedSave = fs.readFileSync(testDataFile, "utf-8");
            assert.equal(
                contentAfterFailedSave,
                malformedContent,
                "Target file must remain identical to malformed content without being overwritten by savePlan"
            );
            console.log("✓ Malformed JSON read failure caught; destructive overwrite prevented");

            // 9c. Simulate persistent read failure (e.g. EACCES permission / disk error)
            const originalReadFileSync = fs.readFileSync;
            try {
                fs.readFileSync = (p, ...args) => {
                    if (p === testDataFile) {
                        const err = new Error("EACCES: permission denied, read");
                        err.code = "EACCES";
                        throw err;
                    }
                    return originalReadFileSync(p, ...args);
                };

                let readErrThrew = false;
                try {
                    savePlan("persistent_read_fail_candidate", { planId: "fail" }, testDataFile);
                } catch (err) {
                    readErrThrew = true;
                    assert.ok(
                        err.message.includes("EACCES"),
                        `Expected EACCES in error message. Received: "${err.message}"`
                    );
                }
                assert.equal(readErrThrew, true, "savePlan must abort and propagate on persistent read failure");
                console.log("✓ Persistent read failure caught; destructive write strictly blocked");
            } finally {
                fs.readFileSync = originalReadFileSync;
            }
        } finally {
            try { if (fs.existsSync(testDataFile)) fs.unlinkSync(testDataFile); } catch {}
            try { if (fs.existsSync(`${testDataFile}.lock`)) fs.unlinkSync(`${testDataFile}.lock`); } catch {}
        }
        console.log("✓ Test 9 PASSED: Read failures prevent destructive overwrites; new installation handled cleanly.");

        // Step 10: Regression Test: Eliminate Non-Atomic Fallback & Preserve Data on Rename Failure
        console.log("\n--- Test 10: Eliminate Non-Atomic Fallback & Preserve Data on Rename Failure ---");

        const testRenameFile = path.join(isolatedDataDir, `test_rename_${Date.now()}.json`);
        const initialValidData = JSON.stringify({ original_plan: { planId: "original_plan", hours: 40 } }, null, 2);
        fs.writeFileSync(testRenameFile, initialValidData, "utf-8");

        const originalRenameSync = fs.renameSync;
        let renameAttemptCount = 0;

        try {
            // Simulate rename failure (e.g. EPERM / EBUSY / antivirus lock on Windows)
            fs.renameSync = (oldPath, newPath) => {
                if (newPath === testRenameFile) {
                    renameAttemptCount++;
                    const err = new Error("EPERM: operation not permitted, rename");
                    err.code = "EPERM";
                    throw err;
                }
                return originalRenameSync(oldPath, newPath);
            };

            let renameFailed = false;
            try {
                savePlan("rename_fail_test", {
                    planId: "rename_fail_test",
                    subjects: { Test: {} }
                }, testRenameFile);
            } catch (err) {
                renameFailed = true;
                assert.ok(
                    err.message.includes("Atomic replacement failed") || err.message.includes("Storage save error"),
                    `Expected atomic replacement error message. Received: "${err.message}"`
                );
            }

            assert.equal(renameFailed, true, "savePlan must throw when atomic rename fails");
            assert.ok(renameAttemptCount > 0, "Rename retries must have been attempted");

            // Verify test file was NOT overwritten or truncated by any non-atomic write fallback
            const dataAfterRenameFail = fs.readFileSync(testRenameFile, "utf-8");
            assert.equal(
                dataAfterRenameFail,
                initialValidData,
                "Target file must remain 100% intact and uncorrupted when atomic replacement fails"
            );

            console.log("✓ Rename failure simulation confirmed: non-atomic fallback eliminated, original file preserved");
        } finally {
            fs.renameSync = originalRenameSync;
            try { if (fs.existsSync(testRenameFile)) fs.unlinkSync(testRenameFile); } catch {}
            try { if (fs.existsSync(`${testRenameFile}.lock`)) fs.unlinkSync(`${testRenameFile}.lock`); } catch {}
        }

        console.log("✓ Test 10 PASSED: Atomic rename failure safely preserves original data without truncation fallback.");

        // Step 11: Regression Test: Transactional Updates & Concurrent Mutation Safety
        console.log("\n--- Test 11: Transactional Updates & Concurrent Mutation Safety ---");

        // 11a. True cross-process concurrent updates via child processes on an isolated storage file
        const crossProcPlanId = `cproc_plan_${Date.now()}`;
        const testFileCrossProc = path.join(isolatedDataDir, `test_cproc_${Date.now()}.json`);

        try {
            savePlan(crossProcPlanId, {
                planId: crossProcPlanId,
                examDate: "2026-12-31",
                daysRemaining: 50,
                dailyAvailableHours: 4,
                availableCapacityHours: 200,
                totalAvailableHours: 200,
                totalAllocatedHours: 200,
                totalCompletedHours: 0,
                totalMissedHours: 0,
                totalRemainingHours: 200,
                overallProgressPercentage: 0,
                subjects: {
                    Mathematics: {
                        priority: "high",
                        weight: 3,
                        allocatedHours: 120,
                        completedHours: 0,
                        missedHours: 0,
                        remainingHours: 120,
                        progressPercentage: 0
                    },
                    Physics: {
                        priority: "medium",
                        weight: 2,
                        allocatedHours: 80,
                        completedHours: 0,
                        missedHours: 0,
                        remainingHours: 80,
                        progressPercentage: 0
                    }
                },
                sessions: [],
                adaptationHistory: []
            }, testFileCrossProc);

            const storageUrl = pathToFileURL(path.resolve(__dirname, "../studypilot-server/storage.js")).href;
            const plannerUrl = pathToFileURL(path.resolve(__dirname, "../studypilot-server/planner.js")).href;
            const targetFilePath = testFileCrossProc;

            const childSessions = [
                { subject: "Mathematics", hoursSpent: 2, status: "completed" },
                { subject: "Mathematics", hoursSpent: 3, status: "completed" },
                { subject: "Physics", hoursSpent: 1.5, status: "completed" },
                { subject: "Physics", hoursSpent: 0, scheduledHours: 2, status: "missed" }
            ];

            // Launch genuine independent Node OS processes simultaneously contending on cross-process file lock
            const workerPromises = childSessions.map(sess => new Promise((resolve, reject) => {
                const code = `
                    import { updatePlan } from ${JSON.stringify(storageUrl)};
                    import { recordSession } from ${JSON.stringify(plannerUrl)};
                    updatePlan(${JSON.stringify(crossProcPlanId)}, (plan) => recordSession(plan, ${JSON.stringify(sess)}), ${JSON.stringify(targetFilePath)});
                `;
                const proc = spawn("node", ["--input-type=module", "-e", code], {
                    stdio: "inherit",
                    env: {
                        ...process.env,
                        STUDYPILOT_DATA_DIR: isolatedDataDir
                    }
                });
                proc.on("close", (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`Worker process exited with code ${code}`));
                });
                proc.on("error", reject);
            }));

            await Promise.all(workerPromises);

            const finalCrossProcPlan = getPlan(crossProcPlanId, testFileCrossProc);
            assert.equal(finalCrossProcPlan.sessions.length, 4, "All 4 cross-process concurrent sessions must be retained");
            assert.equal(finalCrossProcPlan.totalCompletedHours, 6.5, "Cross-process completed hours must equal 2 + 3 + 1.5 = 6.5h");
            assert.equal(finalCrossProcPlan.totalMissedHours, 2, "Cross-process missed hours must equal 2h");
            assert.equal(finalCrossProcPlan.subjects.Mathematics.completedHours, 5, "Math completed hours must equal 2 + 3 = 5h");
            assert.equal(finalCrossProcPlan.subjects.Physics.completedHours, 1.5, "Physics completed hours must equal 1.5h");
            assert.equal(finalCrossProcPlan.subjects.Physics.missedHours, 2, "Physics missed hours must equal 2h");
            console.log("✓ True cross-process concurrent transactions verified across independent OS processes");

            // 11b. Verify mutator failure receives isolated plan and does NOT mutate stored state
            let mutatorFailed = false;
            try {
                updatePlan(crossProcPlanId, (plan) => {
                    // Dirty the plan object
                    plan.sessions.push({ corrupted: true });
                    plan.totalCompletedHours = 9999;
                    throw new Error("Simulated business logic failure during session recording");
                }, testFileCrossProc);
            } catch (err) {
                mutatorFailed = true;
                assert.ok(err.message.includes("Simulated business logic failure"));
            }
            assert.equal(mutatorFailed, true, "updatePlan must propagate mutator errors");

            const planAfterFailedMutator = getPlan(crossProcPlanId, testFileCrossProc);
            assert.equal(planAfterFailedMutator.sessions.length, 4, "Failed mutator must NOT partially persist mutations");
            assert.equal(planAfterFailedMutator.totalCompletedHours, 6.5, "Failed mutator must NOT mutate stored completed hours");
            console.log("✓ Failed mutator transaction isolated cleanly without in-memory or on-disk mutation");

            // 11c. Test end-to-end concurrent MCP tool calls on the live server
            const mcpConcurrentPlanId = `mcp_concurrent_${Date.now()}`;
            await client.callTool({
                name: "create_study_plan",
                arguments: {
                    planId: mcpConcurrentPlanId,
                    subjects: ["Mathematics", "Physics"],
                    examDate: "2026-11-30",
                    dailyAvailableHours: 3
                }
            });

            const mcpConcurrentCalls = [
                { name: "record_study_session", arguments: { planId: mcpConcurrentPlanId, subject: "Mathematics", hoursSpent: 2, status: "completed" } },
                { name: "record_study_session", arguments: { planId: mcpConcurrentPlanId, subject: "Physics", hoursSpent: 1.5, status: "completed" } },
                { name: "record_study_session", arguments: { planId: mcpConcurrentPlanId, subject: "Mathematics", hoursSpent: 0, scheduledHours: 2, status: "missed" } }
            ];

            const mcpResults = await Promise.all(mcpConcurrentCalls.map(call => client.callTool(call)));
            for (const res of mcpResults) {
                assert.equal(Boolean(res.isError), false, `Concurrent MCP call failed: ${JSON.stringify(res.content)}`);
            }

            const mcpPlanResult = await client.callTool({
                name: "get_study_plan",
                arguments: { planId: mcpConcurrentPlanId }
            });
            const retrievedMcpPlan = JSON.parse(mcpPlanResult.content[0].text);
            assert.equal(retrievedMcpPlan.totalSessionsRecorded, 3, "All 3 concurrent MCP sessions must be recorded");
            assert.equal(retrievedMcpPlan.totalCompletedHours, 3.5, "Total completed hours must equal 3.5h");
            assert.equal(retrievedMcpPlan.totalMissedHours, 2, "Total missed hours must equal 2h");
            console.log("✓ Live MCP server concurrent session recording verified end-to-end");

            // 11d. Test concurrent adaptation and session recording on the live server
            const mcpAdaptPlanId = `mcp_adapt_concurrent_${Date.now()}`;
            await client.callTool({
                name: "create_study_plan",
                arguments: {
                    planId: mcpAdaptPlanId,
                    subjects: ["Mathematics", "Physics"],
                    examDate: "2026-11-30",
                    dailyAvailableHours: 3
                }
            });

            const mixedResults = await Promise.all([
                client.callTool({
                    name: "record_study_session",
                    arguments: { planId: mcpAdaptPlanId, subject: "Mathematics", hoursSpent: 2, status: "completed" }
                }),
                client.callTool({
                    name: "adapt_study_plan",
                    arguments: { planId: mcpAdaptPlanId, reason: "Concurrent pace adaptation" }
                }),
                client.callTool({
                    name: "record_study_session",
                    arguments: { planId: mcpAdaptPlanId, subject: "Physics", hoursSpent: 1.5, status: "completed" }
                })
            ]);

            for (const res of mixedResults) {
                assert.equal(Boolean(res.isError), false, `Mixed concurrent MCP call failed: ${JSON.stringify(res.content)}`);
            }

            const mixedPlanResult = await client.callTool({
                name: "get_study_plan",
                arguments: { planId: mcpAdaptPlanId }
            });
            const retrievedMixedPlan = JSON.parse(mixedPlanResult.content[0].text);
            assert.equal(retrievedMixedPlan.totalSessionsRecorded, 2, "Both concurrent sessions must be retained");
            assert.equal(retrievedMixedPlan.totalCompletedHours, 3.5, "Completed hours from both sessions must be preserved (2 + 1.5 = 3.5h)");
            assert.ok(retrievedMixedPlan.recentAdaptations.length >= 1, "Concurrent adaptation must be retained");
            console.log("✓ Concurrent adaptation and session recording preserved both sessions and adaptation history");

        } finally {
            try { if (fs.existsSync(testFileCrossProc)) fs.unlinkSync(testFileCrossProc); } catch {}
            try { if (fs.existsSync(`${testFileCrossProc}.lock`)) fs.unlinkSync(`${testFileCrossProc}.lock`); } catch {}
        }

        console.log("✓ Test 11 PASSED: Transactional updates prevent lost updates under concurrency.");


        console.log("\n========================================================");
        console.log("ALL 11 DETERMINISTIC & REGRESSION TESTS PASSED! (100%)");
        console.log("========================================================");
    } catch (error) {
        console.error("\n❌ Test failure:", error);
        throw error;
    } finally {
        try {
            await client.close();
        } catch { }
        try {
            fs.rmSync(isolatedDataDir, { recursive: true, force: true });
        } catch { }
    }
}

runDeterministicTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
