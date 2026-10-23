/**
 * StudyPilot Planning Engine
 * Core algorithms for study schedule generation, progress tracking, and adaptive rescheduling.
 */

export const DEFAULT_MISSED_SESSION_HOURS = 2;
export const MIN_DAILY_STUDY_HOURS = 0.5;
export const MAX_DAILY_STUDY_HOURS = 12;

export function getDailyStudyHourBounds() {
    const configuredMin = Number(process.env.STUDYPILOT_MIN_DAILY_HOURS || MIN_DAILY_STUDY_HOURS);
    const configuredMax = Number(process.env.STUDYPILOT_MAX_DAILY_HOURS || MAX_DAILY_STUDY_HOURS);
    const min = Number.isFinite(configuredMin) && configuredMin > 0 ? configuredMin : MIN_DAILY_STUDY_HOURS;
    const max = Number.isFinite(configuredMax) && configuredMax >= min ? configuredMax : MAX_DAILY_STUDY_HOURS;
    return { min, max };
}

export function getRecommendedDailyHours({ requestedHours, durationDays, examDate } = {}) {
    const configured = Number(process.env.STUDYPILOT_DEFAULT_DAILY_HOURS || 1.5);
    const { min, max } = getDailyStudyHourBounds();
    const fallback = Number.isFinite(configured)
        ? Math.min(max, Math.max(min, configured))
        : Math.min(max, Math.max(min, 1.5));
    if (requestedHours !== undefined && requestedHours !== null) {
        const hours = Number(requestedHours);
        if (!Number.isFinite(hours) || hours < min || hours > max) {
            throw new Error(`dailyAvailableHours must be between ${min} and ${max}.`);
        }
        return { hours, source: "user" };
    }

    // A shorter learning window or an exam deadline merits a modestly higher,
    // still bounded recommendation; deployments can tune the base via env.
    const days = Number(durationDays);
    const recommendation = examDate || (Number.isFinite(days) && days <= 14)
        ? Math.min(max, Math.max(fallback, 2, min))
        : fallback;
    return { hours: recommendation, source: "recommended" };
}

function getGoalDays(durationDays) {
    const configured = Number(process.env.STUDYPILOT_DEFAULT_DURATION_DAYS || 30);
    const days = durationDays === undefined || durationDays === null || durationDays === ""
        ? (Number.isFinite(configured) && configured > 0 ? configured : 30)
        : Number(durationDays);
    const maxDays = Number(process.env.STUDYPILOT_MAX_DURATION_DAYS || 730);
    if (!Number.isInteger(days) || days < 1 || days > maxDays) {
        throw new Error(`durationDays must be a whole number between 1 and ${maxDays}.`);
    }
    return days;
}

const PRIORITY_WEIGHTS = {
    high: 3,
    medium: 2,
    low: 1
};

/**
 * Safely cleans a single subject name
 */
