import { isRetrievalIntent } from "./normalizer.js";

/**
 * Consistency and Grounding Verifier
 * Ensures agent final answers are strictly grounded in verified tool results
 * and never contradict numerical constraints (such as daily available study hours).
 */

/**
 * Detects whether a text describes a daily schedule that exceeds maxDailyHours.
 * @param {string} text - Candidate final reply text
 * @param {number} maxDailyHours - User's available daily hours
 * @returns {{ exceeds: boolean, detectedHours: number, details?: string }}
 */
export function detectDailyScheduleOverrun(text, maxDailyHours) {
    if (!text || typeof text !== "string" || !Number.isFinite(maxDailyHours) || maxDailyHours <= 0) {
        return { exceeds: false, detectedHours: 0 };
    }

    // 1. Explicit statements of total daily hours (e.g. "total of 4.5 hours per day", "4.5 hours daily")
    const explicitDailyTotalRegex = /(?:total(?:ing)?\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:per day|daily|each day|a day))|(?:(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:per day|daily|each day|a day)\s*(?:in total|total))/i;
    const explicitMatch = text.match(explicitDailyTotalRegex);
    if (explicitMatch) {
        const hours = parseFloat(explicitMatch[1] || explicitMatch[2]);
        if (hours > maxDailyHours + 0.05) {
            return {
                exceeds: true,
                detectedHours: hours,
                details: `Explicit daily total of ${hours} hours exceeds the ${maxDailyHours}-hour daily limit.`
            };
        }
    }

    // 2. Parse daily schedule items or time blocks under daily headings / bullet points
    const lines = text.split("\n");
    let inDailySection = false;
    let dailySectionHours = 0;
    let dailyItemCount = 0;

    for (const rawLine of lines) {
        const line = rawLine.trim();

        // Detect entry into daily schedule section
        if (/(?:daily\s+schedule|daily\s+routine|schedule\s+for\s+each\s+day|days?\s+\d+[\s\-\d]*|each\s+day)/i.test(line)) {
            inDailySection = true;
            continue;
        }

        // If line is a bullet point or inside a daily schedule block
        if (inDailySection || /^[\*\-\•]\s+/.test(line)) {
            // Check for hours in parentheses or colons, e.g. "(3 hours)", ": 1 hour", "(0.5 hrs)"
            const durationMatch = line.match(/\((\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\)/i) ||
                                  line.match(/[:\-–]\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)(?:\s|$|\))/i) ||
                                  line.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:of|for|\/day|per day)/i);

            // Time range like "9:00 - 12:00" or "1:00 - 2:00"
            const timeRangeMatch = line.match(/(\d{1,2}):(\d{2})\s*(?:am|pm)?\s*[\-–]\s*(\d{1,2}):(\d{2})\s*(?:am|pm)?/i);

            let itemHours = 0;
            if (durationMatch) {
                itemHours = parseFloat(durationMatch[1]);
            } else if (timeRangeMatch) {
                let startH = parseInt(timeRangeMatch[1], 10);
                let startM = parseInt(timeRangeMatch[2], 10);
                let endH = parseInt(timeRangeMatch[3], 10);
                let endM = parseInt(timeRangeMatch[4], 10);
                if (endH < startH) endH += 12; // Roll-over for 1:00 after 12:00
                itemHours = (endH + endM / 60) - (startH + startM / 60);
            }

            // Exclude lines describing total overall course hours
            const isOverallTotal = /total\s+(?:allocated|study|course|available)\s+hours/i.test(line);

            if (itemHours > 0 && !isOverallTotal && itemHours <= 24) {
                dailySectionHours += itemHours;
                dailyItemCount++;
            }
        }
    }

    if (dailyItemCount >= 2 && dailySectionHours > maxDailyHours + 0.05) {
        return {
            exceeds: true,
            detectedHours: Math.round(dailySectionHours * 10) / 10,
            details: `Sum of daily scheduled activities (${Math.round(dailySectionHours * 10) / 10} hours) exceeds the ${maxDailyHours}-hour daily limit.`
        };
    }

    // 3. Sum per-subject daily rates (e.g. "Mathematics: 3 hours/day, Physics: 1 hour/day")
    const perDayMatches = [...text.matchAll(/([A-Za-z]+)\s*[:\-–]?\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:\/day|per day|each day|daily)/gi)];
    if (perDayMatches.length >= 2) {
        const sumPerDay = perDayMatches.reduce((acc, m) => acc + parseFloat(m[2]), 0);
        if (sumPerDay > maxDailyHours + 0.05) {
            return {
                exceeds: true,
                detectedHours: Math.round(sumPerDay * 10) / 10,
                details: `Sum of subject daily study allocations (${Math.round(sumPerDay * 10) / 10} hours/day) exceeds the ${maxDailyHours}-hour daily limit.`
            };
        }
    }

    return { exceeds: false, detectedHours: 0 };
}

