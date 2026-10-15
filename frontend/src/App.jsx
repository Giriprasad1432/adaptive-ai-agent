import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { ChatComposer } from './components/ChatComposer'
import { ChatMessage } from './components/ChatMessage'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { StudyPlannerView } from './components/StudyPlannerView'
import { ProgressView } from './components/ProgressView'
import { PreferencesView } from './components/PreferencesView'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

const SUGGESTIONS = [
  {
    id: 'ai-onboarding',
    icon: '✦',
    tag: 'Personalized AI Tutor',
    title: 'Start creating my personalized study plan.',
    subtitle: 'Discover your goals, starting level, and preferred schedule first',
  },
  {
    id: 'tutor-question',
    icon: '💡',
    tag: 'Academic Tutoring',
    title: 'Explain recursion and dynamic programming.',
    subtitle: 'Intuitive analogies, core principles, and clean code examples',
  },
  {
    id: 'quiz-practice',
    icon: '📝',
    tag: 'Practice Quizzes',
    title: 'Give me a diagnostic quiz to test my level.',
    subtitle: 'Check your knowledge gaps and identify weak areas for review',
  },
  {
    id: 'plan-progress',
    icon: '📊',
    tag: 'Adaptive Analytics',
    title: 'Show my study plan progress and workload.',
    subtitle: 'Review completed hours, pacing against deadlines, and catch-up',
  },
]

const DEFAULT_ONBOARDING_GREETING = {
  role: 'assistant',
  content: "Hi! I'm your StudyPilot AI tutor. Let's create a study plan that fits your goals, current level, and schedule. I'll ask a few questions first.\n\nTo begin, what do you want to learn or achieve?",
  quickReplies: [
    "Learn Java from scratch",
    "Master Python for Data Science",
    "Web Development with JavaScript",
    "Prepare for Computer Science Exams"
  ],
  timestamp: 'AI Tutor'
}

