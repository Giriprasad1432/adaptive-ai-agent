/**
 * Tool argument validation and result verification helpers
 */
import { extractExplicitPlanId, extractExplicitSessionDate, extractExplicitMissedSessionHours, isToolNameLike, isRetrievalIntent, isAdaptationIntent } from "./normalizer.js";
import { getDailyStudyHourBounds } from "../../studypilot-server/planner.js";

const isPlaceholderPlanId = value => typeof value === "string" &&
    /^(?:id|identifier|number|name|plan|plan[\s_-]*id|study[\s_-]*plan|unknown|unspecified)$/i.test(value.trim());

/**
 * Validates normalized arguments against an MCP tool's inputSchema.
 * @param {Object} tool - MCP tool definition with inputSchema
 * @param {Object} args - Normalized tool arguments
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateToolArguments(tool, args = {}, options = {}) {
    if (!tool) {
        return { valid: false, error: "Tool definition not found in available tools catalog." };
    }

    const toolName = tool.name || "";

    // Specific intent alignment check for adapt_study_plan
    if (toolName === "adapt_study_plan") {
        if (args.reason && isRetrievalIntent(args.reason)) {
            return {
                valid: false,
                error: 'Invalid adaptation reason: A retrieval or inspection request ("retrieve", "show", "get", "report on") cannot be treated as an adaptation reason. Use "get_study_plan" to retrieve or report on a study plan.'
            };
        }
        if (options.userMessage && isRetrievalIntent(options.userMessage) && !isAdaptationIntent(options.userMessage)) {
            return {
                valid: false,
                error: 'Invalid tool selection: The user requested to retrieve/report on the study plan, not adapt it. Use "get_study_plan" instead of "adapt_study_plan".'
            };
        }
    }

    const schema = tool.inputSchema || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = schema.properties || {};

    const userExplicitlyRequestedPlanId = typeof options.userMessage === "string" &&
        /\bplan\b.{0,20}\b(?:id|identifier|number)\b/i.test(options.userMessage);
    const explicitUserPlanId = userExplicitlyRequestedPlanId
        ? extractExplicitPlanId(options.userMessage)
        : null;

    if (args.planId && isPlaceholderPlanId(args.planId)) {
        return { valid: false, error: 'The plan ID is a label or placeholder, not a specific plan. Please provide the actual plan ID.' };
    }

    if (properties.planId && userExplicitlyRequestedPlanId && (!explicitUserPlanId || args.planId !== explicitUserPlanId)) {
        return { valid: false, error: 'I could not safely resolve the requested plan ID. Please provide the plan ID.' };
    }

    if (toolName === "get_study_plan" && !args.planId) {
        return { valid: false, error: 'I could not identify a saved plan from the active conversation. List saved plans and ask the user to choose by subject or description.' };
    }

    if (((toolName === "adapt_study_plan" && options.userMessage && isAdaptationIntent(options.userMessage)) ||
        (toolName === "record_study_session" && options.userMessage)) && !args.planId) {
        return { valid: false, error: 'I could not identify a saved plan from the active conversation. List saved plans and ask the user to choose by subject or description.' };
    }

    if (toolName === "create_study_plan" && options.userMessage &&
        /\b(?:exam|test)\b.{0,45}\b(?:prep|preparation|revision|plan|schedule)\b|\b(?:prep|preparation|revision)\b.{0,45}\b(?:exam|test)\b/i.test(options.userMessage) &&
        !args.examDate) {
        return { valid: false, error: "Please provide the exam date for this exam-preparation plan, or describe it as a goal-based learning plan." };
    }

    if (toolName === "record_study_session" && options.userMessage) {
        const explicitSessionDate = extractExplicitSessionDate(options.userMessage);
        if (explicitSessionDate && args.date !== explicitSessionDate) {
            return { valid: false, error: `The session date must match the explicit date in your request (${explicitSessionDate}).` };
        }
        if (String(args.status || "").toLowerCase() === "missed") {
            if (args.hoursSpent !== 0) {
                return { valid: false, error: "hoursSpent must be 0 for a missed session because no study occurred." };
            }
            const explicitHours = extractExplicitMissedSessionHours(options.userMessage);
            if (explicitHours.missedHours !== null && args.missedHours !== explicitHours.missedHours) {
                return { valid: false, error: `missedHours must match the requested missed duration (${explicitHours.missedHours}).` };
            }
            if (explicitHours.scheduledHours !== null && args.scheduledHours !== explicitHours.scheduledHours) {
                return { valid: false, error: `scheduledHours must match the requested session duration (${explicitHours.scheduledHours}).` };
            }
        }
        if (args.missedHours !== undefined && args.scheduledHours !== undefined && args.missedHours > args.scheduledHours) {
            return { valid: false, error: "missedHours cannot exceed scheduledHours." };
        }
    }

    // 1. Verify required properties are present
    for (const reqKey of required) {
        const val = args[reqKey];
        if (val === undefined || val === null || val === "") {
            if (reqKey === "planId" && toolName === "get_study_plan") {
                return { valid: false, error: 'I could not identify a verified study plan ID from this request or prior tool results. Please provide the plan ID.' };
            }
            return {
                valid: false,
                error: `Missing required parameter "${reqKey}". Expected type: ${properties[reqKey]?.type || "value"}.`
            };
        }
    }

    // 2. Validate types and structure
    for (const [key, value] of Object.entries(args)) {
        const propDef = properties[key];
        if (!propDef) continue; // Allow extra fields unless schema is strict

        const expectedType = propDef.type;

        // Array validation
        if (expectedType === "array") {
            if (!Array.isArray(value)) {
                return {
                    valid: false,
                    error: `Parameter "${key}" must be an array. Received: ${typeof value}.`
                };
            }
            if (required.includes(key) && value.length === 0) {
                return {
                    valid: false,
                    error: `Parameter "${key}" must be a non-empty array with at least one element.`
                };
            }
            // Check for malformed string entries with bracket/quote/backslash leftovers
            for (const item of value) {
                if (typeof item !== "string" || item.trim() === "") {
                    return {
                        valid: false,
                        error: `Items in "${key}" must be non-empty strings.`
                    };
                }
                if (/^["'\\\[\]]|["'\\\[\]]$/.test(item) || item.includes('"') || item.includes('\\')) {
                    return {
                        valid: false,
                        error: `Item "${item}" in "${key}" contains invalid quotation, bracket, or escape artifacts. Please provide clean names.`
                    };
                }
            }
        }

        // Object validation
        if (expectedType === "object") {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                return {
                    valid: false,
                    error: `Parameter "${key}" must be a valid key-value object. Received: ${typeof value}.`
                };
            }
            for (const [k, v] of Object.entries(value)) {
                if (/^["'\\\[\]]|["'\\\[\]]$/.test(k) || k.includes('"') || k.includes('\\')) {
                    return {
                        valid: false,
                        error: `Key "${k}" in "${key}" contains invalid quotation, bracket, or escape artifacts.`
                    };
                }
                if (typeof v === "string" && (/^["'\\\[\]]|["'\\\[\]]$/.test(v) || v.includes('"') || v.includes('\\'))) {
                    return {
                        valid: false,
                        error: `Value for "${k}" in "${key}" contains invalid quotation, bracket, or escape artifacts.`
                    };
                }
            }

            // Specific validation for priorities object
            if (key === "priorities") {
                const allowedPriorities = ["high", "medium", "low"];
                for (const [subKey, subVal] of Object.entries(value)) {
                    if (typeof subVal !== "string" || !allowedPriorities.includes(subVal.trim().toLowerCase())) {
                        return {
                            valid: false,
                            error: `Invalid priority "${subVal}" for subject "${subKey}". Allowed priorities: high, medium, low.`
                        };
                    }
                }
            }
        }

        // Number validation
        if (expectedType === "number" || expectedType === "integer") {
            if (typeof value !== "number" || !Number.isFinite(value)) {
                return {
                    valid: false,
                    error: `Parameter "${key}" must be a valid number. Received: ${JSON.stringify(value)}.`
                };
            }
            if (expectedType === "integer" && !Number.isInteger(value)) {
                return {
                    valid: false,
                    error: `Parameter "${key}" must be an integer.`
                };
            }
            if (key === "durationDays") {
                const maxDuration = Number(process.env.STUDYPILOT_MAX_DURATION_DAYS || 730);
                if (value < 1 || value > maxDuration) {
                    return { valid: false, error: `Parameter "durationDays" must be a whole number between 1 and ${maxDuration}.` };
                }
            }
            if (["dailyAvailableHours", "newDailyAvailableHours"].includes(key)) {
                const { min, max } = getDailyStudyHourBounds();
                if (value < min || value > max) {
                    return { valid: false, error: `Parameter "${key}" must be a positive number greater than 0 and between ${min} and ${max} hours.` };
                }
            }
            if (key === "hoursSpent") {
                if (value < 0) {
                    return {
                        valid: false,
                        error: `Parameter "hoursSpent" cannot be negative. Received: ${value}.`
                    };
                }
            } else if ((key.toLowerCase().includes("hour") || key.toLowerCase().includes("count")) && value <= 0) {
                return {
                    valid: false,
                    error: `Parameter "${key}" must be a positive number greater than 0. Received: ${value}.`
                };
            }
        }

        // String validation
        if (expectedType === "string") {
            if (typeof value !== "string") {
                return {
                    valid: false,
                    error: `Parameter "${key}" must be a string.`
                };
            }
            if (key.toLowerCase().includes("date")) {
                const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
                if (!dateRegex.test(value) || Number.isNaN(new Date(value).getTime())) {
                    return {
                        valid: false,
                        error: `Parameter "${key}" must be a valid date in YYYY-MM-DD format. Received: "${value}".`
                    };
                }
                const [calendarYear, calendarMonth, calendarDay] = value.split("-").map(Number);
                const parsedDate = new Date(Date.UTC(calendarYear, calendarMonth - 1, calendarDay));
                if (parsedDate.getUTCFullYear() !== calendarYear || parsedDate.getUTCMonth() !== calendarMonth - 1 || parsedDate.getUTCDate() !== calendarDay) {
                    return { valid: false, error: `Parameter "${key}" must be a real calendar date in YYYY-MM-DD format. Received: "${value}".` };
                }
                if (key === "examDate" || key === "newExamDate") {
                    const [y, m, d] = value.trim().split("-").map(Number);
                    const utcTarget = Date.UTC(y, m - 1, d);
                    const refDate = options.referenceDate ? new Date(options.referenceDate) : new Date();
                    const utcRef = Date.UTC(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
                    if (utcTarget < utcRef) {
                        return {
                            valid: false,
                            error: "Exam date cannot be in the past."
                        };
                    }
                }
            }
            if (key === "planId") {
                if (isToolNameLike(value, options.knownTools)) {
                    return {
                        valid: false,
                        error: `Invalid plan identifier "${value}". A tool name cannot be used as a plan ID.`
                    };
                }
            }
        }

        // Enum validation
        if (Array.isArray(propDef.enum)) {
            if (!propDef.enum.includes(value)) {
                return {
                    valid: false,
                    error: `Parameter "${key}" must be one of [${propDef.enum.join(", ")}]. Received: "${value}".`
                };
            }
        }
    }

    return { valid: true };
}

/**
 * Inspects actual MCP tool execution results before the agent reports success.
 * Detects malformed subject names, missing items, or incorrect priority assignments.
 * @param {string} toolName - Name of the executed tool
 * @param {Object} toolArgs - Arguments passed into the tool
 * @param {Object} executionResult - MCP client execution result ({ isError, content })
 * @returns {{ valid: boolean, error?: string }}
 */
