import { isRetrievalIntent, isSessionRecordingIntent, isAdaptationIntent } from "./normalizer.js";

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
    const prefixRegex = /(?:exam\s+date|target\s+exam\s+date|exam\s+day|scheduled\s+exam\s+for|exam\s+is\s+(?:scheduled\s+for|on|set\s+for)|exam\s+(?:will\s+be|takes?\s+place)\s+on|exam\s+on|exam\s*[:=–-])[*_]*\s*(?:is|on|set\s+for|scheduled\s+for)?\s*[:=–-]?[*_]*\s*/gi;
    const explicitDates = new Set();

    let match;
    while ((match = prefixRegex.exec(text)) !== null) {
        const afterPrefix = text.slice(prefixRegex.lastIndex);
        const date = matchDateAtStart(afterPrefix);
        if (date) {
            explicitDates.add(date);
        }
    }

    // Also check patterns where date immediately precedes 'exam', e.g. "2026-12-25 exam"
    const beforeExamRegex = /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[A-Za-z]+(?:,)?\s+\d{4})\s+exam\b/gi;
    let beforeMatch;
    while ((beforeMatch = beforeExamRegex.exec(text)) !== null) {
        const d = normalizeDateToISO(beforeMatch[1]);
        if (d) {
            explicitDates.add(d);
        }
    }

    return Array.from(explicitDates);
}

/**
 * Checks whether user message explicitly requested the exam date.
 * @param {string} userMessage
 * @returns {boolean}
 */