/**
 * Formats a clean, grounded summary directly from a verified StudyPilot plan.
 */
export function formatGroundedPlanSummary(planData) {
    if (!planData || typeof planData !== "object") return "";

    const examDate = planData.examDate || "N/A";
    const daysRemaining = planData.daysRemaining || "N/A";
    const dailyStudyHours = planData.dailyStudyHours || planData.dailyAvailableHours || "N/A";
    const totalAllocatedHours = planData.totalAllocatedHours || "N/A";
    const planId = planData.planId || "default";

    const subjects = planData.subjectAllocations || planData.subjects || {};
    const subjectLines = [];

    for (const [sub, info] of Object.entries(subjects)) {
        const prio = (info.priority || "medium").toUpperCase();
        const hours = info.allocatedHours !== undefined ? info.allocatedHours : info.remainingHours;
        const dailyAvg = typeof daysRemaining === "number" && daysRemaining > 0 && typeof hours === "number"
            ? ` (~${(hours / daysRemaining).toFixed(1)} hrs/day)`
            : "";
        subjectLines.push(`- **${sub}** (${prio} Priority): ${hours} hours total${dailyAvg}`);
    }

    return [
        `Study plan "${planId}" created successfully!`,
        "",
        `**Plan Summary:**`,
        `- **Exam Date:** ${examDate} (${daysRemaining} days remaining)`,
        `- **Daily Available Study Time:** ${dailyStudyHours} hours/day`,
        `- **Total Study Hours Allocated:** ${totalAllocatedHours} hours across all subjects`,
        "",
        `**Subject Allocations:**`,
        ...subjectLines,
        "",
        `All allocations are proportioned according to your priorities and fit strictly within your ${dailyStudyHours}-hour daily limit.`
    ].join("\n");
}

/**
 * Formats a clean, grounded summary from an adapted study plan result.
 */
export function formatGroundedAdaptationSummary(adaptData) {
    if (!adaptData || typeof adaptData !== "object") return "";

    const reason = adaptData.reason || "Progress adaptation";
    const daysRemaining = adaptData.daysRemaining || "N/A";
    const recommendedDaily = adaptData.recommendedDailyHours || "N/A";
    const subjects = adaptData.adjustedSubjectAllocations || {};

    const subjectLines = Object.entries(subjects).map(([sub, info]) => 
        `- **${sub}**: ${info.remainingHours}h remaining (${info.progress || "0%"} progress, ${info.allocatedHours}h total)`
    );

    return [
        `Study plan adapted successfully!`,
        "",
        `**Adaptation Summary:**`,
        `- **Reason:** ${reason}`,
        `- **Days Remaining:** ${daysRemaining}`,
        `- **Recommended Daily Pace:** ${recommendedDaily} hours/day`,
        adaptData.capacityWarning ? `- **Note:** ${adaptData.capacityWarning}` : "",
        "",
        `**Adjusted Allocations:**`,
        ...subjectLines
    ].filter(Boolean).join("\n");
}

/**
 * Formats a clean, grounded summary directly from a retrieved study plan result (get_study_plan).
 * Reports exam date, daily availability, overall progress, all subjects and their priorities,
 * allocated hours, completed hours, remaining hours, missed hours, and recorded sessions.
 */
