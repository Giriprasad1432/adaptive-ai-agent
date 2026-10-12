/**
 * Tool argument normalizer
 * Coerces and normalizes LLM-generated arguments against an MCP tool's inputSchema.
 */

/**
 * Determines the primary expected type from a JSON schema property definition
 */
export function getExpectedType(propDef) {
    if (!propDef) return null;
    if (propDef.type) return propDef.type;

    // Handle anyOf / oneOf
    const variants = propDef.anyOf || propDef.oneOf || [];
    for (const v of variants) {
        if (v.type === "array") return "array";
        if (v.type === "object") return "object";
        if (v.type === "number" || v.type === "integer") return "number";
    }
    return variants[0]?.type || null;
}

/**
 * Safely cleans a single string, stripping quotation, bracket, and backslash artifacts
 */
export function cleanStringItem(item) {
    if (item === null || item === undefined) return "";
    let str = typeof item === "string" ? item : String(item.name || item.subject || item);
    // Strip leading/trailing brackets, quotes, and backslashes
    return str.replace(/^["'\\\[\]]+|["'\\\[\]]+$/g, "").trim();
}

/**
 * Normalizes a list of strings (e.g. subject names) removing quotation/bracket noise
 */
export function cleanStringArray(arr) {
    if (!Array.isArray(arr)) return [];
    const flattened = [];
    for (const item of arr) {
        if (typeof item === "string" && item.includes(",")) {
            const parts = item.split(",").map(p => cleanStringItem(p)).filter(Boolean);
            flattened.push(...parts);
        } else {
            const cleaned = cleanStringItem(item);
            if (cleaned) flattened.push(cleaned);
        }
    }
    return flattened;
}

/**
 * Cleans object keys and string values removing quotation/bracket noise
 */
export function cleanObject(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
    const cleaned = {};
    for (const [k, v] of Object.entries(obj)) {
        const cleanKey = cleanStringItem(k);
        let cleanVal = v;
        if (typeof v === "string") {
            cleanVal = cleanStringItem(v);
        }
        cleaned[cleanKey] = cleanVal;
    }
    return cleaned;
}

/**
 * Checks if a position in a string is at a word boundary (delimited by whitespace or syntax characters)
 */
function isWordBoundary(str, index, length) {
    const prev = index > 0 ? str[index - 1] : " ";
    const next = index + length < str.length ? str[index + length] : " ";
    return /[\s,:[\]{}]/.test(prev) && /[\s,:[\]{}]/.test(next);
}

/**
 * Safely parses a Python-style dictionary or relaxed JSON string into a JavaScript object/array.
 * Does NOT use eval or Function.
 * @param {string} value - Candidate JSON or Python dict string
 * @returns {Object|Array|null} Parsed object or array, or null if invalid
 */
export function parsePythonDictOrRelaxedJson(value) {
    if (typeof value !== "string") return null;
    let str = value.trim();
    if (!str) return null;

    // Must be enclosed in { ... } or [ ... ]
    const isObject = str.startsWith("{") && str.endsWith("}");
    const isArray = str.startsWith("[") && str.endsWith("]");
    if (!isObject && !isArray) return null;

    // Step 1: Try standard JSON.parse first (fast path for valid JSON)
    try {
        return JSON.parse(str);
    } catch {
        // Fall through to safe tokenizer
    }

    // Step 2: Convert Python-style dict / single-quoted JSON into strictly valid JSON
    let out = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escape = false;

    for (let i = 0; i < str.length; i++) {
        const char = str[i];

        if (escape) {
            if (inSingleQuote) {
                // If it was escaped single quote \' inside single quotes, unescape to just '
                if (char === "'") {
                    out += "'";
                } else if (char === '"') {
                    // \" inside single quotes becomes escaped \" in JSON
                    out += '\\"';
                } else {
                    out += "\\" + char;
                }
            } else if (inDoubleQuote) {
                out += "\\" + char;
            } else {
                out += "\\" + char;
            }
            escape = false;
            continue;
        }

        if (char === "\\") {
            escape = true;
            continue;
        }

        if (char === "'" && !inDoubleQuote) {
            if (inSingleQuote) {
                out += '"';
                inSingleQuote = false;
            } else {
                out += '"';
                inSingleQuote = true;
            }
            continue;
        }

        if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            out += '"';
            continue;
        }

        if (inSingleQuote) {
            // Unescaped double quote inside single quote must be escaped in double-quoted JSON
            if (char === '"') {
                out += '\\"';
            } else {
                out += char;
            }
            continue;
        }

        if (inDoubleQuote) {
            out += char;
            continue;
        }

        // Outside string literals:
        // Handle Python boolean and None keywords: True -> true, False -> false, None -> null
        if (str.startsWith("True", i) && isWordBoundary(str, i, 4)) {
            out += "true";
            i += 3;
            continue;
        }
        if (str.startsWith("False", i) && isWordBoundary(str, i, 5)) {
            out += "false";
            i += 4;
            continue;
        }
        if (str.startsWith("None", i) && isWordBoundary(str, i, 4)) {
            out += "null";
            i += 3;
            continue;
        }

        // Handle trailing commas before closing braces/brackets
        if (char === ",") {
            let nextIdx = i + 1;
            while (nextIdx < str.length && /\s/.test(str[nextIdx])) nextIdx++;
            if (str[nextIdx] === "}" || str[nextIdx] === "]") {
                continue;
            }
        }

        out += char;
    }

    if (inSingleQuote || inDoubleQuote || escape) {
        // Malformed unclosed string or trailing escape
        return null;
    }

    try {
        const parsed = JSON.parse(out);
        return (parsed && typeof parsed === "object") ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Safely parses a string that might be JSON or a Python-style dict/list
 */
export function tryParseJson(value) {
    if (typeof value !== "string") return null;
    let trimmed = value.trim();
    if (!trimmed) return null;

    // Handle strings wrapped in extra outer quotes, e.g. "\"{\\\"a\\\":1}\""
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        try {
            const unescaped = JSON.parse(trimmed);
            if (typeof unescaped === "string") {
                trimmed = unescaped.trim();
            } else if (typeof unescaped === "object" && unescaped !== null) {
                return unescaped;
            }
        } catch {
            // ignore
        }
    }

    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || 
        (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
        return parsePythonDictOrRelaxedJson(trimmed);
    }
    return null;
}

export const KNOWN_TOOL_NAMES = [
    "create_study_plan",
    "get_study_plan",
    "record_study_session",
    "adapt_study_plan",
    "add",
    "multiply",
    "divide"
];

/**
 * Checks if a string looks like a tool name
 * @param {string} str - Candidate string
 * @param {string[]} [knownTools] - Optional list of known tool names
 * @returns {boolean}
 */
export function isToolNameLike(str, knownTools = []) {
    if (typeof str !== "string") return false;
    const trimmed = str.trim().toLowerCase();
    const tools = (Array.isArray(knownTools) && knownTools.length > 0)
        ? knownTools.map(t => String(t).toLowerCase())
        : KNOWN_TOOL_NAMES;
    if (tools.includes(trimmed)) {
        return true;
    }
    // Snake_case tool-name pattern (e.g. adapt_study_plan, get_study_plan)
    if (/^[a-z]+_[a-z]+(?:_[a-z]+)*$/.test(trimmed)) {
        if (trimmed.includes("study_plan") || trimmed.includes("session") || trimmed.endsWith("_tool")) {
            return true;
        }
    }
    return false;
}

/**
 * Extracts an explicit user-provided plan identifier from user text or conversation history.
 * Does NOT hardcode any plan name.
 * @param {string} text - User message text or prompt
 * @param {Array} [conversation] - Prior conversation messages
 * @returns {string|null} Extracted planId, or null if none found
 */
export function extractExplicitPlanId(text, conversation = []) {
    const STOP_WORDS = new Set([
        "for", "to", "is", "and", "the", "with", "from", "on", "a", "an", "that", "this",
        "my", "our", "new", "each", "details", "data", "changes", "now", "because",
        "so", "as", "if", "when", "while", "please", "report", "show", "get", "retrieve"
    ]);

    const searchInText = (t) => {
        if (typeof t !== "string" || !t.trim()) return null;

        // 1. Explicit planId / plan_id patterns:
        // e.g. planId "adaptive-demo", planId: adaptive-demo, plan_id='custom-plan'
        const planIdRegex = /\bplan(?:_?id)\s*[:=]?\s*["']?([a-zA-Z0-9_\-]+)["']?/i;
        const match1 = t.match(planIdRegex);
        if (match1 && match1[1] && !isToolNameLike(match1[1]) && !STOP_WORDS.has(match1[1].toLowerCase())) {
            return match1[1];
        }

        // 2. "study plan <name>" or "plan <name>" with quotes:
        // e.g. study plan "adaptive-demo", for plan adaptive-demo, in plan "my-plan"
        const planNameRegex = /(?:study\s+plan|study-plan|plan)\s+["']([a-zA-Z0-9_\-]+)["']/i;
        const match2 = t.match(planNameRegex);
        if (match2 && match2[1] && !isToolNameLike(match2[1]) && !STOP_WORDS.has(match2[1].toLowerCase())) {
            return match2[1];
        }

        // 3. Verbs / prepositions followed by (study) plan <identifier> (unquoted identifier):
        // e.g. "Retrieve study plan adaptive-demo", "Adapt study plan adaptive-demo", "for study plan custom-123",
        // "Please adapt study plan for plan physics-intensive"
        const planWordMatches = [...t.matchAll(/(?:(?:retrieve|get|show|view|inspect|report\s+on|adapt|rebalance|modify|update|for|in|from|to|with|of)\s+)?\b(?:study\s+plan|study-plan|plan)\b\s+([a-zA-Z0-9_\-]+)/gi)];
        for (const m of planWordMatches) {
            const candidate = m[1];
            if (candidate && !isToolNameLike(candidate) && !STOP_WORDS.has(candidate.toLowerCase())) {
                return candidate;
            }
        }

        // 5. Assistant confirmation message: Study plan "<planId>" created successfully!
        const confirmRegex = /Study\s+plan\s+["']([a-zA-Z0-9_\-]+)["']\s+created\s+successfully/i;
        const match5 = t.match(confirmRegex);
        if (match5 && match5[1] && !isToolNameLike(match5[1]) && !STOP_WORDS.has(match5[1].toLowerCase())) {
            return match5[1];
        }

        return null;
    };

    // Check primary user message first
    const fromText = searchInText(text);
    if (fromText) return fromText;

    // Check conversation history in reverse order (most recent first)
    if (Array.isArray(conversation) && conversation.length > 0) {
        for (let i = conversation.length - 1; i >= 0; i--) {
            const msg = conversation[i];
            if (!msg || msg.role === "system") continue;

            // Check message content
            const fromContent = searchInText(msg.content);
            if (fromContent) return fromContent;

            // Check tool calls in assistant messages
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const args = tc.function?.arguments;
                    const parsedArgs = typeof args === "string" ? tryParseJson(args) : args;
                    if (parsedArgs && typeof parsedArgs.planId === "string" && parsedArgs.planId.trim() && !isToolNameLike(parsedArgs.planId)) {
                        return parsedArgs.planId.trim();
                    }
                }
            }
        }
    }

    return null;
}

/**
 * Checks if a value represents an omitted or unspecified optional field from an AI model.
 * Detects null, undefined, empty strings, "null", "undefined", "none", "nan".
 * @param {*} value
 * @returns {boolean}
 */
export function isUnspecifiedOptionalValue(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") {
        const trimmed = value.trim().toLowerCase();
        if (trimmed === "" || trimmed === "null" || trimmed === "undefined" || trimmed === "none" || trimmed === "nan") {
            return true;
        }
    }
    if (typeof value === "number" && Number.isNaN(value)) return true;
    return false;
}

/**
 * Detects if a text represents a study plan retrieval or inspection intent
 * @param {string} text
 * @returns {boolean}
 */
export function isRetrievalIntent(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const clean = text.trim();
    // Common retrieval patterns:
    // e.g. "Retrieve study plan adaptive-demo...", "Show study plan...", "Report every subject...", "Get study plan..."
    const retrievalPatterns = [
        /\b(?:retrieve|get|show|display|inspect|view|report\s+on|report\s+every|fetch)\b.*?\b(?:study\s+plan|plan|subject|metric|progress|session)\b/i,
        /\b(?:study\s+plan|plan)\b.*?\b(?:status|details|progress|overview|report|metrics)\b/i,
        /^(?:retrieve|get|show|display|inspect|view|report|fetch)\b/i
    ];
    // Exclude explicit requests to adapt or modify schedule
    const isExplicitAdapt = /\b(?:adapt|re-?balance|modify\s+schedule|adjust\s+schedule|recalculate)\b/i.test(clean);
    return retrievalPatterns.some(p => p.test(clean)) && !isExplicitAdapt;
}

/**
 * Detects if a text represents a study plan adaptation or rebalancing intent
 * @param {string} text
 * @returns {boolean}
 */
export function isAdaptationIntent(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    return /\b(?:adapt|re-?balance|re-?calculate|adjust\s+(?:remaining\s+)?schedule|update\s+schedule)\b/i.test(text);
}

/**
 * Detects if a text represents a study session recording intent
 * @param {string} text
 * @returns {boolean}
 */
export function isSessionRecordingIntent(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const clean = text.trim();

    // Pure retrieval queries such as "show recorded sessions" or "retrieve sessions" are retrieval intents
    if (isRetrievalIntent(clean) && !/\b(?:record|log|track|mark|enter|add)\b/i.test(clean)) {
        return false;
    }

    const sessionPatterns = [
        /\b(?:record|log|track|mark|enter|add|note)\b.*?\b(?:study\s+session|session|hours?\s+(?:studied|spent)|missed\s+session|completed\s+session)\b/i,
        /\b(?:recorded|logged)\b.*?\b(?:session|hours?\s+studied)\b/i,
        /\b(?:completed|missed)\s+(?:\d+(?:\.\d+)?\s*(?:hours?|hrs?)\s+)?(?:study\s+)?session\b/i,
        /\b(?:record|log)\s+(?:that\s+)?(?:i\s+)?(?:completed|missed|studied|finished)\b/i,
        /\b(?:studied|spent)\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b.*?\b(?:record|log)\b/i
    ];

    return sessionPatterns.some(p => p.test(clean));
}

/**
 * Extracts explicit reason for adjustment provided by user in text
 * @param {string} text
 * @returns {string|null}
 */
export function extractUserReason(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    if (isRetrievalIntent(text)) return null;

    // 1. Explicit reason label: reason: "..." or reason: ...
    const reasonMatch = text.match(/\breason\s*[:=]\s*["']?([^"'\n\.]+)["']?/i);
    if (reasonMatch && reasonMatch[1] && reasonMatch[1].trim()) {
        const r = reasonMatch[1].trim();
        if (!isToolNameLike(r) && !isRetrievalIntent(r)) return r;
    }

    // 2. Text after colon if substantive: e.g. "planId adaptive-demo: missed Mathematics session. Keep exam date unchanged."
    const colonMatch = text.match(/:\s*([A-Za-z0-9\s,\-_]+?)(?:\.|$)/);
    if (colonMatch && colonMatch[1] && colonMatch[1].trim().length > 3) {
        const afterColon = colonMatch[1].trim();
        if (!isToolNameLike(afterColon) && !isRetrievalIntent(afterColon)) return afterColon;
    }

    // 3. "because ..." or "due to ..."
    const becauseMatch = text.match(/\b(?:because|due to|since|as)\s+([^,\.\n]+)/i);
    if (becauseMatch && becauseMatch[1] && becauseMatch[1].trim()) {
        return becauseMatch[1].trim();
    }

    // 4. "missed <subject> session"
    const missedMatch = text.match(/\b(missed\s+[A-Za-z0-9\s\-_]+session[^\.\n]*)/i);
    if (missedMatch && missedMatch[1] && missedMatch[1].trim()) {
        return missedMatch[1].trim();
    }

    return null;
}

/**
 * Aligns the adaptation reason with the user's actual situation and subject,
 * preventing hallucinated subjects (e.g. copying 'physics' from old tool descriptions).
 * Never treats a retrieval request as an adaptation reason.
 * @param {string} modelReason
 * @param {string} userMessage
 * @param {Array} [conversation]
 * @returns {string}
 */
export function alignAdaptationReason(modelReason, userMessage, conversation = []) {
    const textToScan = [
        userMessage,
        ...(Array.isArray(conversation) ? conversation.filter(m => m && m.role !== "system").map(m => m.content || "") : [])
    ].filter(Boolean).join(" ");

    // If there is no user text at all to scan, we have no user context to override
    if (!textToScan.trim()) {
        if (typeof modelReason === "string" && !isRetrievalIntent(modelReason)) {
            return modelReason.trim();
        }
        return "Progress adaptation and schedule re-balancing";
    }

    const explicitUserReason = extractUserReason(userMessage) || extractUserReason(textToScan);

    const knownSubjects = ["mathematics", "math", "physics", "chemistry", "biology", "history", "english"];
    const mentionedSubjects = knownSubjects.filter(sub => {
        const regex = new RegExp(`\\b${sub}\\b`, "i");
        return regex.test(textToScan);
    });

    if (typeof modelReason === "string" && !isRetrievalIntent(modelReason)) {
        const cleanModelReason = modelReason.trim();
        const modelHasPhysics = /\bphysics\b/i.test(cleanModelReason);
        const userHasPhysics = /\bphysics\b/i.test(textToScan);

        // If model output hallucinated physics from schema description example when user did not mention physics:
        if (modelHasPhysics && !userHasPhysics) {
            if (explicitUserReason) {
                return explicitUserReason;
            }
            if (mentionedSubjects.length > 0) {
                const actualSubject = mentionedSubjects[0].charAt(0).toUpperCase() + mentionedSubjects[0].slice(1);
                return cleanModelReason.replace(/\bphysics\b/gi, actualSubject);
            }
            return "Progress adaptation and schedule re-balancing";
        }

        if (cleanModelReason) {
            return cleanModelReason;
        }
    }

    if (explicitUserReason) {
        return explicitUserReason;
    }

    if (mentionedSubjects.length > 0) {
        const actualSubject = mentionedSubjects[0].charAt(0).toUpperCase() + mentionedSubjects[0].slice(1);
        return `Recovering missed ${actualSubject} study session`;
    }

    return "Progress adaptation and schedule re-balancing";
}

/**
 * Checks if the user explicitly requested to keep their exam date unchanged
 * @param {string} text
 * @returns {boolean}
 */
export function userExplicitlyKeptExamDateUnchanged(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const lower = text.toLowerCase();
    const unchangedPatterns = [
        /\b(?:keep|keeping)\s+(?:the\s+|my\s+|our\s+|existing\s+|current\s+)?exam\s+date\s+unchanged\b/i,
        /\bexam\s+date\s+(?:is\s+|remains?\s+|to\s+be\s+|kept\s+)?unchanged\b/i,
        /\b(?:do\s+not|don't|without|never|no\s+need\s+to)\s+(?:change|changing)\s+(?:the\s+|my\s+|our\s+|existing\s+|current\s+)?exam\s+date\b/i,
        /\b(?:keep|keeping)\s+(?:the\s+|my\s+|our\s+|existing\s+|current\s+)?exam\s+date\b/i,
        /\b(?:same|current|existing)\s+exam\s+date\b/i,
        /\bexam\s+date\s+(?:the\s+)?same\b/i,
        /\b(?:leave|leaving)\s+(?:the\s+|my\s+|our\s+|existing\s+)?exam\s+date\s+(?:as\s+is|unchanged|the\s+same)\b/i,
        /\bno\s+change\s+to\s+(?:the\s+|my\s+|our\s+)?exam\s+date\b/i
    ];
    return unchangedPatterns.some(p => p.test(lower));
}

/**
 * Checks if a specific date in the text is associated with a study session or missed session
 * @param {string} dateStr
 * @param {string} text
 * @returns {boolean}
 */
export function isDateAssociatedWithSession(dateStr, text) {
    if (typeof dateStr !== "string" || !dateStr.trim() || typeof text !== "string") return false;
    const cleanDate = dateStr.trim();
    const pattern = new RegExp(
        `(?:session|missed|studied|study|class|completed)[^.\\n]{0,60}\\b${cleanDate}\\b|\\b${cleanDate}\\b[^.\\n]{0,60}(?:session|missed|studied|study|class|completed)`,
        "i"
    );
    return pattern.test(text);
}

/**
 * Checks if the user explicitly requested a new or updated exam date
 * @param {string} text
 * @param {string} [targetDate]
 * @returns {boolean}
 */
export function hasExplicitNewExamDateRequest(text, targetDate) {
    if (typeof text !== "string" || !text.trim()) return false;
    const datePattern = (typeof targetDate === "string" && targetDate.trim())
        ? `(?:${targetDate.trim()})`
        : `\\d{4}-\\d{2}-\\d{2}`;
    const patterns = [
        new RegExp(`\\b(?:new|updated)\\s+exam\\s+date\\s*[:=]?\\s*${datePattern}`, "i"),
        new RegExp(`\\bexam\s+date\s*(?:is|to|on)\\s*[:=]?\\s*${datePattern}`, "i"),
        new RegExp(`\\b(?:change|move|reschedule|postpone|shift|set|update)\\s+(?:the\s+|my\s+)?exam\s+date\s+(?:to|is)\\s+${datePattern}`, "i"),
        new RegExp(`\\bexam\\s+(?:is\\s+)?(?:postponed|rescheduled|moved)\\s+to\\s+${datePattern}`, "i"),
        new RegExp(`\\bexam\\s+on\\s+${datePattern}`, "i")
    ];
    return patterns.some(p => p.test(text));
}

/**
 * Determines if newExamDate should be omitted during adapt_study_plan argument normalization
 * @param {string} rawExamDate
 * @param {string} userText
 * @param {Array} [conversation]
 * @returns {boolean}
 */
export function shouldOmitAdaptationExamDate(rawExamDate, userText, conversation = []) {
    if (!userText && (!Array.isArray(conversation) || conversation.length === 0)) {
        return false;
    }

    const textToScan = [
        userText,
        ...(Array.isArray(conversation) ? conversation.filter(m => m && m.role !== "system").map(m => m.content || "") : [])
    ].filter(Boolean).join(" ");

    if (!textToScan.trim()) {
        return false;
    }

    // 1. User explicitly requested keeping the exam date unchanged:
    // ALWAYS omit newExamDate regardless of any dates mentioned elsewhere
    if (userExplicitlyKeptExamDateUnchanged(textToScan)) {
        return true;
    }

    // 2. Date is associated with a missed session or study session:
    // NEVER infer newExamDate from a session date
    if (typeof rawExamDate === "string" && isDateAssociatedWithSession(rawExamDate, textToScan)) {
        return true;
    }

    // 3. User never requested changing the exam date:
    // If there is no explicit request to update the exam date, omit newExamDate
    if (typeof rawExamDate === "string" && !hasExplicitNewExamDateRequest(textToScan, rawExamDate)) {
        return true;
    }

    return false;
}

/**
 * Determines if newDailyAvailableHours should be omitted during adapt_study_plan argument normalization
 * @param {number|string} rawHours
 * @param {string} userText
 * @param {Array} [conversation]
 * @returns {boolean}
 */
export function shouldOmitDailyHours(rawHours, userText, conversation = []) {
    if (!userText && (!Array.isArray(conversation) || conversation.length === 0)) {
        return false;
    }

    const textToScan = [
        userText,
        ...(Array.isArray(conversation) ? conversation.filter(m => m && m.role !== "system").map(m => m.content || "") : [])
    ].filter(Boolean).join(" ");

    if (!textToScan.trim()) {
        return false;
    }

    const unchangedPatterns = [
        /\bkeep\s+(?:the\s+|my\s+|our\s+|existing\s+|current\s+)?(?:daily\s+)?(?:availability|hours|study\s+hours)\s+unchanged\b/i,
        /\b(?:daily\s+)?(?:availability|hours|study\s+hours)\s+(?:is\s+|remains?\s+|to\s+be\s+|kept\s+)?unchanged\b/i,
        /\b(?:do\s+not|don't|without|never|no\s+need\s+to)\s+change\s+(?:the\s+|my\s+|our\s+)?(?:daily\s+)?(?:availability|hours)\b/i,
        /\b(?:same|current|existing)\s+(?:daily\s+)?(?:availability|hours)\b/i
    ];

    return unchangedPatterns.some(p => p.test(textToScan));
}

/**
 * Normalizes tool arguments against an MCP tool's inputSchema
 * @param {Object} toolOrSchema - MCP tool definition with inputSchema, or inputSchema directly
 * @param {Object} rawArgs - Raw arguments object generated by AI model
 * @param {Object} [options] - Optional normalization options (context, userMessage, knownTools)
 * @returns {Object} Normalized arguments object
 */
export function normalizeToolArguments(toolOrSchema, rawArgs = {}, options = {}) {
    if (!rawArgs || typeof rawArgs !== "object") return {};

    const schema = toolOrSchema?.inputSchema || toolOrSchema || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = schema.properties || {};
    const normalized = {};

    for (const [key, value] of Object.entries(rawArgs)) {
        const propDef = properties[key];
        const isRequired = required.includes(key);

        // Omission rule for optional arguments:
        // If an optional property is unspecified (null, undefined, empty string, "null", "undefined"),
        // omit the property entirely so that defaults or existing plan values are preserved!
        if (!isRequired && isUnspecifiedOptionalValue(value)) {
            // Do not process into normalized; omit completely
            // Exception: planId may still be extracted from user prompt context in Section 7 below
            if (key !== "planId") {
                continue;
            }
        }

        const expectedType = getExpectedType(propDef);

        // 1. Array handling: parse JSON string if string, or clean array
        if (expectedType === "array") {
            if (typeof value === "string") {
                const parsedJson = tryParseJson(value);
                if (Array.isArray(parsedJson)) {
                    normalized[key] = cleanStringArray(parsedJson);
                    continue;
                }
                // Comma-separated list fallback
                normalized[key] = cleanStringArray(value.split(","));
                continue;
            } else if (Array.isArray(value)) {
                normalized[key] = cleanStringArray(value);
                continue;
            }
        }

        // 2. Object handling: parse JSON string if string, or clean object
        if (expectedType === "object") {
            if (typeof value === "string") {
                const parsedJson = tryParseJson(value);
                if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) {
                    normalized[key] = cleanObject(parsedJson);
                    continue;
                }
            } else if (value && typeof value === "object" && !Array.isArray(value)) {
                normalized[key] = cleanObject(value);
                continue;
            }
        }

        // 3. Number / Integer handling: convert numeric strings ONLY when schema expects number/integer
        if (expectedType === "number" || expectedType === "integer") {
            if (typeof value === "string" && value.trim() !== "") {
                const parsedNum = Number(value.trim());
                if (Number.isFinite(parsedNum)) {
                    normalized[key] = expectedType === "integer" ? Math.round(parsedNum) : parsedNum;
                    continue;
                }
            } else if (typeof value === "number") {
                normalized[key] = expectedType === "integer" ? Math.round(value) : value;
                continue;
            }
        }

        // 4. String handling: strictly preserve normal strings (dates, IDs, enum values, descriptions)
        if (expectedType === "string") {
            if (typeof value === "string") {
                let strVal = value;
                if ((strVal.startsWith('"') && strVal.endsWith('"')) || (strVal.startsWith("'") && strVal.endsWith("'"))) {
                    try {
                        const parsed = JSON.parse(strVal);
                        if (typeof parsed === "string") strVal = parsed;
                    } catch {
                        strVal = strVal.replace(/^["']+|["']+$/g, "");
                    }
                }
                normalized[key] = strVal;
                continue;
            }
            normalized[key] = String(value);
            continue;
        }

        // 5. Boolean handling
        if (expectedType === "boolean") {
            if (typeof value === "string") {
                const lower = value.trim().toLowerCase();
                if (lower === "true") {
                    normalized[key] = true;
                    continue;
                }
                if (lower === "false") {
                    normalized[key] = false;
                    continue;
                }
            }
            normalized[key] = Boolean(value);
            continue;
        }

        // 6. Unknown / Untyped property fallback: attempt safe JSON parse if clearly encoded object or array
        if (typeof value === "string") {
            const parsedJson = tryParseJson(value);
            if (parsedJson !== null) {
                normalized[key] = Array.isArray(parsedJson) ? cleanStringArray(parsedJson) : cleanObject(parsedJson);
                continue;
            }
        }

        // Preserves normal values (e.g. strings, un-typed values) as-is
        normalized[key] = value;
    }

    // 7. Context-Aware Plan Identifier Resolution
    // If the tool schema accepts planId, ensure explicit user-specified plan identifiers
    // are faithfully preserved and never displaced by hallucinated tool-name strings.
    if (properties.planId) {
        const userPlanId = extractExplicitPlanId(
            options.message || options.userMessage,
            options.messages || options.conversation || options.context
        );
        const currentVal = normalized.planId;
        const isToolName = currentVal && isToolNameLike(currentVal, options.knownTools);

        if (userPlanId) {
            // User explicitly requested a specific plan ID in prompt/conversation.
            // If model generated a tool name, omitted planId, or generated "default",
            // restore the user's explicit plan ID!
            if (isToolName || !currentVal || currentVal === "default") {
                normalized.planId = userPlanId;
            }
        }
        // NOTE: If NO explicit userPlanId was provided, but model generated a tool-name like string,
        // we DO NOT replace it with "default"! We leave it so validation or MCP can reject it honestly.
    }

    // 8. Reason & Subject Fidelity for adapt_study_plan
    const toolName = toolOrSchema?.name || schema?.name || "";
    if (toolName === "adapt_study_plan" || properties.newExamDate) {
        if (normalized.reason) {
            normalized.reason = alignAdaptationReason(
                normalized.reason,
                options.message || options.userMessage,
                options.messages || options.conversation || options.context
            );
        }
    }

    // 9. Date inference guard & optional adaptation fields omission
    if (toolName === "adapt_study_plan" || properties.newExamDate) {
        const userText = options.message || options.userMessage;
        const conversation = options.messages || options.conversation || options.context;

        if (normalized.newExamDate !== undefined) {
            if (shouldOmitAdaptationExamDate(normalized.newExamDate, userText, conversation)) {
                delete normalized.newExamDate;
            }
        }

        if (normalized.newDailyAvailableHours !== undefined) {
            if (shouldOmitDailyHours(normalized.newDailyAvailableHours, userText, conversation)) {
                delete normalized.newDailyAvailableHours;
            }
        }
    }

    return normalized;
}


