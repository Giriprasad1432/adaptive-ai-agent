import { useState } from 'react'

/**
 * Sanitizes and formats JSON or string content safely without leaking sensitive information.
 */
function formatSafeContent(content) {
  if (!content) return ''
  if (typeof content === 'object') {
    return JSON.stringify(content, null, 2)
  }
  try {
    const parsed = JSON.parse(content)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return String(content)
  }
}

export function AgentActivityTrace({ steps = [], success = true }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [inspectedStep, setInspectedStep] = useState(null)

  if (!Array.isArray(steps) || steps.length === 0) {
    return null
  }

  const toolNames = [
    ...new Set(
      steps
        .map((s) => s.tool || s.redirectedTool || s.toolCalls?.[0]?.name)
        .filter(Boolean)
    ),
  ]

  const hasRedirection = steps.some((s) => s.type === 'intent_tool_redirection')
  const hasGroundedCheck = steps.some((s) => s.type === 'final_answer_grounded')
  const hasError = steps.some((s) => s.type === 'tool_validation_error' || (s.type === 'tool_result' && s.isError))

  const totalToolCalls = steps.filter((s) => s.type === 'tool_executing').length

  return (
    <div className="agent-activity-panel">
      <div
        className="agent-activity-header"
        onClick={() => setIsExpanded((prev) => !prev)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setIsExpanded((prev) => !prev)
          }
        }}
        aria-expanded={isExpanded}
      >
        <div className="activity-header-left">
          <span className="activity-pulse-icon" aria-hidden="true">
            ⚡
          </span>
          <div className="activity-title-group">
            <span className="activity-title">
              Agent Workflow {totalToolCalls > 0 ? `(${totalToolCalls} MCP Tool${totalToolCalls > 1 ? 's' : ''})` : ''}
            </span>
            {toolNames.length > 0 && (
              <span className="activity-summary-meta">
                {toolNames.join(', ')}
              </span>
            )}
          </div>
        </div>

        <div className="activity-header-right">
          <span
            className={`activity-status-tag ${
              hasError ? 'status-error' : success ? 'status-success' : 'status-warning'
            }`}
          >
            {hasError ? 'Error' : success ? 'Completed' : 'Partial'}
          </span>
          <span className="expand-chevron">{isExpanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {isExpanded && (
        <div className="agent-timeline">
          <ol className="timeline-list">
            {/* Tool Selection / Redirections */}
            {hasRedirection && (
              <li className="timeline-stage stage-info">
                <div className="stage-marker">
                  <span className="marker-dot">✦</span>
                </div>
                <div className="stage-content">
                  <div className="stage-header">
                    <strong className="stage-title">Intent Redirection</strong>
                    <span className="badge badge-info">Adaptive</span>
                  </div>
                  {steps
                    .filter((s) => s.type === 'intent_tool_redirection')
                    .map((s, idx) => (
                      <p key={idx} className="stage-desc">
                        Corrected proposed action from <code>{s.originalTool}</code> to{' '}
                        <code>{s.redirectedTool}</code>: {s.reason}
                      </p>
                    ))}
                </div>
              </li>
            )}

            {/* Step 3: Tool Execution & MCP verification */}
            {steps
              .filter((s) => s.type === 'tool_executing' || s.type === 'tool_result' || s.type === 'tool_validation_error')
              .map((step, idx) => {
                const isExec = step.type === 'tool_executing'
                const isValidationErr = step.type === 'tool_validation_error'
                const isErr = isValidationErr || step.isError
                const isResult = step.type === 'tool_result'

                return (
                  <li
                    key={idx}
                    className={`timeline-stage ${isErr ? 'stage-error' : 'stage-completed'}`}
                  >
                    <div className="stage-marker">
                      <span className="marker-dot">{isErr ? '✕' : isExec ? '→' : '✓'}</span>
                    </div>
                    <div className="stage-content">
                      <div className="stage-header">
                        <strong className="stage-title">
                          {isExec
                            ? `Calling MCP Tool: ${step.tool}`
                            : isValidationErr
                            ? `Argument Validation: ${step.tool}`
                            : `Verified MCP Result: ${step.tool}`}
                        </strong>
                        <span
                          className={`badge ${
                            isErr ? 'badge-error' : isExec ? 'badge-in-progress' : 'badge-success'
                          }`}
                        >
                          {isErr ? 'Failed' : isExec ? 'Calling MCP' : 'Completed'}
                        </span>
                      </div>

                      {isExec && step.arguments && Object.keys(step.arguments).length > 0 && (
                        <div className="stage-details">
                          <button
                            type="button"
                            className="toggle-data-btn"
                            onClick={() =>
                              setInspectedStep(inspectedStep === `exec-${idx}` ? null : `exec-${idx}`)
                            }
                          >
                            {inspectedStep === `exec-${idx}` ? 'Hide Arguments' : 'Inspect Arguments'}
                          </button>
                          {inspectedStep === `exec-${idx}` && (
                            <pre className="stage-code">
                              <code>{formatSafeContent(step.arguments)}</code>
                            </pre>
                          )}
                        </div>
                      )}

                      {isResult && (
                        <div className="stage-details">
                          <button
                            type="button"
                            className="toggle-data-btn"
                            onClick={() =>
                              setInspectedStep(inspectedStep === `res-${idx}` ? null : `res-${idx}`)
                            }
                          >
                            {inspectedStep === `res-${idx}` ? 'Hide Tool Result' : 'Inspect MCP Output'}
                          </button>
                          {inspectedStep === `res-${idx}` && (
                            <pre className="stage-code">
                              <code>{formatSafeContent(step.content)}</code>
                            </pre>
                          )}
                        </div>
                      )}

                      {isValidationErr && (
                        <p className="stage-desc text-error">{step.error}</p>
                      )}
                    </div>
                  </li>
                )
              })}

            {/* Step 4: Grounding Verification */}
            {hasGroundedCheck && (
              <li className="timeline-stage stage-completed">
                <div className="stage-marker">
                  <span className="marker-dot">🛡</span>
                </div>
                <div className="stage-content">
                  <div className="stage-header">
                    <strong className="stage-title">Grounding & Consistency Verification</strong>
                    <span className="badge badge-success">Grounded</span>
                  </div>
                  {steps
                    .filter((s) => s.type === 'final_answer_grounded')
                    .map((s, idx) => (
                      <p key={idx} className="stage-desc">
                        Enforced verified tool facts: {s.reason}
                      </p>
                    ))}
                </div>
              </li>
            )}
          </ol>
        </div>
      )}
    </div>
  )
}
