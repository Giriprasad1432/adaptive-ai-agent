import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { ChatComposer } from './components/ChatComposer'
import { ChatMessage } from './components/ChatMessage'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { StudyPlannerView } from './components/StudyPlannerView'
import { ProgressView } from './components/ProgressView'
import { HistoryView } from './components/HistoryView'
import { PreferencesView } from './components/PreferencesView'
import { RightLearningPanel } from './components/RightLearningPanel'
import {
  loadAllConversations,
  saveAllConversations,
  getActiveConversationId,
  setActiveConversationId,
  createNewConversationObject,
  deleteConversationFromStorage,
  renameConversationInStorage,
  clearAllConversationsFromStorage,
  generateTitle,
  DEFAULT_GREETING_MESSAGE,
} from './utils/conversationStorage'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

function sanitizeErrorMessage(err) {
  if (!err) return 'Could not connect to StudyPilot. Please check your connection and try again.'
  const raw = typeof err === 'string' ? err : err.message || ''
  if (
    /stack|at\s+[a-z0-9_.\\]+|econnrefused|internal\s+server|typeerror|referenceerror|syntaxerror|groq|llama|mcp|undefined|node_modules/i.test(
      raw
    )
  ) {
    return 'StudyPilot encountered an unexpected issue while processing your request. Please try again.'
  }
  return raw || 'Could not connect to StudyPilot. Please try again.'
}

// 5 Onboarding Action Chips matching the Mockup
const ONBOARDING_CHIPS = [
  { id: 'new-subject', title: 'Learn a new subject', requiresPlanTools: false },
  { id: 'exam-prep', title: 'Prepare for an exam', requiresPlanTools: false },
  { id: 'prog-skills', title: 'Build programming skills', requiresPlanTools: false },
  { id: 'weak-topics', title: 'Improve my weak topics', requiresPlanTools: true },
  { id: 'study-plan', title: 'Create a study plan', requiresPlanTools: true },
]