export function verifyToolResult(toolName, toolArgs = {}, executionResult = {}) {
    if (!executionResult) {
        return { valid: false, error: "Tool execution returned no result." };
    }

    if (executionResult.isError) {
        return {
            valid: false,
            error: executionResult.content || "Tool execution failed."
        };
    }

    const content = executionResult.content || "";
    let data = null;
    try {
        data = JSON.parse(content);
    } catch {
        // Non-JSON textual response
    }

    if (toolName === "list_study_plans") {
        if (!data || !Array.isArray(data.plans) || data.plans.some(plan =>
            !plan || typeof plan.planId !== "string" || !Array.isArray(plan.subjects) ||
            plan.subjects.some(subject => typeof subject !== "string")
        )) {
            return { valid: false, error: "list_study_plans returned malformed plan summaries." };
        }
    }

    // Verification for create_study_plan
    if (toolName === "create_study_plan") {
        if (!data || typeof data !== "object") {
            return {
                valid: false,
                error: "create_study_plan did not return a valid structured summary."
            };
        }

        if (toolArgs.planId && data.planId !== toolArgs.planId) {
            return {
                valid: false,
                error: `create_study_plan returned plan ID "${data.planId || "(missing)"}" instead of requested ID "${toolArgs.planId}".`
            };
        }

        const subjectAllocations = data.subjectAllocations || data.subjects || {};
        const createdNames = Object.keys(subjectAllocations);

        if (createdNames.length === 0) {
            return {
                valid: false,
                error: "create_study_plan created 0 subjects."
            };
        }

        // 1. Detect malformed subject names containing brackets, quotes, or escapes
        const malformedNames = createdNames.filter(name =>
            /^["'\\\[\]]|["'\\\[\]]$/.test(name) ||
            name.includes('"') ||
            name.includes("'") ||
            name.includes("\\") ||
            name.includes("[") ||
            name.includes("]")
        );

        if (malformedNames.length > 0) {
            return {
                valid: false,
                error: `Tool created malformed subject names: [${malformedNames.join(", ")}]. Subject names must be clean.`
            };
        }

        // 2. Verify all requested subjects were created
        if (Array.isArray(toolArgs.subjects)) {
            for (const expectedSub of toolArgs.subjects) {
                const cleanExpected = typeof expectedSub === "string" ? expectedSub.trim() : "";
                if (cleanExpected && !createdNames.includes(cleanExpected)) {
                    return {
                        valid: false,
                        error: `Requested subject "${cleanExpected}" is missing from created study plan.`
                    };
                }
            }
        }

        // 3. Verify priorities match requested priorities
        if (toolArgs.priorities && typeof toolArgs.priorities === "object") {
            for (const [sub, requestedPrio] of Object.entries(toolArgs.priorities)) {
                const subAllocation = subjectAllocations[sub];
                if (subAllocation) {
                    const actualPrio = (subAllocation.priority || "").toLowerCase();
                    const expectedPrio = (requestedPrio || "").toLowerCase();
                    if (actualPrio !== expectedPrio) {
                        return {
                            valid: false,
                            error: `Priority mismatch for subject "${sub}": requested "${expectedPrio}", but plan assigned "${actualPrio}".`
                        };
                    }
                }
            }
        }
    }

    // Verification for record_study_session
    if (toolName === "record_study_session") {
        if (!data || typeof data !== "object") {
            return {
                valid: false,
                error: "record_study_session did not return a valid structured result."
            };
        }
        if (!data.session || typeof data.session !== "object") {
            return {
                valid: false,
                error: "record_study_session result is missing recorded session details."
            };
        }
        if (!data.subjectProgress || typeof data.subjectProgress !== "object") {
            return {
                valid: false,
                error: "record_study_session result is missing updated subject progress."
            };
        }
        if (toolArgs.planId && data.planId !== toolArgs.planId) {
            return {
                valid: false,
                error: `record_study_session returned plan ID "${data.planId || "(missing)"}" instead of requested ID "${toolArgs.planId}".`
            };
        }
        // Verify recorded subject matches requested subject
        if (toolArgs.subject && data.session.subject) {
            const expectedSub = toolArgs.subject.trim().toLowerCase();
            const actualSub = String(data.session.subject).trim().toLowerCase();
            if (expectedSub !== actualSub) {
                return {
                    valid: false,
                    error: `Recorded session subject mismatch: requested "${toolArgs.subject}", recorded "${data.session.subject}".`
                };
            }
        }
        // Verify recorded status matches requested status
        if (toolArgs.status && data.session.status) {
            if (toolArgs.status.toLowerCase() !== String(data.session.status).toLowerCase()) {
                return {
                    valid: false,
                    error: `Recorded session status mismatch: requested "${toolArgs.status}", recorded "${data.session.status}".`
                };
            }
        }

        const matchesRequestedHours = (field, expected) =>
            expected === undefined || (typeof data.session[field] === "number" && Math.abs(data.session[field] - expected) < 0.001);
        if (!matchesRequestedHours("hoursSpent", toolArgs.hoursSpent)) {
            return { valid: false, error: `Recorded session hoursSpent (${data.session.hoursSpent ?? "missing"}) do not match requested hoursSpent (${toolArgs.hoursSpent}).` };
        }
        if (toolArgs.date !== undefined && data.session.date !== toolArgs.date) {
            return { valid: false, error: `Recorded session date (${data.session.date || "missing"}) does not match requested date (${toolArgs.date}).` };
        }
        for (const field of ["scheduledHours", "missedHours"]) {
            if (!matchesRequestedHours(field, toolArgs[field])) {
                return { valid: false, error: `Recorded session ${field} (${data.session[field] ?? "missing"}) does not match requested ${field} (${toolArgs[field]}).` };
            }
        }
        if (String(toolArgs.status || "").toLowerCase() === "missed" && toolArgs.scheduledHours !== undefined && toolArgs.missedHours === undefined &&
            !matchesRequestedHours("missedHours", toolArgs.scheduledHours)) {
            return { valid: false, error: `Recorded missedHours (${data.session.missedHours ?? "missing"}) does not match requested scheduledHours (${toolArgs.scheduledHours}).` };
        }
    }

    // Verification for get_study_plan and adapt_study_plan
    if (toolName === "get_study_plan" || toolName === "adapt_study_plan") {
        if (!data || typeof data !== "object") {
            return {
                valid: false,
                error: `${toolName} did not return a valid structured summary.`
            };
        }

        if (toolArgs.planId && data.planId !== toolArgs.planId) {
            return {
                valid: false,
                error: `${toolName} returned plan ID "${data.planId || "(missing)"}" instead of requested ID "${toolArgs.planId}".`
            };
        }

        const subjects = data.subjects || data.adjustedSubjectAllocations || {};
        const subjectNames = Object.keys(subjects);

        if (toolName === "adapt_study_plan" && subjectNames.length === 0) {
            return {
                valid: false,
                error: "adapt_study_plan result is missing adjusted subject allocations."
            };
        }

        const malformed = subjectNames.filter(name =>
            /^["'\\\[\]]|["'\\\[\]]$/.test(name) ||
            name.includes('"') ||
            name.includes("\\") ||
            name.includes("[") ||
            name.includes("]")
        );
        if (malformed.length > 0) {
            return {
                valid: false,
                error: `${toolName} contains malformed subject names: [${malformed.join(", ")}].`
            };
        }
    }

    return { valid: true };
}