function App() {
  const [currentView, setCurrentView] = useState('chat')
  const [conversationId, setConversationId] = useState(() => {
    return sessionStorage.getItem('studypilot-conversation-id') || crypto.randomUUID()
  })
  const [messages, setMessages] = useState([DEFAULT_ONBOARDING_GREETING])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [apiStatus, setApiStatus] = useState('checking')
  const [healthInfo, setHealthInfo] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [draftValue, setDraftValue] = useState('')
  const [activePlanId, setActivePlanId] = useState('')

  const bottomRef = useRef(null)
  const abortControllerRef = useRef(null)
  const lastUserPromptRef = useRef('')

  // Scroll to bottom on new messages or loading
  useEffect(() => {
    if (currentView === 'chat') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, loading, currentView])

  // Sync conversation ID to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('studypilot-conversation-id', conversationId)
  }, [conversationId])

  // Health check polling
  useEffect(() => {
    let stopped = false
    const checkHealth = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/health`)
        const health = await response.json()
        if (!response.ok) throw new Error('Health check failed')
        if (!stopped) {
          setHealthInfo(health)
          setApiStatus(
            health.providerStatus?.available && health.mcp?.connected ? 'online' : 'partial'
          )
        }
      } catch {
        if (!stopped) {
          setApiStatus('offline')
        }
      }
    }

    checkHealth()
    const timer = window.setInterval(checkHealth, 30000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [])

  // Clean up in-flight request on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  const handleAbort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
      setLoading(false)
      setError('Generation stopped by user.')
    }
  }, [])

  const handleSendMessage = useCallback(
    async (text) => {
      const message = text.trim()
      if (!message || loading) return

      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }

      const controller = new AbortController()
      abortControllerRef.current = controller

      lastUserPromptRef.current = message
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

      setMessages((prev) => [
        ...prev,
        { role: 'user', content: message, timestamp: timeStr },
      ])
      setError('')
      setLoading(true)

      try {
        const history = messages
          .filter((item) => item.role === 'user' || item.role === 'assistant')
          .map(({ role, content }) => ({ role, content }))

        const response = await fetch(`${API_BASE_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            conversationId,
            messages: history,
          }),
          signal: controller.signal,
        })

        const data = await response.json().catch(() => ({}))

        if (!response.ok) {
          throw new Error(
            data.error || data.message || `Request failed (${response.status})`
          )
        }

        const answer =
          data.response ?? data.answer ?? data.reply ?? data.message

        if (typeof answer !== 'string' || !answer.trim()) {
          throw new Error(
            'The API responded, but no text reply was found. Check the response format.'
          )
        }

        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: answer,
            success: data.success,
            partialSuccess: data.partialSuccess,
            steps: data.steps || [],
            quickReplies: data.quickReplies || [],
            planPreview: data.planPreview || null,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ])

        if (data.conversationId && data.conversationId !== conversationId) {
          setConversationId(data.conversationId)
        }

        // Check if a plan ID was created or touched
        const planCreatedStep = data.steps?.find(
          (s) => s.type === 'tool_result' && s.tool === 'create_study_plan' && !s.isError
        )
        if (planCreatedStep?.content) {
          try {
            const parsed = JSON.parse(planCreatedStep.content)
            if (parsed.planId) {
              setActivePlanId(parsed.planId)
            }
          } catch {
            // Ignore non-JSON tool content
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          return
        }
        setError(err.message || 'Could not connect to StudyPilot.')
      } finally {
        setLoading(false)
        abortControllerRef.current = null
      }
    },
    [conversationId, loading, messages]
  )

  const handleRetryLast = useCallback(() => {
    if (lastUserPromptRef.current) {
      handleSendMessage(lastUserPromptRef.current)
    }
  }, [handleSendMessage])

  const handleNewChat = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setMessages([DEFAULT_ONBOARDING_GREETING])
    setError('')
    setLoading(false)
    const nextId = crypto.randomUUID()
    setConversationId(nextId)
    sessionStorage.setItem('studypilot-conversation-id', nextId)
  }, [])

  // Clicking a suggestion card directly submits the request
  const handleSelectSuggestion = useCallback(
    (prompt) => {
      setCurrentView('chat')
      handleSendMessage(prompt)
    },
    [handleSendMessage]
  )

  const handleAskInChat = useCallback(
    (prompt) => {
      setCurrentView('chat')
      handleSendMessage(prompt)
    },
    [handleSendMessage]
  )

  const handleNavigateToPlanner = useCallback((planId) => {
    if (planId) setActivePlanId(planId)
    setCurrentView('planner')
  }, [])

  return (
    <div className="app-shell">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        currentView={currentView}
        onSelectView={setCurrentView}
        onNewChat={handleNewChat}
        apiStatus={apiStatus}
        healthInfo={healthInfo}
      />

      <section className="workspace">
        <TopBar
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          currentView={currentView}
          onSelectView={setCurrentView}
          apiStatus={apiStatus}
          healthInfo={healthInfo}
        />

        {/* VIEW 1: AI TUTOR (PRIMARY CHAT EXPERIENCE) */}
        {currentView === 'chat' && (
          <div className="chat-viewport">
            <div className="chat-scroll-container">
              <div className="chat-inner-width">
                {/* Initial Empty State when no messages */}
                {messages.length === 0 ? (
                  <div className="chat-empty-hero">
                    <div className="hero-icon-bubble">
                      <span className="hero-pilot-icon" aria-hidden="true">✦</span>
                    </div>

                    <h2 className="hero-heading">What are we learning today?</h2>
                    <p className="hero-description">
                      Ask academic questions, build structured study plans, or test your mastery.
                    </p>

                    <div className="suggestions-grid" role="region" aria-label="Suggested Prompts">
                      {SUGGESTIONS.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="suggestion-action-card"
                          onClick={() => handleSelectSuggestion(item.title)}
                          aria-label={`Ask: ${item.title}`}
                          title={item.title}
                        >
                          <span className="suggestion-icon" aria-hidden="true">{item.icon}</span>
                          <div className="suggestion-text-wrap">
                            <strong className="suggestion-title">{item.title}</strong>
                            <p className="suggestion-sub">{item.subtitle}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="chat-messages-stream" role="log" aria-live="polite">
                    {messages.map((item, index) => (
                      <ChatMessage
                        key={index}
                        message={item}
                        onRetry={handleRetryLast}
                        canRetry={index === messages.length - 1}
                        onQuickReply={handleSendMessage}
                        isLatest={index === messages.length - 1}
                      />
                    ))}

                    {loading && (
                      <article className="message-card assistant loading-state-card">
                        <div className="message-layout">
                          <div className="message-avatar-wrap" aria-hidden="true">
                            <div className="avatar assistant-avatar pulsing-avatar">
                              <span className="avatar-symbol">⚡</span>
                            </div>
                          </div>
                          <div className="message-main">
                            <div className="message-meta-row">
                              <span className="message-author-label">StudyPilot Agent</span>
                              <span className="agent-thinking-pill">Executing Agent Loop…</span>
                            </div>
                            <div className="thinking-bubble">
                              <span className="typing-dot" />
                              <span className="typing-dot" />
                              <span className="typing-dot" />
                            </div>
                          </div>
                        </div>
                      </article>
                    )}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>
            </div>

            {error && (
              <div className="chat-error-bar-wrapper">
                <div className="chat-error-bar" role="alert">
                  <span className="error-icon" aria-hidden="true">⚠</span>
                  <span className="error-text">{error}</span>
                  <button
                    type="button"
                    className="error-dismiss-btn"
                    onClick={() => setError('')}
                    aria-label="Dismiss error notice"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            <ChatComposer
              loading={loading}
              onSubmit={handleSendMessage}
              onAbort={handleAbort}
              draftValue={draftValue}
              onDraftConsumed={() => setDraftValue('')}
            />
          </div>
        )}

        {/* VIEW 2: STUDY PLANNER */}
        {currentView === 'planner' && (
          <div className="view-scroll-container">
            <StudyPlannerView
              onAskInChat={handleAskInChat}
              activePlanId={activePlanId}
            />
          </div>
        )}

        {/* VIEW 3: MY PROGRESS */}
        {currentView === 'progress' && (
          <div className="view-scroll-container">
            <ProgressView
              onNavigateToPlanner={handleNavigateToPlanner}
              onAskInChat={handleAskInChat}
            />
          </div>
        )}

        {/* VIEW 4: PREFERENCES */}
        {currentView === 'preferences' && (
          <div className="view-scroll-container">
            <PreferencesView />
          </div>
        )}
      </section>
    </div>
  )
}

export default App
