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
  const [listening, setListening] = useState(false)
  const [voiceError, setVoiceError] = useState('')
  const [prevDraft, setPrevDraft] = useState(draftValue)
  const textareaRef = useRef(null)
  const recognitionRef = useRef(null)

  useEffect(() => () => recognitionRef.current?.stop(), [])

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

  const handleVoiceInput = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      setVoiceError('Voice input is not supported in this browser. Try Chrome or Edge.')
      return
    }
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }
    setVoiceError('')
    const recognition = new SpeechRecognition()
    recognition.lang = navigator.language || 'en-US'
    recognition.interimResults = true
    recognition.continuous = false
    recognitionRef.current = recognition
    recognition.onstart = () => setListening(true)
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results).map((result) => result[0].transcript).join('')
      setText(transcript)
      if (textareaRef.current) adjustHeight(textareaRef.current)
    }
    recognition.onerror = (event) => {
      setListening(false)
      setVoiceError(event.error === 'not-allowed' ? 'Allow microphone access to use voice input.' : 'Voice input stopped. Please try again.')
    }
    recognition.onend = () => setListening(false)
    recognition.start()
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

              {!loading && (
                <button
                  type="button"
                  className={`btn-voice-input ${listening ? 'is-listening' : ''}`}
                  onClick={handleVoiceInput}
                  title={listening ? 'Stop voice input' : 'Speak your question'}
                  aria-label={listening ? 'Stop voice input' : 'Start voice input'}
                  aria-pressed={listening}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="2" width="6" height="12" rx="3" />
                    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
                  </svg>
                </button>
              )}

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

        {voiceError && <div className="voice-input-error" role="status">{voiceError}</div>}
        <div className={`composer-hint-caption ${listening ? 'voice-listening-caption' : ''}`}>
          <span>{listening ? 'Listening… speak naturally, then send your question' : 'Press Enter to send · Shift + Enter for a new line · Tap the mic to speak'}</span>
        </div>
      </div>
    </footer>
  )
}
