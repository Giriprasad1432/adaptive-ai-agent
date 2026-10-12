import { isRetrievalIntent } from "./normalizer.js";

const MONTH_NAMES = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sep: 9, sept: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12
};

const MONTH_REGEX_PART = "(?:january|jan\\.?|february|feb\\.?|march|mar\\.?|april|apr\\.?|may|june|jun\\.?|july|jul\\.?|august|aug\\.?|september|sept\\.?|sep\\.?|october|oct\\.?|november|nov\\.?|december|dec\\.?)";

/**
 * Strictly validates calendar bounds for a year, month, and day without timezone conversions.
 * Correctly accounts for leap years.
 * @param {number} year
 * @param {number} month - 1-indexed (1 = January, 12 = December)
 * @param {number} day - 1-indexed (1-31)
 * @returns {boolean}
 */
export function isValidCalendarDate(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
        return false;
    }
    if (year < 1000 || year > 9999) return false;
    if (month < 1 || month > 12) return false;
    if (day < 1) return false;

    const daysInMonth = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month === 2) {
        const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
        return day <= (isLeap ? 29 : 28);
    }
    return day <= daysInMonth[month];
}

function toCanonicalIso(year, month, day) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getMonthNumber(monthName) {
    if (!monthName) return null;
    const clean = monthName.replace(".", "").toLowerCase().trim();
    return MONTH_NAMES[clean] || null;
}

/**
 * Strictly parses a single date string in ISO, Month-Day-Year, or Day-Month-Year formats
 * into a canonical YYYY-MM-DD string without timezone shifts or rollover bugs.
 * Returns null if the string is not a valid date.
 * @param {string} str - Candidate date string
 * @returns {string|null} Canonical YYYY-MM-DD string or null
 */
export function normalizeDateToISO(str) {
    if (typeof str !== "string") return null;
    let clean = str.trim();
    clean = clean.replace(/^["'(\[]+|["')\]\.,]+$/g, "").trim();
    if (!clean) return null;

    // 1. ISO YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = clean.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (isoMatch) {
        const y = parseInt(isoMatch[1], 10);
        const m = parseInt(isoMatch[2], 10);
        const d = parseInt(isoMatch[3], 10);
        if (isValidCalendarDate(y, m, d)) return toCanonicalIso(y, m, d);
        return null;
    }

    // 2. Month Day, Year (e.g. "November 30, 2026", "Nov 30th 2026", "Nov. 30, 2026")
    const mdyMatch = clean.match(new RegExp(`^(${MONTH_REGEX_PART})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s+(\\d{4})$`, "i"));
    if (mdyMatch) {
        const m = getMonthNumber(mdyMatch[1]);
        const d = parseInt(mdyMatch[2], 10);
        const y = parseInt(mdyMatch[3], 10);
        if (m && isValidCalendarDate(y, m, d)) return toCanonicalIso(y, m, d);
        return null;
    }

    // 3. Day Month Year (e.g. "30 November 2026", "30th November 2026", "30th of November, 2026")
    const dmyMatch = clean.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_REGEX_PART})(?:,)?\\s+(\\d{4})$`, "i"));
    if (dmyMatch) {
        const d = parseInt(dmyMatch[1], 10);
        const m = getMonthNumber(dmyMatch[2]);
        const y = parseInt(dmyMatch[3], 10);
        if (m && isValidCalendarDate(y, m, d)) return toCanonicalIso(y, m, d);
        return null;
    }

    // 4. Numeric MM/DD/YYYY or DD/MM/YYYY
    const numMatch = clean.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (numMatch) {
        const p1 = parseInt(numMatch[1], 10);
        const p2 = parseInt(numMatch[2], 10);
        const y = parseInt(numMatch[3], 10);
        if (p1 <= 12 && isValidCalendarDate(y, p1, p2)) return toCanonicalIso(y, p1, p2);
        if (p2 <= 12 && isValidCalendarDate(y, p2, p1)) return toCanonicalIso(y, p2, p1);
        return null;
    }

    return null;
}

/**
 * Matches a valid date expression starting at the beginning of str.
 * @param {string} str
 * @returns {string|null} Canonical YYYY-MM-DD or null
 */
export function matchDateAtStart(str) {
    if (typeof str !== "string") return null;
    const trimmed = str.trimStart();

    // 1. ISO YYYY-MM-DD
    const isoMatch = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (isoMatch) {
        const y = parseInt(isoMatch[1], 10);
        const m = parseInt(isoMatch[2], 10);
        const d = parseInt(isoMatch[3], 10);
        if (isValidCalendarDate(y, m, d)) return toCanonicalIso(y, m, d);
    }

    // 2. Month Day, Year
    const mdyMatch = trimmed.match(new RegExp(`^(${MONTH_REGEX_PART})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s+(\\d{4})`, "i"));
    if (mdyMatch) {
        const mon = getMonthNumber(mdyMatch[1]);
        const d = parseInt(mdyMatch[2], 10);
        const y = parseInt(mdyMatch[3], 10);
        if (mon && isValidCalendarDate(y, mon, d)) return toCanonicalIso(y, mon, d);
    }

    // 3. Day Month Year
    const dmyMatch = trimmed.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_REGEX_PART})(?:,)?\\s+(\\d{4})`, "i"));
    if (dmyMatch) {
        const d = parseInt(dmyMatch[1], 10);
        const mon = getMonthNumber(dmyMatch[2]);
        const y = parseInt(dmyMatch[3], 10);
        if (mon && isValidCalendarDate(y, mon, d)) return toCanonicalIso(y, mon, d);
    }

    // 4. Numeric MM/DD/YYYY
    const numMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (numMatch) {
        const p1 = parseInt(numMatch[1], 10);
        const p2 = parseInt(numMatch[2], 10);
        const y = parseInt(numMatch[3], 10);
        if (p1 <= 12 && isValidCalendarDate(y, p1, p2)) return toCanonicalIso(y, p1, p2);
        if (p2 <= 12 && isValidCalendarDate(y, p2, p1)) return toCanonicalIso(y, p2, p1);
    }

    return null;
}

