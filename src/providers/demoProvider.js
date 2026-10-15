import { BaseProvider } from "./baseProvider.js";
import { formatGroundedRetrievalSummary } from "../agent/consistencyChecker.js";
import { isEducationalTutoringIntent, isSessionRecordingIntent, extractExplicitPlanDayNumber } from "../agent/normalizer.js";

/**
 * Built-in Rule-Based / Demo AI Provider for StudyPilot.
 *
 * Allows the application to run fully functional out-of-the-box:
 * - Responds to greetings and general questions
 * - Formulates tool calls for creating study plans, recording sessions, and viewing progress
 * - Works completely offline without needing external Ollama or API keys
 */
export class DemoProvider extends BaseProvider {
    constructor(config = {}) {
        super(config);
        this.model = config.model || "studypilot-builtin";
    }

    async checkHealth() {
        return {
            available: true,
            provider: "demo",
            model: this.model,
            message: "StudyPilot built-in AI assistant is active."
        };
    }

    formatTools(tools = []) {
        return tools;
    }

    async chat({ messages = [], tools = [] }) {
        const userMsg = [...messages].reverse().find(message => message.role === "user")?.content || "";
        const lower = userMsg.toLowerCase();
        const previousAssistantReply = [...messages].reverse().find(message => message.role === "assistant")?.content || "";

        // 1. Check if the previous round executed tools
        const toolMsg = [...messages].reverse().find(m => m.role === "tool");
        if (toolMsg) {
            let parsed = null;
            try {
                parsed = JSON.parse(toolMsg.content);
            } catch {
                parsed = null;
            }

            if (parsed) {
                // Succeeded create_study_plan
                if (parsed.subjectAllocations) {
                    const originalUserMsg = [...messages].find(m => m.role === "user")?.content || "";
                    const hasSessionIntent = /\b(?:record|log|studied|missed|completed|did)\b.{0,40}\b(?:session|hour|hours|hrs|work)\b/i.test(originalUserMsg) ||
                        /\b(?:i studied|i missed|completed \d+ hours?)\b/i.test(originalUserMsg);
                    const alreadyRecorded = messages.some(m => m.role === "tool" && m.tool_name === "record_study_session");

                    if (hasSessionIntent && !alreadyRecorded) {
                        const isMissed = /\bmissed\b/i.test(originalUserMsg);
                        const hoursMatch = originalUserMsg.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/i);
                        const hours = hoursMatch ? parseFloat(hoursMatch[1]) : 2;
                        let subject = Object.keys(parsed.subjectAllocations)[0] || "Mathematics";
                        const common = ["mathematics", "physics", "chemistry", "biology", "history", "javascript", "react", "dbms", "english"];
                        for (const c of common) {
                            if (originalUserMsg.toLowerCase().includes(c)) {
                                subject = c.charAt(0).toUpperCase() + c.slice(1);
                                break;
                            }
                        }
                        return {
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                {
                                    id: `call_record_${Date.now()}`,
                                    name: "record_study_session",
                                    arguments: {
                                        planId: parsed.planId,
                                        subject,
                                        hoursSpent: isMissed ? 0 : hours,
                                        status: isMissed ? "missed" : "completed",
                                        notes: "Initial recorded session"
                                    }
                                }
                            ]
                        };
                    }

                    const subjects = Object.keys(parsed.subjectAllocations);
                    const breakdown = subjects.map(s => {
                        const info = parsed.subjectAllocations[s];
                        return `• ${s} (${info.priority}): ${info.allocatedHours} hours`;
                    }).join("\n");

                    return {
                        role: "assistant",
                        content: `I have created your study plan for ${subjects.join(", ")} (Plan ID: ${parsed.planId}).\n\nTotal allocated study time: ${parsed.totalAllocatedHours} hours.\n\nSubject breakdown:\n${breakdown}\n\nYou can now log study sessions or ask to check your progress anytime!`,
                        toolCalls: []
                    };
                }

                // Succeeded record_study_session
                if (parsed.session || parsed.subjectProgress) {
                    const originalUserMsg = [...messages].find(m => m.role === "user")?.content || "";
                    const hasRetrieval = /\b(?:show|view|inspect|get|retrieve|report|progress|status)\b.*?\b(?:plan|progress|details|workload)\b/i.test(originalUserMsg) ||
                        /\b(?:show my study plan progress|show my progress)\b/i.test(originalUserMsg);
                    const alreadyRetrieved = messages.some(m => m.role === "tool" && m.tool_name === "get_study_plan");

                    if (hasRetrieval && !alreadyRetrieved && (parsed.planId || parsed.session?.planId)) {
                        return {
                            role: "assistant",
                            content: "",
                            toolCalls: [
                                {
                                    id: `call_get_${Date.now()}`,
                                    name: "get_study_plan",
                                    arguments: {
                                        planId: parsed.planId || parsed.session?.planId
                                    }
                                }
                            ]
                        };
                    }

                    const sess = parsed.session || {};
                    const prog = parsed.subjectProgress || {};
                    const hadCreated = messages.some(m => {
                        try { return Boolean(JSON.parse(m.content)?.subjectAllocations); } catch { return false; }
                    });
                    const prefix = hadCreated ? "I have created your study plan and recorded your session!\n\n" : "";
                    return {
                        role: "assistant",
                        content: `${prefix}Recorded ${sess.hoursSpent || 0}h for ${sess.subject || "your session"} (status: ${sess.status || "completed"}).\nOverall plan progress: ${parsed.overallPlanProgress || "updated"}.\nSubject remaining hours: ${prog.remainingHours ?? "updated"}h.`,
                        toolCalls: []
                    };
                }

                // Succeeded get_study_plan
                if (parsed.subjects && parsed.planId) {
                    const originalUserMsg = [...messages].find(m => m.role === "user")?.content || "";
                    const grounded = formatGroundedRetrievalSummary(parsed, originalUserMsg);
                    return {
                        role: "assistant",
                        content: grounded || `Study Plan: ${parsed.planId}\nExam Date: ${parsed.examDate || "No exam date set"}\nOverall Progress: ${parsed.overallProgressPercentage ?? 0}%\nTotal Remaining Workload: ${parsed.totalRemainingHours ?? 0} hours.`,
                        toolCalls: []
                    };
                }

                // Succeeded adapt_study_plan
                if (parsed.adjustedSubjectAllocations) {
                    return {
                        role: "assistant",
                        content: `Your study plan has been adapted (${parsed.reason || "schedule adjustment"}).\nRecommended daily pace: ${parsed.dailyStudyHours || parsed.recommendedDailyStudyHours || 3} hours/day.\nTotal remaining workload: ${parsed.totalRemainingHours || "calculated"}h.`,
                        toolCalls: []
                    };
                }

                // Succeeded list_study_plans
                if (Array.isArray(parsed.plans)) {
                    if (parsed.plans.length === 0) {
                        return {
                            role: "assistant",
                            content: "You don't have any saved study plans yet. Ask me to create one (for example: \"Create a study plan for Mathematics and Physics with exam on 2026-12-31\").",
                            toolCalls: []
                        };
                    }
                    const summary = parsed.plans.map(p => `• ${p.planId} (${(p.subjects || []).join(", ")}) - Progress: ${p.overallProgress || "0%"}`).join("\n");
                    return {
                        role: "assistant",
                        content: `Here are your saved study plans:\n${summary}`,
                        toolCalls: []
                    };
                }

                // Succeeded create_quiz
                if (parsed.quizId && Array.isArray(parsed.questions)) {
                    const formattedQuestions = parsed.questions.map((q, idx) => {
                        const optLabels = ["A", "B", "C", "D"];
                        const optionsText = q.options.map((opt, oIdx) => `  ${optLabels[oIdx]}) ${opt}`).join("\n");
                        return `**Question ${idx + 1}:** ${q.question}\n${optionsText}`;
                    }).join("\n\n");
                    return {
                        role: "assistant",
                        content: `### 📝 Practice Quiz: ${parsed.subject} (${parsed.topic})\n**Difficulty:** ${parsed.difficulty} | **Questions:** ${parsed.questionCount}\n\n${formattedQuestions}\n\nReply with your answers (e.g. 1: A, 2: B, 3: C) or ask me to check your answers!`,
                        toolCalls: []
                    };
                }

                // Succeeded save_quiz_result
                if (parsed.score !== undefined && parsed.totalQuestions !== undefined) {
                    return {
                        role: "assistant",
                        content: `### 📊 Quiz Results Recorded\n• **Subject:** ${parsed.subject} (${parsed.topic})\n• **Score:** ${parsed.score}/${parsed.totalQuestions} (${parsed.percentage})\n• **Status:** ${parsed.status === "passed" ? "✅ Passed (Mastered)" : "⚠️ Needs Review"}\n\n${parsed.weakTopicDetected ? "This concept has been added to your weak topics for targeted revision." : "Great job mastering this topic!"}`,
                        toolCalls: []
                    };
                }

                // Succeeded get_weak_topics
                if (Array.isArray(parsed.weakTopics)) {
                    if (parsed.weakTopics.length === 0) {
                        return {
                            role: "assistant",
                            content: `### 🎯 Weak Topics Analysis\n\nAll clear! No weak topics detected across your study plans or quizzes. Keep up the consistent pace!`,
                            toolCalls: []
                        };
                    }
                    const items = parsed.weakTopics.map(w => `• **${w.subject}** (${w.topic}):\n  - ${w.reasons.join("\n  - ")}\n  - *Recommendation:* ${w.recommendation}`).join("\n\n");
                    return {
                        role: "assistant",
                        content: `### 🎯 Areas Needing Focus (${parsed.count})\n\n${items}`,
                        toolCalls: []
                    };
                }

                // Succeeded get_study_progress
                if (parsed.overallProgress !== undefined || parsed.totalAllocatedHours !== undefined) {
                    return {
                        role: "assistant",
                        content: `### 📈 Overall Study Progress\n• **Active Plans:** ${parsed.totalPlans || 1}\n• **Overall Completion:** ${parsed.overallProgress}\n• **Study Workload:** ${parsed.totalCompletedHours || 0}h completed / ${parsed.totalRemainingHours || 0}h remaining (${parsed.totalAllocatedHours || 0}h total)\n• **Missed Hours:** ${parsed.totalMissedHours || 0}h\n• **Quizzes Taken:** ${parsed.quizzesTaken || 0} (Average Score: ${parsed.averageQuizScore || "N/A"})`,
                        toolCalls: []
                    };
                }
            }

