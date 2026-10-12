/**
 * StudyPilot Planning Engine
 * Core algorithms for study schedule generation, progress tracking, and adaptive rescheduling.
 */

export const DEFAULT_MISSED_SESSION_HOURS = 2;

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
 * Calculates days between today and target date
 */
export function calculateDaysRemaining(targetDateStr, referenceDate = new Date()) {
    if (!targetDateStr || typeof targetDateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(targetDateStr.trim())) {
        throw new Error(`Invalid exam date format: "${targetDateStr}". Please use YYYY-MM-DD.`);
    }

    const target = new Date(targetDateStr.trim());
    if (Number.isNaN(target.getTime())) {
        throw new Error(`Invalid exam date format: "${targetDateStr}". Please use YYYY-MM-DD.`);
    }

    const today = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    if (Number.isNaN(today.getTime())) {
        throw new Error("Invalid reference date provided.");
    }

    // Parse YYYY-MM-DD components directly to avoid timezone shift
    const [tYear, tMonth, tDay] = targetDateStr.trim().split("-").map(Number);
    const utcTarget = Date.UTC(tYear, tMonth - 1, tDay);
    const utcToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());

    const diffDays = Math.round((utcTarget - utcToday) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) {
        throw new Error("Exam date cannot be in the past.");
    }

    return Math.max(1, diffDays);
}

/**
 * Generates an initial study plan
 */
export function createPlan({
    planId = "default",
    subjects,
    examDate,
    dailyAvailableHours = 3,
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

    const dailyHours = Number(dailyAvailableHours);
    if (!Number.isFinite(dailyHours) || dailyHours <= 0) {
        throw new Error("dailyAvailableHours must be a positive number.");
    }

    const daysRemaining = calculateDaysRemaining(examDate, referenceDate);
    const totalAvailableHours = Math.round(daysRemaining * dailyHours * 10) / 10;

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
            hours = Math.max(1, Math.round((totalAvailableHours - allocatedSum) * 10) / 10);
        } else {
            hours = Math.max(1, Math.round(((item.weight / totalWeight) * totalAvailableHours) * 10) / 10);
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
        createdAt: new Date().toISOString(),
        examDate,
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
 * - missedHours: indicates scheduled session duration that was missed.
 *   If scheduledHours (or positive hoursSpent) is provided, that duration is used.
 *   Otherwise, defaults to DEFAULT_MISSED_SESSION_HOURS (2.0 hours).
 * - Corresponding data: missedHours is recorded directly on the sessionRecord in plan.sessions,
 *   guaranteeing subject.missedHours and plan.totalMissedHours equal the sum of missed session records.
 */
export function recordSession(plan, {
    subject,
    hoursSpent = 0,
    scheduledHours = null,
    status = "completed",
    notes = "",
    date = new Date().toISOString().split("T")[0]
}) {
    if (!plan || !plan.subjects) {
        throw new Error("Invalid plan provided.");
    }

    normalizePlan(plan);

    const cleanSubject = String(subject).trim();
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

    let sessionMissedHours = 0;
    let sessionScheduledHours = scheduledHours !== null && scheduledHours !== undefined ? Number(scheduledHours) : 0;

    if (normalizedStatus === "missed") {
        if (sessionScheduledHours > 0) {
            sessionMissedHours = sessionScheduledHours;
        } else if (hours > 0) {
            sessionMissedHours = hours;
            sessionScheduledHours = hours;
        } else {
            sessionMissedHours = DEFAULT_MISSED_SESSION_HOURS;
            sessionScheduledHours = DEFAULT_MISSED_SESSION_HOURS;
        }
    } else {
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

    if (newExamDate) {
        plan.examDate = newExamDate;
    }
    if (newDailyAvailableHours) {
        plan.dailyAvailableHours = Number(newDailyAvailableHours);
    }

    const daysRemaining = calculateDaysRemaining(plan.examDate, referenceDate);
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

