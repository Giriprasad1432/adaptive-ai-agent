export function Sidebar({
  isOpen,
  onClose,
  currentView,
  onSelectView,
  onNewChat,
  apiStatus,
  healthInfo,
}) {
  const handleNavClick = (view) => {
    onSelectView(view)
    if (window.innerWidth <= 860) {
      onClose()
    }
  }

  const handleNewChatClick = () => {
    onNewChat()
    onSelectView('chat')
    if (window.innerWidth <= 860) {
      onClose()
    }
  }

  const activeProvider = healthInfo?.provider || 'Groq'
  const modelName = healthInfo?.model || 'llama-3.3-70b-versatile'
  const toolCount = healthInfo?.mcp?.toolCount ?? 11

  return (
    <>
      {/* Mobile Drawer Backdrop */}
      {isOpen && (
        <div
          className="sidebar-backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}>
        {/* Brand Header */}
        <div className="sidebar-header">
          <a
            className="brand-logo"
            href="/"
            onClick={(e) => {
              e.preventDefault()
              handleNavClick('chat')
            }}
            aria-label="StudyPilot — Adaptive AI Learning Agent"
          >
            <div className="brand-mark">
              <span className="brand-pilot-symbol">✦</span>
            </div>
            <div className="brand-titles">
              <span className="brand-name">StudyPilot</span>
              <span className="brand-tagline">Adaptive AI Agent</span>
            </div>
          </a>

          <button
            type="button"
            className="sidebar-close-btn"
            onClick={onClose}
            aria-label="Close sidebar navigation"
          >
            ✕
          </button>
        </div>

        {/* Primary Action: New Conversation */}
        <button
          type="button"
          className="btn-new-conversation"
          onClick={handleNewChatClick}
          aria-label="Start new conversation"
          title="Start a new chat session"
        >
          <span className="plus-icon">＋</span>
          <span>New Chat</span>
        </button>

        {/* Main Navigation */}
        <nav className="sidebar-nav" aria-label="Main Navigation">
          <button
            type="button"
            className={`nav-item ${currentView === 'chat' ? 'active' : ''}`}
            onClick={() => handleNavClick('chat')}
            title="Chat with AI Tutor"
          >
            <span className="nav-icon" aria-hidden="true">💬</span>
            <span className="nav-label">AI Tutor</span>
          </button>

          <button
            type="button"
            className={`nav-item ${currentView === 'planner' ? 'active' : ''}`}
            onClick={() => handleNavClick('planner')}
            title="View and manage study schedules"
          >
            <span className="nav-icon" aria-hidden="true">📅</span>
            <span className="nav-label">Study Planner</span>
          </button>

          <button
            type="button"
            className={`nav-item ${currentView === 'progress' ? 'active' : ''}`}
            onClick={() => handleNavClick('progress')}
            title="Track study hours, progress and quiz performance"
          >
            <span className="nav-icon" aria-hidden="true">📊</span>
            <span className="nav-label">Progress</span>
          </button>

          <button
            type="button"
            className={`nav-item ${currentView === 'preferences' ? 'active' : ''}`}
            onClick={() => handleNavClick('preferences')}
            title="Configure learning preferences and difficulty"
          >
            <span className="nav-icon" aria-hidden="true">⚙</span>
            <span className="nav-label">Settings</span>
          </button>
        </nav>

        {/* Compact Footer Status */}
        <div className="sidebar-footer">
          <div
            className="sidebar-health-compact"
            title={`${activeProvider} (${modelName}) • ${toolCount} MCP tools registered`}
          >
            <span className={`status-dot ${apiStatus}`} aria-hidden="true" />
            <span className="health-compact-text">
              {apiStatus === 'online'
                ? `${activeProvider} • Ready`
                : apiStatus === 'offline'
                ? 'Backend Offline'
                : 'Connecting...'}
            </span>
          </div>
        </div>
      </aside>
    </>
  )
}