            return {
                role: "assistant",
                content: typeof toolMsg.content === "string" ? toolMsg.content : "The action has been processed.",
                toolCalls: []
            };
        }

function buildCurriculum(subject, level = "Beginner", dailyHours = 2, durationDays = 14, goal = "") {
    const s = (subject || "Programming").trim();
    const sLower = s.toLowerCase();
    const totalHours = Math.round(dailyHours * durationDays);

    let modules = [];
    if (/java\b/i.test(sLower)) {
        modules = [
            {
                title: "Module 1: Java Basics & Environment Setup",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "JVM, JRE & JDK architecture, basic syntax, variables, data types, and arithmetic/logical operators"
            },
            {
                title: "Module 2: Control Flow & Logic",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "Conditional logic (if-else, switch-case), loops (for, while, do-while), and break/continue statements"
            },
            {
                title: "Module 3: Methods, Scope & Arrays",
                duration: `${Math.max(2, Math.round(totalHours * 0.18))} hrs`,
                topics: "Writing reusable methods, parameter passing, return values, method overloading, and 1D/2D arrays"
            },
            {
                title: "Module 4: Object-Oriented Programming (OOP) Core",
                duration: `${Math.max(2, Math.round(totalHours * 0.22))} hrs`,
                topics: "Classes, Objects, Constructors, 'this' keyword, Encapsulation, Getters & Setters, and Access Modifiers"
            },
            {
                title: "Module 5: Advanced OOP & Interfaces",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "Inheritance ('extends', 'super'), Polymorphism (overriding), Abstract Classes, and Interfaces"
            },
            {
                title: "Module 6: Collections & Exception Handling",
                duration: `${Math.max(2, Math.round(totalHours * 0.10))} hrs`,
                topics: "ArrayList, HashMap, HashSet, try-catch-finally, checked vs unchecked exceptions"
            },
            {
                title: "Module 7: Hands-on Mini Project & Mastery Checkpoint",
                duration: `${Math.max(2, Math.round(totalHours * 0.05))} hrs`,
                topics: "Build a console-based practical application (e.g. Student Management System) and complete a diagnostic quiz"
            }
        ];
    } else if (/python/i.test(sLower)) {
        modules = [
            {
                title: "Module 1: Python Fundamentals & Data Types",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "Python syntax, dynamic typing, numeric types, strings, slicing, and operators"
            },
            {
                title: "Module 2: Data Structures (Lists, Dictionaries, Tuples, Sets)",
                duration: `${Math.max(2, Math.round(totalHours * 0.20))} hrs`,
                topics: "List comprehensions, dictionary operations, sets, hashing, and mutability vs immutability"
            },
            {
                title: "Module 3: Control Flow & Functions",
                duration: `${Math.max(2, Math.round(totalHours * 0.18))} hrs`,
                topics: "If-elif-else, for/while loops, function definitions, args/kwargs, and lambda functions"
            },
            {
                title: "Module 4: Modules, File Handling & Error Handling",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "Importing modules, file I/O (reading/writing CSV/JSON), try-except blocks"
            },
            {
                title: "Module 5: Object-Oriented Python",
                duration: `${Math.max(2, Math.round(totalHours * 0.17))} hrs`,
                topics: "Classes, instances, __init__, dunder methods, inheritance, and encapsulation"
            },
            {
                title: "Module 6: Practical Project & Synthesis",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "Develop a CLI data analysis tool or automation script and review progress"
            }
        ];
    } else if (/dbms|sql|database/i.test(sLower)) {
        modules = [
            {
                title: "Module 1: Relational Model & SQL Foundations",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "Relational database concepts, tables, primary/foreign keys, and basic SELECT queries"
            },
            {
                title: "Module 2: Filtering, Aggregations & Grouping",
                duration: `${Math.max(2, Math.round(totalHours * 0.18))} hrs`,
                topics: "WHERE clauses, aggregate functions (COUNT, SUM, AVG), GROUP BY, and HAVING"
            },
            {
                title: "Module 3: Joins & Subqueries",
                duration: `${Math.max(2, Math.round(totalHours * 0.20))} hrs`,
                topics: "INNER, LEFT, RIGHT, FULL OUTER joins, self-joins, correlated and non-correlated subqueries"
            },
            {
                title: "Module 4: ER Modeling & Database Design",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "Entity-Relationship diagrams, cardinalities, weak entities, and converting ER to relational schemas"
            },
            {
                title: "Module 5: Normalization (1NF, 2NF, 3NF, BCNF)",
                duration: `${Math.max(2, Math.round(totalHours * 0.17))} hrs`,
                topics: "Functional dependencies, eliminating anomalies, lossless joins, and dependency preservation"
            },
            {
                title: "Module 6: Transactions, Concurrency & Indexing",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "ACID properties, serializability, two-phase locking, B-Tree indexes, and query plans"
            }
        ];
    } else if (/operating system|os\b/i.test(sLower)) {
        modules = [
            {
                title: "Module 1: OS Architecture & System Calls",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "Kernel modes, system calls, interrupts, dual-mode operation, and OS structures"
            },
            {
                title: "Module 2: Process Management & CPU Scheduling",
                duration: `${Math.max(2, Math.round(totalHours * 0.20))} hrs`,
                topics: "Process control blocks (PCB), process states, FCFS, SJF, Round Robin, and Priority scheduling"
            },
            {
                title: "Module 3: Process Synchronization & IPC",
                duration: `${Math.max(2, Math.round(totalHours * 0.20))} hrs`,
                topics: "Critical section problem, Peterson's solution, mutex locks, semaphores, and classic sync problems"
            },
            {
                title: "Module 4: Deadlocks",
                duration: `${Math.max(2, Math.round(totalHours * 0.15))} hrs`,
                topics: "The 4 Coffman conditions, resource allocation graphs, Banker's algorithm, prevention and recovery"
            },
            {
                title: "Module 5: Memory Management & Virtual Memory",
                duration: `${Math.max(2, Math.round(totalHours * 0.18))} hrs`,
                topics: "Paging, segmentation, TLB, page replacement algorithms (FIFO, LRU, Optimal), and thrashing"
            },
            {
                title: "Module 6: File Systems & Storage",
                duration: `${Math.max(2, Math.round(totalHours * 0.12))} hrs`,
                topics: "Directory structure, inode allocation, disk scheduling algorithms (SSTF, SCAN, C-SCAN)"
            }
        ];
    } else {
        modules = [
            {
                title: "Module 1: Core Fundamentals & Principles",
                duration: `${Math.max(2, Math.round(totalHours * 0.20))} hrs`,
                topics: `Core terminology, mental models, and essential prerequisites for ${s}`
            },
            {
                title: "Module 2: Key Mechanics & Standard Patterns",
                duration: `${Math.max(2, Math.round(totalHours * 0.25))} hrs`,
                topics: `Structured breakdown of central mechanisms, methodologies, and standard problem-solving`
            },
            {
                title: "Module 3: Practical Applications & Hands-on Exercises",
                duration: `${Math.max(2, Math.round(totalHours * 0.25))} hrs`,
                topics: `Realistic case studies, hands-on practice, and iterative problem solving`
            },
            {
                title: "Module 4: Advanced Concepts & Optimization",
                duration: `${Math.max(2, Math.round(totalHours * 0.20))} hrs`,
                topics: `Edge cases, performance trade-offs, and deep-dive conceptual mastery`
            },
            {
                title: "Module 5: Capstone Synthesis & Review",
                duration: `${Math.max(2, Math.round(totalHours * 0.10))} hrs`,
                topics: `End-to-end practical project or comprehensive assessment to cement long-term retention`
            }
        ];
    }

    return { modules, totalHours, subject: s };
}

