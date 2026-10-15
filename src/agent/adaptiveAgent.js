import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import { normalizeToolArguments, isRetrievalIntent, isAdaptationIntent, isSessionRecordingIntent, isPlanListingIntent, extractExplicitPlanId, extractExplicitPlanDayNumber, isPlanCreationContinuation, isMultiDayCompletionStatement } from "./normalizer.js";
import { validateToolArguments, verifyToolResult } from "./validator.js";
import { verifyFinalAnswerConsistency, stripMetaPreamble, formatGroundedPlanSummary, formatGroundedPlanList, formatGroundedAdaptationSummary, formatGroundedRetrievalSummary, formatGroundedSessionSummary } from "./consistencyChecker.js";

const MUTATION_TOOLS = new Set(["record_study_session", "create_study_plan", "adapt_study_plan", "delete_study_plan"]);

function isMalformedToolCallJsonError(error) {
    return error?.code === "MALFORMED_TOOL_CALL_JSON" ||
        (error?.status === 400 &&
            error?.error?.code === "tool_use_failed" &&
            /failed to parse tool call arguments as json/i.test(error?.error?.message || ""));
}

function matchingPlansByMentionedSubject(plans, message) {
    if (!Array.isArray(plans) || typeof message !== "string") return [];
    return plans.filter(plan => (plan.subjects || []).some(subject => {
        const escaped = String(subject).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return escaped && new RegExp(`\\b${escaped}\\b`, "i").test(message);
    }));
}

function getPendingMultiDayCompletionRequest(messages) {
    if (!Array.isArray(messages)) return null;
    const lastAssistantIndex = messages.map(item => item?.role).lastIndexOf("assistant");
    const lastAssistant = messages[lastAssistantIndex];
    const clarificationText = String(lastAssistant?.content || "");
    if (!/\bone plan day\b/i.test(clarificationText) || !/\bhours?\s+you\s+studied\b/i.test(clarificationText)) return null;
    for (let index = lastAssistantIndex - 1; index >= 0; index--) {
        const item = messages[index];
        if (item?.role === "user" && isMultiDayCompletionStatement(item.content)) return item.content;
    }
    return null;
}

function isUnspecifiedBatchCompletionReply(message) {
    if (typeof message !== "string" || !message.trim()) return false;
    const acknowledgesBatch = /\b(?:yeah|yes|yep|yah|right|correct|exactly)\b/i.test(message) &&
        /\b(?:each|every|all)\b.{0,25}\b(?:days?|sessions?)\b/i.test(message) &&
        /\b(?:completed|finished|done|studied)\b/i.test(message);
    const dayReferences = message.match(/\bday\s*\d+\b/gi) || [];
    const givesMultipleDays = dayReferences.length > 1;
    const givesDayOrHours = dayReferences.length > 0 || /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b/i.test(message);
    return (acknowledgesBatch && !givesDayOrHours) || givesMultipleDays;
}

function extractPerDayHours(text) {
    if (typeof text !== "string") return null;
    const match = text.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:each|per\s+day)\b|\b(?:each|per\s+day)\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
    const hours = match ? Number(match[1] || match[2]) : NaN;
    return Number.isFinite(hours) && hours > 0 ? hours : null;
}

function getRecentRecordedCompletedSessionContext(messages) {
    if (!Array.isArray(messages)) return null;
    for (let index = messages.length - 1; index >= 0; index--) {
        const item = messages[index];
        if (item?.role === "user") {
            const text = String(item.content || "");
            const isRelatedDayFollowUp = (/\bday\s*\d+\b/i.test(text) || /\b(?:add|record|log|track|mark|enter)\b/i.test(text)) &&
                (/\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b/i.test(text) || /\bday\s*\d+\b/i.test(text));
            if (isRelatedDayFollowUp || isMultiDayCompletionStatement(text)) continue;
            break;
        }
        if (item?.role !== "assistant") continue;
        const content = String(item.content || "");
        const match = content.match(/\b(?:recorded|logged)\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\s+for\s+(.+?)\s*\(status:\s*completed\)/i);
        if (match) return { subject: match[1].trim(), content };
    }
    return null;
}

function extractHoursFromText(text) {
    if (typeof text !== "string") return null;
    const match = text.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
    const hours = match ? Number(match[1]) : NaN;
    return Number.isFinite(hours) && hours > 0 ? hours : null;
}

function areToolArgumentsEqual(args1, args2) {
    if (args1 === args2) return true;
    if (!args1 || !args2) return false;
    if (typeof args1 !== "object" || typeof args2 !== "object") return false;
    const keys1 = Object.keys(args1).sort();
    const keys2 = Object.keys(args2).sort();
    if (keys1.length !== keys2.length) return false;
    for (let i = 0; i < keys1.length; i++) {
        if (keys1[i] !== keys2[i]) return false;
        const val1 = args1[keys1[i]];
        const val2 = args2[keys2[i]];
        if (typeof val1 === "object" && typeof val2 === "object") {
            if (!areToolArgumentsEqual(val1, val2)) return false;
        } else if (val1 !== val2) {
            return false;
        }
    }
    return true;
}

