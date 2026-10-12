/**
 * StudyPilot Planning Engine
 * Core algorithms for study schedule generation, progress tracking, and adaptive rescheduling.
 */

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
 * Records a study session (completed or missed) and updates metrics
 */
export function recordSession(plan, {
    subject,
    hoursSpent = 0,
    status = "completed",
    notes = "",
    date = new Date().toISOString().split("T")[0]
}) {
    if (!plan || !plan.subjects) {
        throw new Error("Invalid plan provided.");
    }

    const cleanSubject = String(subject).trim();
    let targetSubject = plan.subjects[cleanSubject];

    // If subject was not originally defined, dynamically initialize it
    if (!targetSubject) {
        plan.subjects[cleanSubject] = {
            priority: "medium",
            weight: 2,
            allocatedHours: Number(hoursSpent) || 2,
            completedHours: 0,
            missedHours: 0,
            remainingHours: Number(hoursSpent) || 2,
            progressPercentage: 0
        };
        targetSubject = plan.subjects[cleanSubject];
    }

    const hours = Number(hoursSpent) || 0;
    const normalizedStatus = status.toLowerCase();

    const sessionRecord = {
        id: `sess_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        date,
        subject: cleanSubject,
        hoursSpent: hours,
        status: normalizedStatus,
        notes: notes || "",
        timestamp: new Date().toISOString()
    };

    plan.sessions.push(sessionRecord);

    if (normalizedStatus === "completed" || normalizedStatus === "partially_completed") {
        targetSubject.completedHours = Math.round((targetSubject.completedHours + hours) * 10) / 10;
        targetSubject.remainingHours = Math.max(0, Math.round((targetSubject.allocatedHours - targetSubject.completedHours) * 10) / 10);
    } else if (normalizedStatus === "missed") {
        const missedAmount = hours > 0 ? hours : 2; // Default 2 hours penalty if 0 given for missed
        targetSubject.missedHours = Math.round((targetSubject.missedHours + missedAmount) * 10) / 10;
        targetSubject.unadaptedMissedHours = Math.round(((targetSubject.unadaptedMissedHours || 0) + missedAmount) * 10) / 10;
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
 * Re-balances remaining schedule and adapts study plan based on actual pace and missed sessions
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
    plan.totalAvailableHours = availableHoursCapacity;

    // Calculate total required remaining hours
    let totalNeededHours = 0;
    const subjectDeficits = {};

    for (const [name, sub] of Object.entries(plan.subjects)) {
        // Base remaining is target - completed
        let remaining = Math.max(0, sub.allocatedHours - sub.completedHours);

        // If there were unadapted missed hours, add them to needed hours as backlog recovery
        const missedBacklog = sub.unadaptedMissedHours !== undefined ? sub.unadaptedMissedHours : (sub.missedHours || 0);
        if (missedBacklog > 0) {
            remaining += missedBacklog;
        }

        subjectDeficits[name] = remaining;
        totalNeededHours += remaining;
    }

    // Determine recommended daily study pace
    const recommendedDailyHours = Math.round((totalNeededHours / daysRemaining) * 10) / 10;
    const isOverCapacity = totalNeededHours > availableHoursCapacity;

    // Adjust subject allocations according to priorities and remaining load
    let totalWeight = 0;
    for (const sub of Object.values(plan.subjects)) {
        totalWeight += sub.weight || 2;
    }

    // Reallocate remaining hours across subjects
    for (const [name, sub] of Object.entries(plan.subjects)) {
        // New remaining hours balances subject deficit with priority weight
        const deficit = subjectDeficits[name] || 0;
        const weightShare = (sub.weight || 2) / totalWeight;

        // If capacity is constrained, balance proportionally
        let newRemaining;
        if (isOverCapacity) {
            // Allocate available hours based on weight & deficit
            newRemaining = Math.max(1, Math.round(((deficit * 0.7) + (availableHoursCapacity * weightShare * 0.3)) * 10) / 10);
        } else {
            newRemaining = Math.round(deficit * 10) / 10;
        }

        sub.remainingHours = newRemaining;
        sub.allocatedHours = Math.round((sub.completedHours + newRemaining) * 10) / 10;
        // Mark backlog as adapted while preserving historical missedHours on subject
        sub.unadaptedMissedHours = 0;
        sub.progressPercentage = sub.allocatedHours > 0
            ? Math.min(100, Math.round((sub.completedHours / sub.allocatedHours) * 100))
            : 100;
    }

    refreshPlanTotals(plan);

    const adaptationEntry = {
        id: `adapt_${Date.now()}`,
        timestamp: new Date().toISOString(),
        reason,
        daysRemaining,
        availableCapacityHours: availableHoursCapacity,
        totalRemainingHours: plan.totalRemainingHours,
        recommendedDailyHours,
        capacityWarning: isOverCapacity ? `Remaining study workload exceeds current daily schedule. Recommended daily hours: ${recommendedDailyHours}h.` : null,
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
 * Recomputes top-level totals on the plan object
 */
function refreshPlanTotals(plan) {
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

    plan.overallProgressPercentage = plan.totalAllocatedHours > 0
        ? Math.min(100, Math.round((plan.totalCompletedHours / plan.totalAllocatedHours) * 100))
        : 0;
}