function formatProposedPlan(subject, level, dailyHours, durationDays, goal) {
    const { modules, totalHours } = buildCurriculum(subject, level, dailyHours, durationDays, goal);
    const moduleList = modules.map((m, i) => `${i + 1}. **${m.title}** (~${m.duration})\n   - ${m.topics}`).join("\n");

    return `### 📋 Proposed Study Plan: ${subject}
Here is the personalized learning path I have prepared for you:

**Goal:** ${goal || `Master ${subject}`}
**Level:** ${level || "Beginner"} | **Daily Pace:** ${dailyHours} hrs/day | **Target Period:** ${durationDays} days (~${totalHours} total study hours)

#### Structured Learning Path & Prerequisites:
${moduleList}

Does this study path look good to you, or would you like to modify anything before I save it?`;
}

function extractSubjectFromText(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    const common = [
        "javascript", "python", "java", "c++", "c programming", "c#",
        "dbms", "sql", "operating systems", "data structures", "algorithms",
        "mathematics", "physics", "chemistry", "biology", "web development",
        "machine learning", "artificial intelligence", "computer networks"
    ];
    for (const c of common) {
        const regex = new RegExp(`\\b${c.replace("+", "\\+")}\\b`, "i");
        if (regex.test(lower)) {
            return c.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        }
    }
    const match = text.match(/\b(?:learn|study|master|covering|for)\s+([a-zA-Z0-9#+]+)/i);
    if (match && match[1] && !/^(the|a|an|my|our|some|more|all|this)$/i.test(match[1])) {
        return match[1].charAt(0).toUpperCase() + match[1].slice(1);
    }
    return null;
}


        // 2.1 Proposed Plan Confirmation
        const lastAssistantProposal = [...messages].reverse().find(m => m.role === "assistant" && /### 📋 Proposed Study Plan|Does this study path look good/i.test(m.content || ""));
        if (lastAssistantProposal && /\b(?:confirm|confirm & create|yes|looks good|sounds good|save plan|save it|start plan|create plan|proceed|go ahead|approve|let's do it)\b/i.test(lower)) {
            const subMatch = lastAssistantProposal.content.match(/Proposed Study Plan:\s*([^\n#]+)/i);
            const subject = subMatch ? subMatch[1].trim() : "Java";
            const dailyMatch = lastAssistantProposal.content.match(/\*\*Daily Pace:\*\*\s*(\d+(?:\.\d+)?)/i);
            const dailyHours = dailyMatch ? parseFloat(dailyMatch[1]) : 2;
            const durMatch = lastAssistantProposal.content.match(/\*\*Target Period:\*\*\s*(\d+)/i);
            const durationDays = durMatch ? parseInt(durMatch[1], 10) : 14;

            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_create_${Date.now()}`,
                        name: "create_study_plan",
                        arguments: {
                            subjects: [subject],
                            durationDays,
                            dailyAvailableHours: dailyHours
                        }
                    }
                ]
            };
        }

        // 2.2 Plan Modification
        if (lastAssistantProposal && /\b(?:modify|change|adjust|hours|days|instead)\b/i.test(lower)) {
            const subMatch = lastAssistantProposal.content.match(/Proposed Study Plan:\s*([^\n#]+)/i);
            let subject = extractSubjectFromText(userMsg) || (subMatch ? subMatch[1].trim() : "Java");
            const hoursMatch = userMsg.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/i);
            const dailyHours = hoursMatch ? parseFloat(hoursMatch[1]) : 2;
            const daysMatch = userMsg.match(/(\d+)\s*(?:days?)\b/i);
            const durationDays = daysMatch ? parseInt(daysMatch[1], 10) : 14;

            return {
                role: "assistant",
                content: formatProposedPlan(subject, "Beginner", dailyHours, durationDays, `Master ${subject}`),
                toolCalls: []
            };
        }

        // 2.3 Diagnostic Quiz Request during onboarding
        if (/\b(?:diagnostic quiz|quiz first|test my level|take diagnostic)\b/i.test(lower)) {
            const sub = extractSubjectFromText(userMsg) || "Java";
            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_quiz_${Date.now()}`,
                        name: "create_quiz",
                        arguments: {
                            subject: sub,
                            questionCount: 3,
                            difficulty: "beginner"
                        }
                    }
                ]
            };
        }

        // 2.4 Conversational Onboarding State Machine
        const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")?.content || "";
        const lastAssistantLower = lastAssistant.toLowerCase();

        if (lastAssistantLower.includes("what do you want to learn or achieve") || lastAssistantLower.includes("to begin, what do you want to learn")) {
            const sub = extractSubjectFromText(userMsg);
            if (sub) {
                return {
                    role: "assistant",
                    content: `Got it—${sub}! How would you describe your current experience with it? Are you a complete beginner, familiar with the basics, or already experienced?`,
                    toolCalls: []
                };
            }
            return {
                role: "assistant",
                content: "That sounds like a great goal! Which specific subjects or topics would you like to study?",
                toolCalls: []
            };
        }

        if (lastAssistantLower.includes("which specific subjects or topics")) {
            const sub = extractSubjectFromText(userMsg) || userMsg.trim().slice(0, 30);
            return {
                role: "assistant",
                content: `Great—${sub}! How would you describe your current experience with it? Are you a complete beginner, familiar with the basics, or already experienced?`,
                toolCalls: []
            };
        }

        if (lastAssistantLower.includes("current experience with it") || lastAssistantLower.includes("complete beginner, familiar with the basics")) {
            return {
                role: "assistant",
                content: "Understood! What topics do you already feel comfortable with, and which areas feel tricky or unfamiliar? (You can say 'Skip' to start from the ground up.)",
                toolCalls: []
            };
        }

        if (lastAssistantLower.includes("already feel comfortable with") || lastAssistantLower.includes("tricky or unfamiliar")) {
            return {
                role: "assistant",
                content: "How much time can you realistically dedicate to studying each day?",
                toolCalls: []
            };
        }

        if (lastAssistantLower.includes("dedicate to studying each day")) {
            return {
                role: "assistant",
                content: "Do you have a target date, upcoming exam, project, or interview deadline in mind? (Or say 'Skip' for a self-paced plan.)",
                toolCalls: []
            };
        }

        if (lastAssistantLower.includes("target date, upcoming exam") || lastAssistantLower.includes("interview deadline in mind")) {
            return {
                role: "assistant",
                content: "What's your preferred way of learning? (e.g. step-by-step explanations with examples, hands-on coding, quizzes, or a balanced mix?)",
                toolCalls: []
            };
        }

        if (lastAssistantLower.includes("preferred way of learning")) {
            return {
                role: "assistant",
                content: "Almost ready! Do you have preferred study days or times? (e.g., Every day, Weekdays only, Evenings?)",
                toolCalls: []
            };
        }

        if (lastAssistantLower.includes("preferred study days or times")) {
            const fullHistory = messages.map(m => m.content).join(" ");
            const detectedSub = extractSubjectFromText(fullHistory) || "Java";
            const hoursMatch = fullHistory.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/i);
            const dailyHours = hoursMatch ? parseFloat(hoursMatch[1]) : 2;
            const daysMatch = fullHistory.match(/(\d+)\s*(?:days?)\b/i);
            const durationDays = daysMatch ? parseInt(daysMatch[1], 10) : 14;

            return {
                role: "assistant",
                content: formatProposedPlan(detectedSub, "Beginner", dailyHours, durationDays, `Master ${detectedSub}`),
                toolCalls: []
            };
        }

        // 2.5 Greeting / Start Onboarding
        if (/^(hi+|hello+|hey+|howdy|greetings|help|who are you|what can you do|start|start onboarding|onboarding)[\s!.]*$/i.test(lower) ||
            /^(?:i want to |can you )?(?:create|build|make|set up|start)\b.{0,20}\b(?:a\s+)?(?:study plan|plan)\b[\s!.]*$/i.test(lower)) {
            return {
                role: "assistant",
                content: "Hi! I'm your StudyPilot AI tutor. Let's create a study plan that fits your goals, current level, and schedule. I'll ask a few questions first.\n\nTo begin, what do you want to learn or achieve?",
                toolCalls: []
            };
        }

        if (/^(?:ok(?:ay)?|nice|thanks|thank you|cool)(?:[\s!.]+(?:nice|thanks|thank you|cool))?[\s!.]*$/i.test(lower) &&
            /(?:practice quiz|question\s+1:)/i.test(previousAssistantReply)) {
            return {
                role: "assistant",
                content: "Glad it helps! When you're ready, send your answers in a format like ‘1: A, 2: B, 3: C’, and I’ll check them.",
                toolCalls: []
            };
        }

        // 2.6 Quiz Intent
        if (/\b(?:create|generate|start|take|give me|make)\b.{0,20}\b(?:quiz|test|assessment|questions)\b/i.test(lower) ||
            /\bquiz (?:me|on)\b/i.test(lower)) {
            let subject = "JavaScript";
            const common = ["javascript", "react", "dbms", "operating systems", "mathematics", "physics", "chemistry", "data structures", "algorithms"];
            for (const c of common) {
                if (lower.includes(c)) {
                    subject = c.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
                    break;
                }
            }
            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_quiz_${Date.now()}`,
                        name: "create_quiz",
                        arguments: {
                            subject,
                            questionCount: 3
                        }
                    }
                ]
            };
        }

        // 2.7 Weak Topics Intent
        if (/\b(?:weak\s+topics?|weak\s+areas?|areas?\s+needing\s+improvement|where\s+am\s+i\s+struggling)\b/i.test(lower)) {
            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_weak_${Date.now()}`,
                        name: "get_weak_topics",
                        arguments: {}
                    }
                ]
            };
        }

        // 2.8 Aggregated Global Progress Intent
        if (/\b(?:overall|global|total|all plans)\b.{0,30}\b(?:progress|study\s+progress|summary)\b/i.test(lower) ||
            /\b(?:how am i doing overall|study metrics summary)\b/i.test(lower)) {
            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_global_prog_${Date.now()}`,
                        name: "get_study_progress",
                        arguments: {}
                    }
                ]
            };
        }

        // 2.9 Explicit Single-Shot Plan Creation (with dates, duration, or hours explicitly specified)
        if (/\b(?:create|make|build|generate|setup|set up|start|new)\b.{0,30}\b(?:plan|schedule)\b/i.test(lower) ||
            /\b(?:study plan|prep plan)\b/i.test(lower)) {
            
            // Extract subjects
            let subjects = [];
            const candidates = ["mathematics", "physics", "chemistry", "biology", "history", "javascript", "react", "dbms", "english", "computer science"];
            for (const c of candidates) {
                if (lower.includes(c)) subjects.push(c === "dbms" ? "DBMS" : (c.charAt(0).toUpperCase() + c.slice(1)));
            }
            if (subjects.length === 0) {
                const subMatch = lower.match(/(?:for|in|covering|subjects?)\s+([a-zA-Z0-9,\s&]+?)(?:\s+(?:with|having|exam|for|daily)|$)/i);
                if (subMatch && subMatch[1]) {
                    subjects = subMatch[1].split(/,| and /i).map(s => s.trim()).filter(s => s.length > 1 && !/^(the|a|an|my|our|a\s+week|\d+\s*(?:days?|weeks?)|week|days?)$/i.test(s));
                }
            }
            if (subjects.length === 0) {
                // If no subject given, transition to conversational onboarding
                return {
                    role: "assistant",
                    content: "Hi! I'm your StudyPilot AI tutor. Let's create a study plan that fits your goals, current level, and schedule. I'll ask a few questions first.\n\nTo begin, what do you want to learn or achieve?",
                    toolCalls: []
                };
            }

            // Extract exam date YYYY-MM-DD
            const dateMatch = userMsg.match(/\b(\d{4}-\d{2}-\d{2})\b/);
            const examDate = dateMatch ? dateMatch[1] : undefined;

            // Extract daily hours
            const hoursMatch = userMsg.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/i);
            const dailyAvailableHours = hoursMatch ? parseFloat(hoursMatch[1]) : 2;

            // Extract duration days if no exam date
            let durationDays;
            const daysMatch = userMsg.match(/(\d+)\s*(?:days?)\b/i);
            const weekMatch = userMsg.match(/\b(?:a|1)\s*week\b/i);
            if (daysMatch && !examDate) {
                durationDays = parseInt(daysMatch[1], 10);
            } else if (weekMatch && !examDate) {
                durationDays = 7;
            }

            const args = {
                subjects: subjects.map(s => s.charAt(0).toUpperCase() + s.slice(1)),
                dailyAvailableHours
            };
            if (examDate) args.examDate = examDate;
            if (durationDays) args.durationDays = durationDays;

            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_create_${Date.now()}`,
                        name: "create_study_plan",
                        arguments: args
                    }
                ]
            };
        }

        // 2.3 Record study session intent
        if (isSessionRecordingIntent(userMsg) ||
            /\b(?:record|log|studied|missed|completed|did)\b.{0,40}\b(?:session|hour|hours|hrs|work)\b/i.test(lower) ||
            /\b(?:i studied|i missed)\b/i.test(lower)) {
            
            const isMissed = /\bmissed\b/i.test(lower);
            const hoursMatch = userMsg.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
            const hours = hoursMatch ? parseFloat(hoursMatch[1]) : 2;
            const dayNumber = extractExplicitPlanDayNumber(userMsg);

            // Find subject
            let subject = "Mathematics";
            const common = ["mathematics", "physics", "chemistry", "biology", "history", "javascript", "react", "dbms", "english"];
            for (const c of common) {
                if (lower.includes(c)) {
                    subject = c.charAt(0).toUpperCase() + c.slice(1);
                    break;
                }
            }
            if (subject === "Mathematics" && !lower.includes("mathematics") && !lower.includes("math")) {
                for (let i = messages.length - 1; i >= 0; i--) {
                    const content = String(messages[i]?.content || "").toLowerCase();
                    for (const c of common) {
                        if (content.includes(c)) {
                            subject = c.charAt(0).toUpperCase() + c.slice(1);
                            break;
                        }
                    }
                    if (subject !== "Mathematics") break;
                }
            }

            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_record_${Date.now()}`,
                        name: "record_study_session",
                        arguments: {
                            subject,
                            hoursSpent: isMissed ? 0 : hours,
                            ...(isMissed ? { missedHours: hours, scheduledHours: hours } : {}),
                            status: isMissed ? "missed" : "completed",
                            ...(dayNumber ? { dayNumber } : {}),
                            notes: userMsg
                        }
                    }
                ]
            };
        }

        // 2.4 Educational / Academic Tutoring intent (CS, Math, Engineering, General Science)
        if (isEducationalTutoringIntent(userMsg)) {
            // Recursion
            if (/recursion|recursive/i.test(lower)) {
                return {
                    role: "assistant",
                    content: `### Understanding Recursion\n\n**Recursion** is a programming technique where a function solves a problem by calling a smaller instance of itself.\n\n#### Key Components of Any Recursive Function:\n1. **Base Case:** The terminating condition where no further recursive calls occur, preventing infinite recursion.\n2. **Recursive Step:** The reduction of the problem toward the base case.\n\n#### Example: Factorial in C++\n\`\`\`cpp\n#include <iostream>\n\n// Recursive function to calculate n!\nlong long factorial(int n) {\n    // 1. Base Case\n    if (n <= 1) return 1;\n    // 2. Recursive Case\n    return n * factorial(n - 1);\n}\n\nint main() {\n    int num = 5;\n    std::cout << num << "! = " << factorial(num) << std::endl; // Output: 120\n    return 0;\n}\n\`\`\`\n\n#### Time & Space Complexity:\n- **Time Complexity:** $O(n)$ because the function executes $n$ times.\n- **Space Complexity:** $O(n)$ due to call stack frames stored in memory.`,
                    toolCalls: []
                };
            }

            // BFS vs DFS
            if (/bfs.*dfs|dfs.*bfs|breadth.*depth|depth.*breadth/i.test(lower)) {
                return {
                    role: "assistant",
                    content: `### Breadth-First Search (BFS) vs. Depth-First Search (DFS)\n\nBoth are fundamental graph/tree traversal algorithms with distinct exploration strategies and tradeoffs:\n\n| Feature | Breadth-First Search (BFS) | Depth-First Search (DFS) |\n| :--- | :--- | :--- |\n| **Traversal Strategy** | Explores level by level (horizontal) | Explores as deep as possible along each branch before backtracking (vertical) |\n| **Underlying Data Structure** | **Queue** (FIFO) | **Stack** (LIFO) or Function Call Stack (Recursion) |\n| **Time Complexity** | $O(V + E)$ | $O(V + E)$ |\n| **Space Complexity** | $O(V)$ (holds entire breadth of tree) | $O(h)$ where $h$ is maximum depth of the tree |\n| **Optimal For** | Finding shortest path in unweighted graphs | Cycle detection, topological sorting, puzzle solving (maze paths) |`,
                    toolCalls: []
                };
            }

            // Operating System Deadlock
            if (/deadlock/i.test(lower)) {
                return {
                    role: "assistant",
                    content: `### Deadlock in Operating Systems\n\nA **deadlock** is a situation in concurrent systems where two or more processes are blocked indefinitely because each is holding a resource and waiting for another resource held by another process.\n\n#### The Four Coffman Conditions (All must hold simultaneously for deadlock):\n1. **Mutual Exclusion:** At least one resource must be non-shareable.\n2. **Hold and Wait:** A process is holding at least one resource and requesting additional resources held by other processes.\n3. **No Preemption:** Resources cannot be forcibly taken from a process; they can only be released voluntarily.\n4. **Circular Wait:** A closed chain of processes exists such that each process holds at least one resource that is needed by the next process in the chain.\n\n#### Deadlock Handling Strategies:\n- **Deadlock Prevention:** Invalidate at least one of the 4 Coffman conditions.\n- **Deadlock Avoidance:** Use runtime state information (e.g., Dijkstra's Banker's Algorithm) to guarantee safety.\n- **Deadlock Detection & Recovery:** Allow deadlocks to occur, periodically detect cycles using Resource Allocation Graphs (RAG), and recover by process termination or resource preemption.`,
                    toolCalls: []
                };
            }

            // DBMS Normalization
            if (/normalization|normal\s*form|1nf|2nf|3nf|bcnf/i.test(lower)) {
                return {
                    role: "assistant",
                    content: `### Database Normalization (1NF, 2NF, 3NF, BCNF)\n\n**Normalization** organizes relational database tables to reduce data redundancy and eliminate insert, update, and delete anomalies.\n\n| Normal Form | Primary Rule | Anomaly Prevented |\n| :--- | :--- | :--- |\n| **1NF** | Each column contains atomic (indivisible) values; no repeating groups. | Inconsistent data storage |\n| **2NF** | In 1NF and no **partial functional dependencies** (every non-key attribute is fully functionally dependent on candidate keys). | Update & delete redundancy in composite-key tables |\n| **3NF** | In 2NF and no **transitive dependencies** ($A \\to B \\to C$). | Indirect attribute updates |\n| **BCNF** | For every functional dependency $X \\to Y$, $X$ must be a super key. | Overlapping candidate key anomalies |`,
                    toolCalls: []
                };
            }

            // Code Debugging
            if (/debug|nullpointer|error|exception|bug|fix/i.test(lower)) {
                return {
                    role: "assistant",
                    content: `### Code Analysis & Debugging Guide\n\nWhen diagnosing runtime exceptions such as \`NullPointerException\` or segmentation faults:\n\n1. **Root Cause Analysis:** The program attempted to access an object member or array index on an uninitialized or \`null\` reference.\n2. **Prevention Strategy:** Guard references with explicit non-null checks, use \`Optional<T>\`, or use safe navigation operators.\n3. **Recommended Fix Example:**\n\`\`\`java\n// Guard against null before dereferencing\nif (target != null && target.isValid()) {\n    target.execute();\n} else {\n    logger.warn("Target reference was null or invalid");\n}\n\`\`\``,
                    toolCalls: []
                };
            }

            // Programming Exercises / Aptitude
            if (/exercise|practice|viva|aptitude|problem/i.test(lower)) {
                return {
                    role: "assistant",
                    content: `### Practice Problems & Exercises\n\nHere are targeted practice exercises designed to test your mastery:\n\n1. **Problem 1 (Concept Application):** Explain the time and space complexity trade-offs of the algorithm.\n2. **Problem 2 (Edge Case Analysis):** How does your implementation behave with empty inputs, duplicates, or negative bounds?\n3. **Problem 3 (Implementation Challenge):** Write a clean implementation with zero memory leaks.\n\nWould you like a step-by-step walkthrough or an interactive StudyPilot quiz on this topic?`,
                    toolCalls: []
                };
            }

            // General Educational Fallback
            return {
                role: "assistant",
                content: `### Academic Concept Overview: ${userMsg}\n\nHere is a structured explanation:\n\n1. **Core Concept:** This topic is an essential foundation in academic curricula and technical interviews.\n2. **Application:** Mastery of this topic enables systematic reasoning and efficient problem solving.\n3. **Interactive Study:** Would you like to review an implementation example, practice with a quiz, or add this topic to your StudyPilot plan?`,
                toolCalls: []
            };

        }

        // 2.5 Retrieve study plan / progress intent
        if (/\b(?:get|show|view|inspect|retrieve|report)\b.*?\b(?:plan|progress|status|metrics?|schedule|history)\b/i.test(lower) ||
            /\b(?:how am i doing|my plan|plan status|study progress|progress of plan)\b/i.test(lower)) {
            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_get_${Date.now()}`,
                        name: "get_study_plan",
                        arguments: {}
                    }
                ]
            };
        }

        // 2.5 Adapt plan intent
        if (/\b(?:adapt|adjust|rebalance|recalculate|modify|change pace)\b/i.test(lower)) {
            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_adapt_${Date.now()}`,
                        name: "adapt_study_plan",
                        arguments: {
                            reason: userMsg
                        }
                    }
                ]
            };
        }

        // 2.6 List plans
        if (/\b(?:list|all plans|saved plans)\b/i.test(lower)) {
            return {
                role: "assistant",
                content: "",
                toolCalls: [
                    {
                        id: `call_list_${Date.now()}`,
                        name: "list_study_plans",
                        arguments: {}
                    }
                ]
            };
        }

        // Default conversational response
        return {
            role: "assistant",
            content: `I'm here to help with your studies! You can ask me to:\n• **Create a study plan** (e.g. "Create a plan for Math and Physics with exam on 2026-12-15")\n• **Record a session** (e.g. "I completed 2 hours of Math today")\n• **Check your progress** (e.g. "Show my current study progress")\n• **Adapt your plan** (e.g. "Adapt my schedule after missed sessions")`,
            toolCalls: []
        };
    }
}