function App() {
  const [currentView, setCurrentView] = useState('chat')
  const [userName, setUserName] = useState('Alex')

  // Theme Management: 'dark' | 'light' | 'system'
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('studypilot_theme') || 'dark'
  })

  // Right Dashboard Panel state: default open on desktop (>= 1200px), optional/toggleable
  const [showRightPanel, setShowRightPanel] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 1200) {
      return true
    }
    return false
  })

  // Apply Theme Effect
  useEffect(() => {
    localStorage.setItem('studypilot_theme', theme)
    const root = document.documentElement

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const applySystemTheme = (e) => {
        root.setAttribute('data-theme', e.matches ? 'dark' : 'light')
      }
      applySystemTheme(mediaQuery)
      mediaQuery.addEventListener('change', applySystemTheme)
      return () => mediaQuery.removeEventListener('change', applySystemTheme)
    } else {
      root.setAttribute('data-theme', theme)
    }
  }, [theme])

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => {
      if (prev === 'dark') return 'light'
      if (prev === 'light') return 'system'
      return 'dark'
    })
  }, [])

  // Fetch preferences for user name
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/preferences`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.userName) setUserName(data.userName)
      })
      .catch(() => {})
  }, [])

  // ChatGPT-Style Conversations Storage State
  const [conversations, setConversations] = useState(() => {
    const loaded = loadAllConversations()
    if (loaded.length > 0) return loaded
    const initial = createNewConversationObject()
    saveAllConversations([initial])
    return [initial]
  })

  const [activeConversationId, setActiveConvoIdState] = useState(() => {
    const savedActiveId = getActiveConversationId()
    const all = loadAllConversations()
    if (savedActiveId && all.some((c) => c.id === savedActiveId)) {
      return savedActiveId
    }
    return all.length > 0 ? all[0].id : crypto.randomUUID()
  })

  // Ensure active conversation ID is synced to storage
  useEffect(() => {
    setActiveConversationId(activeConversationId)
  }, [activeConversationId])

  // Get active conversation object
  const activeConversation =
    conversations.find((c) => c.id === activeConversationId) ||
    conversations[0] ||
    createNewConversationObject()
  const messages = activeConversation.messages || []

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

  // Backend Health check polling with fast retry during initial MCP startup
  useEffect(() => {
    let stopped = false
    let timerId = null

    const checkHealth = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/health`)
        const health = await response.json()
        if (!response.ok) throw new Error('Health check failed')
        if (!stopped) {
          setHealthInfo(health)
          const mcpReady = Boolean(health.mcp?.connected)
          const providerReady = Boolean(health.providerStatus?.available)
          setApiStatus(providerReady && mcpReady ? 'online' : 'partial')

          // Poll quickly (1000ms) until MCP connects, then relax to 30000ms
          const delayMs = mcpReady ? 30000 : 1000
          timerId = window.setTimeout(checkHealth, delayMs)
        }
      } catch {
        if (!stopped) {
          setApiStatus('offline')
          timerId = window.setTimeout(checkHealth, 3000)
        }
      }
    }

    checkHealth()
    return () => {
      stopped = true
      if (timerId) window.clearTimeout(timerId)
    }
  }, [])

  const isMcpReady = Boolean(healthInfo?.mcp?.connected)

  // Clean up in-flight request on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  // Abort Handler
  const handleAbort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
      setLoading(false)
      setError('Generation stopped by user.')
    }
  }, [])

  // Update Messages in active conversation
  const updateActiveConversationMessages = useCallback(
    (updater) => {
      setConversations((prev) => {
        const updated = prev.map((c) => {
          if (c.id === activeConversationId) {
            const nextMessages = typeof updater === 'function' ? updater(c.messages || []) : updater
            return {
              ...c,
              messages: nextMessages,
              updatedAt: new Date().toISOString(),
            }
          }
          return c
        })
        saveAllConversations(updated)
        return updated
      })
    },
    [activeConversationId]
  )

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

      const userMsg = { role: 'user', content: message, timestamp: timeStr }

      // Check if conversation title should be auto-named from first user message
      const isFirstUserMessage = !messages.some((m) => m.role === 'user')
      if (isFirstUserMessage) {
        const autoTitle = generateTitle(message)
        setConversations((prev) => {
          const updated = prev.map((c) => {
            if (c.id === activeConversationId) {
              return { ...c, title: autoTitle }
            }
            return c
          })
          saveAllConversations(updated)
          return updated
        })
      }

      updateActiveConversationMessages((prev) => [...prev, userMsg])
      setError('')
      setLoading(true)

      try {
        const history = [...messages, userMsg]
          .filter((item) => item.role === 'user' || item.role === 'assistant')
          .map(({ role, content }) => ({ role, content }))

        const response = await fetch(`${API_BASE_URL}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            conversationId: activeConversationId,
            messages: history,
            activePlanId: activePlanId || undefined,
          }),
          signal: controller.signal,
        })

        const data = await response.json().catch(() => ({}))

        if (!response.ok) {
          const rawErr = data.error || data.message || `Request failed (${response.status})`
          throw new Error(sanitizeErrorMessage(rawErr))
        }

        const answer =
          data.response ?? data.answer ?? data.reply ?? data.message

        if (typeof answer !== 'string' || !answer.trim()) {
          throw new Error(
            'The assistant responded, but no text reply was found. Please try again.'
          )
        }

        const assistantMsg = {
          role: 'assistant',
          content: answer,
          success: data.success,
          partialSuccess: data.partialSuccess,
          needsClarification: data.needsClarification,
          steps: data.steps || [],
          quickReplies: data.quickReplies || [],
          planPreview: data.planPreview || null,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }

        updateActiveConversationMessages((prev) => [...prev, assistantMsg])

        if (data.activePlanId) {
          setActivePlanId(data.activePlanId)
        } else {
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
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          return
        }
        setError(sanitizeErrorMessage(err))
      } finally {
        setLoading(false)
        abortControllerRef.current = null
      }
    },
    [activeConversationId, loading, messages, updateActiveConversationMessages]
  )

  const handleRetryLast = useCallback(() => {
    if (lastUserPromptRef.current && !loading) {
      handleSendMessage(lastUserPromptRef.current)
    }
  }, [handleSendMessage, loading])

  // New Chat Handler
  const handleNewChat = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    const newConvo = createNewConversationObject()
    setConversations((prev) => {
      const updated = [newConvo, ...prev]
      saveAllConversations(updated)
      return updated
    })
    setActiveConvoIdState(newConvo.id)
    setError('')
    setLoading(false)
  }, [])

  // Select Conversation
  const handleSelectConversation = useCallback((id) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setActiveConvoIdState(id)
    setError('')
    setLoading(false)
  }, [])

  // Delete Conversation
  const handleDeleteConversation = useCallback(
    (id) => {
      const updated = deleteConversationFromStorage(id)
      setConversations(updated)
      if (id === activeConversationId) {
        if (updated.length > 0) {
          setActiveConvoIdState(updated[0].id)
        } else {
          const fresh = createNewConversationObject()
          saveAllConversations([fresh])
          setConversations([fresh])
          setActiveConvoIdState(fresh.id)
        }
      }
    },
    [activeConversationId]
  )

  // Rename Conversation
  const handleRenameConversation = useCallback((id, newTitle) => {
    const updated = renameConversationInStorage(id, newTitle)
    setConversations(updated)
  }, [])

  // Rename active chat from TopBar
  const handleRenameCurrentChat = useCallback(() => {
    const currentTitle = activeConversation.title || 'New Chat'
    const newTitle = window.prompt('Enter new title for this conversation:', currentTitle)
    if (newTitle && newTitle.trim()) {
      handleRenameConversation(activeConversationId, newTitle.trim())
    }
  }, [activeConversation.title, activeConversationId, handleRenameConversation])

  // Clear Messages in current conversation
  const handleClearCurrentChat = useCallback(() => {
    updateActiveConversationMessages([DEFAULT_GREETING_MESSAGE])
    setError('')
  }, [updateActiveConversationMessages])

  // Clear All Conversation History
  const handleClearAllHistory = useCallback(() => {
    clearAllConversationsFromStorage()
    const fresh = createNewConversationObject()
    saveAllConversations([fresh])
    setConversations([fresh])
    setActiveConvoIdState(fresh.id)
    setError('')
  }, [])

  // Callback to start learning in chat from any view
  const handleStartLearningInChat = useCallback(
    (prompt = "Hi! Let's create a personalized study plan.") => {
      setCurrentView('chat')
      handleSendMessage(prompt)
    },
    [handleSendMessage]
  )

  return (
    <div className="app-shell">
      {/* LEFT NAVIGATION DRAWER / SIDEBAR */}
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        currentView={currentView}
        onSelectView={setCurrentView}
        onNewChat={handleNewChat}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onRenameConversation={handleRenameConversation}
        onClearCurrentChat={handleClearCurrentChat}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        apiStatus={apiStatus}
      />

      <section className="workspace">
        {/* TOP APP BAR */}
        <TopBar
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          currentView={currentView}
          onSelectView={setCurrentView}
          activeConversationTitle={activeConversation.title}
          onClearCurrentChat={handleClearCurrentChat}
          onRenameCurrentChat={handleRenameCurrentChat}
          theme={theme}
          onToggleTheme={handleToggleTheme}
          apiStatus={apiStatus}
          showRightPanel={showRightPanel}
          onToggleRightPanel={() => setShowRightPanel((prev) => !prev)}
          userName={userName}
        />

        {/* VIEW 1: AI TUTOR CHAT (PRIMARY AI ASSISTANT EXPERIENCE) */}
        {currentView === 'chat' && (
          <div className="chat-layout-split">
            <div className="chat-viewport">
              <div className="chat-scroll-container">
                <div className="chat-inner-width">
                  {/* Empty state or Onboarding Hero matching mockup */}
                  {messages.length === 0 ? (
                    <div className="chat-onboarding-hero">
                      <div className="onboarding-orbit" aria-hidden="true">
                        <span className="orbit-ring orbit-ring-one" />
                        <span className="orbit-ring orbit-ring-two" />
                        <span className="onboarding-bot-avatar-glow"><span className="onboarding-bot-emoji">✦</span></span>
                        <span className="orbit-spark orbit-spark-one">✧</span>
                        <span className="orbit-spark orbit-spark-two">·</span>
                      </div>

                      <span className="onboarding-eyebrow">YOUR PERSONAL AI STUDY COMPANION</span>
                      <h2 className="onboarding-heading">Hi {userName}, what’s on your mind?</h2>
                      <p className="onboarding-subheading">
                        Ask anything, explore a new subject, or tell me what you’re working toward. We’ll figure out the next step together.
                      </p>

                      {!isMcpReady && apiStatus === 'partial' && (
                        <div className="mcp-initializing-pill" style={{ margin: '0 auto 1.25rem', padding: '0.4rem 1rem', background: 'rgba(59, 130, 246, 0.12)', border: '1px solid rgba(59, 130, 246, 0.25)', borderRadius: 20, fontSize: '0.82rem', color: '#93c5fd', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, maxWidth: 440 }}>
                          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#60a5fa' }} />
                          <span>Planner tools connecting… Academic Q&A is ready.</span>
                        </div>
                      )}

                      <div className="onboarding-prompt-label">A good place to start</div>
                      <div className="onboarding-chips-grid" role="region" aria-label="Suggested Learning Paths">
                        {ONBOARDING_CHIPS.map((chip) => {
                          const disabled = chip.requiresPlanTools && !isMcpReady
                          return (
                            <button
                              key={chip.id}
                              type="button"
                              className={`onboarding-chip-btn ${disabled ? 'disabled' : ''}`}
                              onClick={() => !disabled && handleSendMessage(chip.title)}
                              disabled={disabled}
                              aria-label={`Ask: ${chip.title}`}
                              title={disabled ? 'Waiting for MCP planner tools to connect...' : chip.title}
                              style={disabled ? { opacity: 0.65, cursor: 'not-allowed' } : {}}
                            >
                              <span>{chip.title}</span>
                            </button>
                          )
                        })}
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
                                <span className="avatar-symbol">🤖</span>
                              </div>
                            </div>
                            <div className="message-main">
                              <div className="message-meta-row">
                                <span className="message-author-label">StudyPilot AI Tutor</span>
                                <span className="agent-thinking-pill">Thinking…</span>
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

              {/* Mockup Floating Pill Composer */}
              <ChatComposer
                loading={loading}
                onSubmit={handleSendMessage}
                onAbort={handleAbort}
                draftValue={draftValue}
                onDraftConsumed={() => setDraftValue('')}
              />
            </div>

            {/* Optional Right-Side Learning Dashboard Panel matching mockup */}
            {showRightPanel && (
              <RightLearningPanel
                activePlanId={activePlanId}
                onNavigateToView={(view) => setCurrentView(view)}
                onStartLearning={() => handleStartLearningInChat()}
                onClose={() => setShowRightPanel(false)}
              />
            )}
          </div>
        )}

        {/* VIEW 2: STUDY PLANNER */}
        {currentView === 'planner' && (
          <div className="view-scroll-container">
            <StudyPlannerView
              onAskInChat={handleStartLearningInChat}
              activePlanId={activePlanId}
              mcpConnected={isMcpReady}
            />
          </div>
        )}

        {/* VIEW 3: PROGRESS & ANALYTICS */}
        {currentView === 'progress' && (
          <div className="view-scroll-container">
            <ProgressView
              onNavigateToPlanner={() => setCurrentView('planner')}
              onAskInChat={handleStartLearningInChat}
            />
          </div>
        )}

        {/* VIEW 4: STUDY HISTORY (NEW) */}
        {currentView === 'history' && (
          <div className="view-scroll-container">
            <HistoryView
              onStartLearning={handleStartLearningInChat}
              onNavigateToPlanner={() => setCurrentView('planner')}
            />
          </div>
        )}

        {/* VIEW 5: SETTINGS & PREFERENCES */}
        {currentView === 'preferences' && (
          <div className="view-scroll-container">
            <PreferencesView
              theme={theme}
              onSelectTheme={setTheme}
              onClearAllHistory={handleClearAllHistory}
            />
          </div>
        )}
      </section>
    </div>
  )
}

export default App
