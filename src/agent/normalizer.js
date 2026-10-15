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
    const isDateLikeOrPlaceholder = (value, sourceText = "", start = -1) => {
        const token = String(value || "");
        const monthDate = new RegExp(`\\b${token}\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}\\b`, "i");
        const durationAfterNumber = start >= 0 && new RegExp(`^${token}\\s*(?:hours?|hrs?|days?|weeks?)\\b`, "i").test(sourceText.slice(start));
        return /(?:\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|exam[_-]?date|your[_-]|placeholder|plan[_-]?id)/i.test(token) ||
            /^\d+(?:\.\d+)?(?:h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i.test(token) ||
            durationAfterNumber ||
            (start >= 0 && monthDate.test(sourceText.slice(start, start + token.length + 24)));
    };
    const STOP_WORDS = new Set([
        "for", "to", "is", "and", "the", "with", "from", "on", "a", "an", "that", "this",
        "my", "our", "new", "each", "details", "data", "changes", "now", "because",
        "so", "as", "if", "when", "while", "please", "report", "show", "get", "retrieve",
        "progress", "date", "exam", "examdate", "exam_date", "exam-date",
        "id", "identifier", "number", "name", "planid", "plan_id",
        "remaining", "hours", "hour", "status", "schedule", "workload", "overview", "metrics"
    ]);
    // These are ordinary references to a plan, not identifiers. Keep this
    // separate from STOP_WORDS so a user can still explicitly choose one as
    // an ID (for example, "plan ID: these").
    const GENERIC_PLAN_REFERENCE_WORDS = new Set(["these", "those", "all", "any", "existing", "current"]);

    const searchInText = (t) => {
        if (typeof t !== "string" || !t.trim()) return null;

        // 1. Explicit planId / plan_id patterns:
        // e.g. planId "adaptive-demo", planId: adaptive-demo, plan_id='custom-plan'
        const planIdRegex = /\bplan(?:_?id)\s*[:=]?\s*["']?([a-zA-Z0-9_\-]+)["']?/i;
        const match1 = t.match(planIdRegex);
        if (match1 && match1[1] && !isDateLikeOrPlaceholder(match1[1], t, match1.index + match1[0].lastIndexOf(match1[1])) && !isToolNameLike(match1[1]) && !STOP_WORDS.has(match1[1].toLowerCase())) {
            return match1[1];
        }

        // "plan ID 2" is a labeled identifier, not a plan whose ID is "ID".
        // Match the value after the label before the broader "plan <name>" matcher.
        const labeledPlanIdRegex = /\bplan\s+(?:with\s+)?(?:id|identifier|number)\s*[:=#]?\s*["']?([a-zA-Z0-9_\-]+)["']?/i;
        const labeledMatch = t.match(labeledPlanIdRegex);
        if (labeledMatch && labeledMatch[1] && !isDateLikeOrPlaceholder(labeledMatch[1], t, labeledMatch.index + labeledMatch[0].lastIndexOf(labeledMatch[1])) && !isToolNameLike(labeledMatch[1]) && !STOP_WORDS.has(labeledMatch[1].toLowerCase())) {
            return labeledMatch[1];
        }

        // 2. "study plan <name>" or "plan <name>" with quotes:
        // e.g. study plan "adaptive-demo", for plan adaptive-demo, in plan "my-plan"
        const planNameRegex = /(?:study\s+plan|study-plan|plan)\s+["']([a-zA-Z0-9_\-]+)["']/i;
        const match2 = t.match(planNameRegex);
        if (match2 && match2[1] && !isDateLikeOrPlaceholder(match2[1], t, match2.index + match2[0].lastIndexOf(match2[1])) && !isToolNameLike(match2[1]) && !STOP_WORDS.has(match2[1].toLowerCase())) {
            return match2[1];
        }

        // 3. Verbs / prepositions followed by (study) plan <identifier> (unquoted identifier):
        // e.g. "Retrieve study plan adaptive-demo", "Adapt study plan adaptive-demo", "for study plan custom-123",
        // "Please adapt study plan for plan physics-intensive"
        const planWordMatches = [...t.matchAll(/(?:(?:retrieve|get|show|view|inspect|report\s+on|adapt|rebalance|modify|update|for|in|from|to|with|of)\s+)?\b(?:study\s+plan|study-plan|plan)\b\s+(?:(?:for|with|named|called)\s+(?:plan\s+)?)?([a-zA-Z0-9_\-]+)/gi)];
        for (const m of planWordMatches) {
            const candidate = m[1];
            const candidateOffset = m[0].lastIndexOf(candidate);
            const prefix = m[0].slice(0, candidateOffset);
            // "study plan for Mathematics" describes the plan's subject, not its ID.
            // Require an explicit "for plan" / named marker when a preposition
            // separates the plan name from its identifier.
            const ambiguousPreposition = /\b(?:study\s+plan|study-plan|plan)\s+(?:for|with)\s*$/i.test(prefix) &&
                !/\b(?:for|with)\s+plan\s*$/i.test(prefix) &&
                !/\b(?:named|called)\s*$/i.test(prefix) &&
                !/[-_\d]/.test(candidate);
            if (ambiguousPreposition) continue;
            if (candidate && !isDateLikeOrPlaceholder(candidate, t, m.index + candidateOffset) && !isToolNameLike(candidate) && !STOP_WORDS.has(candidate.toLowerCase()) && !GENERIC_PLAN_REFERENCE_WORDS.has(candidate.toLowerCase())) {
                return candidate;
            }
        }

        // 5. Assistant confirmation message: Study plan "<planId>" created successfully!
        const confirmRegex = /Study\s+plan\s+["']([a-zA-Z0-9_\-]+)["']\s+created\s+successfully/i;
        const match5 = t.match(confirmRegex);
        if (match5 && match5[1] && !isDateLikeOrPlaceholder(match5[1], t, match5.index + match5[0].lastIndexOf(match5[1])) && !isToolNameLike(match5[1]) && !STOP_WORDS.has(match5[1].toLowerCase())) {
            return match5[1];
        }

        return null;
    };

    // Check primary user message first
    const fromText = searchInText(text);
    if (fromText) return fromText;

    // Check conversation history in reverse order (most recent first)
    if (Array.isArray(conversation) && conversation.length > 0) {
        let currentUserTurnPassed = false;
        for (let i = conversation.length - 1; i >= 0; i--) {
            const msg = conversation[i];
            if (!msg || msg.role === "system") continue;

            if (msg.role === "user") {
                if (!currentUserTurnPassed && (!text || msg.content === text)) {
                    currentUserTurnPassed = true;
                    continue;
                }
                // A prior user turn separates older tool results from the current
                // intent; do not reuse an ID across that boundary.
                break;
            }

            // Only use IDs returned by a successful tool result. Assistant text and
            // tool-call arguments can contain model-proposed or stale identifiers.
            if (msg.role === "tool" && typeof msg.content === "string") {
                const result = tryParseJson(msg.content);
                if (result && typeof result.planId === "string" && result.planId.trim() && !isDateLikeOrPlaceholder(result.planId) && !isToolNameLike(result.planId)) {
                    return result.planId.trim();
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
 * Detects if a text explicitly requests retrieval or inspection of a study plan
 * @param {string} text
 * @returns {boolean}
 */
export function hasExplicitPlanRetrievalRequest(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    return /\b(?:retrieve|get|fetch|inspect)\b.*?\b(?:study\s+plan|plan)\b/i.test(text) ||
        /\b(?:show|display|view)\s+(?:the\s+|my\s+)?(?:full\s+|entire\s+|whole\s+|complete\s+|updated\s+|current\s+|revised\s+|latest\s+)?(?:study\s+plan|plan)\b/i.test(text) ||
        /\b(?:full|entire|complete|whole)\s+study\s+plan\b/i.test(text) ||
        /\b(?:report\s+on|report\s+every)\s+(?:subject|study\s+plan)\b/i.test(text) ||
        /\b(?:subject(?:-wise|-by-subject|\s+wise|\s+by\s+subject)?\s+breakdown|breakdown\s+of\s+all\s+subjects)\b/i.test(text);
}

/**
 * Detects if a text represents an educational or conceptual tutoring request
 * (e.g. explaining CS algorithms, concepts, code snippets, math formulas, general academic questions)
 * rather than a StudyPilot operational command (create/get/adapt/record plan).
 */
export function isEducationalTutoringIntent(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const clean = text.trim();

    // 1. Study plan operational requests must never be misclassified as passive tutoring
    if (/\b(?:study\s+plan|prep\s+plan|exam\s+date|log\s+session|record\s+session|adapt\s+plan|rebalance\s+schedule)\b/i.test(clean)) {
        return false;
    }

    // 2. Explicit quiz generation requests must delegate to the create_quiz MCP tool
    if (/\b(?:quiz|quizzes)\b/i.test(clean) && /\b(?:create|generate|start|build|make|run|give\s+me\s+a)\b/i.test(clean)) {
        return false;
    }

    const educationalPatterns = [
        // Conceptual Q&A & explanations
        /\b(?:explain|what\s+is|what\s+are|how\s+does|how\s+do|why\s+does|how\s+to\s+solve|teach\s+me|help\s+me\s+understand|give\s+me\s+(?:an?\s+)?overview\s+of)\b/i,
        /\b(?:difference\s+between|compare\s+and\s+contrast|versus|\bvs\.?\b)\b/i,
        /\b(?:in\s+simple\s+terms|for\s+beginners?|beginner-friendly|step\s*-\s*by\s*-\s*step|deep\s+dive|advanced\s+overview)\b/i,
        // Coding, programming, debugging & exercises
        /\b(?:example|code|sample|syntax|implementation)\s+(?:of|for|in|showing|demonstrating)\b/i,
        /\b(?:write|debug|fix|analyze|troubleshoot|solve)\s+(?:a\s+)?(?:python|c\+\+|javascript|java|rust|go|c|sql|html|css)?\s*(?:code|program|function|script|error|bug|issue|exception)\b/i,
        /\b(?:help\s+me\s+debug|why\s+does\s+(?:this|my)\b|error\b|exception\b|nullpointer|stack\s*overflow|syntaxerror|runtime\s*error|segmentation\s*fault)\b/i,
        /\b(?:exercise|exercises|practice\s+problems?|practice\s+questions?|viva\s+questions?|interview\s+questions?)\b/i,
        // Computer Science & Software Engineering
        /\b(?:recursion|recursive|binary\s+search|bfs|dfs|dynamic\s+programming|dijkstra|deadlock|semaphore|mutex|concurrency|multithreading|time\s+complexity|big\s+o|asymptotic|sorting\s+algorithm|bubble\s+sort|merge\s+sort|quick\s+sort)\b/i,
        /\b(?:normalization|normal\s+form|1nf|2nf|3nf|bcnf|acid\s+properties|transactions?|sql\s+query|indexing|b-tree|foreign\s+key)\b/i,
        /\b(?:tcp|udp|osi\s+model|dns|http|ip\s+address|subnetting|packet|socket|routing)\b/i,
        /\b(?:virtual\s+memory|paging|page\s+fault|cpu\s+scheduling|process\s+vs\s+thread|context\s+switch)\b/i,
        /\b(?:machine\s+learning|gradient\s+descent|neural\s+network|deep\s+learning|supervised|unsupervised|classification|regression)\b/i,
        // Mathematics & Aptitude
        /\b(?:calculus|derivative|integral|eigenvalues?|eigenvectors?|matrix\s+multiplication|linear\s+algebra|differential\s+equations?|probability|bayes|normal\s+distribution)\b/i,
        /\b(?:algebra|permutation|combination|discrete\s+mathematics|graph\s+theory|combinatorics|arithmetic|syllogism|logical\s+reasoning|aptitude|profit\s+and\s+loss|speed\s+and\s+distance)\b/i,
        // Natural & Physical Sciences
        /\b(?:photosynthesis|newton'?s\s+laws?|thermodynamics|quantum|mitochondria|dna\s+replication|periodic\s+table)\b/i
    ];

    return educationalPatterns.some(p => p.test(clean));
}


/**
 * Detects if a text represents a study plan retrieval or inspection intent
 * @param {string} text
 * @returns {boolean}
 */
export function isRetrievalIntent(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const clean = text.trim();

    if (isEducationalTutoringIntent(clean)) {
        return false;
    }

    const isPlanCreation = /\b(?:create|make|build|generate)\b.{0,60}\b(?:study\s+plan|plan)\b/i.test(clean);
    if (isPlanCreation && !hasExplicitPlanRetrievalRequest(clean)) return false;

    // Adaptation phrases must not be redirected to retrieval.
    if (isAdaptationIntent(clean)) return false;

    // For session recording requests, treat as retrieval intent only if the user
    // ALSO explicitly requested a separate study plan retrieval
    if (isSessionRecordingIntent(clean)) {
        return hasExplicitPlanRetrievalRequest(clean);
    }

    const retrievalPatterns = [
        /\b(?:my|the)\s+exam\s+(?:is\s+on\s+)?(?:date|day)\b/i,
        /\bmy\s+exam\s+is\s+on\b.*\b(?:right|correct|isn't\s+it|is\s+it)\b/i,
        /\b(?:is|was)\s+my\s+exam\s+on\b/i,
        /\b(?:retrieve|get|show|display|inspect|view|report\s+on|report\s+every|fetch)\b.*?\b(?:study\s+plan|plan|subject|metric|progress|session)\b/i,
        /\b(?:study\s+plan|plan)\b.*?\b(?:status|details|progress|overview|report|metrics)\b/i,
        /^(?:retrieve|get|show|display|inspect|view|report|fetch)\b/i
    ];

    return retrievalPatterns.some(p => p.test(clean));
}

/** Identifies explicit requests to enumerate saved plans, without involving the model. */
export function isPlanListingIntent(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const clean = text.trim();
    if (/\b(?:create|make|build|generate|start|prepare)\b.{0,60}\b(?:study\s+)?plans?\b/i.test(clean)) return false;
    return /\b(?:all|every|each)\b.{0,35}\b(?:my\s+|saved\s+|created\s+|study\s+)?plans?\b/i.test(clean) ||
        /\b(?:plans?|study\s+plans?)\b.{0,35}\b(?:created|saved|stored)\b/i.test(clean) ||
        /\b(?:list|give|provide)\b.{0,35}\b(?:all\s+|my\s+|saved\s+|created\s+|study\s+)?plans?\b/i.test(clean) ||
        /\b(?:show|display)\b.{0,35}\b(?:all|my|saved|created)\s+(?:study\s+)?plans\b/i.test(clean);
}

/**
 * Detects if a text represents a study plan adaptation or rebalancing intent
 * @param {string} text
 * @returns {boolean}
 */
export function isAdaptationIntent(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    return /\b(?:adapt|re-?balance|re-?calculate)\b|\b(?:adjust|update|modify|change)\b.{0,30}\b(?:schedule|study\s+plan|plan)\b/i.test(text);
}

/**
 * Detects if a text represents a study session recording intent
 * @param {string} text
 * @returns {boolean}
 */
export function isSessionRecordingIntent(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const clean = text.trim();

    // Pure retrieval queries such as "show recorded sessions", "view sessions", or "list recorded sessions"
    // are retrieval queries, not recording actions
    const isPureSessionHistoryQuery = /^(?:show|retrieve|get|display|view|list|inspect|report)\b/i.test(clean) &&
        !/\b(?:record|log|track|mark|enter|add)\b/i.test(clean);
    if (isPureSessionHistoryQuery) {
        return false;
    }

    if (isMultiDayCompletionStatement(clean)) {
        return false;
    }

    const sessionPatterns = [
        /\b(?:i\s+)?missed\s+(?:plan\s+)?day\s*\d+\b/i,
        /\bday\s*\d+\s+(?:was\s+)?missed\b/i,
        /\b(?:record|log|track|mark|enter|add|note)\b.*?\b(?:study\s+session|session|hours?\s+(?:studied|spent)|missed\s+session|completed\s+session)\b/i,
        /\b(?:recorded|logged)\b.*?\b(?:session|hours?\s+studied)\b/i,
        /\b(?:completed|missed)\s+(?:\d+(?:\.\d+)?\s*(?:hours?|hrs?)\s+)?(?:study\s+)?session\b/i,
        /\b(?:record|log)\s+(?:that\s+)?(?:i\s+)?(?:completed|missed|studied|finished)\b/i,
        /\b(?:studied|spent)\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b.*?\b(?:record|log)\b/i,
        /\b(?:record|log|track|mark|enter|add|note)\b.*?\bday\s*\d+\b/i,
        /\bday\s*\d+\b.*?\b(?:completed|done|finished|studied|only)?\s*\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b/i,
        /\b(?:record|log|track|mark|enter|add)\b.*?\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b/i,
        /\b(?:completed|finished|studied)\b.*?\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b/i
    ];

    return sessionPatterns.some(p => p.test(clean));
}

/** Detect a multi-day completion claim that needs per-day session details. */
export function isMultiDayCompletionStatement(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    return /\b\d+\s+(?:study\s+)?days?\s+(?:were\s+)?(?:completed|finished|done|studied)\b|\b(?:completed|finished|did|studied)\s+\d+\s+(?:study\s+)?days?\b/i.test(text);
}

/** True when a short user reply answers an outstanding study-plan creation question. */
export function isPlanCreationContinuation(text, conversation = []) {
    if (typeof text !== "string" || text.trim().length > 100 || !Array.isArray(conversation)) return false;
    if (/\b(?:create|make|build|generate|retrieve|get|fetch|show|view|record|adapt|adjust)\b.{0,50}\b(?:plan|session|schedule)\b/i.test(text)) return false;
    const lastAssistantIndex = conversation.map(item => item?.role).lastIndexOf("assistant");
    if (lastAssistantIndex < 0) return false;
    const lastAssistant = String(conversation[lastAssistantIndex]?.content || "");
    if (!/[?？]/.test(lastAssistant) && !/\b(?:could you|please (?:provide|tell|let me know)|let me know|which subject|what subject)\b/i.test(lastAssistant)) return false;

    let lastCreateCompletion = -1;
    for (let i = 0; i < lastAssistantIndex; i++) {
        if (conversation[i]?.role === "assistant" && /\b(?:plan|study plan)\b.{0,50}\bcreated successfully\b|\bcreated successfully\b.{0,50}\b(?:plan|plan ID)\b/i.test(String(conversation[i].content || ""))) {
            lastCreateCompletion = i;
        }
    }
    const priorCreate = conversation.slice(lastCreateCompletion + 1, lastAssistantIndex).some(item =>
        item?.role === "user" && (
            /\b(?:create|make|build|generate|set up|start)\b.{0,100}\b(?:study\s+plan|plan|schedule)\b/i.test(String(item.content || "")) ||
            /\b(?:want to study|plan to study|need to study|study for|prepare for)\b/i.test(String(item.content || ""))
        )
    );
    const asksCreationDetails = /\b(?:study\s+plan|plan|subject|daily|hours?|duration|days?|week|identifier|plan\s+id)\b/i.test(lastAssistant);
    return priorCreate && asksCreationDetails;
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
    const isoDate = extractExplicitDate(dateStr.trim());
    if (!isoDate) return false;
    const [year, month, day] = isoDate.split("-").map(Number);
    const monthName = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" })
        .format(new Date(Date.UTC(year, month - 1, day)));
    const datePattern = `(?:${isoDate}|${monthName}\\s+${day}(?:st|nd|rd|th)?[,]?\\s+${year}|${day}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthName}[,]?\\s+${year})`;
    const pattern = new RegExp(
        `(?:session|missed|studied|study|class|completed)[^.\\n]{0,80}\\b${datePattern}\\b|\\b${datePattern}\\b[^.\\n]{0,80}(?:session|missed|studied|study|class|completed)`,
        "i"
    );
    return pattern.test(text);
}

/** Return the explicit calendar date associated with a session in the request. */
export function extractExplicitSessionDate(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    const dateToken = /\b\d{4}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)[,]?\s+\d{4}\b/gi;
    for (const match of text.matchAll(dateToken)) {
        const normalizedDate = extractExplicitDate(match[0]);
        if (normalizedDate && isDateAssociatedWithSession(normalizedDate, text)) return normalizedDate;
    }
    return null;
}

/** Return a user-mentioned numbered plan day, such as "Day 2". */
export function extractExplicitPlanDayNumber(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    const match = text.match(/\bday\s*(\d+)\b/i);
    return match ? Number(match[1]) : null;
}

/** Extract a missed amount and intended session duration when the user states them. */
export function extractExplicitMissedSessionHours(text) {
    if (typeof text !== "string" || !text.trim()) return { missedHours: null, scheduledHours: null };
    const missedMatch = text.match(/\bmissed\s+(?:a\s+)?(\d+(?:\.\d+)?)\s*(?:-\s*)?(?:hours?|hrs?)\b|\b(\d+(?:\.\d+)?)\s*(?:-\s*)?(?:hours?|hrs?)[^.\n]{0,50}\bmissed\b/i);
    const scheduledMatch = text.match(/\b(\d+(?:\.\d+)?)\s*-\s*(?:hours?|hrs?)[^.\n]{0,50}\b(?:study\s+)?session\b|\b(?:scheduled|session)\b[^.\n]{0,50}\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i);
    // Both missed-duration alternatives are explicit amounts; use the first match.
    const missedHours = missedMatch ? Number(missedMatch.slice(1).find(Boolean)) : null;
    let scheduledHours = scheduledMatch ? Number(scheduledMatch.slice(1).find(Boolean)) : null;
    if (scheduledHours === null && missedHours !== null) scheduledHours = missedHours;
    return { missedHours, scheduledHours };
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
    if (patterns.some(p => p.test(text))) return true;
    const explicitDate = extractExplicitDate(text);
    const explicitlyChanging = /\b(?:change|move|reschedule|postpone|shift|set|update)\b.{0,40}\b(?:exam\s+date|exam)\b|\bnew\s+exam\s+date\b/i.test(text);
    return Boolean(explicitlyChanging && explicitDate && targetDate && explicitDate === targetDate);
}

/**
 * Determines if newExamDate should be omitted during adapt_study_plan argument normalization
 * @param {string} rawExamDate
 * @param {string} userText
 * @param {Array} [conversation]
 * @returns {boolean}
 */
export function shouldOmitAdaptationExamDate(rawExamDate, userText, conversation = []) {
    const textToScan = typeof userText === "string" ? userText : "";

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
    const textToScan = typeof userText === "string" ? userText : "";

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
 * Determines if session date should be omitted during record_study_session argument normalization.
 * If user requested "today", or relative date keywords are passed, or if model generated an unmentioned date (e.g. 2024-01-01),
 * omitting the date allows the tool default (current date) to apply safely.
 * @param {string} rawDate
 * @param {string} userText
 * @param {Array} [conversation]
 * @returns {boolean}
 */
export function shouldOmitSessionDate(rawDate, userText = "", conversation = []) {
    if (rawDate === undefined || rawDate === null) return true;
    if (typeof rawDate === "string") {
        const clean = rawDate.trim().toLowerCase();
        // 1. Literal relative date keywords or empty/null values
        if (clean === "today" || clean === "now" || clean === "current" || clean === "null" || clean === "undefined" || clean === "") {
            return true;
        }

        const textToScan = typeof userText === "string" ? userText : "";
        // A second normalization pass with no user turn is a transport boundary;
        // preserve the already-normalized date instead of treating it as a guess.
        if (!textToScan.trim()) return false;
        const explicitSessionDate = extractExplicitSessionDate(textToScan);

        // 2. If the user explicitly wrote this date in their prompt, preserve it!
        if (explicitSessionDate && extractExplicitDate(rawDate.trim()) === explicitSessionDate) {
            return false;
        }

        // 3. If user prompt specifically asks for "today" (or does not contain any YYYY-MM-DD date),
        // and model generated an unmentioned date (like "2024-01-01"), omit it so the server defaults to today.
        const hasExplicitDateInText = Boolean(explicitSessionDate && extractExplicitDate(rawDate.trim()) === explicitSessionDate);
        if (!hasExplicitDateInText || /\btoday\b/i.test(textToScan)) {
            return true;
        }
    }
    return false;
}

function extractExplicitDate(text) {
    const iso = String(text || "").match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    let year;
    let month;
    let day;
    if (iso) {
        [, year, month, day] = iso;
    } else {
        const natural = String(text || "").match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/i);
        if (!natural) return null;
        const monthIndex = new Date(`${natural[1]} 1, 2000`).getMonth() + 1;
        year = natural[3];
        month = String(monthIndex).padStart(2, "0");
        day = natural[2].padStart(2, "0");
    }
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    const candidate = new Date(Date.UTC(y, m - 1, d));
    // Preserve a user's explicit but invalid calendar date so validation can explain
    // the error; never silently replace it with a model-generated date.
    if (!iso && (candidate.getUTCFullYear() !== y || candidate.getUTCMonth() !== m - 1 || candidate.getUTCDate() !== d)) {
        return `${year}-${month}-${day}`;
    }
    return `${year}-${month}-${day}`;
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

    const currentUserText = options.message || options.userMessage || "";
    if ((toolOrSchema?.name || schema?.name) === "create_study_plan") {
        const contextMessages = options.messages || options.conversation || options.context;
        const continuation = options.isPlanCreationContinuation ?? isPlanCreationContinuation(currentUserText, contextMessages);
        const lastCreateCompletion = Array.isArray(contextMessages)
            ? contextMessages.reduce((last, item, index) => item?.role === "assistant" && /\bcreated successfully\b/i.test(String(item.content || "")) ? index : last, -1)
            : -1;
        const creationText = continuation && Array.isArray(contextMessages)
            ? contextMessages.slice(lastCreateCompletion + 1).filter(item => item?.role === "user" && typeof item.content === "string").map(item => item.content).join(" ")
            : currentUserText;
        const explicitHours = [...creationText.matchAll(/(?<![\w.])(-?\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gi)].at(-1);
        const dailyHoursSpecified = /\b(?:per|a|each)\s*day\b|\bdaily\b|\b(?:hours?|hrs?)\s*\/\s*day\b/i.test(creationText);
        const explicitDuration = creationText.match(/\b(\d{1,4})\s*[- ]?days?\b|\b(\d{1,3})\s*weeks?\b|\b(\d{1,3})\s*week\b|\b(?:a|one)\s+week\b/i);
        const hourValue = explicitHours && dailyHoursSpecified && Number(explicitHours[1]);
        const durationValue = explicitDuration && (explicitDuration[1]
            ? Number(explicitDuration[1])
            : /\b(?:a|one)\s+week\b/i.test(explicitDuration[0]) ? 7 : Number(explicitDuration[2] || explicitDuration[3]) * 7);
        if (Number.isFinite(hourValue) && properties.dailyAvailableHours) normalized.dailyAvailableHours = hourValue;
        else if (currentUserText.trim() && properties.dailyAvailableHours) delete normalized.dailyAvailableHours;
        if (durationValue && properties.durationDays) normalized.durationDays = durationValue;
        else if (currentUserText.trim() && properties.durationDays) delete normalized.durationDays;
        const explicitDate = extractExplicitDate(creationText);
        if (explicitDate && properties.examDate) normalized.examDate = explicitDate;
        else if (currentUserText.trim() && properties.examDate &&
            !/\b\d{4}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/i.test(creationText) &&
            !(/\b(?:exam\s+date|exam\s+(?:is\s+)?on)\b/i.test(creationText) && !/\b(?:no|without|not|don't|do\s+not)\b.{0,20}\b(?:exam\s+date|date)\b/i.test(creationText))) {
            // A date not supplied by the user is an optional model guess. Omit it so
            // goal-based planning proceeds without a fabricated or stale exam date.
            delete normalized.examDate;
        }
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

        const contextPlanId = userPlanId;
        const isCreateTool = (toolOrSchema?.name || schema?.name) === "create_study_plan";
        const verifiedListedIds = Array.isArray(options.verifiedPlanIds) ? [...options.verifiedPlanIds] : [];
        for (const item of (options.messages || options.conversation || options.context || [])) {
            if (item?.role !== "tool" || typeof item.content !== "string") continue;
            const parsed = tryParseJson(item.content);
            if (Array.isArray(parsed?.plans)) {
                verifiedListedIds.push(...parsed.plans.map(plan => plan?.planId).filter(id => typeof id === "string"));
            }
        }
        const planIdDescription = String(properties.planId?.description || "");
        const hasDocumentedDefault = /defaults?\s+to\s+['"]?default\b/i.test(planIdDescription);
        if (contextPlanId) {
            // The latest user's explicit identifier always wins over model arguments.
            normalized.planId = contextPlanId;
        } else if (isCreateTool && currentUserText.trim()) {
            // Creation IDs are generated by the MCP server unless the user
            // explicitly supplied one in this request or its active clarification.
            delete normalized.planId;
        } else if (options.activePlanId && !isCreateTool) {
            normalized.planId = options.activePlanId;
        } else if (!isCreateTool && currentVal && verifiedListedIds.includes(currentVal)) {
            normalized.planId = currentVal;
        } else if (!isCreateTool && !currentVal && verifiedListedIds.length === 1) {
            normalized.planId = verifiedListedIds[0];
        } else if (options.trustedPlanId && currentVal && !isToolName &&
            !/(?:\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|exam[_-]?date|your[_-]|placeholder|plan[_-]?id)/i.test(String(currentVal))) {
            // AdaptiveAgent marks arguments trusted only after context resolution and
            // validation. Preserve that identifier through the MCP client's second
            // schema normalization pass.
            normalized.planId = currentVal;
        } else if (isToolName || (currentVal && currentVal !== "default")) {
            // Do not let an unverified model proposal silently select a different plan.
            // A documented default is safe only when the model actually selected it.
            if (currentVal === "default" && hasDocumentedDefault) normalized.planId = "default";
            else if (hasDocumentedDefault && /(?:\b\d{4}-\d{2}-\d{2}\b|exam[_-]?date|your[_-]|placeholder|plan[_-]?id)/i.test(String(currentVal || ""))) normalized.planId = "default";
            else delete normalized.planId;
        } else if (!currentVal && hasDocumentedDefault && !rawArgs.planId) {
            // Preserve an explicitly documented server default only when the model did
            // not propose a different (now rejected) identifier.
            normalized.planId = "default";
        }
        // For retrieval, model-supplied IDs are discarded above unless independently
        // verified in tool-result context or explicitly provided by the user.
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

    // 10. Date inference guard for record_study_session
    if (toolName === "record_study_session" || (properties.subject && properties.hoursSpent && properties.date)) {
        const userText = options.message || options.userMessage;
        const conversation = options.messages || options.conversation || options.context;

        const textToScan = typeof userText === "string" ? userText : "";
        const explicitSessionDate = extractExplicitSessionDate(textToScan);
        if (explicitSessionDate) {
            normalized.date = explicitSessionDate;
            // A supplied calendar date is authoritative even if the request
            // also mentions a plan-day number.
            delete normalized.dayNumber;
        } else if (normalized.date !== undefined && shouldOmitSessionDate(normalized.date, userText, conversation)) {
            delete normalized.date;
        }

        let explicitPlanDay = extractExplicitPlanDayNumber(textToScan);
        const isShortClarification = textToScan.trim().length > 0 && textToScan.trim().length <= 48 &&
            !/\b(?:record|log|track|mark|enter|add|missed|completed|studied|study|create|make|build|generate|adapt|adjust|update|show|retrieve|get|view)\b/i.test(textToScan);
        if (explicitPlanDay === null && (isShortClarification || !textToScan.trim()) && Array.isArray(conversation)) {
            for (let index = conversation.length - 1; index >= 0; index--) {
                const item = conversation[index];
                if (item?.role !== "user" || typeof item.content !== "string") continue;
                explicitPlanDay = extractExplicitPlanDayNumber(item.content);
                if (explicitPlanDay !== null) break;
            }
        }
        if (!explicitSessionDate && explicitPlanDay !== null) {
            normalized.dayNumber = explicitPlanDay;
            // Do not allow a model-invented date to override the numbered day.
            delete normalized.date;
        } else if (!textToScan.trim() && !Array.isArray(conversation) && Number.isInteger(normalized.dayNumber)) {
            // MCP client performs a second schema-normalization pass after the
            // agent has resolved the user's day reference. Preserve that
            // normalized value at the transport boundary.
        } else if (!textToScan.trim() && Array.isArray(conversation) &&
            !conversation.some(item => item?.role === "user" && typeof item.content === "string" && item.content.trim()) &&
            Number.isInteger(normalized.dayNumber)) {
            // Also preserve a normalized value when context contains only
            // system messages and no user text.
        } else {
            delete normalized.dayNumber;
        }

        if (String(normalized.status || "").toLowerCase() === "missed") {
            // Missed sessions record no actual study time. Keep the missed amount
            // and the intended session duration as distinct values.
            normalized.hoursSpent = 0;
            const explicitHours = extractExplicitMissedSessionHours(textToScan);
            if (explicitHours.missedHours !== null) normalized.missedHours = explicitHours.missedHours;
            if (explicitHours.scheduledHours !== null) normalized.scheduledHours = explicitHours.scheduledHours;
            else if (explicitHours.missedHours !== null) normalized.scheduledHours = explicitHours.missedHours;
        } else {
            if (normalized.hoursSpent === undefined || normalized.hoursSpent === null || Number.isNaN(normalized.hoursSpent)) {
                const hrsMatch = textToScan.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
                if (hrsMatch && Number.isFinite(Number(hrsMatch[1])) && Number(hrsMatch[1]) > 0) {
                    normalized.hoursSpent = Number(hrsMatch[1]);
                }
            }
            if (!normalized.status) {
                normalized.status = /\b(?:missed|skip|skipped)\b/i.test(textToScan) ? "missed" : "completed";
            }
        }
    }

    return normalized;
}