export function formatGroundedRetrievalSummary(planData) {
    if (!planData || typeof planData !== "object") return "";

    const planId = planData.planId || "default";
    const examDate = planData.examDate || "N/A";
    const daysRemaining = planData.daysRemaining !== undefined ? planData.daysRemaining : "N/A";
    const dailyStudyHours = planData.dailyStudyHours !== undefined ? planData.dailyStudyHours : (planData.dailyAvailableHours || "N/A");
    const overallProgress = planData.overallProgress || `${planData.overallProgressPercentage || 0}%`;
    const totalCompleted = planData.totalCompletedHours !== undefined ? planData.totalCompletedHours : 0;
    const totalMissed = planData.totalMissedHours !== undefined ? planData.totalMissedHours : 0;
    const totalRemaining = planData.totalRemainingHours !== undefined ? planData.totalRemainingHours : "N/A";

    const subjects = planData.subjects || {};
    const subjectLines = Object.entries(subjects).map(([sub, info]) => {
        const priority = (info.priority || "medium").toUpperCase();
        const allocated = info.allocatedHours !== undefined ? info.allocatedHours : "N/A";
        const completed = info.completedHours !== undefined ? info.completedHours : 0;
        const remaining = info.remainingHours !== undefined ? info.remainingHours : "N/A";
        const missed = info.missedHours !== undefined ? info.missedHours : 0;
        const progress = info.progressPercentage !== undefined ? `${info.progressPercentage}%` : "0%";
        return `- **${sub}** (${priority} Priority): ${allocated}h allocated, ${completed}h completed, ${remaining}h remaining, ${missed}h missed (${progress} progress)`;
    });

    // Format recorded study sessions
    const sessionCount = planData.totalSessionsRecorded !== undefined
        ? planData.totalSessionsRecorded
        : (Array.isArray(planData.sessions) ? planData.sessions.length : 0);
    const recentSessions = planData.recentSessions || planData.sessions || [];
    const sessionLines = [];
    if (Array.isArray(recentSessions) && recentSessions.length > 0) {
        sessionLines.push(`**Recorded Study Sessions (${sessionCount}):**`);
        for (const s of recentSessions) {
            sessionLines.push(`- ${s.date || "N/A"}: **${s.subject}** - ${s.hoursSpent}h (${s.status})${s.notes ? ` - ${s.notes}` : ""}`);
        }
    } else {
        sessionLines.push(`**Recorded Study Sessions:** 0 study sessions recorded.`);
    }

    return [
        `Study Plan Details: "${planId}"`,
        "",
        `**Overview:**`,
        `- **Exam Date:** ${examDate} (${daysRemaining} days remaining)`,
        `- **Daily Available Study Time:** ${dailyStudyHours} hours/day`,
        `- **Overall Progress:** ${overallProgress}`,
        `- **Total Hours:** ${totalCompleted}h completed, ${totalMissed}h missed, ${totalRemaining}h remaining`,
        "",
        `**Subject Breakdown:**`,
        ...subjectLines,
        "",
        ...sessionLines
    ].join("\n");
}

/**
 * Verifies final answer consistency against executed tools.
 * If the model invented a schedule exceeding daily constraints or contradicting tool totals,
 * generates a verified grounded summary.
 * @param {string} finalReply - LLM-generated reply
 * @param {Array} executedTools - History of executed tool calls and results
 * @param {string} [userMessage=""] - User's original message
 * @returns {{ valid: boolean, reason?: string, correctedReply?: string, failure?: boolean }}
 */