export class AdaptiveAgent {
    constructor({ provider, mcpClient, maxRounds, systemPrompt, allowPartialSuccess, toolTimeoutMs } = {}) {
        if (!provider) {
            throw new Error("AdaptiveAgent requires a valid AI provider instance.");
        }
        if (!mcpClient) {
            throw new Error("AdaptiveAgent requires a valid McpClientManager instance.");
        }

        this.provider = provider;
        this.mcpClient = mcpClient;
        this.maxRounds = maxRounds || Number(process.env.MAX_AGENT_ROUNDS) || 6;
        this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
        this.allowPartialSuccess = allowPartialSuccess ?? false;
        this.toolTimeoutMs = toolTimeoutMs ?? null;
    }

    /**
     * Run the agent loop with bounded iterations and tool execution
     * @param {Object} params
     * @param {string} [params.message] - User message
     * @param {Array} [params.messages] - Prior conversation turns
     * @returns {Promise<{ success: boolean, reply: string, steps: Array, rounds: number }>}
     */
    async run({ message, messages = [], activePlanId = null, allowPartialSuccess, toolTimeoutMs }) {
        if (!message && (!messages || messages.length === 0)) {
            throw new Error("A user message or conversation history is required.");
        }

        const pendingMultiDayRequest = getPendingMultiDayCompletionRequest(messages);
        const pendingDayNumber = pendingMultiDayRequest ? extractExplicitPlanDayNumber(message) : null;
        const pendingHours = pendingMultiDayRequest ? extractPerDayHours(pendingMultiDayRequest) : null;
        const recentSessionContext = getRecentRecordedCompletedSessionContext(messages);
        const recentSessionDayNumber = recentSessionContext ? extractExplicitPlanDayNumber(message) : null;
        const recentSessionHours = recentSessionContext ? extractHoursFromText(message) : null;
        const continuesRecentSession = Boolean(recentSessionContext && recentSessionDayNumber && recentSessionHours &&
            !/\b(?:missed|skip|skipped)\b/i.test(message || ""));
        const continuesPendingSession = Boolean(pendingMultiDayRequest && pendingDayNumber && pendingHours &&
            (/\b(?:completed|finished|done|studied)\b/i.test(message || "") || /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b/i.test(message || "")));
        if (pendingMultiDayRequest && isUnspecifiedBatchCompletionReply(message)) {
            const reply = /\bday\s*\d+\b/i.test(message || "")
                ? "I see details for more than one day. To avoid assigning a date or amount incorrectly, please send one day at a time (for example, “Day 1: 2 hours”). Nothing has been recorded yet."
                : "Thanks—I understand that you completed those days. To log them accurately, please confirm the hours for each day (for example, “2 hours on each of the five days”) and whether they were plan days 1–5. Nothing has been recorded yet.";
            return {
                success: false,
                partialSuccess: false,
                needsClarification: true,
                reply,
                activePlanId,
                steps: [{ type: "clarification_required", reason: "The follow-up confirms a batch completion but does not provide per-day hours or dates; no session was recorded.", timestamp: new Date().toISOString() }],
                rounds: 0
            };
        }

        if (isMultiDayCompletionStatement(message)) {
            const reply = "I can record your study sessions, but I need the details for each day to avoid guessing. Please tell me one plan day and the hours you studied (for example, ‘Day 5: 2 hours’), and I’ll log it.";
            return {
                success: false,
                partialSuccess: false,
                needsClarification: true,
                reply,
                activePlanId,
                steps: [{ type: "clarification_required", reason: "A multi-day completion needs individual session details; no session was recorded.", timestamp: new Date().toISOString() }],
                rounds: 0
            };
        }

        const permitsPartialSuccess = allowPartialSuccess ?? this.allowPartialSuccess;
        const effectiveTimeoutMs = toolTimeoutMs ?? this.toolTimeoutMs;
        let resolvedActivePlanId = activePlanId;
        const planResolutionText = continuesPendingSession
            ? `${pendingMultiDayRequest} ${message}`
            : continuesRecentSession
                ? `${recentSessionContext.content} ${message}`
            : message;
        const continuationSession = continuesPendingSession
            ? { dayNumber: pendingDayNumber, hoursSpent: pendingHours, subjectText: pendingMultiDayRequest }
            : continuesRecentSession
                ? { dayNumber: recentSessionDayNumber, hoursSpent: recentSessionHours, subjectText: recentSessionContext.subject }
                : null;

        // 1. Fetch available tools dynamically from MCP client
        if (typeof this.mcpClient.whenReady === "function" && this.mcpClient.isConfigured?.() && !this.mcpClient.connected) {
            await this.mcpClient.whenReady(effectiveTimeoutMs || 5000);
        }
        const tools = this.mcpClient.listTools();

        // 2. Prepare conversation history with system instructions
        const conversation = [
            {
                role: "system",
                content: this.systemPrompt
            }
        ];

        if (Array.isArray(messages) && messages.length > 0) {
            for (const msg of messages) {
                if (msg.role && (msg.content !== undefined || msg.tool_calls)) {
                    conversation.push(msg);
                }
            }
        }

        if (message) {
            conversation.push({
                role: "user",
                content: message
            });
        }

        if (activePlanId) {
            conversation.splice(1, 0, { role: "system", content: `Verified active study plan ID for this conversation: ${activePlanId}. Use it for plan operations unless the latest user message names another valid plan.` });
        }

        const createContinuation = isPlanCreationContinuation(message, conversation);

        const steps = [];
        const executedTools = [];
        let resolvedPlanSummary = null;
        let completed = false;
        let concluded = false;
        let finalReply = "";
        let roundsExecuted = 0;
        let turnFailures = [];
        let turnSuccesses = [];
        let lastToolExecutionFailed = false;
        let lastToolFailureReason = "";
        let malformedToolCallCorrectionAttempted = false;

        // Plan enumeration is deterministic. Avoid sending a potentially large
        // catalog back through the model on a later round (and avoid accidental
        // create/adapt calls for a read-only list request).
        if (isPlanListingIntent(message)) {
            const timestamp = new Date().toISOString();
            steps.push({ type: "tool_executing", tool: "list_study_plans", arguments: {}, timestamp });
            let listing;
            try {
                listing = tools.some(tool => tool.name === "list_study_plans")
                    ? await this.mcpClient.callTool("list_study_plans", {}, { trustedPlanId: true })
                    : { isError: true, content: "The StudyPilot plan-listing tool is unavailable." };
            } catch (error) {
                listing = { isError: true, content: `Plan listing failed: ${error.message}` };
            }
            const verification = verifyToolResult("list_study_plans", {}, listing);
            let listedData = null;
            if (verification.valid) {
                try { listedData = JSON.parse(listing.content); } catch { /* verifier already checked the result */ }
            }
            const failed = !verification.valid || !listedData;
            const content = listing.content || verification.error || "Plan listing returned no data.";
            executedTools.push({ toolName: "list_study_plans", toolArgs: {}, isError: failed, content, parsedData: listedData });
            steps.push({ type: "tool_result", tool: "list_study_plans", isError: failed, content, timestamp: new Date().toISOString() });
            finalReply = failed
                ? `I couldn't retrieve your saved plans. ${verification.error || content}`
                : formatGroundedPlanList(listedData);
            completed = !failed;
            steps.push({ type: "final_answer", reply: finalReply, success: completed, timestamp: new Date().toISOString() });
            return {
                success: completed,
                partialSuccess: false,
                reply: finalReply,
                activePlanId: !failed && listedData.plans.length === 1 ? listedData.plans[0].planId : resolvedActivePlanId,
                steps,
                rounds: 0
            };
        }

        const hasIncompletePlanIdReference = /\bplan\b.{0,20}\b(?:id|identifier|number)\b/i.test(message || "") && !extractExplicitPlanId(message);
        if (hasIncompletePlanIdReference && !resolvedActivePlanId) {
            finalReply = "I couldn't identify which saved plan you mean. Please describe it by subject or goal, and I'll find it without needing you to remember an ID.";
            completed = false;
            concluded = true;
        }

        const hasExplicitCreateIntent = /\b(?:create|make|build|generate|set up|start|new)\b.{0,40}\b(?:study\s+plan|plan|schedule)\b/i.test(message || "");

        const needsExistingPlan = !createContinuation && (!resolvedActivePlanId || continuesPendingSession || continuesRecentSession) &&
            !concluded &&
            !hasExplicitCreateIntent &&
            !extractExplicitPlanId(message) &&
            (isRetrievalIntent(message) || isSessionRecordingIntent(message) ||
                (continuesPendingSession && isMultiDayCompletionStatement(pendingMultiDayRequest)) || continuesRecentSession || isAdaptationIntent(message));
        if (needsExistingPlan && tools.some(tool => tool.name === "list_study_plans")) {
            steps.push({ type: "tool_executing", tool: "list_study_plans", arguments: {}, timestamp: new Date().toISOString() });
            const listing = await this.mcpClient.callTool("list_study_plans", {}, { trustedPlanId: true });
            const listingVerification = verifyToolResult("list_study_plans", {}, listing);
            let listedData = null;
            if (listingVerification.valid) {
                try { listedData = JSON.parse(listing.content); } catch { }
            }
            const listFailed = !listingVerification.valid || listing.isError || !listedData;
            executedTools.push({ toolName: "list_study_plans", toolArgs: {}, isError: listFailed, content: listing.content, parsedData: listedData });
            steps.push({ type: "tool_result", tool: "list_study_plans", isError: listFailed, content: listing.content, timestamp: new Date().toISOString() });
            if (listFailed) {
                finalReply = `Action Failed: I could not safely identify your study plan. ${listingVerification.error || listing.content || "Plan listing failed."}`;
                completed = false;
                concluded = true;
            } else if (listedData.plans.length === 0) {
                finalReply = "I don't see a saved study plan in this conversation yet. Create one first, and I'll keep track of it for you.";
                completed = false;
                concluded = true;
            } else {
                if (listedData.plans.length === 1) {
                    resolvedPlanSummary = listedData.plans[0];
                    resolvedActivePlanId = listedData.plans[0].planId;
                }
                else if (listedData.plans.length > 1) {
                    const subjectMatches = matchingPlansByMentionedSubject(listedData.plans, planResolutionText);
                    if (subjectMatches.length === 1) {
                        resolvedPlanSummary = subjectMatches[0];
                        resolvedActivePlanId = subjectMatches[0].planId;
                    } else if (isRetrievalIntent(message) || isSessionRecordingIntent(message) || continuesPendingSession || continuesRecentSession || isAdaptationIntent(message)) {
                        finalReply = "Action Failed: I found more than one saved study plan and can't safely tell which one you mean. Which plan should I use? You can identify it by its subject or goal.";
                        completed = false;
                        concluded = true;
                        steps.push({
                            type: "plan_selection_required",
                            candidateCount: listedData.plans.length,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
                if (!concluded) {
                    conversation.push({ role: "system", content: `Verified saved study plans (internal IDs; never ask the user to repeat an ID): ${JSON.stringify(listedData.plans)}. Use the verified active plan ID selected from the current request; if ambiguous, ask the user to choose by subject or goal.` });
                }
            }
        }

        // 3. Bounded Agent Execution Loop
        for (let round = 1; !concluded && round <= this.maxRounds; round++) {
            roundsExecuted = round;

            steps.push({
                round,
                type: "round_start",
                timestamp: new Date().toISOString()
            });

            let providerResponse;
            try {
                if (continuesRecentSession && round === 1) {
                    providerResponse = { content: "", toolCalls: [{ name: "record_study_session", arguments: {} }] };
                } else if (continuesRecentSession && round > 1) {
                    const recorded = [...executedTools].reverse().find(item => item.toolName === "record_study_session" && !item.isError && item.parsedData);
                    providerResponse = recorded
                        ? { content: formatGroundedSessionSummary(recorded.parsedData, recorded.toolArgs), toolCalls: [] }
                        : await this.provider.chat({ messages: conversation, tools });
                } else {
                    providerResponse = await this.provider.chat({ messages: conversation, tools });
                }
            } catch (error) {
                // Groq can reject a generated tool call before returning a
                // provider response when its argument string is malformed JSON.
                // No MCP call has occurred at this point, so one bounded model
                // correction is safe. Other provider failures are never retried.
                const hasAnyToolExecution = executedTools.length > 0;
                if (!malformedToolCallCorrectionAttempted && !hasAnyToolExecution && isMalformedToolCallJsonError(error)) {
                    malformedToolCallCorrectionAttempted = true;
                    steps.push({
                        round,
                        type: "provider_tool_call_correction",
                        reason: "Provider rejected malformed tool-call JSON before any tool executed.",
                        timestamp: new Date().toISOString()
                    });
                    conversation.push({
                        role: "assistant",
                        content: "The provider rejected the previous tool call because its arguments were not valid JSON. No tool was executed."
                    });
                    conversation.push({
                        role: "user",
                        content: "Make one correction attempt for my original request. If a tool is needed, return valid JSON arguments matching the provided tool schema. Do not claim the action succeeded unless the tool result confirms it."
                    });
                    continue;
                }
                const errorMsg = `Provider error during round ${round}: ${error.message}`;
                steps.push({
                    round,
                    type: "provider_error",
                    error: errorMsg,
                    timestamp: new Date().toISOString()
                });

                return {
                    success: false,
                    reply: errorMsg,
                    steps,
                    rounds: roundsExecuted
                };
            }

            const toolCalls = providerResponse.toolCalls || [];

            // Case A: Model responded with a final text reply (no tool calls)
            if (toolCalls.length === 0) {
                concluded = true;
                finalReply = stripMetaPreamble(providerResponse.content || "");

                // Inspect whether prior tool execution failed without resolution
                const hasFailures = turnFailures.length > 0;
                const hasSuccesses = turnSuccesses.length > 0;

                if (hasFailures && !hasSuccesses) {
                    // Total failure: all attempted tool calls in the turn failed
                    completed = false;
                    const failureDetails = turnFailures.map(f => f.error).join("\n");
                    finalReply = `Action Failed: The requested action could not be completed successfully: ${failureDetails}\n\nPlease check the required parameters and try again.`;
                } else if (hasFailures && hasSuccesses) {
                    // Partial outcome: some tools succeeded and some failed in the turn
                    completed = permitsPartialSuccess;
                    const failureLines = turnFailures.map(f => `- Tool "${f.toolName}" failed: ${f.error}`).join("\n");

                    let successSummary = "";
                    const successfulPlan = [...executedTools].reverse().find(t => !t.isError && t.parsedData);
                    if (successfulPlan && successfulPlan.toolName === "create_study_plan") {
                        successSummary = formatGroundedPlanSummary(successfulPlan.parsedData);
                    } else if (successfulPlan && successfulPlan.toolName === "adapt_study_plan") {
                        successSummary = formatGroundedAdaptationSummary(successfulPlan.parsedData);
                    } else if (successfulPlan && successfulPlan.toolName === "get_study_plan") {
                        successSummary = formatGroundedRetrievalSummary(successfulPlan.parsedData);
                    } else if (successfulPlan && successfulPlan.toolName === "record_study_session") {
                        successSummary = formatGroundedSessionSummary(successfulPlan.parsedData, successfulPlan.toolArgs);
                    } else {
                        successSummary = turnSuccesses.map(s => `- Tool "${s.toolName}": ${s.content}`).join("\n");
                    }

                    finalReply = `Action Partially Completed: One or more requested actions encountered errors:\n${failureLines}\n\nSuccessful Outcomes:\n${successSummary}`;
                } else {
                    completed = true;

                    // Ensure final answer is grounded in verified tool results and does not contradict constraints
                    if (executedTools.length > 0) {
                        const consistencyCheck = verifyFinalAnswerConsistency(finalReply, executedTools, message);
                        if (!consistencyCheck.valid) {
                            console.warn(`[Agent] Final answer consistency check: ${consistencyCheck.reason}. Grounding answer in verified tool results.`);
                            const originalReply = finalReply;
                            finalReply = consistencyCheck.correctedReply;
                            if (consistencyCheck.failure) {
                                completed = false;
                            }
                            steps.push({
                                round,
                                type: "final_answer_grounded",
                                originalReply: consistencyCheck.redactOriginalReply
                                    ? "[omitted: unsupported exam-date claim]"
                                    : originalReply,
                                correctedReply: finalReply,
                                reason: consistencyCheck.reason,
                                timestamp: new Date().toISOString()
                            });
                        }
                    } else if (isSessionRecordingIntent(message) && isRetrievalIntent(message)) {
                        completed = false;
                        finalReply = `Action Failed: The requested study session recording and plan retrieval could not be completed because no tools were executed.`;
                    } else if (isSessionRecordingIntent(message)) {
                        completed = false;
                        finalReply = `Action Failed: The requested study session could not be recorded because no study session recording was performed.`;
                    } else if (isRetrievalIntent(message)) {
                        completed = false;
                        finalReply = `Action Failed: The requested study plan could not be retrieved because no study plan retrieval was performed.`;
                    } else if (isAdaptationIntent(message)) {
                        completed = false;
                        finalReply = `Action Failed: The requested plan adaptation could not be completed because no study plan adaptation was performed.`;
                    }
                }

                conversation.push({
                    role: "assistant",
                    content: finalReply
                });

                steps.push({
                    round,
                    type: "final_answer",
                    reply: finalReply,
                    success: completed,
                    timestamp: new Date().toISOString()
                });

                break;
            }

            // Case B: Model requested one or more tool calls
            steps.push({
                round,
                type: "tool_calls_requested",
                toolCalls,
                timestamp: new Date().toISOString()
            });

            // Reset turn-level tracking for this new round of tool executions
            turnFailures = [];
            turnSuccesses = [];

            // Keep the assistant turn with tool calls in history
            conversation.push(providerResponse.rawMessage || {
                role: "assistant",
                content: providerResponse.content || "",
                tool_calls: toolCalls.map((tc, index) => ({
                    id: tc.id || `agent_tool_call_${round}_${index}`,
                    type: "function",
                    function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.arguments ?? {})
                    }
                }))
            });

            // Execute each requested tool call
            for (const call of toolCalls) {
                let toolName = call.name;
                let rawArgs = call.arguments || {};

                if (continuationSession) {
                    const planSubjects = resolvedPlanSummary?.subjects || [];
                    const mentionedSubject = planSubjects.find(subject => {
                        const escaped = String(subject).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                        return new RegExp(`\\b${escaped}\\b`, "i").test(`${continuationSession.subjectText} ${planResolutionText}`);
                    });
                    if (toolName !== "record_study_session") {
                        steps.push({ round, type: "intent_tool_redirection", originalTool: toolName, redirectedTool: "record_study_session", reason: "The user supplied a specific study day and duration in session-recording context.", timestamp: new Date().toISOString() });
                    }
                    toolName = "record_study_session";
                    rawArgs = {
                        ...rawArgs,
                        planId: resolvedActivePlanId,
                        subject: mentionedSubject || (planSubjects.length === 1 ? planSubjects[0] : (recentSessionContext?.subject || rawArgs.subject)),
                        hoursSpent: continuationSession.hoursSpent,
                        status: "completed",
                        dayNumber: continuationSession.dayNumber
                    };
                } else if (toolName === "record_study_session") {
                    if (!rawArgs.planId && resolvedActivePlanId) {
                        rawArgs.planId = resolvedActivePlanId;
                    }
                    const planSubjects = resolvedPlanSummary?.subjects || [];
                    const matchedPlanSubject = rawArgs.subject && planSubjects.find(s => s.toLowerCase() === String(rawArgs.subject).toLowerCase());
                    const isRawSubjectInPlan = Boolean(matchedPlanSubject);
                    const userMentionsRawSubject = rawArgs.subject && new RegExp(`\\b${String(rawArgs.subject).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(message);

                    if (matchedPlanSubject) {
                        rawArgs.subject = matchedPlanSubject;
                    } else if (!rawArgs.subject || (!isRawSubjectInPlan && !userMentionsRawSubject)) {
                        if (planSubjects.length === 1) {
                            rawArgs.subject = planSubjects[0];
                        } else if (recentSessionContext?.subject) {
                            rawArgs.subject = recentSessionContext.subject;
                        }
                    }
                    if (!rawArgs.hoursSpent) {
                        const extractedHours = extractHoursFromText(message);
                        if (extractedHours) rawArgs.hoursSpent = extractedHours;
                    }
                    if (!rawArgs.dayNumber) {
                        const extractedDay = extractExplicitPlanDayNumber(message);
                        if (extractedDay) rawArgs.dayNumber = extractedDay;
                    }
                    if (!rawArgs.status) {
                        rawArgs.status = /\b(?:missed|skip|skipped)\b/i.test(message) ? "missed" : "completed";
                    }
                }

                // A short selection such as "study plan" answers the assistant's
                // create-vs-record clarification; it must not be treated as a request
                // to retrieve an existing plan.
                if (createContinuation && toolName === "get_study_plan") {
                    toolName = "create_study_plan";
                    steps.push({
                        round,
                        type: "intent_tool_redirection",
                        originalTool: "get_study_plan",
                        redirectedTool: "create_study_plan",
                        reason: "User selected the previously clarified study-plan creation request.",
                        timestamp: new Date().toISOString()
                    });
                }

                const isPreviouslyListedId = executedTools.some(item => item.toolName === "list_study_plans" &&
                    !item.isError && item.parsedData?.plans?.some(plan => plan.planId === rawArgs.planId));
                if (!resolvedActivePlanId && !extractExplicitPlanId(message) && !isPreviouslyListedId &&
                    (isRetrievalIntent(message) || isSessionRecordingIntent(message) || isAdaptationIntent(message)) &&
                    toolName === "get_study_plan" && tools.some(tool => tool.name === "list_study_plans")) {
                    toolName = "list_study_plans";
                    steps.push({ round, type: "intent_tool_redirection", originalTool: "get_study_plan", redirectedTool: "list_study_plans", reason: "No plan was active or explicitly named, so StudyPilot checked saved plans without guessing an ID.", timestamp: new Date().toISOString() });
                }

                // Intent-based tool enforcement:
                // If user intent is retrieval ("retrieve", "get", "show", "inspect", "report on")
                // but the model incorrectly requested "adapt_study_plan",
                // redirect to "get_study_plan" and preserve the explicit planId.
                if (isRetrievalIntent(message) && toolName === "adapt_study_plan") {
                    console.log(`[Agent] Redirected incorrect tool call "${toolName}" to "get_study_plan" based on user retrieval intent.`);
                    toolName = "get_study_plan";
                    steps.push({
                        round,
                        type: "intent_tool_redirection",
                        originalTool: "adapt_study_plan",
                        redirectedTool: "get_study_plan",
                        reason: "User requested study plan retrieval, not plan adaptation.",
                        timestamp: new Date().toISOString()
                    });
                }

                // A proposed-date verification is a retrieval query, not a request to
                // create a plan. Prevent a misclassified model call from mutating data.
                if (isRetrievalIntent(message) && toolName === "create_study_plan" && !/\b(?:create|make|build|generate)\b/i.test(message)) {
                    toolName = "get_study_plan";
                    steps.push({
                        round,
                        type: "intent_tool_redirection",
                        originalTool: "create_study_plan",
                        redirectedTool: "get_study_plan",
                        reason: "User asked to verify or retrieve existing plan data, not create a new plan.",
                        timestamp: new Date().toISOString()
                    });
                }

                // Find tool schema
                const toolDef = tools.find(t => t.name === toolName);

                // Step 1: Normalize tool arguments against tool's inputSchema
                const toolArgs = normalizeToolArguments(toolDef, rawArgs, {
                    message,
                    messages: conversation,
                    context: conversation,
                    activePlanId: resolvedActivePlanId,
                    isPlanCreationContinuation: createContinuation,
                    verifiedPlanIds: executedTools.filter(item => item.toolName === "list_study_plans" && !item.isError)
                        .flatMap(item => item.parsedData?.plans?.map(plan => plan.planId) || []),
                    userMessage: message,
                    knownTools: tools.map(t => t.name)
                });

                if (rawArgs.planId && toolArgs.planId && rawArgs.planId !== toolArgs.planId) {
                    console.log(`[Agent] Preserved explicit user planId "${toolArgs.planId}" (model provided "${rawArgs.planId}").`);
                    steps.push({
                        round,
                        type: "identifier_preserved",
                        field: "planId",
                        rawArgument: rawArgs.planId,
                        preservedValue: toolArgs.planId,
                        timestamp: new Date().toISOString()
                    });
                }

                // Step 2: Validate normalized arguments before execution
                const validation = validateToolArguments(toolDef, toolArgs, {
                    knownTools: tools.map(t => t.name),
                    userMessage: message
                });

                if (!validation.valid) {
                    const validationErrMsg = `Argument validation failed for tool "${toolName}": ${validation.error} Please provide valid arguments.`;
                    console.warn(`[Agent] ${validationErrMsg}`);

                    lastToolExecutionFailed = true;
                    lastToolFailureReason = validationErrMsg;
                    turnFailures.push({
                        toolName,
                        error: validationErrMsg,
                        isValidationError: true
                    });

                    steps.push({
                        round,
                        type: "tool_validation_error",
                        tool: toolName,
                        arguments: toolArgs,
                        rawArguments: rawArgs,
                        error: validationErrMsg,
                        timestamp: new Date().toISOString()
                    });

                    // Return actionable validation feedback to the model instead of executing with corrupted data
                    conversation.push({
                        role: "tool",
                        tool_name: toolName,
                        tool_call_id: call.id,
                        content: validationErrMsg
                    });

                    continue;
                }

                // Step 2.5: Guard against duplicate mutation execution
                // If a mutation tool was already successfully executed with identical arguments in this turn,
                // reuse the prior successful outcome rather than re-mutating persisted state.
                if (MUTATION_TOOLS.has(toolName)) {
                    const priorSuccess = executedTools.find(t =>
                        t.toolName === toolName &&
                        !t.isError &&
                        areToolArgumentsEqual(t.toolArgs, toolArgs)
                    );

                    if (priorSuccess) {
                        console.log(`[Agent] Deduplicated duplicate execution of mutation tool "${toolName}" with identical arguments.`);
                        steps.push({
                            round,
                            type: "duplicate_mutation_skipped",
                            tool: toolName,
                            arguments: toolArgs,
                            reusedResult: priorSuccess.content,
                            timestamp: new Date().toISOString()
                        });

                        turnSuccesses.push({
                            toolName,
                            content: priorSuccess.content
                        });

                        executedTools.push({
                            toolName,
                            toolArgs,
                            isError: false,
                            content: priorSuccess.content,
                            parsedData: priorSuccess.parsedData,
                            isDeduplicated: true
                        });

                        conversation.push({
                            role: "tool",
                            tool_name: toolName,
                            tool_call_id: call.id,
                            content: priorSuccess.content
                        });

                        continue;
                    }
                }

                // Step 3: Execute tool via MCP client with normalized arguments
                steps.push({
                    round,
                    type: "tool_executing",
                    tool: toolName,
                    arguments: toolArgs,
                    timestamp: new Date().toISOString()
                });

                let executionResult;
                try {
                    const callOptions = typeof effectiveTimeoutMs === "number"
                        ? { timeout: effectiveTimeoutMs, trustedPlanId: true }
                        : { trustedPlanId: true };
                    executionResult = await this.mcpClient.callTool(toolName, toolArgs, callOptions);
                } catch (callError) {
                    executionResult = {
                        isError: true,
                        content: `Tool execution failed: ${callError.message}`
                    };
                }

                // Step 4: Inspect actual tool result before claiming success
                const resultVerification = verifyToolResult(toolName, toolArgs, executionResult);
                if (!resultVerification.valid) {
                    console.warn(`[Agent] Result verification failed for "${toolName}": ${resultVerification.error}`);
                    executionResult.isError = true;
                    executionResult.content = `Tool result verification failed: ${resultVerification.error}`;
                }

                if (executionResult.isError) {
                    lastToolExecutionFailed = true;
                    lastToolFailureReason = executionResult.content;
                    turnFailures.push({
                        toolName,
                        error: executionResult.content,
                        isExecutionError: true
                    });
                } else {
                    turnSuccesses.push({
                        toolName,
                        content: executionResult.content
                    });
                    // Crucial: A subsequent successful tool does NOT hide prior failures in this turn!
                    lastToolExecutionFailed = turnFailures.length > 0;
                    if (!lastToolExecutionFailed) {
                        lastToolFailureReason = "";
                    }
                }

                let parsedData = null;
                try {
                    parsedData = JSON.parse(executionResult.content);
                } catch {
                    // Non-JSON or plain text content
                }

                executedTools.push({
                    toolName,
                    toolArgs,
                    isError: executionResult.isError,
                    content: executionResult.content,
                    parsedData
                });

                if (!executionResult.isError && parsedData?.planId) {
                    resolvedActivePlanId = parsedData.planId;
                } else if (!executionResult.isError && toolName === "list_study_plans" && parsedData?.plans?.length === 1) {
                    resolvedActivePlanId = parsedData.plans[0].planId;
                }

                steps.push({
                    round,
                    type: "tool_result",
                    tool: toolName,
                    isError: executionResult.isError,
                    content: executionResult.content,
                    timestamp: new Date().toISOString()
                });

                // Return genuine outcome to model
                const toolContent = executionResult.isError
                    ? `Tool "${toolName}" failed: ${executionResult.content}`
                    : executionResult.content;

                conversation.push({
                    role: "tool",
                    tool_name: toolName,
                    tool_call_id: call.id,
                    content: toolContent
                });
            }
        }

        // If loop finished without concluding, report maximum rounds reached
        if (!concluded) {
            const hasFailures = turnFailures.length > 0;
            const hasSuccesses = turnSuccesses.length > 0;

            if (hasFailures && hasSuccesses) {
                const failureLines = turnFailures.map(f => `- Tool "${f.toolName}": ${f.error}`).join("\n");
                finalReply = `Action Partially Completed: The requested action encountered errors:\n${failureLines}`;
            } else if (hasFailures) {
                const failureDetails = turnFailures.map(f => f.error).join("\n");
                finalReply = `Action Failed: The requested action could not be completed successfully: ${failureDetails}`;
            } else if (!finalReply) {
                finalReply = `Agent stopped: reached maximum allowed execution limit (${this.maxRounds} rounds).`;
            }

            steps.push({
                type: "limit_reached",
                reply: finalReply,
                timestamp: new Date().toISOString()
            });
        }

        const isPartial = turnFailures.length > 0 && turnSuccesses.length > 0;
        const finalSuccess = isPartial
            ? permitsPartialSuccess
            : (completed && turnFailures.length === 0);

        const { quickReplies, planPreview } = extractQuickRepliesAndPreview(finalReply, executedTools);

        return {
            success: finalSuccess,
            partialSuccess: isPartial,
            reply: finalReply,
            activePlanId: resolvedActivePlanId,
            quickReplies,
            planPreview,
            steps,
            rounds: roundsExecuted
        };
    }
}

export function extractQuickRepliesAndPreview(reply, executedTools = []) {
    if (!reply || typeof reply !== "string") {
        return { quickReplies: [], planPreview: null };
    }

    const lower = reply.toLowerCase();
    const quickReplies = [];
    let planPreview = null;

    // 1. Did create_study_plan succeed in this turn?
    const createdTool = executedTools.find(t => t.toolName === "create_study_plan" && !t.isError);
    if (createdTool) {
        return {
            quickReplies: ["View Schedule in Planner →", "Teach me first module", "Take a Diagnostic Quiz"],
            planPreview: null
        };
    }

    // 2. Is the reply a Proposed Study Plan awaiting confirmation?
    if (/proposed (?:study|personalized|learning) plan|here is the (?:personalized )?learning path|does this study path look good|confirm or modify/i.test(reply)) {
        const goalMatch = reply.match(/\*\*Goal:\*\*\s*([^\n|*]+)/i);
        const levelMatch = reply.match(/\*\*Level:\*\*\s*([^\n|*]+)/i);
        const dailyMatch = reply.match(/\*\*Daily Pace:\*\*\s*([^\n|*]+)/i);
        const timelineMatch = reply.match(/\*\*Target Period:\*\*\s*([^\n|*]+)/i);
        const subjectMatch = reply.match(/Plan:\s*([^\n#]+)/i);

        const stageMatches = [...reply.matchAll(/(?:Module|Stage)\s*(\d+)[:\s-]*\s*([^\n(]+)(?:\(([^)]+)\))?/gi)];
        const modules = stageMatches.map(m => ({
            number: m[1],
            title: m[2]?.trim(),
            duration: m[3]?.trim() || ""
        }));

        planPreview = {
            title: subjectMatch ? subjectMatch[1].trim() : "Personalized Study Plan",
            goal: goalMatch ? goalMatch[1].trim() : "",
            level: levelMatch ? levelMatch[1].trim() : "Beginner",
            dailyHours: dailyMatch ? dailyMatch[1].trim() : "2 hrs/day",
            timeline: timelineMatch ? timelineMatch[1].trim() : "14 days",
            modules: modules.length > 0 ? modules : []
        };

        return {
            quickReplies: ["✓ Confirm & Create Plan", "✏ Modify Daily Hours", "✏ Change Deadline", "Take Diagnostic Quiz First"],
            planPreview
        };
    }

    // 3. Experience level question
    if (/complete beginner|familiar with the basics|already experienced|current experience/i.test(lower)) {
        quickReplies.push("Complete Beginner", "Know the Basics", "Already Experienced", "Skip");
    }
    // 4. Starting point / difficult topics question
    else if (/already (?:feel )?comfortable with|tricky or unfamiliar|topics are difficult|starting point/i.test(lower)) {
        quickReplies.push("Start from the ground up", "Know fundamentals, need advanced", "Skip");
    }
    // 5. Daily study availability question
    else if (/dedicate to studying each day|study each day|hours per day|daily available/i.test(lower)) {
        quickReplies.push("1 hour / day", "2 hours / day", "3 hours / day", "Skip");
    }
    // 6. Deadline / Target date question
    else if (/target date|deadline in mind|upcoming exam|interview deadline/i.test(lower)) {
        quickReplies.push("In 2 weeks", "In 1 month", "In 3 months", "No strict deadline (Self-paced)", "Skip");
    }
    // 7. Learning preference question
    else if (/preferred (?:way of )?learning|preferred explanation style|hands-on/i.test(lower)) {
        quickReplies.push("Explanations + Examples", "Hands-on Coding", "Quizzes & Practice", "Balanced Mix", "Skip");
    }
    // 8. Study schedule question
    else if (/preferred study days|study schedule|weekdays only/i.test(lower)) {
        quickReplies.push("Every day", "Weekdays only", "Weekends only", "Skip");
    }
    // 9. Initial onboarding question (Goal / What do you want to learn)
    else if (/what do you want to learn or achieve|what are we learning today/i.test(lower)) {
        quickReplies.push("Learn Java from scratch", "Master Python for Data Science", "Web Development with JavaScript", "Prepare for Computer Science Exams");
    }

    return { quickReplies, planPreview };
}

