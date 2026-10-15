import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadAllPlans } from "./storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getQuizFilePath() {
    const dataDir = process.env.STUDYPILOT_DATA_DIR
        ? path.resolve(process.cwd(), process.env.STUDYPILOT_DATA_DIR)
        : path.resolve(__dirname, "data");
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    return path.join(dataDir, "studypilot_quizzes.json");
}

function loadQuizData() {
    const file = getQuizFilePath();
    if (!fs.existsSync(file)) {
        return { quizzes: {}, results: [] };
    }
    try {
        const raw = fs.readFileSync(file, "utf-8");
        return JSON.parse(raw) || { quizzes: {}, results: [] };
    } catch {
        return { quizzes: {}, results: [] };
    }
}

function saveQuizData(data) {
    const file = getQuizFilePath();
    const tmp = `${file}.${process.pid}_${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, file);
}

// Built-in curated question bank for common disciplines
const QUESTION_BANK = {
    javascript: [
        {
            question: "What is the primary characteristic of a closure in JavaScript?",
            options: [
                "A function bundled together with references to its lexical environment",
                "A method to close browser tabs programmatically",
                "A strict syntax mode for preventing global variables",
                "A loop termination construct"
            ],
            correctIndex: 0,
            explanation: "A closure gives an inner function access to an outer function's scope even after the outer function has executed."
        },
        {
            question: "Which of the following creates a microtask in the JavaScript Event Loop?",
            options: [
                "setTimeout callback",
                "Promise.then() callback",
                "setInterval callback",
                "requestAnimationFrame callback"
            ],
            correctIndex: 1,
            explanation: "Promise reactions (.then, .catch, .finally) and queueMicrotask execute in the microtask queue before macrotasks."
        },
        {
            question: "What is the result of typeof NaN in JavaScript?",
            options: [
                "'nan'",
                "'undefined'",
                "'number'",
                "'object'"
            ],
            correctIndex: 2,
            explanation: "In JavaScript, NaN ('Not a Number') is of type 'number' according to the IEEE 754 floating-point standard."
        }
    ],
    dbms: [
        {
            question: "Which normal form requires the elimination of transitive functional dependencies?",
            options: [
                "First Normal Form (1NF)",
                "Second Normal Form (2NF)",
                "Third Normal Form (3NF)",
                "Boyce-Codd Normal Form (BCNF)"
            ],
            correctIndex: 2,
            explanation: "3NF requires a relation to be in 2NF and have no non-prime attribute transitively dependent on any candidate key."
        },
        {
            question: "In ACID properties of transactions, what does 'Atomicity' guarantee?",
            options: [
                "All operations within a transaction succeed completely or none take effect",
                "The database remains in a consistent state before and after execution",
                "Concurrent transactions execute without interfering with one another",
                "Committed changes survive system crashes"
            ],
            correctIndex: 0,
            explanation: "Atomicity is the 'all-or-nothing' property ensuring partial transaction executions never persist."
        },
        {
            question: "Which index structure is most widely utilized in relational databases for range queries?",
            options: [
                "Hash Index",
                "B+ Tree Index",
                "Inverted Index",
                "Bitmap Index"
            ],
            correctIndex: 1,
            explanation: "B+ trees store all data pointers in leaf nodes linked sequentially, making range scans $O(\\log n + k)$."
        }
    ],
    operatingsystems: [
        {
            question: "Which condition is NOT one of the four Coffman conditions required for a deadlock?",
            options: [
                "Mutual Exclusion",
                "Hold and Wait",
                "Preemption Allowed",
                "Circular Wait"
            ],
            correctIndex: 2,
            explanation: "The condition is 'No Preemption'. If preemption is allowed, deadlock cannot form."
        },
        {
            question: "What is thrashing in virtual memory systems?",
            options: [
                "A state where the CPU spends more time swapping pages than executing user processes",
                "A virus destroying disk partition tables",
                "Memory leaks causing out-of-memory crashes",
                "Hardware cache failure in L1 cache"
            ],
            correctIndex: 0,
            explanation: "Thrashing occurs when total working set sizes exceed physical RAM, causing constant page fault overhead."
        }
    ],
    datastructures: [
        {
            question: "What is the worst-case time complexity of QuickSort without randomized pivot selection?",
            options: [
                "O(n log n)",
                "O(n)",
                "O(n^2)",
                "O(log n)"
            ],
            correctIndex: 2,
            explanation: "When the pivot selected is consistently the minimum or maximum element (e.g. sorted array), recursion depth is $n$, giving $O(n^2)$."
        },
        {
            question: "Which data structure is inherently used by Breadth-First Search (BFS)?",
            options: [
                "Stack (LIFO)",
                "Queue (FIFO)",
                "Priority Queue",
                "Hash Map"
            ],
            correctIndex: 1,
            explanation: "BFS explores neighboring vertices level-by-level using a First-In-First-Out Queue."
        }
    ]
};

/**
 * Creates a structured quiz for a subject or topic.
 */
export function createQuiz({ subject, topic = "", questionCount = 3, difficulty = "intermediate" }) {
    if (!subject || typeof subject !== "string") {
        throw new Error("Parameter 'subject' is required and must be a string.");
    }

    const cleanSubject = subject.trim();
    const cleanTopic = (topic || "").trim();
    const count = Math.max(1, Math.min(Number(questionCount) || 3, 10));
    const normalizedKey = cleanSubject.toLowerCase().replace(/[^a-z0-9]/g, "");

    let pool = QUESTION_BANK[normalizedKey];
    if (!pool && normalizedKey.includes("script")) pool = QUESTION_BANK.javascript;
    if (!pool && (normalizedKey.includes("os") || normalizedKey.includes("system"))) pool = QUESTION_BANK.operatingsystems;
    if (!pool && (normalizedKey.includes("database") || normalizedKey.includes("sql"))) pool = QUESTION_BANK.dbms;
    if (!pool && (normalizedKey.includes("algo") || normalizedKey.includes("structure"))) pool = QUESTION_BANK.datastructures;

    const questions = [];
    if (pool && pool.length > 0) {
        for (let i = 0; i < count; i++) {
            const item = pool[i % pool.length];
            questions.push({
                questionId: `q_${i + 1}`,
                question: item.question,
                options: item.options,
                correctOptionIndex: item.correctIndex,
                explanation: item.explanation
            });
        }
    } else {
        // Procedural questions for any custom subject
        const topicLabel = cleanTopic ? `${cleanTopic} in ${cleanSubject}` : cleanSubject;
        questions.push(
            {
                questionId: "q_1",
                question: `What is the core conceptual foundation of ${topicLabel}?`,
                options: [
                    `The fundamental principles and operational rules defining ${topicLabel}`,
                    "A legacy syntax that has been deprecated",
                    "A hardware-specific machine instruction",
                    "An optional compiler flag"
                ],
                correctOptionIndex: 0,
                explanation: `Understanding the foundational principles of ${topicLabel} enables structured problem-solving.`
            },
            {
                questionId: "q_2",
                question: `Which approach is considered best practice when implementing ${topicLabel}?`,
                options: [
                    "Bypassing validation to optimize raw throughput",
                    "Modular structure with boundary condition checks",
                    "Hardcoding static parameters throughout the codebase",
                    "Eliminating error handling constructs"
                ],
                correctOptionIndex: 1,
                explanation: "Modular structure and robust boundary validation are universally recommended best practices."
            },
            {
                questionId: "q_3",
                question: `How does ${topicLabel} typically impact runtime or architectural efficiency?`,
                options: [
                    "It has no measurable influence on performance",
                    "Proper design balances computational complexity against memory allocation",
                    "It guarantees linear scaling regardless of input bounds",
                    "It always triples the memory footprint"
                ],
                correctOptionIndex: 1,
                explanation: "Optimal implementations carefully balance time complexity and memory overhead."
            }
        );
    }

    const quizId = `quiz-${cleanSubject.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 16)}-${randomUUID().slice(0, 8)}`;
    const quizRecord = {
        quizId,
        subject: cleanSubject,
        topic: cleanTopic || cleanSubject,
        difficulty,
        questionCount: questions.length,
        createdAt: new Date().toISOString(),
        questions
    };

    const data = loadQuizData();
    data.quizzes[quizId] = quizRecord;
    saveQuizData(data);

    return quizRecord;
}

/**
 * Saves a completed quiz result and evaluates mastery.
 */
export function saveQuizResult({ quizId, subject, topic, score, totalQuestions, answers = [] }) {
    if (!subject || typeof subject !== "string") {
        throw new Error("Parameter 'subject' is required.");
    }
    const total = Number(totalQuestions);
    const earned = Number(score);

    if (!Number.isFinite(total) || total <= 0) {
        throw new Error("Parameter 'totalQuestions' must be a positive number.");
    }
    if (!Number.isFinite(earned) || earned < 0 || earned > total) {
        throw new Error(`Parameter 'score' must be between 0 and ${total}. Received: ${score}`);
    }

    const percentage = Math.round((earned / total) * 100);
    const passed = percentage >= 70;
    const weakTopicDetected = percentage < 70;

    const resultRecord = {
        resultId: `res-${randomUUID().slice(0, 8)}`,
        quizId: quizId || null,
        subject: subject.trim(),
        topic: (topic || subject).trim(),
        score: earned,
        totalQuestions: total,
        percentage,
        status: passed ? "passed" : "needs_improvement",
        weakTopicDetected,
        recordedAt: new Date().toISOString()
    };

    const data = loadQuizData();
    data.results.push(resultRecord);
    saveQuizData(data);

    return {
        message: `Quiz result recorded for ${resultRecord.subject} (${resultRecord.topic}): ${earned}/${total} (${percentage}%). Status: ${resultRecord.status}.`,
        resultId: resultRecord.resultId,
        subject: resultRecord.subject,
        topic: resultRecord.topic,
        score: earned,
        totalQuestions: total,
        percentage: `${percentage}%`,
        status: resultRecord.status,
        weakTopicDetected
    };
}

/**
 * Identifies weak topics based on quiz scores and missed plan study sessions.
 */
export function getWeakTopics({ planId, subject: filterSubject } = {}) {
    const quizData = loadQuizData();
    const plans = loadAllPlans();
    const weakTopicsMap = new Map();

    // 1. Analyze quiz results for low scores (<70%)
    for (const res of quizData.results || []) {
        if (filterSubject && res.subject.toLowerCase() !== filterSubject.toLowerCase()) continue;
        if (res.percentage < 70) {
            const key = `${res.subject}:${res.topic}`;
            const existing = weakTopicsMap.get(key) || {
                subject: res.subject,
                topic: res.topic,
                reasons: [],
                recentQuizScore: `${res.percentage}%`,
                recommendation: `Score was ${res.percentage}%. Revisit fundamental concepts and take another practice quiz.`
            };
            existing.reasons.push(`Low quiz score: ${res.score}/${res.totalQuestions} (${res.percentage}%)`);
            weakTopicsMap.set(key, existing);
        }
    }

    // 2. Analyze study plans for missed sessions or low progress
    const plansToScan = planId && plans[planId] ? { [planId]: plans[planId] } : plans;
    for (const [pId, plan] of Object.entries(plansToScan)) {
        for (const [subName, subInfo] of Object.entries(plan.subjects || {})) {
            if (filterSubject && subName.toLowerCase() !== filterSubject.toLowerCase()) continue;
            if (subInfo.missedHours > 0) {
                const key = `${subName}:${subName}`;
                const existing = weakTopicsMap.get(key) || {
                    subject: subName,
                    topic: subName,
                    reasons: [],
                    recommendation: `Allocate ${subInfo.missedHours} catch-up hours using StudyPilot schedule adaptation.`
                };
                existing.reasons.push(`Accumulated ${subInfo.missedHours} missed study hours in plan ${pId}.`);
                weakTopicsMap.set(key, existing);
            }
        }
    }

    const list = Array.from(weakTopicsMap.values());
    return {
        weakTopics: list,
        count: list.length,
        summary: list.length === 0
            ? "No weak topics detected! Your study sessions and quiz mastery are currently on track."
            : `Identified ${list.length} area(s) needing attention or catch-up revision.`
    };
}

/**
 * Returns aggregated study progress across plans or for a specific plan.
 */
export function getStudyProgress({ planId } = {}) {
    const plans = loadAllPlans();
    const quizData = loadQuizData();

    if (planId) {
        const plan = plans[planId];
        if (!plan) {
            throw new Error(`No study plan found with ID "${planId}".`);
        }
        return {
            planId,
            examDate: plan.examDate || null,
            durationDays: plan.durationDays || plan.daysRemaining,
            overallProgress: `${plan.overallProgressPercentage || 0}%`,
            totalAllocatedHours: plan.totalAllocatedHours,
            totalCompletedHours: plan.totalCompletedHours,
            totalRemainingHours: plan.totalRemainingHours,
            totalMissedHours: plan.totalMissedHours,
            subjects: plan.subjects,
            recentSessionsCount: (plan.sessions || []).length
        };
    }

    // Global summary across all plans
    const allPlans = Object.values(plans);
    const totalPlans = allPlans.length;
    let totalAllocatedHours = 0;
    let totalCompletedHours = 0;
    let totalRemainingHours = 0;
    let totalMissedHours = 0;

    for (const p of allPlans) {
        totalAllocatedHours += (p.totalAllocatedHours || 0);
        totalCompletedHours += (p.totalCompletedHours || 0);
        totalRemainingHours += (p.totalRemainingHours || 0);
        totalMissedHours += (p.totalMissedHours || 0);
    }

    const overallPct = totalAllocatedHours > 0
        ? Math.round((totalCompletedHours / totalAllocatedHours) * 100)
        : 0;

    const quizCount = quizData.results?.length || 0;
    const avgScore = quizCount > 0
        ? Math.round(quizData.results.reduce((acc, r) => acc + r.percentage, 0) / quizCount)
        : null;

    return {
        totalPlans,
        totalAllocatedHours: Math.round(totalAllocatedHours * 10) / 10,
        totalCompletedHours: Math.round(totalCompletedHours * 10) / 10,
        totalRemainingHours: Math.round(totalRemainingHours * 10) / 10,
        totalMissedHours: Math.round(totalMissedHours * 10) / 10,
        overallProgress: `${overallPct}%`,
        quizzesTaken: quizCount,
        averageQuizScore: avgScore !== null ? `${avgScore}%` : "No quizzes taken yet",
        activePlans: allPlans.map(p => ({
            planId: p.planId,
            subjects: Object.keys(p.subjects || {}),
            progress: `${p.overallProgressPercentage || 0}%`,
            daysRemaining: p.daysRemaining
        }))
    };
}

export function resetQuizData() {
    saveQuizData({ quizzes: {}, results: [] });
    return { success: true, message: "Quiz data reset successfully." };
}

