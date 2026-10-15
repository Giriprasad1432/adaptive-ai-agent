import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPlan, loadAllPlans, saveNewPlan, updatePlan, getUserPreferences, saveUserPreferences, resetLearningData } from "./storage.js";
import { createPlan, recordSession, adaptPlan, getActiveSessionCount, resolvePlanDayDate } from "./planner.js";
import { createQuiz, saveQuizResult, getWeakTopics, getStudyProgress, resetQuizData } from "./quizManager.js";

function createMcpServer() {
    // Initialize the StudyPilot MCP Server
    const mcp = new McpServer({
        name: "studypilot-mcp-server",
        version: "1.0.0"
    });

    // 1. Tool: create_study_plan
    mcp.tool(
        "list_study_plans",
        "List saved study plans so the user can refer to them by subject or goal without remembering internal plan IDs.",
        {},
        async () => {
            try {
                const plans = loadAllPlans();
                const summaries = Object.entries(plans).map(([planId, plan]) => ({
                    planId,
                    subjects: Object.keys(plan.subjects || {}),
                    examDate: plan.examDate || null,
                    durationDays: plan.durationDays || null,
                    dailyAvailableHours: plan.dailyAvailableHours || null,
                    overallProgress: plan.overallProgress || `${plan.overallProgressPercentage || 0}%`,
                    totalRemainingHours: plan.totalRemainingHours ?? null
                }));
                return { content: [{ type: "text", text: JSON.stringify({ plans: summaries, count: summaries.length }) }] };
            } catch (error) {
                return { isError: true, content: [{ type: "text", text: `Failed to list study plans: ${error.message}` }] };
            }
        }
    );

    mcp.tool(
        "create_study_plan",
        "Create a structured exam-preparation or goal-based learning plan. examDate is optional for goal plans; use durationDays when a learning period is specified. dailyAvailableHours is optional and a bounded recommendation is used when omitted.",
        {
            subjects: z.array(z.string()).describe("List of subjects, e.g. ['Mathematics', 'Physics', 'Chemistry']"),
            examDate: z.string().optional().describe("Optional target exam date in YYYY-MM-DD format. Omit for goal-based learning plans."),
            durationDays: z.number().int().optional().describe("Learning-plan duration in days. Defaults to a configurable 30-day goal period when no exam date or duration is supplied."),
            dailyAvailableHours: z.number().optional().describe("User's daily study capacity within configured bounds. When omitted, the planner uses its bounded configurable recommendation."),
            priorities: z.record(z.string(), z.string()).optional().describe("Optional subject priorities: 'high', 'medium', or 'low'"),
            planId: z.string().optional().describe("Optional plan ID only when the user explicitly supplies one. Otherwise StudyPilot generates a unique ID; never use or overwrite 'default' implicitly.")
        },
        async ({ subjects, examDate, durationDays, dailyAvailableHours, priorities, planId: requestedPlanId }) => {
            try {
                const slug = (subjects[0] || "study").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "study";
                let planId = requestedPlanId || `${slug}-${randomUUID().slice(0, 8)}`;
                let parsedPriorities = priorities || {};
                if (typeof parsedPriorities === "string") {
                    try {
                        parsedPriorities = JSON.parse(parsedPriorities);
                    } catch {
                        parsedPriorities = {};
                    }
                }

                let plan = createPlan({ planId, subjects, examDate, durationDays, dailyAvailableHours, priorities: parsedPriorities });

                // Guard against malformed subject names before persisting
                const subjectNames = Object.keys(plan.subjects);
                const malformed = subjectNames.filter(name =>
                    /^["'\\\[\]]|["'\\\[\]]$/.test(name) ||
                    name.includes('"') ||
                    name.includes('\\') ||
                    name.includes('[') ||
                    name.includes(']')
                );

                if (malformed.length > 0) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Failed to create study plan: subjects contain invalid artifacts: [${malformed.join(", ")}]`
                            }
                        ]
                    };
                }

                let saved = saveNewPlan(planId, plan);
                // A collision on an automatically generated ID is retried. Explicit
                // IDs are never overwritten; the user must choose a different ID.
                if (!saved && !requestedPlanId) {
                    planId = `${slug}-${randomUUID().slice(0, 8)}`;
                    plan = createPlan({ planId, subjects, examDate, durationDays, dailyAvailableHours, priorities: parsedPriorities });
                    saved = saveNewPlan(planId, plan);
                }
                if (!saved) {
                    return { isError: true, content: [{ type: "text", text: `A study plan with ID "${planId}" already exists. Nothing was changed. Try creating a new plan without specifying an ID.` }] };
                }

                const summary = {
                    message: `Study plan "${planId}" created successfully!`,
                    planId: plan.planId,
                    examDate: plan.examDate,
                    daysRemaining: plan.daysRemaining,
                    durationDays: plan.durationDays,
                    durationSource: plan.durationSource,
                    planningMode: plan.examDate ? "exam" : "goal",
                    dailyStudyHours: plan.dailyAvailableHours,
                    dailyHoursSource: plan.dailyHoursSource,
                    totalAllocatedHours: plan.totalAllocatedHours,
                    totalCompletedHours: plan.totalCompletedHours,
                    totalRemainingHours: plan.totalRemainingHours,
                    overallProgressPercentage: plan.overallProgressPercentage,
                    subjectAllocations: Object.fromEntries(
                        Object.entries(plan.subjects).map(([name, data]) => [
                            name,
                            {
                                priority: data.priority,
                                allocatedHours: data.allocatedHours,
                                completedHours: data.completedHours,
                                remainingHours: data.remainingHours,
                                progressPercentage: data.progressPercentage
                            }
                        ])
                    )
                };

                return {
                    isError: false,
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(summary, null, 2)
                        }
                    ]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Error creating study plan: ${error.message}`
                        }
                    ]
                };
            }
        }
    );

    // 2. Tool: get_study_plan
    mcp.tool(
        "get_study_plan",
        "Retrieve and report on an existing saved study plan with progress metrics, remaining hours, exam date, daily availability, and recent session logs. Use this tool when the user asks to retrieve, show, get, view, inspect, or report on a study plan. NEVER use adapt_study_plan for retrieval or report requests.",
        {
            planId: z.string().optional().describe("Internal identifier of the plan selected from a verified list, explicit user reference, or active conversation. Omit when no plan is known; do not default to 'default'.")
        },
        async ({ planId }) => {
            try {
                if (!planId) return { isError: true, content: [{ type: "text", text: "No study plan was selected. List saved plans and choose by subject or plan description." }] };
                const plan = getPlan(planId);
                if (!plan) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `No study plan found with ID "${planId}". Create one first using create_study_plan.`
                            }
                        ]
                    };
                }

                const response = {
                    planId: plan.planId,
                    examDate: plan.examDate,
                    daysRemaining: plan.daysRemaining,
                    durationDays: plan.durationDays || plan.daysRemaining,
                    durationSource: plan.durationSource || (plan.examDate ? "exam-deadline" : "legacy"),
                    dailyHoursSource: plan.dailyHoursSource || "user",
                    planningMode: plan.examDate ? "exam" : "goal",
                    dailyStudyHours: plan.dailyAvailableHours,
                    overallProgress: `${plan.overallProgressPercentage}%`,
                    totalCompletedHours: plan.totalCompletedHours,
                    totalMissedHours: plan.totalMissedHours,
                    totalRemainingHours: plan.totalRemainingHours,
                    totalAllocatedHours: plan.totalAllocatedHours,
                    totalAvailableHours: plan.totalAvailableHours,
                    availableCapacityHours: plan.availableCapacityHours || Math.round((plan.daysRemaining * plan.dailyAvailableHours) * 10) / 10,
                    subjects: plan.subjects,
                    totalSessionsRecorded: getActiveSessionCount(plan),
                    recentSessions: plan.sessions.slice(-5),
                    recentAdaptations: plan.adaptationHistory.slice(-3)
                };

                return {
                    isError: false,
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(response, null, 2)
                        }
                    ]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Error retrieving study plan: ${error.message}`
                        }
                    ]
                };
            }
        }
    );

    // 3. Tool: record_study_session
    mcp.tool(
        "record_study_session",
        "Record a completed or missed study session and update progress metrics for the subject.",
        {
            subject: z.string().describe("Subject name (e.g. 'Mathematics')"),
            hoursSpent: z.number().describe("Hours spent studying, or 0 if session was missed"),
            status: z.enum(["completed", "partially_completed", "missed"]).describe("Session status: 'completed', 'partially_completed', or 'missed'"),
            missedHours: z.number().optional().describe("Hours of the intended session that were missed. For a missed session, defaults to scheduledHours or 2h."),
            scheduledHours: z.number().optional().describe("Intended duration of the session in hours. For missed sessions, defaults to missedHours or 2h."),
            notes: z.string().optional().describe("Optional notes or reason for missed session"),
            date: z.string().optional().describe("Date of session in YYYY-MM-DD format (defaults to today)"),
            dayNumber: z.number().int().optional().describe("Plan day number when the user says Day N. Day 1 is the plan start date; an explicit calendar date takes precedence."),
            planId: z.string().optional().describe("Internal identifier from the active conversation, a verified plan list, or explicit user reference. Never default to another plan.")
        },
        async ({ subject, hoursSpent, status, missedHours, scheduledHours, notes, date, dayNumber, planId }) => {
            try {
                if (!planId) return { isError: true, content: [{ type: "text", text: "No study plan was selected. List saved plans and choose by subject or plan description." }] };
                const updated = updatePlan(planId, (plan) => {
                    if (!Object.hasOwn(plan.subjects || {}, subject)) {
                        throw new Error(`Subject "${subject}" is not part of study plan "${planId}".`);
                    }
                    const sessionDate = date || (dayNumber !== undefined
                        ? resolvePlanDayDate(plan, dayNumber)
                        : undefined);
                    return recordSession(plan, {
                        subject,
                        hoursSpent,
                        missedHours,
                        scheduledHours,
                        status,
                        notes,
                        date: sessionDate
                    });
                });

                if (!updated) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Cannot record session: No study plan found with ID "${planId}".`
                            }
                        ]
                    };
                }

                const { plan, result } = updated;

                const outcome = {
                    message: `Study session for "${subject}" recorded successfully (${status}).`,
                    planId: plan.planId,
                    session: result.session,
                    subjectProgress: {
                        subject,
                        completedHours: result.updatedSubject.completedHours,
                        missedHours: result.updatedSubject.missedHours,
                        remainingHours: result.updatedSubject.remainingHours,
                        progressPercentage: `${result.updatedSubject.progressPercentage}%`
                    },
                    overallPlanProgress: `${plan.overallProgressPercentage}%`
                };

                return {
                    isError: false,
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(outcome, null, 2)
                        }
                    ]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Error recording study session: ${error.message}`
                        }
                    ]
                };
            }
        }
    );

    // 4. Tool: adapt_study_plan
    mcp.tool(
        "adapt_study_plan",
        "Dynamically re-balance and adapt the remaining study schedule based on actual progress, missed sessions, and remaining days. ONLY invoke when the user explicitly requests to adapt, modify, adjust, re-balance, or recalculate the schedule. NEVER invoke for retrieval, inspection, or report requests ('retrieve', 'show', 'get', 'report on').",
        {
            planId: z.string().optional().describe("Internal identifier from the active conversation, a verified plan list, or explicit user reference. Never default to another plan."),
            reason: z.string().optional().describe("Reason for schedule adjustment reflecting user's actual situation and missed sessions. Must NEVER be a retrieval or inspection request."),
            newExamDate: z.string().optional().describe("Optional updated exam date in YYYY-MM-DD format only if explicitly requested to change. Omit entirely if exam date remains unchanged. NEVER populate this with session dates or missed session dates."),
            newDailyAvailableHours: z.number().optional().describe("Optional updated daily study hours capacity only if changing. Omit entirely if daily availability remains unchanged.")
        },
        async ({ planId, reason, newExamDate, newDailyAvailableHours }) => {
            try {
                if (!planId) return { isError: true, content: [{ type: "text", text: "No study plan was selected. List saved plans and choose by subject or plan description." }] };
                const updated = updatePlan(planId, (plan) => {
                    return adaptPlan(plan, {
                        reason: reason || "Progress adaptation and missed session recovery",
                        newExamDate,
                        newDailyAvailableHours
                    });
                });

                if (!updated) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Cannot adapt plan: No study plan found with ID "${planId}".`
                            }
                        ]
                    };
                }

                const { plan, result } = updated;
                const { adaptation } = result;

                const summary = {
                    message: "Study plan adapted successfully!",
                    planId: plan.planId,
                    examDate: plan.examDate,
                    dailyStudyHours: plan.dailyAvailableHours,
                    durationDays: plan.durationDays || plan.daysRemaining,
                    daysRemaining: adaptation.daysRemaining,
                    recommendedDailyHours: adaptation.recommendedDailyHours,
                    capacityWarning: adaptation.capacityWarning,
                    adaptationId: adaptation.id,
                    reason: adaptation.reason,
                    adjustedSubjectAllocations: Object.fromEntries(
                        Object.entries(plan.subjects).map(([k, v]) => [
                            k,
                            {
                                priority: v.priority,
                                allocatedHours: v.allocatedHours,
                                completedHours: v.completedHours,
                                remainingHours: v.remainingHours,
                                progress: `${v.progressPercentage}%`
                            }
                        ])
                    )
                };

                return {
                    isError: false,
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(summary, null, 2)
                        }
                    ]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: `Error adapting study plan: ${error.message}`
                        }
                    ]
                };
            }
        }
    );

    // 6. Tool: create_quiz
    mcp.tool(
        "create_quiz",
        "Generate a practice quiz for a subject or topic with multiple-choice questions, options, difficulty level, and answer explanations.",
        {
            subject: z.string().describe("Subject name (e.g. 'JavaScript', 'DBMS', 'Operating Systems', 'Mathematics')"),
            topic: z.string().optional().describe("Specific topic or concept within the subject (e.g. 'Recursion', 'Deadlocks', 'Normalization')"),
            questionCount: z.number().int().optional().describe("Number of questions to generate (1 to 10, default 3)"),
            difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional().describe("Quiz difficulty level (default: 'intermediate')")
        },
        async ({ subject, topic, questionCount, difficulty }) => {
            try {
                const quiz = createQuiz({ subject, topic, questionCount, difficulty });
                return {
                    isError: false,
                    content: [{ type: "text", text: JSON.stringify(quiz, null, 2) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to create quiz: ${error.message}` }]
                };
            }
        }
    );

    // 7. Tool: save_quiz_result
    mcp.tool(
        "save_quiz_result",
        "Record a completed quiz score, evaluate subject mastery, and detect weak topics for adaptive study revision.",
        {
            subject: z.string().describe("Subject name"),
            score: z.number().describe("Number of questions answered correctly"),
            totalQuestions: z.number().describe("Total number of questions in the quiz"),
            topic: z.string().optional().describe("Topic or concept of the quiz"),
            quizId: z.string().optional().describe("Optional identifier of the quiz that was completed")
        },
        async ({ subject, score, totalQuestions, topic, quizId }) => {
            try {
                const outcome = saveQuizResult({ subject, score, totalQuestions, topic, quizId });
                return {
                    isError: false,
                    content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to save quiz result: ${error.message}` }]
                };
            }
        }
    );

    // 8. Tool: get_weak_topics
    mcp.tool(
        "get_weak_topics",
        "Identify academic subjects or topics requiring extra review based on missed study sessions and quiz scores below 70%.",
        {
            planId: z.string().optional().describe("Optional plan identifier to restrict analysis to a specific study plan"),
            subject: z.string().optional().describe("Optional subject name to filter weak topic analysis")
        },
        async ({ planId, subject }) => {
            try {
                const report = getWeakTopics({ planId, subject });
                return {
                    isError: false,
                    content: [{ type: "text", text: JSON.stringify(report, null, 2) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to analyze weak topics: ${error.message}` }]
                };
            }
        }
    );

    // 9. Tool: get_study_progress
    mcp.tool(
        "get_study_progress",
        "Get high-level aggregated study progress, total hours completed, remaining workload, and quiz performance metrics across all active plans or for a specific plan.",
        {
            planId: z.string().optional().describe("Optional plan identifier to view progress for a specific plan. If omitted, returns global progress across all plans.")
        },
        async ({ planId }) => {
            try {
                const progress = getStudyProgress({ planId });
                return {
                    isError: false,
                    content: [{ type: "text", text: JSON.stringify(progress, null, 2) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to retrieve study progress: ${error.message}` }]
                };
            }
        }
    );

    // 10. Tool: get_user_preferences
    mcp.tool(
        "get_user_preferences",
        "Retrieve stored learning and study preferences (e.g. explanation style, preferred language, default daily availability, difficulty, custom notes).",
        {
            userId: z.string().optional().describe("User identifier (default: 'default')")
        },
        async ({ userId = "default" }) => {
            try {
                const prefs = getUserPreferences(userId);
                return {
                    isError: false,
                    content: [{ type: "text", text: JSON.stringify(prefs, null, 2) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to retrieve user preferences: ${error.message}` }]
                };
            }
        }
    );

    // 11. Tool: update_user_preferences
    mcp.tool(
        "update_user_preferences",
        "Save or update user learning preferences such as onboarding goal, subjects, current level, starting knowledge, deadline, preferred explanation style ('short', 'detailed', 'code_first', 'intuitive'), preferred programming language, default daily study hours, target difficulty, or custom notes.",
        {
            userId: z.string().optional().describe("User identifier (default: 'default')"),
            goal: z.string().optional().describe("User's primary learning goal (e.g. 'Learn Java for backend development')"),
            subjects: z.array(z.string()).optional().describe("List of target subjects or topics"),
            currentLevel: z.string().optional().describe("User's self-assessed level: 'beginner', 'basics', 'intermediate', or 'advanced'"),
            startingPoint: z.string().optional().describe("What the user already knows or current starting point"),
            difficultTopics: z.array(z.string()).optional().describe("Topics identified as difficult or needing extra review"),
            targetDeadline: z.string().optional().describe("Target exam or completion date or period"),
            learningPreference: z.string().optional().describe("User's preferred learning style (e.g. 'hands-on', 'explanations', 'quizzes', 'mix')"),
            studySchedule: z.string().optional().describe("Preferred study schedule (e.g. 'weekdays', 'daily', 'evenings')"),
            preferredExplanationStyle: z.enum(["short", "detailed", "code_first", "intuitive"]).optional().describe("Preferred explanation style"),
            preferredLanguage: z.string().optional().describe("Preferred programming language (e.g. 'Java', 'Python', 'JavaScript', 'C++')"),
            defaultDailyAvailableHours: z.number().min(0.5).max(12).optional().describe("Default daily study availability in hours (0.5 to 12)"),
            targetDifficulty: z.enum(["beginner", "intermediate", "advanced"]).optional().describe("Default learning and quiz difficulty level"),
            customNotes: z.string().optional().describe("Custom learning preferences or notes"),
            onboardingCompleted: z.boolean().optional().describe("Whether conversational onboarding is complete")
        },
        async ({
            userId = "default",
            goal,
            subjects,
            currentLevel,
            startingPoint,
            difficultTopics,
            targetDeadline,
            learningPreference,
            studySchedule,
            preferredExplanationStyle,
            preferredLanguage,
            defaultDailyAvailableHours,
            targetDifficulty,
            customNotes,
            onboardingCompleted
        }) => {
            try {
                const updates = {};
                if (goal !== undefined) updates.goal = goal;
                if (subjects !== undefined) updates.subjects = subjects;
                if (currentLevel !== undefined) updates.currentLevel = currentLevel;
                if (startingPoint !== undefined) updates.startingPoint = startingPoint;
                if (difficultTopics !== undefined) updates.difficultTopics = difficultTopics;
                if (targetDeadline !== undefined) updates.targetDeadline = targetDeadline;
                if (learningPreference !== undefined) updates.learningPreference = learningPreference;
                if (studySchedule !== undefined) updates.studySchedule = studySchedule;
                if (preferredExplanationStyle !== undefined) updates.preferredExplanationStyle = preferredExplanationStyle;
                if (preferredLanguage !== undefined) updates.preferredLanguage = preferredLanguage;
                if (defaultDailyAvailableHours !== undefined) updates.defaultDailyAvailableHours = defaultDailyAvailableHours;
                if (targetDifficulty !== undefined) updates.targetDifficulty = targetDifficulty;
                if (customNotes !== undefined) updates.customNotes = customNotes;
                if (onboardingCompleted !== undefined) updates.onboardingCompleted = onboardingCompleted;

                const saved = saveUserPreferences(userId, updates);
                return {
                    isError: false,
                    content: [{ type: "text", text: JSON.stringify({ message: "User preferences updated successfully.", preferences: saved }, null, 2) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to update user preferences: ${error.message}` }]
                };
            }
        }
    );

    // 12. Tool: reset_learning_data
    mcp.tool(
        "reset_learning_data",
        "Cleanly reset user study plans, session logs, preferences, and quizzes when explicitly requested by the user. NEVER call without explicit user confirmation.",
        {
            confirm: z.boolean().describe("Must be true to confirm reset"),
            userId: z.string().optional().describe("User identifier (default: 'default')")
        },
        async ({ confirm, userId = "default" }) => {
            try {
                if (!confirm) {
                    return {
                        isError: true,
                        content: [{ type: "text", text: "Reset was not confirmed. User data remains untouched." }]
                    };
                }
                const resetResult = resetLearningData(userId);
                resetQuizData();
                return {
                    isError: false,
                    content: [{ type: "text", text: JSON.stringify({ message: resetResult.message, reset: true }, null, 2) }]
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{ type: "text", text: `Failed to reset learning data: ${error.message}` }]
                };
            }
        }
    );


    return mcp;
}


