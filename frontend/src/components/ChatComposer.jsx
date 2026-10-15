import { useEffect, useRef, useState } from 'react'

function adjustHeight(el) {
  if (!el) return
  el.style.height = 'auto'
  const newHeight = Math.min(el.scrollHeight, 160)
  el.style.height = `${Math.max(46, newHeight)}px`
}

export function ChatComposer({
  loading,
  onSubmit,
  onAbort,
  draftValue,
  onDraftConsumed,
}) {
  const [text, setText] = useState('')
  const [prevDraft, setPrevDraft] = useState(draftValue)
  const textareaRef = useRef(null)

  if (draftValue && draftValue !== prevDraft) {
    setPrevDraft(draftValue)
    setText(draftValue)
  }

  useEffect(() => {
    if (draftValue) {
      onDraftConsumed?.()
      if (textareaRef.current) {
        textareaRef.current.focus()
        adjustHeight(textareaRef.current)
      }
    }
  }, [draftValue, onDraftConsumed])

  const handleChange = (e) => {
    setText(e.target.value)
    adjustHeight(e.target)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleSubmit = (e) => {
    e?.preventDefault?.()
    const trimmed = text.trim()
    if (!trimmed || loading) return

    onSubmit(trimmed)
    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = '46px'
    }
  }

  return (
    <footer className="composer-region">
      <div className="composer-inner">
        <form className="composer-card-pill" onSubmit={handleSubmit}>
          <div className="composer-input-row">
            <textarea
              ref={textareaRef}
              rows={1}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={
                loading
                  ? 'Processing response...'
                  : 'Type your message...'
              }
              disabled={loading}
              aria-label="Type your message"
            />

            <div className="composer-actions-cluster">
              <button
                type="button"
                className="composer-inline-icon-btn"
                title="Attach notes or topic context"
                aria-label="Attach notes"
                onClick={() => {}}
              >
                <span aria-hidden="true">📎</span>
              </button>

              <button
                type="button"
                className="composer-inline-icon-btn"
                title="Add reference image or formula"
                aria-label="Add image"
                onClick={() => {}}
              >
                <span aria-hidden="true">🖼️</span>
              </button>

              <button
                type="button"
                className="composer-inline-icon-btn"
                title="Options"
                aria-label="Options"
                onClick={() => {}}
              >
                <span aria-hidden="true">⌵</span>
              </button>

              {loading ? (
                <button
                  type="button"
                  className="btn-stop-pill"
                  onClick={onAbort}
                  title="Stop generation"
                  aria-label="Stop generation"
                >
                  <span className="stop-sq">■</span>
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn-send-round-violet"
                  disabled={!text.trim()}
                  title="Send message (Enter)"
                  aria-label="Send message"
                >
                  <svg
                    className="send-plane-svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </form>

        <div className="composer-hint-caption">
          <span>✓ Press Enter to send • Shift + Enter for new line</span>
        </div>
      </div>
    </footer>
  )
}
