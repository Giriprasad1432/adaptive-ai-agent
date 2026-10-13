import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import { normalizeToolArguments, isRetrievalIntent, isAdaptationIntent, isSessionRecordingIntent, isPlanListingIntent, extractExplicitPlanId, isPlanCreationContinuation } from "./normalizer.js";
import { validateToolArguments, verifyToolResult } from "./validator.js";
import { verifyFinalAnswerConsistency, stripMetaPreamble, formatGroundedPlanSummary, formatGroundedPlanList, formatGroundedAdaptationSummary, formatGroundedRetrievalSummary, formatGroundedSessionSummary } from "./consistencyChecker.js";

const MUTATION_TOOLS = new Set(["record_study_session", "create_study_plan", "adapt_study_plan"]);

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

        const permitsPartialSuccess = allowPartialSuccess ?? this.allowPartialSuccess;
        const effectiveTimeoutMs = toolTimeoutMs ?? this.toolTimeoutMs;
        let resolvedActivePlanId = activePlanId;

        // 1. Fetch available tools dynamically from MCP client
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
        let completed = false;
        let concluded = false;
        let finalReply = "";
        let roundsExecuted = 0;
        let turnFailures = [];
        let turnSuccesses = [];
        let lastToolExecutionFailed = false;
        let lastToolFailureReason = "";

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

        const needsExistingPlan = !createContinuation && !resolvedActivePlanId &&
            !concluded &&
            !extractExplicitPlanId(message) &&
            (isRetrievalIntent(message) || isSessionRecordingIntent(message) || isAdaptationIntent(message));
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
                if (listedData.plans.length === 1) resolvedActivePlanId = listedData.plans[0].planId;
                conversation.push({ role: "system", content: `Verified saved study plans (internal IDs; never ask the user to repeat an ID): ${JSON.stringify(listedData.plans)}. Select a single matching plan by its subjects or ask the user to choose by subject/description when ambiguous.` });
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
                providerResponse = await this.provider.chat({
                    messages: conversation,
                    tools
                });
            } catch (error) {
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
                tool_calls: toolCalls.map(tc => ({
                    function: {
                        name: tc.name,
                        arguments: tc.arguments
                    }
                }))
            });

            // Execute each requested tool call
            for (const call of toolCalls) {
                let toolName = call.name;
                const rawArgs = call.arguments || {};

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

        return {
            success: finalSuccess,
            partialSuccess: isPartial,
            reply: finalReply,
            activePlanId: resolvedActivePlanId,
            steps,
            rounds: roundsExecuted
        };
    }
}