const transportMode = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();

if (transportMode === "stdio") {
    const mcp = createMcpServer();
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    console.error("StudyPilot MCP Server is running over stdio...");
} else if (transportMode === "http") {
    const isRender = Boolean(process.env.RENDER_EXTERNAL_HOSTNAME);

    const host =
        process.env.MCP_HTTP_HOST ||
        (isRender ? "0.0.0.0" : "127.0.0.1");

    const port = Number(
        process.env.PORT || process.env.MCP_HTTP_PORT || 3001
    );
    const server = createServer(async (req, res) => {
        const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        if (requestUrl.pathname !== "/mcp") {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
            return;
        }

        const allowedHosts = new Set([
            host.toLowerCase(),
            `${host}:${port}`.toLowerCase(),
            ...(process.env.MCP_ALLOWED_HOSTS || "")
                .split(",")
                .map(value => value.trim().toLowerCase())
                .filter(Boolean)
        ]);

        if (["127.0.0.1", "localhost", "::1"].includes(host)) {
            for (const allowedHost of ["127.0.0.1", "localhost", "[::1]"]) {
                allowedHosts.add(allowedHost);
                allowedHosts.add(`${allowedHost}:${port}`);
            }
        }

        const requestHost = (req.headers.host || "").toLowerCase();

        if (!allowedHosts.has(requestHost)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden host" }));
            return;
        }

        if (req.method !== "POST") {
            res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
            res.end(JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32000, message: "Method not allowed. Use POST for MCP requests." },
                id: null
            }));
            return;
        }

        const requiredAuthToken = process.env.MCP_AUTH_TOKEN;
        if (requiredAuthToken) {
            const authHeader = req.headers.authorization || "";
            const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
            if (token !== requiredAuthToken) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    jsonrpc: "2.0",
                    error: { code: -32001, message: "Unauthorized. A valid Bearer token is required." },
                    id: null
                }));
                return;
            }
        }

        const mcp = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true
        });
        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            void transport.close();
            void mcp.close();
        };
        res.once("finish", cleanup);
        res.once("close", cleanup);

        try {
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
        } catch (error) {
            console.error("[StudyPilot MCP] HTTP request failed:", error);
            if (!res.headersSent && !res.writableEnded) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null
                }));
            }
        }
    });
    server.listen(port, host, () => {
        console.error(`StudyPilot MCP Streamable HTTP server listening at http://${host}:${port}/mcp`);
    });
} else {
    throw new Error(`Unsupported MCP_TRANSPORT "${transportMode}". Use "stdio" or "http".`);
}
