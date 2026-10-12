/**
 * Tool argument validation and result verification helpers
 */
import { isToolNameLike, isRetrievalIntent, isAdaptationIntent } from "./normalizer.js";

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

    // 1. Verify required properties are present
    for (const reqKey of required) {
        const val = args[reqKey];
        if (val === undefined || val === null || val === "") {
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

    // Verification for create_study_plan
    if (toolName === "create_study_plan") {
        if (!data || typeof data !== "object") {
            return {
                valid: false,
                error: "create_study_plan did not return a valid structured summary."
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

    // Verification for get_study_plan and adapt_study_plan
    if (toolName === "get_study_plan" || toolName === "adapt_study_plan") {
        if (data && typeof data === "object") {
            const subjects = data.subjects || data.adjustedSubjectAllocations || {};
            const subjectNames = Object.keys(subjects);
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
                    error: `Retrieved study plan contains malformed subject names: [${malformed.join(", ")}].`
                };
            }
        }
    }

    return { valid: true };
}
