import { useState } from 'react'

export function Sidebar({
  isOpen,
  onClose,
  currentView,
  onSelectView,
  onNewChat,
  conversations = [],
  activeConversationId,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onClearCurrentChat,
  theme,
  onToggleTheme,
  apiStatus,
}) {
  const [editingId, setEditingId] = useState(null)
  const [editTitle, setEditTitle] = useState('')
  const [convoToDelete, setConvoToDelete] = useState(null)

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

  const handleStartRename = (e, convo) => {
    e.stopPropagation()
    setEditingId(convo.id)
    setEditTitle(convo.title)
  }

  const handleSaveRename = (id) => {
    if (editTitle.trim()) {
      onRenameConversation(id, editTitle.trim())
    }
    setEditingId(null)
    setEditTitle('')
  }

  const handleRenameKeyDown = (e, id) => {
    if (e.key === 'Enter') {
      handleSaveRename(id)
    } else if (e.key === 'Escape') {
      setEditingId(null)
      setEditTitle('')
    }
  }

  const handlePromptDelete = (e, convo) => {
    e.stopPropagation()
    setConvoToDelete(convo)
  }

  const handleConfirmDelete = () => {
    if (convoToDelete) {
      onDeleteConversation(convoToDelete.id)
      setConvoToDelete(null)
    }
  }

  const themeIcons = {
    dark: '🌙',
    light: '☀️',
    system: '💻',
  }

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
        {/* Brand Header matching mockup */}
        <div className="sidebar-header">
          <a
            className="brand-logo"
            href="/"
            onClick={(e) => {
              e.preventDefault()
              handleNavClick('chat')
            }}
            aria-label="StudyPilot — Your AI Study Companion"
          >
            <div className="brand-mark-violet">
              <svg className="plane-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </div>
            <div className="brand-titles">
              <span className="brand-name">StudyPilot</span>
              <span className="brand-tagline">Your AI Study Companion</span>
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

        {/* Main Navigation matching mockup layout */}
        <nav className="sidebar-nav" aria-label="Main Navigation">
          <button
            type="button"
            className={`nav-item ${currentView === 'chat' ? 'active' : ''}`}
            onClick={() => handleNavClick('chat')}
            title="AI Chat Tutor"
          >
            <span className="nav-icon" aria-hidden="true">💬</span>
            <span className="nav-label">Chat</span>
          </button>

          <button
            type="button"
            className={`nav-item ${currentView === 'planner' ? 'active' : ''}`}
            onClick={() => handleNavClick('planner')}
            title="Study Plans & Schedules"
          >
            <span className="nav-icon" aria-hidden="true">📋</span>
            <span className="nav-label">Study Plans</span>
          </button>

          <button
            type="button"
            className={`nav-item ${currentView === 'progress' ? 'active' : ''}`}
            onClick={() => handleNavClick('progress')}
            title="Subject Progress & Analytics"
          >
            <span className="nav-icon" aria-hidden="true">📈</span>
            <span className="nav-label">Progress</span>
          </button>

          <button
            type="button"
            className={`nav-item ${currentView === 'history' ? 'active' : ''}`}
            onClick={() => handleNavClick('history')}
            title="Study History & Sessions"
          >
            <span className="nav-icon" aria-hidden="true">🕒</span>
            <span className="nav-label">History</span>
          </button>

          <button
            type="button"
            className={`nav-item ${currentView === 'preferences' ? 'active' : ''}`}
            onClick={() => handleNavClick('preferences')}
            title="Settings & Learning Preferences"
          >
            <span className="nav-icon" aria-hidden="true">⚙</span>
            <span className="nav-label">Settings</span>
          </button>
        </nav>

        {/* Conversations History List */}
        <div className="sidebar-section-container">
          <div className="sidebar-section-header">
            <span className="section-label">Recent Chats</span>
            {activeConversationId && currentView === 'chat' && (
              <button
                type="button"
                className="section-mini-action"
                onClick={onClearCurrentChat}
                title="Clear current conversation messages"
                aria-label="Clear current conversation"
              >
                Clear
              </button>
            )}
          </div>

          <div className="conversations-scroll-list" role="list" aria-label="Recent Conversations">
            {conversations.length === 0 ? (
              <div className="empty-conversations-hint">
                <span>No saved chats yet</span>
              </div>
            ) : (
              conversations.map((convo) => {
                const isActive = convo.id === activeConversationId && currentView === 'chat'
                const isEditing = editingId === convo.id

                return (
                  <div
                    key={convo.id}
                    className={`convo-item ${isActive ? 'active' : ''}`}
                    onClick={() => {
                      onSelectConversation(convo.id)
                      onSelectView('chat')
                      if (window.innerWidth <= 860) onClose()
                    }}
                    role="listitem"
                  >
                    <span className="convo-icon" aria-hidden="true">💬</span>

                    {isEditing ? (
                      <input
                        type="text"
                        className="convo-rename-input"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={() => handleSaveRename(convo.id)}
                        onKeyDown={(e) => handleRenameKeyDown(e, convo.id)}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Rename conversation"
                      />
                    ) : (
                      <span className="convo-title" title={convo.title}>
                        {convo.title}
                      </span>
                    )}

                    <div className="convo-actions">
                      <button
                        type="button"
                        className="convo-action-btn"
                        onClick={(e) => handleStartRename(e, convo)}
                        title="Rename conversation"
                        aria-label={`Rename ${convo.title}`}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="convo-action-btn convo-delete-btn"
                        onClick={(e) => handlePromptDelete(e, convo)}
                        title="Delete conversation"
                        aria-label={`Delete ${convo.title}`}
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Promo Card matching mockup bottom */}
        <div className="sidebar-promo-card">
          <div className="promo-robot-bubble" aria-hidden="true">
            🤖
          </div>
          <div className="promo-text-wrap">
            <strong className="promo-heading">Smarter Learning</strong>
            <span className="promo-subheading">Better Tomorrow</span>
            <p className="promo-desc">Personalized plans. Real progress. Powered by AI.</p>
          </div>
        </div>

        {/* Compact Footer Status & Theme Toggle */}
        <div className="sidebar-footer">
          <div className="sidebar-footer-controls">
            <button
              type="button"
              className="theme-quick-btn"
              onClick={onToggleTheme}
              title={`Current theme: ${theme}. Click to switch theme.`}
              aria-label={`Current theme: ${theme}. Click to cycle themes.`}
            >
              <span className="theme-icon" aria-hidden="true">{themeIcons[theme] || '🌙'}</span>
              <span className="theme-text">Theme: {theme}</span>
            </button>
          </div>

          <div
            className="sidebar-health-compact"
            title={apiStatus === 'online' ? 'StudyPilot Service Online' : 'Service Offline'}
          >
            <span className={`status-dot ${apiStatus}`} aria-hidden="true" />
            <span className="health-compact-text">
              {apiStatus === 'online'
                ? 'StudyPilot • Ready'
                : apiStatus === 'offline'
                ? 'Service Offline'
                : 'Connecting...'}
            </span>
          </div>
        </div>
      </aside>

      {/* Delete Conversation Confirmation Dialog */}
      {convoToDelete && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-convo-title">
          <div className="confirm-modal-card">
            <div className="modal-header-row">
              <span className="modal-danger-icon" aria-hidden="true">🗑</span>
              <h3 id="delete-convo-title">Delete Conversation</h3>
            </div>
            <p className="modal-confirm-text">
              Are you sure you want to delete <strong>"{convoToDelete.title}"</strong>?
            </p>
            <p className="modal-confirm-subtext">
              This will remove this conversation history from your browser storage. This action cannot be undone.
            </p>
            <div className="modal-actions-cluster">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConvoToDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger-confirm"
                onClick={handleConfirmDelete}
              >
                Delete Conversation
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