/**
 * Extracts all valid canonical YYYY-MM-DD dates appearing in text.
 * @param {string} text
 * @returns {string[]} Unique array of canonical YYYY-MM-DD date strings
 */
export function extractCanonicalDates(text) {
    if (typeof text !== "string" || !text.trim()) return [];
    const dates = new Set();

    // 1. ISO & YYYY/MM/DD
    const isoMatches = text.matchAll(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g);
    for (const m of isoMatches) {
        const y = parseInt(m[1], 10);
        const mon = parseInt(m[2], 10);
        const d = parseInt(m[3], 10);
        if (isValidCalendarDate(y, mon, d)) {
            dates.add(toCanonicalIso(y, mon, d));
        }
    }

    // 2. Month Day, Year (e.g. November 30, 2026 / Nov 30th, 2026)
    const mdyMatches = text.matchAll(new RegExp(`\\b(${MONTH_REGEX_PART})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s+(\\d{4})\\b`, "gi"));
    for (const m of mdyMatches) {
        const mon = getMonthNumber(m[1]);
        const d = parseInt(m[2], 10);
        const y = parseInt(m[3], 10);
        if (mon && isValidCalendarDate(y, mon, d)) {
            dates.add(toCanonicalIso(y, mon, d));
        }
    }

    // 3. Day Month Year (e.g. 30 November 2026 / 30th of November, 2026)
    const dmyMatches = text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_REGEX_PART})(?:,)?\\s+(\\d{4})\\b`, "gi"));
    for (const m of dmyMatches) {
        const d = parseInt(m[1], 10);
        const mon = getMonthNumber(m[2]);
        const y = parseInt(m[3], 10);
        if (mon && isValidCalendarDate(y, mon, d)) {
            dates.add(toCanonicalIso(y, mon, d));
        }
    }

    // 4. Numeric MM/DD/YYYY or DD/MM/YYYY
    const numMatches = text.matchAll(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g);
    for (const m of numMatches) {
        const p1 = parseInt(m[1], 10);
        const p2 = parseInt(m[2], 10);
        const y = parseInt(m[3], 10);
        if (p1 <= 12 && isValidCalendarDate(y, p1, p2)) {
            dates.add(toCanonicalIso(y, p1, p2));
        }
        if (p2 <= 12 && isValidCalendarDate(y, p2, p1)) {
            dates.add(toCanonicalIso(y, p2, p1));
        }
    }

    return Array.from(dates);
}

/**
 * Extracts dates explicitly associated with exam date labels in text.
 * @param {string} text
 * @returns {string[]} Canonical YYYY-MM-DD dates identified as explicit exam dates
 */
export function extractExplicitExamDates(text) {
    if (typeof text !== "string" || !text.trim()) return [];
    const prefixRegex = /(?:exam\s+date|target\s+exam\s+date|exam\s+day|scheduled\s+exam\s+for|exam\s+is\s+(?:scheduled\s+for|on|set\s+for)|exam\s+on)[*_]*\s*(?:is|on|set\s+for|scheduled\s+for)?\s*[:=–-]?[*_]*\s*/gi;
    const explicitDates = new Set();

    let match;
    while ((match = prefixRegex.exec(text)) !== null) {
        const afterPrefix = text.slice(prefixRegex.lastIndex);
        const date = matchDateAtStart(afterPrefix);
        if (date) {
            explicitDates.add(date);
        }
    }

    return Array.from(explicitDates);
}

/**
 * Checks whether text contradicts or omits the expected exam date.
 * Normalizes equivalent representations (e.g. "November 30, 2026", "November 30th, 2026",
 * "Nov 30, 2026", "30 November 2026", "2026-11-30") before comparison.
 * Detects genuinely incorrect or omitted exam dates.
 * @param {string} text - Final reply text to verify
 * @param {string} expectedDateStr - Ground truth exam date (e.g. "2026-11-30")
 * @returns {boolean} True if exam date is omitted or contradicted, false if equivalent date is present
 */
export function isExamDateContradicted(text, expectedDateStr) {
    if (!expectedDateStr || typeof expectedDateStr !== "string") return false;
    if (typeof text !== "string" || !text.trim()) return true;

    const targetIso = normalizeDateToISO(expectedDateStr);
    if (!targetIso) {
        return !text.includes(expectedDateStr);
    }

    // 1. Check if text contains any date representation equivalent to targetIso
    const datesInReply = extractCanonicalDates(text);
    const hasEquivalentDate = datesInReply.includes(targetIso);

    if (!hasEquivalentDate) {
        return true;
    }

    // 2. If an explicit exam date is stated, ensure it does not contradict targetIso
    const explicitExamDates = extractExplicitExamDates(text);
    if (explicitExamDates.length > 0) {
        const hasMatchingExplicit = explicitExamDates.includes(targetIso);
        const hasContradictoryExplicit = explicitExamDates.some(d => d !== targetIso);
        if (hasContradictoryExplicit && !hasMatchingExplicit) {
            return true;
        }
    }

    return false;
}

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

        // Check if reply contradicts or omits examDate (normalizing equivalent date representations)
        const examDateContradiction = Boolean(data.examDate && isExamDateContradicted(finalReply, data.examDate));

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
        if (parsedData.examDate && isExamDateContradicted(finalReply, parsedData.examDate)) {
            return {
                valid: false,
                reason: `Final reply omitted or contradicted exam date "${parsedData.examDate}".`,
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
