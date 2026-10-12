import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import { normalizeToolArguments, isRetrievalIntent, isAdaptationIntent, extractExplicitPlanId } from "./normalizer.js";
import { validateToolArguments, verifyToolResult } from "./validator.js";
import { verifyFinalAnswerConsistency, formatGroundedPlanSummary, formatGroundedAdaptationSummary, formatGroundedRetrievalSummary } from "./consistencyChecker.js";

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
    async run({ message, messages = [], allowPartialSuccess, toolTimeoutMs }) {
        if (!message && (!messages || messages.length === 0)) {
            throw new Error("A user message or conversation history is required.");
        }

        const permitsPartialSuccess = allowPartialSuccess ?? this.allowPartialSuccess;
        const effectiveTimeoutMs = toolTimeoutMs ?? this.toolTimeoutMs;

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

        // 3. Bounded Agent Execution Loop
        for (let round = 1; round <= this.maxRounds; round++) {
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
                finalReply = providerResponse.content || "";

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
                                originalReply,
                                correctedReply: finalReply,
                                reason: consistencyCheck.reason,
                                timestamp: new Date().toISOString()
                            });
                        }
                    } else if (isRetrievalIntent(message)) {
                        completed = false;
                        finalReply = `Action Failed: The requested study plan could not be retrieved because no study plan retrieval was performed.`;
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

                // Find tool schema
                const toolDef = tools.find(t => t.name === toolName);

                // Step 1: Normalize tool arguments against tool's inputSchema
                const toolArgs = normalizeToolArguments(toolDef, rawArgs, {
                    message,
                    messages: conversation,
                    context: conversation,
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
                        content: validationErrMsg
                    });

                    continue;
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
                    const callOptions = typeof effectiveTimeoutMs === "number" ? { timeout: effectiveTimeoutMs } : {};
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
            steps,
            rounds: roundsExecuted
        };
    }
}