export function verifyFinalAnswerConsistency(finalReply, executedTools = [], userMessage = "") {
    if (!Array.isArray(executedTools) || executedTools.length === 0) {
        if (userMessage && isRetrievalIntent(userMessage)) {
            return {
                valid: false,
                reason: "Retrieval request requires successful execution of get_study_plan.",
                correctedReply: 'Action Failed: The requested plan retrieval could not be completed successfully. Required tool "get_study_plan" was not executed.',
                failure: true
            };
        }
        return { valid: true };
    }

    // 1. Retrieval intent verification
    if (userMessage && isRetrievalIntent(userMessage)) {
        const retrievalTool = executedTools.find(t => t.toolName === "get_study_plan" && !t.isError && t.parsedData);
        if (!retrievalTool) {
            return {
                valid: false,
                reason: 'Retrieval request did not successfully execute "get_study_plan".',
                correctedReply: 'Action Failed: The requested plan retrieval could not be completed successfully because "get_study_plan" was not executed.',
                failure: true
            };
        }

        const data = retrievalTool.parsedData;
        const requiredSubjects = Object.keys(data.subjects || {});
        const missingSubject = requiredSubjects.find(sub => !new RegExp(`\\b${sub}\\b`, "i").test(finalReply));

        // Check if reply contradicts examDate
        const examDateContradiction = data.examDate && !finalReply.includes(data.examDate);

        // Check if reply fabricated that no sessions exist when sessions actually exist
        const hasSessions = (Array.isArray(data.recentSessions) && data.recentSessions.length > 0) || (data.totalSessionsRecorded > 0);
        const falselyClaimsNoSessions = hasSessions && /\b(?:no\s+sessions?|0\s+sessions?|not\s+recorded\s+any)\b/i.test(finalReply);

        if (missingSubject || examDateContradiction || falselyClaimsNoSessions) {
            const reason = missingSubject
                ? `Final reply omitted subject "${missingSubject}" from retrieved plan.`
                : (examDateContradiction
                    ? `Final reply omitted or contradicted exam date "${data.examDate}".`
                    : `Final reply falsely claimed no sessions exist when sessions are recorded.`);
            return {
                valid: false,
                reason,
                correctedReply: formatGroundedRetrievalSummary(data)
            };
        }

        // Check if user explicitly asked for specific fields and reply omitted them
        const fieldChecks = [
            { req: /priorit/i, field: "priorities", test: () => /priority|priorities/i.test(finalReply) },
            { req: /missed\s+hours/i, field: "missed hours", test: () => /missed/i.test(finalReply) },
            { req: /(?:daily\s+availability|daily\s+hours|available\s+hours)/i, field: "daily availability", test: () => /(?:daily|availability)/i.test(finalReply) },
            { req: /(?:recorded\s+(?:study\s+)?sessions?|sessions?)/i, field: "recorded sessions", test: () => /session/i.test(finalReply) },
            { req: /(?:overall\s+progress|progress)/i, field: "overall progress", test: () => /progress/i.test(finalReply) }
        ];

        for (const c of fieldChecks) {
            if (c.req.test(userMessage) && !c.test()) {
                return {
                    valid: false,
                    reason: `Final reply omitted requested field: ${c.field}.`,
                    correctedReply: formatGroundedRetrievalSummary(data)
                };
            }
        }
    }

    // 2. Find the latest successful tool call
    const successfulTool = [...executedTools].reverse().find(t => !t.isError && t.parsedData);
    if (!successfulTool) {
        return { valid: true };
    }

    const { toolName, toolArgs, parsedData } = successfulTool;

    // Consistency check for get_study_plan
    if (toolName === "get_study_plan" && parsedData) {
        const subjects = Object.keys(parsedData.subjects || {});
        const missingSub = subjects.find(sub => !new RegExp(`\\b${sub}\\b`, "i").test(finalReply));
        if (missingSub) {
            return {
                valid: false,
                reason: `Final reply omitted subject "${missingSub}" from retrieved plan.`,
                correctedReply: formatGroundedRetrievalSummary(parsedData)
            };
        }
    }

    // Consistency check for create_study_plan
    if (toolName === "create_study_plan" && parsedData) {
        const maxDaily = Number(parsedData.dailyStudyHours || toolArgs?.dailyAvailableHours);

        if (Number.isFinite(maxDaily) && maxDaily > 0) {
            const overrun = detectDailyScheduleOverrun(finalReply, maxDaily);

            if (overrun.exceeds) {
                const corrected = formatGroundedPlanSummary(parsedData);
                return {
                    valid: false,
                    reason: overrun.details || `Daily schedule of ${overrun.detectedHours}h exceeds available limit of ${maxDaily}h/day.`,
                    correctedReply: corrected
                };
            }
        }

        // Check if reply contradicts subject priority mappings
        if (parsedData.subjectAllocations && typeof parsedData.subjectAllocations === "object") {
            for (const [sub, info] of Object.entries(parsedData.subjectAllocations)) {
                const prio = (info.priority || "").toLowerCase();
                const opposite = prio === "high" ? "low priority" : (prio === "low" ? "high priority" : null);
                if (opposite && new RegExp(`${sub}\\s+(?:is|to|has)\\s+${opposite}`, "i").test(finalReply)) {
                    const corrected = formatGroundedPlanSummary(parsedData);
                    return {
                        valid: false,
                        reason: `Final reply states "${sub} is ${opposite}", contradicting tool priority "${prio}".`,
                        correctedReply: corrected
                    };
                }
            }
        }
    }

    // Consistency check for adapt_study_plan
    if (toolName === "adapt_study_plan" && parsedData) {
        const recommendedDaily = Number(parsedData.recommendedDailyHours);
        if (Number.isFinite(recommendedDaily) && recommendedDaily > 0) {
            const overrun = detectDailyScheduleOverrun(finalReply, recommendedDaily * 1.5);
            if (overrun.exceeds) {
                const corrected = formatGroundedAdaptationSummary(parsedData);
                return {
                    valid: false,
                    reason: overrun.details || `Daily hours exceed recommended pace.`,
                    correctedReply: corrected
                };
            }
        }
    }

    return { valid: true };
}
