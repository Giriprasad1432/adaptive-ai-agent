import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPlan, loadAllPlans, saveNewPlan, updatePlan } from "./storage.js";
import { createPlan, recordSession, adaptPlan, getActiveSessionCount, resolvePlanDayDate } from "./planner.js";

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
