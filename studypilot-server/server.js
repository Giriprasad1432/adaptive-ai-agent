import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPlan, savePlan } from "./storage.js";
import { createPlan, recordSession, adaptPlan } from "./planner.js";

// Initialize the StudyPilot MCP Server
const mcp = new McpServer({
    name: "studypilot-mcp-server",
    version: "1.0.0"
});

// 1. Tool: create_study_plan
mcp.tool(
    "create_study_plan",
    "Create a structured study plan from subjects, exam date, daily available hours, and optional subject priorities.",
    {
        subjects: z.array(z.string()).describe("List of subjects, e.g. ['Mathematics', 'Physics', 'Chemistry']"),
        examDate: z.string().describe("Target exam date in YYYY-MM-DD format"),
        dailyAvailableHours: z.number().describe("Hours available to study each day (e.g. 3)"),
        priorities: z.record(z.string(), z.string()).optional().describe("Optional subject priorities: 'high', 'medium', or 'low'"),
        planId: z.string().optional().describe("Unique study plan identifier (e.g. as specified by user). Must not be a tool name. Defaults to 'default'")
    },
    async ({ subjects, examDate, dailyAvailableHours, priorities, planId = "default" }) => {
        try {
            let parsedPriorities = priorities || {};
            if (typeof parsedPriorities === "string") {
                try {
                    parsedPriorities = JSON.parse(parsedPriorities);
                } catch {
                    parsedPriorities = {};
                }
            }

            const plan = createPlan({
                planId,
                subjects,
                examDate,
                dailyAvailableHours,
                priorities: parsedPriorities
            });

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

            savePlan(planId, plan);

            const summary = {
                message: `Study plan "${planId}" created successfully!`,
                examDate: plan.examDate,
                daysRemaining: plan.daysRemaining,
                dailyStudyHours: plan.dailyAvailableHours,
                totalAllocatedHours: plan.totalAllocatedHours,
                subjectAllocations: Object.fromEntries(
                    Object.entries(plan.subjects).map(([name, data]) => [
                        name,
                        {
                            priority: data.priority,
                            allocatedHours: data.allocatedHours,
                            remainingHours: data.remainingHours
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
        planId: z.string().optional().describe("Unique identifier of the study plan to retrieve (e.g. 'adaptive-demo'). Must not be a tool name. Defaults to 'default'")
    },
    async ({ planId = "default" }) => {
        try {
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
                dailyStudyHours: plan.dailyAvailableHours,
                overallProgress: `${plan.overallProgressPercentage}%`,
                totalCompletedHours: plan.totalCompletedHours,
                totalMissedHours: plan.totalMissedHours,
                totalRemainingHours: plan.totalRemainingHours,
                totalAllocatedHours: plan.totalAllocatedHours,
                totalAvailableHours: plan.totalAvailableHours,
                availableCapacityHours: plan.availableCapacityHours || Math.round((plan.daysRemaining * plan.dailyAvailableHours) * 10) / 10,
                subjects: plan.subjects,
                totalSessionsRecorded: plan.sessions.length,
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
        scheduledHours: z.number().optional().describe("Optional scheduled duration of the session in hours (useful for missed sessions; defaults to 2h)"),
        notes: z.string().optional().describe("Optional notes or reason for missed session"),
        date: z.string().optional().describe("Date of session in YYYY-MM-DD format (defaults to today)"),
        planId: z.string().optional().describe("Unique identifier of the study plan to record session into. Must not be a tool name. Defaults to 'default'")
    },
    async ({ subject, hoursSpent, status, scheduledHours, notes, date, planId = "default" }) => {
        try {
            const plan = getPlan(planId);
            if (!plan) {
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

            const result = recordSession(plan, {
                subject,
                hoursSpent,
                scheduledHours,
                status,
                notes,
                date
            });

            savePlan(planId, plan);

            const outcome = {
                message: `Study session for "${subject}" recorded successfully (${status}).`,
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
        planId: z.string().optional().describe("Unique identifier of the study plan to adapt (e.g. 'adaptive-demo'). Must not be a tool name. Defaults to 'default'"),
        reason: z.string().optional().describe("Reason for schedule adjustment reflecting user's actual situation and missed sessions. Must NEVER be a retrieval or inspection request."),
        newExamDate: z.string().optional().describe("Optional updated exam date in YYYY-MM-DD format only if explicitly requested to change. Omit entirely if exam date remains unchanged. NEVER populate this with session dates or missed session dates."),
        newDailyAvailableHours: z.number().optional().describe("Optional updated daily study hours capacity only if changing. Omit entirely if daily availability remains unchanged.")
    },
    async ({ planId = "default", reason, newExamDate, newDailyAvailableHours }) => {
        try {
            const plan = getPlan(planId);
            if (!plan) {
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

            const { adaptation } = adaptPlan(plan, {
                reason: reason || "Progress adaptation and missed session recovery",
                newExamDate,
                newDailyAvailableHours
            });

            savePlan(planId, plan);

            const summary = {
                message: "Study plan adapted successfully!",
                planId: plan.planId,
                examDate: plan.examDate,
                dailyStudyHours: plan.dailyAvailableHours,
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

// Connect via StdioServerTransport
const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error("StudyPilot MCP Server is running...");