export function cleanSubjectName(item) {
    if (item === null || item === undefined) return "";
    let str = typeof item === "string" ? item : String(item.name || item.subject || item);
    return str.replace(/^["'\\\[\]]+|["'\\\[\]]+$/g, "").trim();
}

/**
 * Resolves a requested subject against a plan's defined subjects, handling:
 * 1. Exact match (e.g. "DBMS" === "DBMS")
 * 2. Case-insensitive match (e.g. "dbms" === "DBMS")
 * 3. Standard computer science / STEM acronym & alias mapping (e.g. "DBMS" <-> "Database Management Systems")
 * 4. Distinct substring match (e.g. "Database" -> "Database Management Systems")
 */
export function resolvePlanSubject(plan, requestedSubject) {
    if (!plan || !plan.subjects || !requestedSubject) return null;
    const subjects = Object.keys(plan.subjects);
    if (subjects.length === 0) return null;

    // 1. Exact match
    if (Object.hasOwn(plan.subjects, requestedSubject)) {
        return requestedSubject;
    }

    const cleanReq = String(requestedSubject).trim();
    const cleanReqLower = cleanReq.toLowerCase();

    // 2. Case-insensitive match
    const caseMatch = subjects.find(s => s.toLowerCase() === cleanReqLower);
    if (caseMatch) return caseMatch;

    // 3. Known acronym / alias mappings
    const ACRONYMS = {
        "dbms": ["database management systems", "database management system", "database", "databases"],
        "dms": ["database management systems", "database management system"],
        "os": ["operating systems", "operating system"],
        "cn": ["computer networks", "computer networking", "computer network"],
        "ai": ["artificial intelligence"],
        "ml": ["machine learning"],
        "dl": ["deep learning"],
        "dsa": ["data structures and algorithms", "data structures & algorithms", "data structures"],
        "ds": ["data structures", "data science"],
        "oop": ["object oriented programming", "object-oriented programming"],
        "oops": ["object oriented programming", "object-oriented programming"],
        "se": ["software engineering"],
        "toc": ["theory of computation"],
        "cd": ["compiler design"],
        "coa": ["computer organization and architecture", "computer organization & architecture"],
        "ca": ["computer architecture"],
        "js": ["javascript"],
        "ts": ["typescript"],
        "py": ["python"],
        "cpp": ["c++"]
    };

    for (const s of subjects) {
        const sLower = s.toLowerCase();
        const expansions = ACRONYMS[cleanReqLower];
        if (expansions && expansions.some(exp => sLower.includes(exp) || exp.includes(sLower))) {
            return s;
        }
        const sExpansions = ACRONYMS[sLower];
        if (sExpansions && sExpansions.some(exp => exp === cleanReqLower)) {
            return s;
        }
        // Direct initials check: e.g. "Database Management Systems" -> "DMS" or "DBMS"
        const words = sLower.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
        const initials = words.map(w => w[0]).join("");
        if (initials === cleanReqLower || (words[0] === "database" && initials.replace(/^d/, "db") === cleanReqLower)) {
            return s;
        }
    }

    // 4. Substring inclusion if unambiguous
    const substringMatches = subjects.filter(s =>
        s.toLowerCase().includes(cleanReqLower) || cleanReqLower.includes(s.toLowerCase())
    );
    if (substringMatches.length === 1) {
        return substringMatches[0];
    }

    return null;
}

/**
 * Normalizes subjects list into array of clean subject names
 */
export function normalizeSubjects(subjects) {
    if (typeof subjects === "string") {
        const trimmed = subjects.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.map(s => cleanSubjectName(s)).filter(Boolean);
                }
            } catch {
                // fall through
            }
        }
        return trimmed.split(",").map(s => cleanSubjectName(s)).filter(Boolean);
    }
    if (Array.isArray(subjects)) {
        const flattened = [];
        for (const item of subjects) {
            if (typeof item === "string" && item.includes(",")) {
                flattened.push(...item.split(",").map(s => cleanSubjectName(s)).filter(Boolean));
            } else {
                const cleaned = cleanSubjectName(item);
                if (cleaned) flattened.push(cleaned);
            }
        }
        return flattened;
    }
    return [];
}

/**
 * Calculates the number of calendar days from the reference date to a target.
 * Date-only values use UTC consistently. By default this preserves the
 * existing "days until" behavior used for exam dates. Goal-plan end dates are
 * inclusive and pass { includeReferenceDate: true }, so a plan ending today
 * still has one remaining study day.
 */
export function calculateDaysRemaining(targetDateStr, referenceDate = new Date(), { includeReferenceDate = false } = {}) {
    if (!targetDateStr || typeof targetDateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDateStr.trim())) {
        throw new Error(`Invalid exam date format: "${targetDateStr}". Please use YYYY-MM-DD.`);
    }

    const [targetYear, targetMonth, targetDay] = targetDateStr.trim().split("-").map(Number);
    const target = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay));
    if (Number.isNaN(target.getTime()) || target.getUTCFullYear() !== targetYear || target.getUTCMonth() !== targetMonth - 1 || target.getUTCDate() !== targetDay) {
        throw new Error(`Invalid exam date format: "${targetDateStr}". Please use YYYY-MM-DD.`);
    }

    const today = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    if (Number.isNaN(today.getTime())) {
        throw new Error("Invalid reference date provided.");
    }

    // Parse YYYY-MM-DD components directly to avoid timezone shift
    const utcTarget = Date.UTC(targetYear, targetMonth - 1, targetDay);
    const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

    const diffDays = Math.round((utcTarget - utcToday) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) {
        throw new Error("Exam date cannot be in the past.");
    }

    return Math.max(1, diffDays + (includeReferenceDate ? 1 : 0));
}

