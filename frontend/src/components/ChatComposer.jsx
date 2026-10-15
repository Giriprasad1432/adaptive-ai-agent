import { useEffect, useRef, useState } from 'react'

function adjustHeight(el) {
  if (!el) return
  el.style.height = 'auto'
  const newHeight = Math.min(el.scrollHeight, 160)
  el.style.height = `${Math.max(48, newHeight)}px`
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
      textareaRef.current.style.height = '48px'
    }
  }

  return (
    <footer className="composer-region">
      <div className="composer-inner">
        <form className="composer-card" onSubmit={handleSubmit}>
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              loading
                ? 'Processing request...'
                : 'Ask a question or request a study plan...'
            }
            disabled={loading}
            aria-label="Ask StudyPilot AI"
          />

          <div className="composer-toolbar">
            {loading ? (
              <button
                type="button"
                className="btn-stop-stream"
                onClick={onAbort}
                title="Stop generation"
                aria-label="Stop generation"
              >
                <span className="stop-sq">■</span>
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                className="btn-send-message"
                disabled={!text.trim()}
                title="Send message (Enter)"
                aria-label="Send message"
              >
                <span>Send</span>
                <span className="send-arrow" aria-hidden="true">↑</span>
              </button>
            )}
          </div>
        </form>
      </div>
    </footer>
  )
}