export function isExamDateRequested(userMessage) {
    if (typeof userMessage !== "string" || !userMessage.trim()) return false;
    return /\b(?:exam\s+date|target\s+exam\s+date|exam\s+day|date\s+of\s+(?:the\s+)?exam|when\s+(?:is|'s)\s+(?:the\s+|my\s+)?exam)\b/i.test(userMessage);
}

/**
 * Checks whether text explicitly contradicts the expected exam date.
 * Normalizes equivalent representations (e.g. "November 30, 2026", "November 30th, 2026",
 * "Nov 30, 2026", "30 November 2026", "2026-11-30") before comparison.
 * Distinguishes omission from contradiction: a reply that does not mention an exam date
 * is NOT classified as contradicting the exam date.
 * If the reply explicitly states an exam date, rejects it only when it conflicts with expectedDateStr.
 * @param {string} text - Final reply text to verify
 * @param {string} expectedDateStr - Ground truth exam date (e.g. "2026-11-30")
 * @returns {boolean} True if a stated exam date conflicts with expectedDateStr, false otherwise
 */
export function isExamDateContradicted(text, expectedDateStr) {
    if (!expectedDateStr || typeof expectedDateStr !== "string") return false;
    if (typeof text !== "string" || !text.trim()) return false;

    const targetIso = normalizeDateToISO(expectedDateStr);
    if (!targetIso) {
        return false;
    }

    const explicitExamDates = extractExplicitExamDates(text);
    if (explicitExamDates.length > 0) {
        const hasMatchingExplicit = explicitExamDates.includes(targetIso);
        const hasContradictoryExplicit = explicitExamDates.some(d => d !== targetIso);
        if (hasContradictoryExplicit || !hasMatchingExplicit) {
            return true;
        }
        return false;
    }

    // If no valid dates were extracted, check if text contains an explicit exam date label with non-date text
    const labelMatch = text.match(/(?:exam\s+date|target\s+exam\s+date|exam\s+day)\s*[:=]\s*([^\n;]+)/i);
    if (labelMatch) {
        const candidate = labelMatch[1].trim();
        const candIso = matchDateAtStart(candidate) || normalizeDateToISO(candidate);
        if (!candIso || candIso !== targetIso) {
            return true;
        }
    }

    return false;
}

/**
 * Safely escapes regular expression metacharacters in a string.
 * @param {string} str
 * @returns {string}
 */
export function escapeRegex(str) {
    if (typeof str !== "string") return "";
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks whether a text (such as an LLM reply or user prompt) mentions a subject.
 * Safely handles:
 * 1. Aliases: "Math" and "Maths" for "Mathematics" (case-insensitive).
 * 2. Escaped metacharacters for subject names such as "C++" and "R&D".
 * 3. Accurate boundary checking to prevent false substring matches (e.g. "aftermath").
 * @param {string} text - Candidate text to inspect
 * @param {string} subject - Target subject name
 * @returns {boolean} True if subject or its alias is mentioned
 */
export function replyMentionsSubject(text, subject) {
    if (!text || typeof text !== "string" || !subject || typeof subject !== "string") {
        return false;
    }
    const cleanSub = subject.trim();
    if (!cleanSub) return false;

    // Mathematics aliases: "Math" and "Maths"
    if (/^math(?:ematics)?$/i.test(cleanSub)) {
        return /\b(?:mathematics|maths?)\b/i.test(text);
    }

    const escaped = escapeRegex(cleanSub);
    const leadingBoundary = /^\w/.test(cleanSub) ? "\\b" : "(?:^|[\\s.,;!?:'\"()\\[\\]{}*\\/\\\\-])";
    const trailingBoundary = /\w$/.test(cleanSub) ? "\\b" : "(?=$|[\\s.,;!?:'\"()\\[\\]{}*\\/\\\\-])";

    const regex = new RegExp(`${leadingBoundary}${escaped}${trailingBoundary}`, "i");
    return regex.test(text);
}

/**
 * Determines which subjects are required in the reply based on user message and plan subjects.
 * For focused retrieval questions (e.g. user asks only about "Chemistry"), only the mentioned
 * subject(s) are required unless the user asks for all subjects or full plan.
 * @param {string[]} subjectsInPlan
 * @param {string} [userMessage=""]
 * @returns {string[]}
 */
export function getRequiredSubjects(subjectsInPlan = [], userMessage = "") {
    if (!userMessage || typeof userMessage !== "string") {
        return subjectsInPlan;
    }
    const userMentionedSubjects = subjectsInPlan.filter(sub => replyMentionsSubject(userMessage, sub));
    const asksForAllSubjects = /\b(?:all\s+subjects|every\s+subject|all\s+(?:of\s+)?my\s+subjects|full\s+plan|entire\s+plan|whole\s+plan)\b/i.test(userMessage);
    if (!asksForAllSubjects && userMentionedSubjects.length > 0) {
        return userMentionedSubjects;
    }
    return subjectsInPlan;
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
 * Formats a clean, grounded confirmation summary directly from a verified record_study_session result.
 * Reports session details (subject, status, hours, date, notes) and updated metrics
 * (completed hours, remaining hours, missed hours, subject progress, and overall plan progress).
 * @param {Object} sessionData
 * @param {Object} [toolArgs]
 * @returns {string}
 */
export function formatGroundedSessionSummary(sessionData, toolArgs = {}) {
    if (!sessionData || typeof sessionData !== "object") return "";

    const session = sessionData.session || {};
    const subjectProgress = sessionData.subjectProgress || {};
    const subject = subjectProgress.subject || session.subject || toolArgs?.subject || "Unknown";
    const status = (session.status || toolArgs?.status || "completed").toLowerCase();
    const formattedStatus = status.charAt(0).toUpperCase() + status.slice(1);
    const hoursSpent = session.hoursSpent !== undefined ? session.hoursSpent : (toolArgs?.hoursSpent ?? 0);
    const date = session.date || toolArgs?.date || "today";

    const completedHours = subjectProgress.completedHours !== undefined ? subjectProgress.completedHours : "N/A";
    const remainingHours = subjectProgress.remainingHours !== undefined ? subjectProgress.remainingHours : "N/A";
    const missedHours = subjectProgress.missedHours !== undefined ? subjectProgress.missedHours : 0;
    const progressPct = subjectProgress.progressPercentage || (subjectProgress.progress ? `${subjectProgress.progress}` : "N/A");
    const overallProgress = sessionData.overallPlanProgress || sessionData.overallProgress || "N/A";

    const lines = [
        `Study session recorded successfully!`,
        "",
        `**Session Details:**`,
        `- **Subject:** ${subject}`,
        `- **Status:** ${formattedStatus}`,
        `- **Hours Spent:** ${hoursSpent} hour${hoursSpent === 1 ? "" : "s"}`,
        `- **Date:** ${date}`
    ];

    if (session.notes) {
        lines.push(`- **Notes:** ${session.notes}`);
    }

    lines.push(
        "",
        `**Updated Progress for ${subject}:**`,
        `- **Completed Hours:** ${completedHours}h`,
        `- **Remaining Hours:** ${remainingHours}h`,
        `- **Missed Hours:** ${missedHours}h`,
        `- **Subject Progress:** ${progressPct}`,
        `- **Overall Plan Progress:** ${overallProgress}`
    );

    return lines.join("\n");
}

/**
 * Formats a clean, grounded summary from an adapted study plan result.
 */
export function formatGroundedAdaptationSummary(adaptData) {
    if (!adaptData || typeof adaptData !== "object") return "";

    const planId = adaptData.planId ? ` "${adaptData.planId}"` : "";
    const reason = adaptData.reason || "Progress adaptation";
    const daysRemaining = adaptData.daysRemaining !== undefined ? adaptData.daysRemaining : "N/A";
    const recommendedDaily = adaptData.recommendedDailyHours !== undefined ? adaptData.recommendedDailyHours : "N/A";
    const subjects = adaptData.adjustedSubjectAllocations || adaptData.subjects || {};

    const subjectLines = Object.entries(subjects).map(([sub, info]) => {
        const remaining = info.remainingHours !== undefined ? `${info.remainingHours}h remaining` : "";
        const progress = info.progress !== undefined ? `${info.progress} progress` : (info.progressPercentage !== undefined ? `${info.progressPercentage}% progress` : "");
        const completed = info.completedHours !== undefined ? `${info.completedHours}h completed` : "";
        const allocated = info.allocatedHours !== undefined ? `${info.allocatedHours}h total allocated` : "";
        const details = [remaining, progress, completed, allocated].filter(Boolean).join(", ");
        return `- **${sub}**: ${details ? `(${details})` : "adjusted"}`;
    });

    return [
        `Study plan${planId} adapted successfully!`,
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
 * Leading conversational meta-preamble regex.
 * Matches model-generated boilerplate phrases like:
 * - "Here is the final answer to the original user question:"
 * - "Here is the final answer:"
 * - "Based on the tool results, here is the final answer:"
 * - "Based on the verified tool results, here is the answer to your question:"
 * - "Final answer:"
 * Supports optional leading/trailing markdown bolding (** or *).
 * Preserves meaningful user-facing introductory sentences like:
 * - "Here is your updated study plan for Mathematics and Physics:"
 * - "Here is an overview of your schedule before the exam on 2026-11-30:"
 * - "Based on your exam date, you have 49 days remaining."
 */
export const META_PREAMBLE_REGEX = /^\s*(?:\*{1,2})?(?:(?:based\s+on\s+(?:the\s+)?(?:verified\s+)?(?:tool\s+results?|tool\s+executions?|tools?)[,\s]+)?(?:here\s+is\s+(?:the|your)\s+(?:final\s+)?answer(?:\s+to\s+(?:the\s+|your\s+)?(?:original\s+)?(?:user\s+)?(?:question|request))?|final\s+answer))(?:[:.]\s*(?:\*{1,2})?|(?:\*{1,2})\s*[:.]?)\s*/i;

/**
 * Strips leading conversational meta-preambles from model replies, preserving actual answer content and formatting.
 * @param {string} text
 * @returns {string}
 */
export function stripMetaPreamble(text) {
    if (typeof text !== "string") return text;
    return text.replace(META_PREAMBLE_REGEX, "");
}

/**
 * Detects whether the reply explicitly asserts a plan-wide total remaining hours
 * that contradicts data.totalRemainingHours.
 * @param {string} reply
 * @param {number} expectedTotal - data.totalRemainingHours
 * @returns {{ contradicted: boolean, claimedTotal?: number }}
 */
export function detectPlanWideTotalRemainingHoursContradiction(reply, expectedTotal) {
    if (typeof reply !== "string" || typeof expectedTotal !== "number" || isNaN(expectedTotal)) {
        return { contradicted: false };
    }

    const prefixRegexes = [
        /(?:plan-wide\s+)?(?:total|overall)\s+(?:remaining\s+(?:study\s+)?hours?|remaining)(?:\s+(?:for|across|in)\s+(?:the\s+)?(?:entire\s+|whole\s+|all\s+)?(?:plan|subjects))?\s*(?:are|is|=|:)\s*(\d+(?:\.\d+)?)/i,
        /(?:plan-wide\s+)?(?:total|overall)\s+remaining(?:\s+(?:study\s+)?hours?)?(?:\s+(?:for|across|in)\s+(?:the\s+)?(?:entire\s+|whole\s+|all\s+)?(?:plan|subjects))?\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)?/i,
        /(?:total|overall)\s+hours?[:\s]+[^\n]*?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)?\s+remaining/i,
        /total\s+of\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)?\s+remaining/i,
        /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)?\s+(?:total|overall)\s+remaining(?:\s+hours?)?/i
    ];

    for (const rx of prefixRegexes) {
        const match = reply.match(rx);
        if (match && match[1]) {
            const claimed = parseFloat(match[1]);
            if (!isNaN(claimed)) {
                if (Math.abs(claimed - expectedTotal) > 0.2) {
                    return { contradicted: true, claimedTotal: claimed };
                }
            }
        }
    }

    return { contradicted: false };
}

/**
 * Detects whether the reply asserts a blanket claim that all recent sessions occurred on one date,
 * but returned recentSessions contains sessions with distinct dates establishing the claim is false.
 * @param {string} reply
 * @param {Array} recentSessions
 * @returns {{ contradicted: boolean, claimedDate?: string, actualDates?: string[] }}
 */
export function detectBlanketRecentSessionDateContradiction(reply, recentSessions) {
    if (typeof reply !== "string" || !Array.isArray(recentSessions) || recentSessions.length === 0) {
        return { contradicted: false };
    }

    // Extract all valid normalized ISO dates from recentSessions
    const validSessionDates = recentSessions
        .map(s => (s && s.date ? normalizeDateToISO(String(s.date)) : null))
        .filter(Boolean);

    // If there are no session dates or only 1 distinct date, a blanket single-date claim cannot be contradicted
    const uniqueDates = [...new Set(validSessionDates)];
    if (uniqueDates.length <= 1) {
        return { contradicted: false };
    }

    // Regexes targeting explicit blanket statements about all recent sessions
    const blanketPatterns = [
        /(?:the\s+)?(?:most\s+)?recent\s+sessions?\s+were\s+all\s+(?:completed|recorded|logged|held|conducted)\s+(?:on|in)\s+([^\n]+)/i,
        /\ball\s+(?:\d+\s+)?(?:recent\s+)?sessions?\s+(?:were\s+all\s+|were\s+|are\s+)?(?:completed|recorded|logged|held|conducted|took\s+place|occurred)\s+(?:on|in)\s+([^\n]+)/i,
        /\ball\s+sessions?\s+(?:took\s+place|occurred)\s+(?:on|in)\s+([^\n]+)/i
    ];

    for (const pattern of blanketPatterns) {
        const match = reply.match(pattern);
        if (match && match[1]) {
            const rawAfter = match[1].trim();
            const claimedIso = matchDateAtStart(rawAfter) || normalizeDateToISO(rawAfter);
            if (claimedIso) {
                // If at least one returned recent session date differs from the claimed date,
                // the returned records establish that the blanket claim is false.
                const hasMismatch = uniqueDates.some(d => d !== claimedIso);
                if (hasMismatch) {
                    return {
                        contradicted: true,
                        claimedDate: claimedIso,
                        actualDates: uniqueDates
                    };
                }
            }
        }
    }

    return { contradicted: false };
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
    finalReply = stripMetaPreamble(finalReply);
    if (!Array.isArray(executedTools) || executedTools.length === 0) {
        if (userMessage && isRetrievalIntent(userMessage)) {
            return {
                valid: false,
                reason: "Retrieval request requires successful execution of get_study_plan.",
                correctedReply: 'Action Failed: The requested plan retrieval could not be completed successfully. Required tool "get_study_plan" was not executed.',
                failure: true
            };
        }
        if (userMessage && isSessionRecordingIntent(userMessage)) {
            return {
                valid: false,
                reason: 'Session recording request requires successful execution of "record_study_session".',
                correctedReply: 'Action Failed: The requested study session could not be recorded because "record_study_session" was not executed.',
                failure: true
            };
        }
        if (userMessage && isAdaptationIntent(userMessage)) {
            return {
                valid: false,
                reason: 'Plan adaptation request requires successful execution of "adapt_study_plan".',
                correctedReply: 'Action Failed: The requested plan adaptation could not be completed successfully because "adapt_study_plan" was not executed.',
                failure: true
            };
        }
        return { valid: true };
    }

    // 1. Intent execution integrity checks
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
        const subjectsInPlan = Object.keys(data.subjects || {});
        const requiredSubjects = getRequiredSubjects(subjectsInPlan, userMessage);
        const missingSubject = requiredSubjects.find(sub => !replyMentionsSubject(finalReply, sub));

        // Check if reply contradicts or omits examDate (distinguishing omission from contradiction)
        const examDateContradiction = Boolean(data.examDate && isExamDateContradicted(finalReply, data.examDate));
        const examDateOmission = Boolean(
            data.examDate &&
            userMessage &&
            isExamDateRequested(userMessage) &&
            !extractCanonicalDates(finalReply).includes(normalizeDateToISO(data.examDate))
        );

        // Check if reply fabricated that no sessions exist when sessions actually exist
        const hasSessions = (Array.isArray(data.recentSessions) && data.recentSessions.length > 0) || (data.totalSessionsRecorded > 0) || (Array.isArray(data.sessions) && data.sessions.length > 0);
        const falselyClaimsNoSessions = hasSessions && /\b(?:no\s+sessions?|0\s+sessions?|not\s+recorded\s+any)\b/i.test(finalReply);

        if (missingSubject || examDateContradiction || examDateOmission || falselyClaimsNoSessions) {
            const reason = missingSubject
                ? `Final reply omitted subject "${missingSubject}" from retrieved plan.`
                : (examDateContradiction || examDateOmission
                    ? `Final reply omitted or contradicted exam date "${data.examDate}".`
                    : `Final reply falsely claimed no sessions exist when sessions are recorded.`);
            return {
                valid: false,
                reason,
                correctedReply: formatGroundedRetrievalSummary(data)
            };
        }

        // Check if reply contradicts plan-wide total remaining hours
        if (typeof data.totalRemainingHours === "number") {
            const totalRemainingCheck = detectPlanWideTotalRemainingHoursContradiction(finalReply, data.totalRemainingHours);
            if (totalRemainingCheck.contradicted) {
                return {
                    valid: false,
                    reason: `Final reply states total remaining hours as ${totalRemainingCheck.claimedTotal}h, contradicting verified plan-wide total remaining hours of ${data.totalRemainingHours}h.`,
                    correctedReply: formatGroundedRetrievalSummary(data)
                };
            }
        }

        // Check if reply makes a false blanket claim about all recent session dates
        const recentSessionsList = data.recentSessions || data.sessions || [];
        if (Array.isArray(recentSessionsList) && recentSessionsList.length > 0) {
            const blanketDateCheck = detectBlanketRecentSessionDateContradiction(finalReply, recentSessionsList);
            if (blanketDateCheck.contradicted) {
                return {
                    valid: false,
                    reason: `Final reply falsely claims all recent sessions were completed on "${blanketDateCheck.claimedDate}", but returned history contains sessions on distinct dates (${blanketDateCheck.actualDates.join(", ")}).`,
                    correctedReply: formatGroundedRetrievalSummary(data)
                };
            }
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
        const requiredSubjects = getRequiredSubjects(subjects, userMessage);
        const missingSub = requiredSubjects.find(sub => !replyMentionsSubject(finalReply, sub));
        if (missingSub) {
            return {
                valid: false,
                reason: `Final reply omitted subject "${missingSub}" from retrieved plan.`,
                correctedReply: formatGroundedRetrievalSummary(parsedData)
            };
        }
        const examDateContradiction = Boolean(parsedData.examDate && isExamDateContradicted(finalReply, parsedData.examDate));
        const examDateOmission = Boolean(
            parsedData.examDate &&
            userMessage &&
            isExamDateRequested(userMessage) &&
            !extractCanonicalDates(finalReply).includes(normalizeDateToISO(parsedData.examDate))
        );
        if (examDateContradiction || examDateOmission) {
            return {
                valid: false,
                reason: `Final reply omitted or contradicted exam date "${parsedData.examDate}".`,
                correctedReply: formatGroundedRetrievalSummary(parsedData)
            };
        }
        if (typeof parsedData.totalRemainingHours === "number") {
            const totalRemainingCheck = detectPlanWideTotalRemainingHoursContradiction(finalReply, parsedData.totalRemainingHours);
            if (totalRemainingCheck.contradicted) {
                return {
                    valid: false,
                    reason: `Final reply states total remaining hours as ${totalRemainingCheck.claimedTotal}h, contradicting verified plan-wide total remaining hours of ${parsedData.totalRemainingHours}h.`,
                    correctedReply: formatGroundedRetrievalSummary(parsedData)
                };
            }
        }
        const recentSessionsList = parsedData.recentSessions || parsedData.sessions || [];
        if (Array.isArray(recentSessionsList) && recentSessionsList.length > 0) {
            const blanketDateCheck = detectBlanketRecentSessionDateContradiction(finalReply, recentSessionsList);
            if (blanketDateCheck.contradicted) {
                return {
                    valid: false,
                    reason: `Final reply falsely claims all recent sessions were completed on "${blanketDateCheck.claimedDate}", but returned history contains sessions on distinct dates (${blanketDateCheck.actualDates.join(", ")}).`,
                    correctedReply: formatGroundedRetrievalSummary(parsedData)
                };
            }
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

    // Consistency check for record_study_session
    if (toolName === "record_study_session" && parsedData) {
        const session = parsedData.session || {};
        const subjectProgress = parsedData.subjectProgress || {};
        const subject = subjectProgress.subject || session.subject || toolArgs?.subject;
        const trimmed = finalReply.trim();

        // 1. Detect raw JSON dump or code block representing a study plan or data
        const isRawJson = (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
            (trimmed.startsWith("```") && (trimmed.includes('"planId"') || trimmed.includes('"examDate"') || trimmed.includes('"subjects"')));
        if (isRawJson) {
            return {
                valid: false,
                reason: "Final reply was a raw JSON object or code block instead of a grounded session confirmation.",
                correctedReply: formatGroundedSessionSummary(parsedData, toolArgs)
            };
        }

        // 2. Detect fabricated study plan fields (e.g., exam date, daily available study time) not in session result
        const mentionsFabricatedPlanData = /\bexam\s*date\b/i.test(finalReply) ||
            /\bexamDate\b/.test(finalReply) ||
            /\bdaily\s+available\s+study\s+time\b/i.test(finalReply) ||
            /\bstudy\s+plan\s+details\b/i.test(finalReply);
        if (mentionsFabricatedPlanData) {
            return {
                valid: false,
                reason: "Final reply presented unrelated study plan details (e.g. exam date) instead of a grounded session confirmation.",
                correctedReply: formatGroundedSessionSummary(parsedData, toolArgs)
            };
        }

        // 3. Must mention the target subject (handling aliases like Math / Maths for Mathematics)
        if (subject && !replyMentionsSubject(finalReply, subject)) {
            return {
                valid: false,
                reason: `Final reply omitted subject "${subject}" from recorded session confirmation.`,
                correctedReply: formatGroundedSessionSummary(parsedData, toolArgs)
            };
        }

        // 4. Detect generic or unhelpful final responses:
        // Must mention session/study/completed/missed AND mention hours or progress metrics
        const mentionsSessionOrAction = /\b(?:session|studied|study|recorded|logged|completed|missed)\b/i.test(finalReply);
        const mentionsHoursOrProgress = /\b(?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)|progress|%)\b/i.test(finalReply);

        if (!mentionsSessionOrAction || !mentionsHoursOrProgress) {
            return {
                valid: false,
                reason: "Final reply was generic or omitted verified session hours and progress metrics.",
                correctedReply: formatGroundedSessionSummary(parsedData, toolArgs)
            };
        }

        // 3. Contradiction checks:
        // If session was missed, ensure reply does not falsely claim hours were completed
        const isMissed = session.status === "missed" || toolArgs?.status === "missed";
        if (isMissed && /\bcompleted\s+\d+\s*(?:hours?|hrs?)/i.test(finalReply) && !/\bmissed\b/i.test(finalReply)) {
            return {
                valid: false,
                reason: "Final reply claimed session was completed when it was recorded as missed.",
                correctedReply: formatGroundedSessionSummary(parsedData, toolArgs)
            };
        }

        // 4. If reply claims hoursSpent contradicting tool result
        const actualHours = session.hoursSpent !== undefined ? session.hoursSpent : toolArgs?.hoursSpent;
        if (typeof actualHours === "number" && actualHours > 0) {
            const hoursClaimRegex = /(?:recorded|completed|studied|logged)\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)/i;
            const match = finalReply.match(hoursClaimRegex);
            if (match) {
                const claimedHours = parseFloat(match[1]);
                if (Math.abs(claimedHours - actualHours) > 0.05) {
                    return {
                        valid: false,
                        reason: `Final reply claimed ${claimedHours} hours recorded, contradicting tool result of ${actualHours} hours.`,
                        correctedReply: formatGroundedSessionSummary(parsedData, toolArgs)
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

        // Detect generic final replies that fail to confirm adaptation details
        const mentionsAdaptation = /\b(?:adapt(?:ed|ation)?|re-?balanc(?:ed|ing)|adjust(?:ed|ment)|reschedul(?:ed|ing)|updat(?:ed|ing)\s+(?:the\s+)?(?:schedule|plan))\b/i.test(finalReply);
        const mentionsMetricsOrSubjects = /\b(?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)|pace|daily|progress|%|remaining)\b/i.test(finalReply);

        if (!mentionsAdaptation || !mentionsMetricsOrSubjects) {
            return {
                valid: false,
                reason: "Final reply was generic or omitted verified plan adaptation details.",
                correctedReply: formatGroundedAdaptationSummary(parsedData)
            };
        }
    }

    return { valid: true };
}