function addUtcCalendarDays(dateOnly, days) {
    if (typeof dateOnly !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly) || !Number.isInteger(days)) {
        throw new Error("Cannot calculate a plan date from invalid date metadata.");
    }
    const [year, month, day] = dateOnly.split("-").map(Number);
    const base = new Date(0);
    base.setUTCHours(0, 0, 0, 0);
    base.setUTCFullYear(year, month - 1, day);
    if (base.getUTCFullYear() !== year || base.getUTCMonth() !== month - 1 || base.getUTCDate() !== day) {
        throw new Error("Cannot calculate a plan date from invalid date metadata.");
    }
    const date = new Date(base.getTime());
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

/** Resolve a numbered plan day to its UTC calendar date (Day 1 is startDate). */
export function resolvePlanDayDate(plan, dayNumber) {
    if (!Number.isInteger(dayNumber)) {
        throw new Error("dayNumber must be a whole number within the plan duration.");
    }
    const durationDays = Number(plan?.durationDays);
    if (!Number.isInteger(durationDays) || durationDays < 1) {
        throw new Error("This plan has no valid duration for resolving a plan day.");
    }
    if (dayNumber < 1 || dayNumber > durationDays) {
        throw new Error(`dayNumber must be between 1 and ${durationDays} for this plan.`);
    }

    let startDate = plan.startDate;
    if (!startDate && typeof plan.createdAt === "string") {
        startDate = plan.createdAt.slice(0, 10);
    }
    // Legacy plans without creation metadata can be anchored from their
    // inclusive end date and duration without changing stored data.
    if (!startDate && typeof plan.goalEndDate === "string") {
        startDate = addUtcCalendarDays(plan.goalEndDate, -(durationDays - 1));
    }
    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        throw new Error("The plan start date is unavailable. Please provide an explicit session date.");
    }
    return addUtcCalendarDays(startDate, dayNumber - 1);
}

/**
 * Generates an initial study plan
 */
