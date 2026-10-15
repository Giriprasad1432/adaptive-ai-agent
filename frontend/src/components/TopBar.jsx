import { useState } from 'react'

export function TopBar({
  onToggleSidebar,
  currentView,
  onSelectView,
  activeConversationTitle,
  onClearCurrentChat,
  onRenameCurrentChat,
  theme,
  onToggleTheme,
  apiStatus,
  showRightPanel,
  onToggleRightPanel,
  userName = 'Alex',
}) {
  const [showGuideModal, setShowGuideModal] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)

  const viewTitles = {
    chat: { title: activeConversationTitle || 'New Chat', tag: 'Chat' },
    planner: { title: 'Study Plans', tag: 'Schedules' },
    progress: { title: 'Learning Progress', tag: 'Metrics' },
    history: { title: 'Study History', tag: 'Sessions' },
    preferences: { title: 'Settings', tag: 'Preferences' },
  }

  const currentMeta = viewTitles[currentView] || viewTitles.chat

  const themeIcons = {
    dark: '🌙',
    light: '☀️',
    system: '💻',
  }

  return (
    <>
      <header className="topbar" role="banner">
        <div className="topbar-left">
          <button
            type="button"
            className="mobile-menu-btn"
            onClick={onToggleSidebar}
            aria-label="Toggle navigation drawer"
            title="Toggle Menu"
          >
            <span className="hamburger-icon" aria-hidden="true">☰</span>
          </button>

          <div className="topbar-title-box">
            <h1 className="topbar-page-title">
              {currentView === 'chat' ? (activeConversationTitle || 'New Chat') : currentMeta.title}
            </h1>
            {currentView === 'chat' && onRenameCurrentChat && (
              <button
                type="button"
                className="edit-title-inline-btn"
                onClick={onRenameCurrentChat}
                title="Rename conversation"
                aria-label="Rename conversation"
              >
                ✎
              </button>
            )}
          </div>
        </div>

        {/* Center Quick Navigation Tabs */}
        <nav className="topbar-center-nav" aria-label="Section Tabs">
          <button
            type="button"
            className={`topbar-tab-btn ${currentView === 'chat' ? 'active' : ''}`}
            onClick={() => onSelectView('chat')}
            aria-current={currentView === 'chat' ? 'page' : undefined}
            title="AI Tutor & Chat"
          >
            <span className="tab-icon" aria-hidden="true">💬</span>
            <span>Chat</span>
          </button>

          <button
            type="button"
            className={`topbar-tab-btn ${currentView === 'planner' ? 'active' : ''}`}
            onClick={() => onSelectView('planner')}
            aria-current={currentView === 'planner' ? 'page' : undefined}
            title="Study Plans & Schedules"
          >
            <span className="tab-icon" aria-hidden="true">📋</span>
            <span>Study Plans</span>
          </button>

          <button
            type="button"
            className={`topbar-tab-btn ${currentView === 'progress' ? 'active' : ''}`}
            onClick={() => onSelectView('progress')}
            aria-current={currentView === 'progress' ? 'page' : undefined}
            title="Progress & Analytics"
          >
            <span className="tab-icon" aria-hidden="true">📈</span>
            <span>Progress</span>
          </button>

          <button
            type="button"
            className={`topbar-tab-btn ${currentView === 'history' ? 'active' : ''}`}
            onClick={() => onSelectView('history')}
            aria-current={currentView === 'history' ? 'page' : undefined}
            title="Study History & Session Logs"
          >
            <span className="tab-icon" aria-hidden="true">🕒</span>
            <span>History</span>
          </button>

          <button
            type="button"
            className={`topbar-tab-btn ${currentView === 'preferences' ? 'active' : ''}`}
            onClick={() => onSelectView('preferences')}
            aria-current={currentView === 'preferences' ? 'page' : undefined}
            title="Settings & Preferences"
          >
            <span className="tab-icon" aria-hidden="true">⚙</span>
            <span>Settings</span>
          </button>
        </nav>

        <div className="topbar-right">
          {currentView === 'chat' && (
            <button
              type="button"
              className="topbar-action-btn"
              onClick={onClearCurrentChat}
              title="Clear messages in current chat"
              aria-label="Clear current conversation"
            >
              <span className="action-icon" aria-hidden="true">↺</span>
              <span className="action-text">Clear</span>
            </button>
          )}

          {/* Theme Dropdown / Button matching mockup */}
          <button
            type="button"
            className="theme-selector-chip"
            onClick={onToggleTheme}
            title={`Switch Theme (Current: ${theme})`}
            aria-label={`Switch Theme (Current: ${theme})`}
          >
            <span className="theme-chip-icon" aria-hidden="true">{themeIcons[theme] || '🌙'}</span>
            <span className="theme-chip-label">{theme.charAt(0).toUpperCase() + theme.slice(1)}</span>
            <span className="theme-chip-arrow" aria-hidden="true">⌵</span>
          </button>

          {/* Notification Bell */}
          <button
            type="button"
            className="topbar-icon-btn"
            title="Notifications"
            aria-label="Notifications"
            onClick={() => setShowGuideModal(true)}
          >
            <span className="bell-icon" aria-hidden="true">🔔</span>
          </button>

          {/* Toggle Learning Progress Panel on Chat view */}
          {currentView === 'chat' && onToggleRightPanel && (
            <button
              type="button"
              className={`topbar-panel-toggle-btn ${showRightPanel ? 'active' : ''}`}
              onClick={onToggleRightPanel}
              title={showRightPanel ? 'Hide Learning Dashboard Panel' : 'Show Learning Dashboard Panel'}
              aria-label="Toggle Learning Dashboard Panel"
              aria-pressed={showRightPanel}
            >
              <span className="panel-btn-icon" aria-hidden="true">📊</span>
              <span className="panel-btn-text">Dashboard</span>
            </button>
          )}

          {/* User Profile matching mockup */}
          <div className="user-profile-menu-wrap">
            <button
              type="button"
              className="user-profile-btn"
              onClick={() => setShowUserMenu((p) => !p)}
              aria-label="User Account Menu"
              aria-expanded={showUserMenu}
            >
              <div className="user-avatar-circle">
                <span>{userName.charAt(0).toUpperCase()}</span>
              </div>
              <span className="user-name-text">{userName}</span>
              <span className="user-arrow-down" aria-hidden="true">⌵</span>
            </button>

            {showUserMenu && (
              <div className="user-dropdown-popover" role="menu">
                <div className="popover-user-info">
                  <strong>{userName}</strong>
                  <span className="popover-email">Active Learner</span>
                </div>
                <hr className="popover-divider" />
                <button
                  type="button"
                  className="popover-item"
                  onClick={() => {
                    setShowUserMenu(false)
                    onSelectView('preferences')
                  }}
                >
                  ⚙ Preferences &amp; Goals
                </button>
                <button
                  type="button"
                  className="popover-item"
                  onClick={() => {
                    setShowUserMenu(false)
                    setShowGuideModal(true)
                  }}
                >
                  💡 How StudyPilot Works
                </button>
              </div>
            )}
          </div>

          {/* Clean status badge */}
          <div
            className="status-badge-clean"
            title={apiStatus === 'online' ? 'StudyPilot Service Active' : 'Service Offline'}
            aria-label={`Service status: ${apiStatus}`}
          >
            <span className={`status-indicator-dot ${apiStatus}`} aria-hidden="true" />
          </div>
        </div>
      </header>

      {/* Guide Modal */}
      {showGuideModal && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="guide-modal-title"
          onClick={() => setShowGuideModal(false)}
        >
          <div
            className="guide-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="guide-modal-header">
              <div className="guide-title-row">
                <span className="guide-pilot-badge">✦</span>
                <h3 id="guide-modal-title">How StudyPilot Works</h3>
              </div>
              <button
                type="button"
                className="guide-modal-close"
                onClick={() => setShowGuideModal(false)}
                aria-label="Close guide modal"
              >
                ✕
              </button>
            </div>

            <div className="guide-modal-content">
              <div className="guide-step-card">
                <span className="step-num">1</span>
                <div>
                  <strong>Conversational AI Onboarding</strong>
                  <p>StudyPilot asks what you want to learn, your starting level, and your available study time before proposing a plan.</p>
                </div>
              </div>

              <div className="guide-step-card">
                <span className="step-num">2</span>
                <div>
                  <strong>Prerequisite Topic Progression</strong>
                  <p>Curriculums are sequenced logically. You get an interactive plan preview to confirm or tweak before it is saved.</p>
                </div>
              </div>

              <div className="guide-step-card">
                <span className="step-num">3</span>
                <div>
                  <strong>Adaptive AI Tutoring</strong>
                  <p>Ask conceptual questions directly without forcing a study plan. When you log study sessions or quizzes, your schedule adapts automatically.</p>
                </div>
              </div>
            </div>

            <div className="guide-modal-footer">
              <button
                type="button"
                className="btn-primary"
                onClick={() => setShowGuideModal(false)}
              >
                Got It
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
