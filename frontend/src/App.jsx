
import { useEffect, useRef, useState } from 'react'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

const initialMessage = {
  role: 'assistant',
  content: "Hi! I'm StudyPilot AI. I can help you create study plans, track your sessions, and adapt your schedule. What would you like to work on?",
}

function App() {
  const [conversationId, setConversationId] = useState(() => {
    const saved = sessionStorage.getItem('studypilot-conversation-id')
    return saved || crypto.randomUUID()
  })
  const [messages, setMessages] = useState([initialMessage])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [apiStatus, setApiStatus] = useState('checking')
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    sessionStorage.setItem('studypilot-conversation-id', conversationId)
  }, [conversationId])

  useEffect(() => {
    let stopped = false
    const checkHealth = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/health`)
        const health = await response.json()
        if (!response.ok) throw new Error('Health request failed')
        if (!stopped) setApiStatus(health.providerStatus?.available && health.mcp?.connected ? 'online' : 'partial')
      } catch {
        if (!stopped) setApiStatus('offline')
      }
    }
    checkHealth()
    const timer = window.setInterval(checkHealth, 30000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])

  async function sendMessage(event) {
    event.preventDefault()
    const message = input.trim()

    if (!message || loading) return

    setMessages((previous) => [
      ...previous,
      { role: 'user', content: message },
    ])
    setInput('')
    setError('')
    setLoading(true)

    try {
      const response = await fetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          conversationId,
          messages: messages
            .slice(1)
            .filter((item) => item.role === 'user' || item.role === 'assistant')
            .map(({ role, content }) => ({ role, content })),
        }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error(
          data.error || data.message || `Request failed (${response.status})`,
        )
      }

      const answer =
        data.response ??
        data.answer ??
        data.reply ??
        data.message

      if (typeof answer !== 'string' || !answer.trim()) {
        throw new Error(
          'The API responded, but no text reply was found. Check the response format in src/server.js.',
        )
      }

      setMessages((previous) => [
        ...previous,
        { role: 'assistant', content: answer, success: data.success, steps: data.steps || [] },
      ])
      if (data.conversationId && data.conversationId !== conversationId) {
        setConversationId(data.conversationId)
      }
    } catch (err) {
      setError(err.message || 'Could not connect to StudyPilot.')
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  function startSuggestion(text) {
    setInput(text)
    inputRef.current?.focus()
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="StudyPilot home">
          <span className="brand-icon">S</span>
          <span>StudyPilot<span className="brand-ai"> AI</span></span>
        </a>

        <button
          className="new-chat"
          onClick={() => {
            setMessages([initialMessage])
            setError('')
            setInput('')
            const nextConversationId = crypto.randomUUID()
            setConversationId(nextConversationId)
            sessionStorage.setItem('studypilot-conversation-id', nextConversationId)
          }}
        >
          <span>＋</span> New conversation
        </button>

        <div className="sidebar-label">YOUR STUDY SPACE</div>
        <div className="sidebar-item active">
          <span>◉</span> AI Study Assistant
        </div>
        <div className="sidebar-item">
          <span>▤</span> Study planning
        </div>
        <div className="sidebar-item">
          <span>◷</span> Progress tracking
        </div>

        <div className="sidebar-bottom">
          <div className={`status-dot ${apiStatus}`} />
          <div>
            <strong>StudyPilot backend</strong>
            <small>{apiStatus === 'online' ? 'API and agent ready' : apiStatus === 'partial' ? 'API running; provider or MCP unavailable' : apiStatus === 'offline' ? 'Backend unavailable' : 'Checking connection…'}</small>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="mobile-brand">StudyPilot AI</span>
            <span className="page-label">AI STUDY ASSISTANT</span>
          </div>
          <div className="model-badge">
            <span className={`status-dot ${apiStatus}`} /> {apiStatus === 'online' ? 'Ready' : apiStatus === 'checking' ? 'Checking' : 'Needs attention'}
          </div>
        </header>

        <div className="chat-scroll">
          <div className="chat-content">
            <div className="welcome-heading">
              <div className="welcome-icon">✳</div>
              <p className="eyebrow">YOUR PERSONAL STUDY PARTNER</p>
              <h1>Make every study session count.</h1>
              <p className="welcome-subtitle">
                Plan smarter, keep track of your progress, and adjust your
                study routine as you go.
              </p>
            </div>

            {messages.length === 1 && (
              <div className="suggestions">
                <button onClick={() => startSuggestion('Create a study plan for JavaScript')}>
                  <span>✦</span>
                  <strong>Create a study plan</strong>
                  <small>Build a realistic learning schedule</small>
                  <span className="suggestion-arrow">↗</span>
                </button>
                <button onClick={() => startSuggestion('Help me record a completed study session')}>
                  <span>◷</span>
                  <strong>Track a study session</strong>
                  <small>Record what you've studied</small>
                  <span className="suggestion-arrow">↗</span>
                </button>
                <button onClick={() => startSuggestion('Show me my study progress for plan 2')}>
                  <span>↗</span>
                  <strong>Review my progress</strong>
                  <small>Check your existing study plan</small>
                  <span className="suggestion-arrow">↗</span>
                </button>
              </div>
            )}

            <div className="messages">
              {messages.map((item, index) => (
                <article className={`message ${item.role}`} key={index}>
                  <div className="message-avatar">
                    {item.role === 'assistant' ? '✳' : 'Y'}
                  </div>
                  <div className="message-body">
                    <div className="message-author">
                      {item.role === 'assistant' ? 'StudyPilot' : 'You'}
                    </div>
                    <div className="message-text">{item.content}</div>
                    {item.role === 'assistant' && item.success === false && (
                      <small className="action-failed">This request did not complete.</small>
                    )}
                    {item.role === 'assistant' && item.steps?.some((step) => step.type === 'tool_executing' || step.type === 'tool_result') && (
                      <details className="activity-trace">
                        <summary>Activity</summary>
                        <ul>
                          {item.steps.filter((step) => step.type === 'tool_executing' || step.type === 'tool_result').map((step, stepIndex) => (
                            <li key={`${step.type}-${stepIndex}`}>
                              <strong>{step.type === 'tool_executing' ? 'Called' : step.isError ? 'Failed' : 'Completed'}: {step.tool}</strong>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                </article>
              ))}

              {loading && (
                <article className="message assistant">
                  <div className="message-avatar">✳</div>
                  <div className="message-body">
                    <div className="message-author">StudyPilot</div>
                    <div className="typing-indicator" aria-label="Thinking">
                      <span /><span /><span />
                    </div>
                  </div>
                </article>
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        </div>

        <footer className="composer-area">
          {error && (
            <div className="error-message" role="alert">
              <span>⚠ {error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss error">×</button>
            </div>
          )}
          <form className="composer" onSubmit={sendMessage}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="Ask StudyPilot to help with your studies..."
              rows={2}
              aria-label="Message StudyPilot"
              disabled={loading}
            />
            <div className="composer-bottom">
              <span>Enter to send · Shift + Enter for a new line</span>
              <button
                className="send-button"
                type="submit"
                disabled={loading || !input.trim()}
                aria-label="Send message"
              >
                {loading ? '…' : '↑'}
              </button>
            </div>
          </form>
          <p className="disclaimer">
            StudyPilot can make mistakes. Verify important study-plan details.
          </p>
        </footer>
      </section>
    </main>
  )
}

export default App
