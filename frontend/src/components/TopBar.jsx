import { useState } from 'react'

export function TopBar({
  onToggleSidebar,
  currentView,
  onSelectView,
  apiStatus,
  healthInfo,
}) {
  const [showStatusModal, setShowStatusModal] = useState(false)
  const [showGuideModal, setShowGuideModal] = useState(false)

  const viewTitles = {
    chat: { title: 'AI Tutor', tag: 'Chat' },
    planner: { title: 'Study Planner', tag: 'Schedules' },
    progress: { title: 'Progress', tag: 'Analytics' },
    preferences: { title: 'Settings', tag: 'Preferences' },
  }

  const currentMeta = viewTitles[currentView] || viewTitles.chat
  const modelName = healthInfo?.model || 'llama-3.3-70b-versatile'
  const provider = healthInfo?.provider || 'Groq'
  const tools = healthInfo?.mcp?.tools || []
  const toolCount = healthInfo?.mcp?.toolCount ?? tools.length

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

          <div className="topbar-titles">
            <h1 className="topbar-page-title">{currentMeta.title}</h1>
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
            <span>AI Tutor</span>
          </button>

          <button
            type="button"
            className={`topbar-tab-btn ${currentView === 'planner' ? 'active' : ''}`}
            onClick={() => onSelectView('planner')}
            aria-current={currentView === 'planner' ? 'page' : undefined}
            title="Study Planner & Schedule"
          >
            <span className="tab-icon" aria-hidden="true">📅</span>
            <span>Planner</span>
          </button>

          <button
            type="button"
            className={`topbar-tab-btn ${currentView === 'progress' ? 'active' : ''}`}
            onClick={() => onSelectView('progress')}
            aria-current={currentView === 'progress' ? 'page' : undefined}
            title="Progress & Mastery"
          >
            <span className="tab-icon" aria-hidden="true">📊</span>
            <span>Progress</span>
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
          <button
            type="button"
            className="how-it-works-btn"
            onClick={() => setShowGuideModal(true)}
            aria-label="Open Guide"
            title="Learn how StudyPilot works"
          >
            <span className="how-icon" aria-hidden="true">💡</span>
            <span>Guide</span>
          </button>

          {/* System status pill */}
          <button
            type="button"
            className="model-status-btn"
            onClick={() => setShowStatusModal(true)}
            title="Inspect Model & MCP Diagnostics"
            aria-label="Inspect active model and MCP tool status"
          >
            <span className={`status-indicator-dot ${apiStatus}`} aria-hidden="true" />
            <span className="model-name-text">
              {apiStatus === 'online'
                ? provider
                : apiStatus === 'checking'
                ? 'Connecting'
                : apiStatus === 'partial'
                ? 'Connecting Tools'
                : 'Offline'}
            </span>
            <span className="tool-count-badge">{toolCount} Tools</span>
          </button>
        </div>
      </header>

      {/* HOW IT WORKS / USER GUIDE MODAL */}
      {showGuideModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowGuideModal(false)}
          onKeyDown={(e) => e.key === 'Escape' && setShowGuideModal(false)}
        >
          <div className="modal-dialog modal-guide-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-wrap">
                <h3>How StudyPilot Works</h3>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowGuideModal(false)}
                aria-label="Close guide modal"
              >
                ✕
              </button>
            </div>

            <div className="guide-modal-body">
              <div className="guide-pillars-grid">
                <div className="guide-pillar-card">
                  <div className="pillar-badge">1</div>
                  <h4>AI Academic Tutor</h4>
                  <p>
                    Ask conceptual questions, get code walkthroughs, or take targeted practice quizzes.
                  </p>
                </div>

                <div className="guide-pillar-card">
                  <div className="pillar-badge">2</div>
                  <h4>Autonomous MCP Planner</h4>
                  <p>
                    Generates structured schedules and persists study plans with allocated daily hours.
                  </p>
                </div>

                <div className="guide-pillar-card">
                  <div className="pillar-badge">3</div>
                  <h4>Adaptive Re-balancing</h4>
                  <p>
                    Recalculates remaining workloads automatically when study sessions are missed.
                  </p>
                </div>
              </div>

              <div className="guide-try-section">
                <h4>QUICK ACTIONS:</h4>
                <div className="guide-actions-list">
                  <button
                    type="button"
                    className="guide-action-item"
                    onClick={() => {
                      setShowGuideModal(false)
                      onSelectView('chat')
                    }}
                  >
                    <span className="action-num">→</span>
                    <div>
                      <strong>Ask AI Tutor:</strong>
                      <span>"Create a 7-day DBMS study plan"</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    className="guide-action-item"
                    onClick={() => {
                      setShowGuideModal(false)
                      onSelectView('planner')
                    }}
                  >
                    <span className="action-num">→</span>
                    <div>
                      <strong>Open Planner:</strong>
                      <span>Inspect allocated hours and log sessions</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    className="guide-action-item"
                    onClick={() => {
                      setShowGuideModal(false)
                      onSelectView('progress')
                    }}
                  >
                    <span className="action-num">→</span>
                    <div>
                      <strong>View Progress:</strong>
                      <span>Review study metrics and weak topics</span>
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-actions">
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

      {/* System Status & MCP Inspector Modal */}
      {showStatusModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowStatusModal(false)}
          onKeyDown={(e) => e.key === 'Escape' && setShowStatusModal(false)}
        >
          <div className="modal-dialog modal-status-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title-wrap">
                <span className="modal-tag">SYSTEM ARCHITECTURE</span>
                <h3>Agent &amp; MCP Server Diagnostics</h3>
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowStatusModal(false)}
                aria-label="Close diagnostics modal"
              >
                ✕
              </button>
            </div>

            <div className="status-modal-body">
              <div className="status-grid">
                <div className="status-item">
                  <span className="status-label">AI PROVIDER</span>
                  <strong className="status-val">{provider.toUpperCase()}</strong>
                </div>
                <div className="status-item">
                  <span className="status-label">ACTIVE MODEL</span>
                  <strong className="status-val">{modelName}</strong>
                </div>
                <div className="status-item">
                  <span className="status-label">MCP TRANSPORT</span>
                  <strong className="status-val">
                    {healthInfo?.mcp?.connected ? 'Stdio / HTTP (Connected)' : 'Checking...'}
                  </strong>
                </div>
                <div className="status-item">
                  <span className="status-label">REGISTERED TOOLS</span>
                  <strong className="status-val text-success">{toolCount} Tools Active</strong>
                </div>
              </div>

              <div className="tools-inspection-section">
                <h4>DISCOVERED MCP TOOLS</h4>
                <p className="tools-explainer">
                  The adaptive agent dynamically discovers and executes these real tools over the Model Context Protocol:
                </p>
                <div className="tools-badges-list">
                  {[
                    'list_study_plans',
                    'create_study_plan',
                    'get_study_plan',
                    'record_study_session',
                    'adapt_study_plan',
                    'create_quiz',
                    'save_quiz_result',
                    'get_weak_topics',
                    'get_study_progress',
                    'get_user_preferences',
                    'update_user_preferences',
                  ].map((t) => (
                    <div key={t} className="tool-chip">
                      <span className="tool-dot" aria-hidden="true">⚡</span>
                      <code>{t}</code>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowStatusModal(false)}
              >
                Close Diagnostics
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
