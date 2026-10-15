import React, { useState } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'

export const ChatMessage = React.memo(function ChatMessage({
  message,
  onRetry,
  canRetry,
  onQuickReply,
  isLatest,
}) {
  const [copied, setCopied] = useState(false)
  const isAssistant = message.role === 'assistant'

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard fallback
    }
  }

  return (
    <article className={`message-card ${message.role}`}>
      <div className="message-layout">
        <div className="message-avatar-wrap" aria-hidden="true">
          {isAssistant ? (
            <div className="avatar assistant-avatar" title="StudyPilot AI Tutor">
              <span className="avatar-symbol">🤖</span>
            </div>
          ) : (
            <div className="avatar user-avatar" title="Alex">
              <span className="avatar-symbol">A</span>
            </div>
          )}
        </div>

        <div className="message-main">
          <div className="message-meta-row">
            <span className="message-author-label">
              {isAssistant ? 'StudyPilot AI Tutor' : 'You'}
            </span>
            {message.timestamp && (
              <time className="message-timestamp">{message.timestamp}</time>
            )}

            <div className="message-actions-cluster">
              <button
                type="button"
                className="action-pill-btn"
                onClick={handleCopyMessage}
                title="Copy entire response"
                aria-label="Copy response"
              >
                {copied ? '✓ Copied' : '⧉ Copy'}
              </button>
            </div>
          </div>

          {/* Clean Markdown content */}
          <div className="message-prose">
            <MarkdownRenderer content={message.content} />
          </div>

          {/* Plan Preview Card before confirmation */}
          {isAssistant && message.planPreview && (
            <div className="plan-preview-card" role="region" aria-label="Proposed Study Plan Preview">
              <div className="plan-preview-header">
                <div className="plan-preview-title-row">
                  <span className="plan-preview-badge">📋 Proposed Plan</span>
                  <h4 className="plan-preview-title">{message.planPreview.title}</h4>
                </div>
                {message.planPreview.goal && (
                  <p className="plan-preview-goal">
                    <strong>Goal:</strong> {message.planPreview.goal}
                  </p>
                )}
                <div className="plan-preview-meta-row">
                  {message.planPreview.level && (
                    <span className="meta-pill">
                      <span className="meta-icon">🎯</span> Level: {message.planPreview.level}
                    </span>
                  )}
                  {message.planPreview.dailyHours && (
                    <span className="meta-pill">
                      <span className="meta-icon">⏱</span> {message.planPreview.dailyHours}
                    </span>
                  )}
                  {message.planPreview.timeline && (
                    <span className="meta-pill">
                      <span className="meta-icon">📅</span> {message.planPreview.timeline}
                    </span>
                  )}
                </div>
              </div>

              {Array.isArray(message.planPreview.modules) && message.planPreview.modules.length > 0 && (
                <div className="plan-preview-modules">
                  <span className="modules-label">Curriculum Modules (Prerequisite Sequence):</span>
                  <div className="modules-list">
                    {message.planPreview.modules.map((mod, idx) => (
                      <div key={idx} className="module-item">
                        <span className="module-num">{mod.number || idx + 1}</span>
                        <div className="module-info">
                          <strong className="module-title">{mod.title}</strong>
                          {mod.duration && <span className="module-dur">{mod.duration}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {isLatest && onQuickReply && (
                <div className="plan-preview-actions">
                  <button
                    type="button"
                    className="btn-confirm-plan"
                    onClick={() => onQuickReply('Confirm & create plan')}
                  >
                    <span>✓ Confirm &amp; Save Study Plan</span>
                  </button>
                  <button
                    type="button"
                    className="btn-modify-plan"
                    onClick={() => onQuickReply('I would like to modify the schedule or topics')}
                  >
                    <span>✏ Modify Plan</span>
                  </button>
                  <button
                    type="button"
                    className="btn-quiz-plan"
                    onClick={() => onQuickReply('Give me a diagnostic quiz first')}
                  >
                    <span>📝 Diagnostic Quiz</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Quick Reply Chips */}
          {isAssistant && isLatest && Array.isArray(message.quickReplies) && message.quickReplies.length > 0 && (
            <div className="quick-replies-wrapper" role="group" aria-label="Suggested responses">
              <span className="quick-replies-hint">Suggested response:</span>
              <div className="quick-chips-row">
                {message.quickReplies.map((chip, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="quick-chip-btn"
                    onClick={() => onQuickReply?.(chip)}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Failure Notice */}
          {isAssistant && message.success === false && !message.needsClarification && (
            <div className="message-failure-alert" role="alert">
              <div className="failure-alert-body">
                <span className="failure-icon" aria-hidden="true">⚠</span>
                <span className="failure-text">
                  StudyPilot could not complete this response. Please retry.
                </span>
              </div>
              {canRetry && onRetry && (
                <button
                  type="button"
                  className="retry-pill-btn"
                  onClick={onRetry}
                  aria-label="Retry this request"
                >
                  ↺ Retry
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  )
})