export function createPlan({
    planId = "default",
    subjects,
    examDate,
    durationDays,
    dailyAvailableHours,
    priorities = {},
    referenceDate = new Date()
}) {
    const cleanSubjects = normalizeSubjects(subjects);
    if (cleanSubjects.length === 0) {
        throw new Error("At least one subject is required to create a study plan.");
    }

    // Safely parse priorities if JSON string or Python-style dictionary string
    let parsedPriorities = priorities;
    if (typeof parsedPriorities === "string") {
        try {
            parsedPriorities = JSON.parse(parsedPriorities);
        } catch {
            try {
                const converted = parsedPriorities.replace(/'/g, '"');
                parsedPriorities = JSON.parse(converted);
            } catch {
                parsedPriorities = {};
            }
        }
    }
    if (!parsedPriorities || typeof parsedPriorities !== "object") {
        parsedPriorities = {};
    }

    const ALLOWED_PRIORITIES = ["high", "medium", "low"];

    // Validate any explicitly passed priorities
    for (const [subj, prio] of Object.entries(parsedPriorities)) {
        if (typeof prio === "string") {
            const cleanPrio = prio.trim().toLowerCase();
            if (!ALLOWED_PRIORITIES.includes(cleanPrio)) {
                throw new Error(`Invalid priority "${prio}" for subject "${subj}". Allowed priorities: high, medium, low.`);
            }
        } else if (prio !== undefined && prio !== null) {
            throw new Error(`Invalid priority "${prio}" for subject "${subj}". Allowed priorities: high, medium, low.`);
        }
    }

    const hasExamDate = examDate !== undefined && examDate !== null;
    const planDurationDays = hasExamDate
        ? calculateDaysRemaining(examDate, referenceDate)
        : getGoalDays(durationDays);
    const hoursRecommendation = getRecommendedDailyHours({
        requestedHours: dailyAvailableHours,
        durationDays: planDurationDays,
        examDate: hasExamDate ? examDate : null
    });
    const dailyHours = hoursRecommendation.hours;
    const daysRemaining = planDurationDays;
    const durationSource = hasExamDate ? "exam-deadline" : (durationDays === undefined || durationDays === null ? "recommended" : "user");
    const totalAvailableHours = Math.round(daysRemaining * dailyHours * 10) / 10;
    const createdAt = new Date(referenceDate).toISOString();
    const startDate = createdAt.slice(0, 10);
    // Goal duration counts the start date as Day 1: seven days beginning
    // October 14 end on October 20.
    const goalEndDate = hasExamDate ? null : addUtcCalendarDays(startDate, planDurationDays - 1);

    // Calculate priority weights
    let totalWeight = 0;
    const subjectMap = {};

    for (const name of cleanSubjects) {
        let priorityVal = parsedPriorities[name];
        if (!priorityVal) {
            const cleanName = cleanSubjectName(name).toLowerCase();
            for (const [pk, pv] of Object.entries(parsedPriorities)) {
                if (cleanSubjectName(pk).toLowerCase() === cleanName) {
                    priorityVal = pv;
                    break;
                }
            }
        }
        if (priorityVal) {
            const cleanPrio = String(priorityVal).trim().toLowerCase();
            if (!ALLOWED_PRIORITIES.includes(cleanPrio)) {
                throw new Error(`Invalid priority "${priorityVal}" for subject "${name}". Allowed priorities: high, medium, low.`);
            }
        }
        const priorityLevel = (priorityVal || "medium").toLowerCase();
        const weight = PRIORITY_WEIGHTS[priorityLevel] || PRIORITY_WEIGHTS.medium;
        totalWeight += weight;
        subjectMap[name] = {
            priority: priorityLevel,
            weight
        };
    }

    // Allocate hours proportional to weights
    let allocatedSum = 0;
    const subjectsData = {};

    cleanSubjects.forEach((name, index) => {
        const item = subjectMap[name];
        let hours;
        if (index === cleanSubjects.length - 1) {
            // Allocate remainder to avoid rounding drift
            hours = Math.max(0, Math.round((totalAvailableHours - allocatedSum) * 10) / 10);
        } else {
            hours = Math.max(0, Math.round(((item.weight / totalWeight) * totalAvailableHours) * 10) / 10);
            allocatedSum += hours;
        }

        subjectsData[name] = {
            priority: item.priority,
            weight: item.weight,
            allocatedHours: hours,
            completedHours: 0,
            missedHours: 0,
            remainingHours: hours,
            progressPercentage: 0
        };
    });

    return {
        planId,
        createdAt,
        startDate,
        examDate: hasExamDate ? examDate : null,
        durationDays: planDurationDays,
        durationSource,
        goalEndDate,
        dailyHoursSource: hoursRecommendation.source,
        daysRemaining,
        dailyAvailableHours: dailyHours,
        availableCapacityHours: totalAvailableHours,
        totalAvailableHours,
        totalAllocatedHours: Object.values(subjectsData).reduce((acc, s) => acc + s.allocatedHours, 0),
        totalCompletedHours: 0,
        totalMissedHours: 0,
        totalRemainingHours: Object.values(subjectsData).reduce((acc, s) => acc + s.allocatedHours, 0),
        overallProgressPercentage: 0,
        subjects: subjectsData,
        sessions: [],
        adaptationHistory: []
    };
}

/**
 * Normalizes an existing study plan to ensure all accounting invariants hold:
 * 1. Missed sessions record explicit missedHours matching subject/plan missed accounting.
 * 2. Completed sessions record explicit hoursSpent.
 * 3. Plan totals and capacity figures are synchronized.
 */
export function normalizePlan(plan) {
    if (!plan || !plan.subjects) return plan;

    if (Array.isArray(plan.sessions)) {
        for (const sess of plan.sessions) {
            const sub = plan.subjects[sess.subject];
            const isMissed = sess.status === "missed";

            if (isMissed) {
                if (sess.missedHours === undefined || sess.missedHours === null) {
                    sess.missedHours = sess.hoursSpent > 0
                        ? sess.hoursSpent
                        : (sub?.missedHours && sub.missedHours > 0 ? sub.missedHours : DEFAULT_MISSED_SESSION_HOURS);
                }
                if (sess.scheduledHours === undefined || sess.scheduledHours === null) {
                    sess.scheduledHours = sess.missedHours;
                }
            } else {
                if (sess.missedHours === undefined || sess.missedHours === null) {
                    sess.missedHours = 0;
                }
                if (sess.scheduledHours === undefined || sess.scheduledHours === null) {
                    sess.scheduledHours = sess.hoursSpent || 0;
                }
            }
        }
    }

    refreshPlanTotals(plan);
    return plan;
}

/**
 * Records a study session (completed or missed) and updates metrics
 *
 * Missed Session Accounting Rule:
 * - hoursSpent: indicates actual study time spent (typically 0 when missed).
 * - missedHours: indicates the amount of the intended session that was missed.
 * - scheduledHours: indicates the full intended session duration and can differ
 *   from missedHours (for example, 1 missed hour in a 2-hour scheduled session).
 *   For fully missed sessions, omitted values default from each other and then to
 *   DEFAULT_MISSED_SESSION_HOURS (2.0 hours).
 * - Corresponding data: missedHours is recorded directly on the sessionRecord in plan.sessions,
 *   guaranteeing subject.missedHours and plan.totalMissedHours equal the sum of missed session records.
 */
export function recordSession(plan, {
    subject,
    hoursSpent = 0,
    missedHours = null,
    scheduledHours = null,
    status = "completed",
    notes = "",
    date = new Date().toISOString().split("T")[0]
}) {
    if (!plan || !plan.subjects) {
        throw new Error("Invalid plan provided.");
    }

    normalizePlan(plan);

    const cleanSubject = resolvePlanSubject(plan, subject) || String(subject).trim();
    let targetSubject = plan.subjects[cleanSubject];

    // If subject was not originally defined, dynamically initialize it
    if (!targetSubject) {
        plan.subjects[cleanSubject] = {
            priority: "medium",
            weight: 2,
            allocatedHours: Number(hoursSpent) || DEFAULT_MISSED_SESSION_HOURS,
            completedHours: 0,
            missedHours: 0,
            remainingHours: Number(hoursSpent) || DEFAULT_MISSED_SESSION_HOURS,
            progressPercentage: 0
        };
        targetSubject = plan.subjects[cleanSubject];
    }

    const hours = Number(hoursSpent) || 0;
    const normalizedStatus = status.toLowerCase();

    if (!Number.isFinite(Number(hoursSpent)) || hours < 0) {
        throw new Error("hoursSpent must be a finite, non-negative number.");
    }
    if (scheduledHours !== null && scheduledHours !== undefined && (!Number.isFinite(Number(scheduledHours)) || Number(scheduledHours) <= 0)) {
        throw new Error("scheduledHours must be a finite, positive number when provided.");
    }
    if (missedHours !== null && missedHours !== undefined && (!Number.isFinite(Number(missedHours)) || Number(missedHours) <= 0)) {
        throw new Error("missedHours must be a finite, positive number when provided.");
    }

    let sessionMissedHours = 0;
    let sessionScheduledHours = scheduledHours !== null && scheduledHours !== undefined ? Number(scheduledHours) : 0;

    if (normalizedStatus === "missed") {
        if (hours !== 0) {
            throw new Error("hoursSpent must be 0 for a missed session.");
        }
        if (!sessionScheduledHours && missedHours !== null && missedHours !== undefined) {
            sessionScheduledHours = Number(missedHours);
        }
        if (!sessionScheduledHours) {
            sessionScheduledHours = DEFAULT_MISSED_SESSION_HOURS;
        }
        sessionMissedHours = missedHours !== null && missedHours !== undefined
            ? Number(missedHours)
            : sessionScheduledHours;
        if (sessionMissedHours > sessionScheduledHours) {
            throw new Error("missedHours cannot exceed scheduledHours.");
        }
    } else {
        if (missedHours !== null && missedHours !== undefined && Number(missedHours) > 0) {
            throw new Error("missedHours can only be set for a missed session.");
        }
        if (!sessionScheduledHours) {
            sessionScheduledHours = hours;
        }
    }

    const sessionRecord = {
        id: `sess_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        date,
        subject: cleanSubject,
        hoursSpent: hours,
        missedHours: sessionMissedHours,
        scheduledHours: sessionScheduledHours,
        status: normalizedStatus,
        notes: notes || "",
        timestamp: new Date().toISOString()
    };

    plan.sessions.push(sessionRecord);

    if (normalizedStatus === "completed" || normalizedStatus === "partially_completed") {
        targetSubject.completedHours = Math.round((targetSubject.completedHours + hours) * 10) / 10;
        targetSubject.remainingHours = Math.max(0, Math.round((targetSubject.allocatedHours - targetSubject.completedHours) * 10) / 10);
    } else if (normalizedStatus === "missed") {
        targetSubject.missedHours = Math.round((targetSubject.missedHours + sessionMissedHours) * 10) / 10;
        targetSubject.unadaptedMissedHours = Math.round(((targetSubject.unadaptedMissedHours || 0) + sessionMissedHours) * 10) / 10;
    }

    // Update progress percentages
    if (targetSubject.allocatedHours > 0) {
        targetSubject.progressPercentage = Math.min(100, Math.round((targetSubject.completedHours / targetSubject.allocatedHours) * 100));
    }

    // Refresh plan-level totals
    refreshPlanTotals(plan);

    return {
        session: sessionRecord,
        updatedSubject: targetSubject,
        planSummary: {
            totalCompletedHours: plan.totalCompletedHours,
            totalMissedHours: plan.totalMissedHours,
            totalRemainingHours: plan.totalRemainingHours,
            overallProgressPercentage: plan.overallProgressPercentage
        }
    };
}

/**
 * Supersedes one incorrectly recorded session with an audited correction.
 * The original entry and its original values remain in `sessions`; active
 * accounting applies only the delta between the old and corrected missed hours.
 * A stable correction ID makes retries idempotent.
 */
export function correctSessionRecord(plan, {
    sessionId,
    expectedOriginal,
    correctedSession,
    correctionId = `correction_${sessionId}`,
    correctedAt = new Date().toISOString()
}) {
    if (!plan || !Array.isArray(plan.sessions) || !plan.subjects) {
        throw new Error("Invalid plan provided for session correction.");
    }
    if (!sessionId || !expectedOriginal || !correctedSession || !correctionId) {
        throw new Error("Session correction requires an ID, expected original values, corrected values, and correction ID.");
    }

    const original = plan.sessions.find(session => session.id === sessionId);
    if (!original) throw new Error(`Session "${sessionId}" was not found.`);

    const existingCorrectionId = original.supersededBy;
    if (existingCorrectionId) {
        const existingCorrection = plan.sessions.find(session => session.id === existingCorrectionId);
        if (existingCorrection && existingCorrectionId === correctionId && existingCorrection.correctionOf === sessionId &&
            Object.entries(correctedSession).every(([key, value]) => existingCorrection[key] === value)) {
            return { session: existingCorrection, original, alreadyApplied: true };
        }
        throw new Error(`Session "${sessionId}" is already superseded by a different or inconsistent correction.`);
    }

    for (const [key, value] of Object.entries(expectedOriginal)) {
        if (original[key] !== value) {
            throw new Error(`Session "${sessionId}" does not match its expected original value for "${key}".`);
        }
    }
    if (plan.sessions.some(session => session.id === correctionId)) {
        throw new Error(`Correction session ID "${correctionId}" already exists without a matching supersession link.`);
    }

    const oldMissed = Number(original.missedHours || 0);
    const nextMissed = Number(correctedSession.missedHours);
    const scheduled = Number(correctedSession.scheduledHours);
    const correctionDate = String(correctedSession.date || "");
    const [year, month, day] = correctionDate.split("-").map(Number);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(correctionDate) &&
        Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) &&
        new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === correctionDate;
    if (original.status !== "missed" || correctedSession.status !== "missed" || original.subject !== correctedSession.subject ||
        !Number.isFinite(oldMissed) || oldMissed <= 0 || !Number.isFinite(nextMissed) || nextMissed <= 0 ||
        Number(correctedSession.hoursSpent) !== 0 || !Number.isFinite(scheduled) || scheduled < nextMissed || !validDate) {
        throw new Error("Correction must preserve the missed-session subject and provide valid date and hour values.");
    }

    const originalSnapshot = structuredClone(original);
    const targetSubject = plan.subjects[original.subject];
    if (!targetSubject) throw new Error(`Subject "${original.subject}" is missing from the plan.`);
    if ((Number(targetSubject.missedHours) || 0) < oldMissed) {
        throw new Error("Subject missed-hour total is smaller than the session being corrected.");
    }

    const corrected = {
        ...correctedSession,
        id: correctionId,
        notes: correctedSession.notes ?? original.notes ?? "",
        timestamp: correctedAt,
        correctionOf: sessionId
    };
    original.supersededBy = correctionId;
    original.correction = {
        type: "superseded",
        correctedAt,
        supersededBy: correctionId,
        originalValues: originalSnapshot
    };
    plan.sessions.push(corrected);

    targetSubject.missedHours = Math.round(((Number(targetSubject.missedHours) || 0) - oldMissed + nextMissed) * 10) / 10;
    if (targetSubject.unadaptedMissedHours !== undefined) {
        targetSubject.unadaptedMissedHours = Math.max(0, Math.round(((Number(targetSubject.unadaptedMissedHours) || 0) - oldMissed + nextMissed) * 10) / 10);
    }
    refreshPlanTotals(plan);
    return { session: corrected, original, alreadyApplied: false };
}

/** Number of records that are active for session-count reporting. */
export function getActiveSessionCount(plan) {
    return Array.isArray(plan?.sessions) ? plan.sessions.filter(session => !session.supersededBy).length : 0;
}

/**
 * Re-balances remaining schedule and adapts study plan based on actual pace and missed sessions.
 *
 * Capacity & Allocation Invariants:
 * 1. availableHoursCapacity = daysRemaining * dailyAvailableHours (capacity available for remaining study).
 * 2. If totalNeededHours <= availableHoursCapacity, remaining workload is allocated exactly.
 * 3. If totalNeededHours > availableHoursCapacity (constrained capacity), the available capacity
 *    is allocated across subjects according to priority weights and deficit share, so that
 *    sum(remainingHours) === availableHoursCapacity.
 * 4. totalAllocatedHours === totalCompletedHours + totalRemainingHours.
 * 5. capacityWarning accurately reflects actual remaining workload vs available capacity.
 */
export function adaptPlan(plan, {
    reason = "Automatic progress adaptation",
    newExamDate = null,
    newDailyAvailableHours = null,
    referenceDate = new Date()
} = {}) {
    if (!plan || !plan.subjects) {
        throw new Error("Invalid plan provided for adaptation.");
    }

    normalizePlan(plan);

    const previousAllocations = {};
    for (const [name, sub] of Object.entries(plan.subjects)) {
        previousAllocations[name] = {
            allocatedHours: sub.allocatedHours,
            remainingHours: sub.remainingHours
        };
    }

    if (newExamDate !== undefined && newExamDate !== null) {
        // Validate before mutating the plan. Empty and malformed values must not be
        // treated as an omitted optional field.
        calculateDaysRemaining(newExamDate, referenceDate);
        plan.examDate = newExamDate;
    }
    if (newDailyAvailableHours !== undefined && newDailyAvailableHours !== null) {
        const hours = Number(newDailyAvailableHours);
        const { min, max } = getDailyStudyHourBounds();
        if (!Number.isFinite(hours) || hours < min || hours > max) {
            throw new Error(`newDailyAvailableHours must be between ${min} and ${max}.`);
        }
        plan.dailyAvailableHours = hours;
    }

    const derivedGoalEndDate = !plan.examDate && !plan.goalEndDate && typeof plan.createdAt === "string"
        ? addUtcCalendarDays(plan.startDate || plan.createdAt.slice(0, 10), getGoalDays(plan.durationDays) - 1)
        : null;
    const daysRemaining = plan.examDate
        ? calculateDaysRemaining(plan.examDate, referenceDate)
        : ((plan.goalEndDate || derivedGoalEndDate)
            ? calculateDaysRemaining(plan.goalEndDate || derivedGoalEndDate, referenceDate, { includeReferenceDate: true })
            : getGoalDays(plan.durationDays));
    plan.daysRemaining = daysRemaining;

    const availableHoursCapacity = Math.round(daysRemaining * plan.dailyAvailableHours * 10) / 10;
    plan.availableCapacityHours = availableHoursCapacity;

    // Calculate total required remaining hours
    let totalNeededHours = 0;
    const subjectDeficits = {};

    for (const [name, sub] of Object.entries(plan.subjects)) {
        // Base remaining is target - completed
        let remaining = Math.max(0, Math.round((sub.allocatedHours - sub.completedHours) * 10) / 10);

        // If there were unadapted missed hours, add them to needed hours as backlog recovery
        const missedBacklog = sub.unadaptedMissedHours !== undefined ? sub.unadaptedMissedHours : 0;
        if (missedBacklog > 0) {
            remaining = Math.round((remaining + missedBacklog) * 10) / 10;
        }

        subjectDeficits[name] = remaining;
        totalNeededHours += remaining;
    }
    totalNeededHours = Math.round(totalNeededHours * 10) / 10;

    const isOverCapacity = totalNeededHours > availableHoursCapacity;

    // Determine recommended daily study pace
    const paceRequired = totalNeededHours / daysRemaining;
    let recommendedDailyHours = Math.round(paceRequired * 10) / 10;
    if (isOverCapacity) {
        const ceilDaily = Math.ceil(paceRequired * 10) / 10;
        recommendedDailyHours = Math.max(ceilDaily, Math.round((plan.dailyAvailableHours + 0.1) * 10) / 10);
    }

    // Adjust subject allocations according to priorities and remaining load
    let totalWeight = 0;
    for (const sub of Object.values(plan.subjects)) {
        totalWeight += sub.weight || 2;
    }

    const subjectNames = Object.keys(plan.subjects);

    if (isOverCapacity) {
        // Capacity is constrained: allocate availableHoursCapacity across subjects
        // balancing deficit share (70%) and priority weight share (30%)
        let allocatedRemainingSum = 0;

        subjectNames.forEach((name, index) => {
            const sub = plan.subjects[name];
            const deficit = subjectDeficits[name] || 0;
            const deficitShare = totalNeededHours > 0 ? (deficit / totalNeededHours) : (1 / subjectNames.length);
            const weightShare = (sub.weight || 2) / (totalWeight || 1);
            const blendedShare = (deficitShare * 0.7) + (weightShare * 0.3);

            let newRemaining;
            if (index === subjectNames.length - 1) {
                // Remainder ensures sum of newRemaining === availableHoursCapacity exactly
                newRemaining = Math.max(1, Math.round((availableHoursCapacity - allocatedRemainingSum) * 10) / 10);
            } else {
                newRemaining = Math.max(1, Math.round((availableHoursCapacity * blendedShare) * 10) / 10);
                allocatedRemainingSum += newRemaining;
            }

            sub.remainingHours = newRemaining;
            sub.allocatedHours = Math.round((sub.completedHours + newRemaining) * 10) / 10;
            sub.unadaptedMissedHours = 0;
            sub.progressPercentage = sub.allocatedHours > 0
                ? Math.min(100, Math.round((sub.completedHours / sub.allocatedHours) * 100))
                : 100;
        });
    } else {
        // Within capacity: allocate exact deficit to each subject
        subjectNames.forEach(name => {
            const sub = plan.subjects[name];
            const deficit = subjectDeficits[name] || 0;
            sub.remainingHours = Math.round(deficit * 10) / 10;
            sub.allocatedHours = Math.round((sub.completedHours + sub.remainingHours) * 10) / 10;
            sub.unadaptedMissedHours = 0;
            sub.progressPercentage = sub.allocatedHours > 0
                ? Math.min(100, Math.round((sub.completedHours / sub.allocatedHours) * 100))
                : 100;
        });
    }

    refreshPlanTotals(plan);

    const capacityWarning = isOverCapacity
        ? `Remaining study workload (${totalNeededHours}h) exceeds available capacity (${availableHoursCapacity}h). Schedule allocates ${availableHoursCapacity}h. Recommended daily hours: ${recommendedDailyHours}h.`
        : null;

    const adaptationEntry = {
        id: `adapt_${Date.now()}`,
        timestamp: new Date().toISOString(),
        reason,
        daysRemaining,
        availableCapacityHours: availableHoursCapacity,
        totalNeededHours,
        totalRemainingHours: plan.totalRemainingHours,
        recommendedDailyHours,
        capacityWarning,
        previousAllocations,
        newAllocations: Object.fromEntries(
            Object.entries(plan.subjects).map(([k, v]) => [k, { allocatedHours: v.allocatedHours, remainingHours: v.remainingHours }])
        )
    };

    plan.adaptationHistory.push(adaptationEntry);

    return {
        plan,
        adaptation: adaptationEntry
    };
}

/**
 * Recomputes top-level totals on the plan object and enforces accounting consistency
 */
export function refreshPlanTotals(plan) {
    let completed = 0;
    let missed = 0;
    let remaining = 0;
    let allocated = 0;

    for (const sub of Object.values(plan.subjects)) {
        completed += sub.completedHours || 0;
        missed += sub.missedHours || 0;
        remaining += sub.remainingHours || 0;
        allocated += sub.allocatedHours || 0;
    }

    plan.totalCompletedHours = Math.round(completed * 10) / 10;
    plan.totalMissedHours = Math.round(missed * 10) / 10;
    plan.totalRemainingHours = Math.round(remaining * 10) / 10;
    plan.totalAllocatedHours = Math.round(allocated * 10) / 10;


    if (plan.daysRemaining && plan.dailyAvailableHours) {
        const remainingCapacity = Math.round(plan.daysRemaining * plan.dailyAvailableHours * 10) / 10;
        plan.availableCapacityHours = remainingCapacity;
        plan.totalAvailableHours = remainingCapacity;
    }


    plan.overallProgressPercentage = plan.totalAllocatedHours > 0
        ? Math.min(100, Math.round((plan.totalCompletedHours / plan.totalAllocatedHours) * 100))
        : 0;
}

