import { useEffect, useState } from 'react'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

export function PreferencesView({
  theme = 'dark',
  onSelectTheme,
  onClearAllHistory,
}) {
  const [prefs, setPrefs] = useState({
    preferredExplanationStyle: 'detailed',
    preferredLanguage: 'JavaScript',
    defaultDailyAvailableHours: 2,
    targetDifficulty: 'intermediate',
    customNotes: '',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [showResetModal, setShowResetModal] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [showClearHistoryModal, setShowClearHistoryModal] = useState(false)

  useEffect(() => {
    let ignore = false
    const loadPreferences = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/preferences`)
        if (!res.ok) throw new Error(`Failed to load preferences (${res.status})`)
        const data = await res.json()
        if (!ignore && data) {
          setPrefs((prev) => ({
            ...prev,
            ...data,
          }))
        }
      } catch (err) {
        if (!ignore) setError(err.message || 'Unable to load user preferences.')
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    loadPreferences()
    return () => {
      ignore = true
    }
  }, [])

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    setSuccess('')

    try {
      const res = await fetch(`${API_BASE_URL}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        throw new Error(result.error || 'Failed to update preferences.')
      }

      setSuccess('Preferences updated successfully! StudyPilot agent will ground responses to these settings.')
    } catch (err) {
      setError(err.message || 'Could not save preferences.')
    } finally {
      setSaving(false)
    }
  }

  const handleResetData = async () => {
    setResetting(true)
    setError('')
    setSuccess('')
    try {
      const res = await fetch(`${API_BASE_URL}/api/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'default' }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        throw new Error(result.error || 'Failed to reset learning data.')
      }

      setPrefs({
        goal: '',
        subjects: [],
        currentLevel: 'intermediate',
        startingPoint: '',
        difficultTopics: [],
        targetDeadline: '',
        learningPreference: 'detailed',
        studySchedule: '',
        preferredExplanationStyle: 'detailed',
        preferredLanguage: 'JavaScript',
        defaultDailyAvailableHours: 2,
        targetDifficulty: 'intermediate',
        customNotes: '',
      })
      setShowResetModal(false)
      setSuccess('All study plans, sessions, and learning preferences have been cleanly reset to default!')
    } catch (err) {
      setError(err.message || 'Could not reset learning data.')
    } finally {
      setResetting(false)
    }
  }

  const handleConfirmClearHistory = () => {
    onClearAllHistory?.()
    setShowClearHistoryModal(false)
    setSuccess('All local chat conversations have been permanently cleared from your browser.')
  }

  return (
    <div className="preferences-container">
      <div className="preferences-top-bar">
        <div>
          <h2>Settings &amp; Preferences</h2>
          <p className="preferences-subtitle">
            Configure appearance theme, chat history, AI tutor persona, and learning goals.
          </p>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          <span className="banner-icon" aria-hidden="true">⚠</span>
          <span className="banner-text">{error}</span>
          <button type="button" className="banner-dismiss" onClick={() => setError('')}>✕</button>
        </div>
      )}

      {success && (
        <div className="banner banner-success" role="status">
          <span className="banner-icon" aria-hidden="true">✓</span>
          <span className="banner-text">{success}</span>
          <button type="button" className="banner-dismiss" onClick={() => setSuccess('')}>✕</button>
        </div>
      )}

      {/* SECTION 1: APPEARANCE & THEME SELECTOR */}
      <div className="settings-card">
        <div className="settings-card-header">
          <span className="settings-card-icon" aria-hidden="true">🎨</span>
          <div>
            <h3>Appearance &amp; Color Theme</h3>
            <p className="settings-card-sub">
              Select your interface color scheme. StudyPilot will adapt all panels, graphs, and inputs.
            </p>
          </div>
        </div>

        <div className="theme-options-grid" role="radiogroup" aria-label="Appearance Theme">
          <button
            type="button"
            role="radio"
            aria-checked={theme === 'dark'}
            className={`theme-option-card ${theme === 'dark' ? 'active' : ''}`}
            onClick={() => onSelectTheme?.('dark')}
          >
            <div className="theme-preview dark-preview">
              <div className="preview-nav" />
              <div className="preview-content">
                <div className="preview-line line-1" />
                <div className="preview-line line-2" />
              </div>
            </div>
            <div className="theme-option-info">
              <div className="theme-title-row">
                <span className="theme-name">Dark</span>
                {theme === 'dark' && <span className="theme-active-dot">✓</span>}
              </div>
              <p className="theme-desc">Deep charcoal palette with violet accent. Ideal for low-light focus.</p>
            </div>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={theme === 'light'}
            className={`theme-option-card ${theme === 'light' ? 'active' : ''}`}
            onClick={() => onSelectTheme?.('light')}
          >
            <div className="theme-preview light-preview">
              <div className="preview-nav" />
              <div className="preview-content">
                <div className="preview-line line-1" />
                <div className="preview-line line-2" />
              </div>
            </div>
            <div className="theme-option-info">
              <div className="theme-title-row">
                <span className="theme-name">Light</span>
                {theme === 'light' && <span className="theme-active-dot">✓</span>}
              </div>
              <p className="theme-desc">Soft neutral background with crisp white surfaces and restrained accent.</p>
            </div>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={theme === 'system'}
            className={`theme-option-card ${theme === 'system' ? 'active' : ''}`}
            onClick={() => onSelectTheme?.('system')}
          >
            <div className="theme-preview system-preview">
              <div className="preview-split-dark" />
              <div className="preview-split-light" />
            </div>
            <div className="theme-option-info">
              <div className="theme-title-row">
                <span className="theme-name">System</span>
                {theme === 'system' && <span className="theme-active-dot">✓</span>}
              </div>
              <p className="theme-desc">Automatically match your operating system appearance preference.</p>
            </div>
          </button>
        </div>
      </div>

      {/* SECTION 2: CHAT HISTORY MANAGEMENT */}
      <div className="settings-card">
        <div className="settings-card-header">
          <span className="settings-card-icon" aria-hidden="true">💬</span>
          <div>
            <h3>Chat History Management</h3>
            <p className="settings-card-sub">
              Chat transcripts are stored locally in your browser storage. You can delete individual chats from the sidebar or clear all history below.
            </p>
          </div>
        </div>

        <div className="history-management-row">
          <div>
            <strong>Clear All Chat History</strong>
            <p className="text-muted">
              Permanently deletes all saved chat conversations from this device without affecting your study plans.
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setShowClearHistoryModal(true)}
          >
            Clear All Chats
          </button>
        </div>
      </div>

      {/* SECTION 3: LEARNING GOALS & TUTOR PREFERENCES */}
      <form onSubmit={handleSave} className="preferences-form-card">
        <div className="pref-group-section">
          <h3 className="pref-group-title">🎯 Learning Goals &amp; Background</h3>

          <div className="form-group">
            <label htmlFor="pref-goal">Primary Learning Goal</label>
            <input
              id="pref-goal"
              type="text"
              className="form-input"
              value={prefs.goal || ''}
              onChange={(e) => setPrefs({ ...prefs, goal: e.target.value })}
              placeholder="e.g. Master Full-Stack Web Development, Pass CS301 Exam"
            />
          </div>

          <div className="form-group">
            <label htmlFor="pref-starting-point">Current Knowledge / What You Already Know</label>
            <input
              id="pref-starting-point"
              type="text"
              className="form-input"
              value={prefs.startingPoint || ''}
              onChange={(e) => setPrefs({ ...prefs, startingPoint: e.target.value })}
              placeholder="e.g. Basic variables and loops; struggled with pointers and recursion"
            />
          </div>

          <div className="form-group">
            <label htmlFor="pref-target-deadline">Target Deadline or Exam Date</label>
            <input
              id="pref-target-deadline"
              type="text"
              className="form-input"
              value={prefs.targetDeadline || ''}
              onChange={(e) => setPrefs({ ...prefs, targetDeadline: e.target.value })}
              placeholder="e.g. In 4 weeks, or 2026-12-15"
            />
          </div>
        </div>

        <div className="pref-group-section">
          <h3 className="pref-group-title">⏱ Study Pace &amp; Schedule</h3>

          <div className="form-row">
            <div className="form-group flex-1">
              <label htmlFor="pref-hours">Default Daily Study Capacity</label>
              <input
                id="pref-hours"
                type="number"
                step="0.5"
                min="0.5"
                max="12"
                className="form-input"
                value={prefs.defaultDailyAvailableHours ?? 2}
                onChange={(e) =>
                  setPrefs({ ...prefs, defaultDailyAvailableHours: parseFloat(e.target.value) || 2 })
                }
              />
              <span className="input-hint">Used as default baseline for new study schedules.</span>
            </div>

            <div className="form-group flex-1">
              <label htmlFor="pref-schedule">Preferred Study Days or Hours</label>
              <input
                id="pref-schedule"
                type="text"
                className="form-input"
                value={prefs.studySchedule || ''}
                onChange={(e) => setPrefs({ ...prefs, studySchedule: e.target.value })}
                placeholder="e.g. Weekday evenings from 7-9 PM"
              />
            </div>
          </div>
        </div>

        <div className="pref-group-section">
          <h3 className="pref-group-title">🧠 AI Tutor Pedagogy &amp; Explanations</h3>

          <div className="form-row">
            <div className="form-group flex-1">
              <label htmlFor="pref-level">Target Difficulty Level</label>
              <select
                id="pref-level"
                className="form-select"
                value={prefs.targetDifficulty || 'intermediate'}
                onChange={(e) => setPrefs({ ...prefs, targetDifficulty: e.target.value })}
              >
                <option value="beginner">Beginner (Foundations &amp; Syntax)</option>
                <option value="intermediate">Intermediate (Standard Curriculum)</option>
                <option value="advanced">Advanced (Deep Dive &amp; Optimizations)</option>
              </select>
            </div>

            <div className="form-group flex-1">
              <label htmlFor="pref-style">Explanation Style</label>
              <select
                id="pref-style"
                className="form-select"
                value={prefs.preferredExplanationStyle || 'detailed'}
                onChange={(e) => setPrefs({ ...prefs, preferredExplanationStyle: e.target.value })}
              >
                <option value="concise">Concise &amp; Direct</option>
                <option value="detailed">Detailed with Analogies</option>
                <option value="socratic">Socratic (Guided Questions)</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="pref-notes">Custom Learning Instructions for Tutor</label>
            <textarea
              id="pref-notes"
              className="form-textarea"
              rows={3}
              value={prefs.customNotes || ''}
              onChange={(e) => setPrefs({ ...prefs, customNotes: e.target.value })}
              placeholder="e.g. Always provide short runnable code snippets; quiz me after every topic."
            />
          </div>
        </div>

        <div className="pref-actions-bar">
          <button
            type="submit"
            className="btn-primary"
            disabled={saving || loading}
          >
            {saving ? 'Saving...' : 'Save Preferences'}
          </button>
        </div>
      </form>

      {/* SECTION 4: DANGER ZONE (LEARNING DATA RESET) */}
      <div className="danger-zone-card">
        <div className="danger-zone-header">
          <span className="danger-icon" aria-hidden="true">⚠</span>
          <div className="danger-zone-text">
            <h4>Danger Zone: Reset All Learning Records</h4>
            <p className="danger-zone-sub">
              Cleanly resets all saved study plans, session history, quiz scores, and personalized preferences to start fresh.
            </p>
          </div>
          <button
            type="button"
            className="btn-danger"
            onClick={() => setShowResetModal(true)}
            disabled={loading || resetting}
          >
            Reset All Records
          </button>
        </div>
      </div>

      {/* Clear Chat History Confirmation Modal */}
      {showClearHistoryModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="clear-history-title">
          <div className="confirm-modal-card">
            <div className="modal-header-row">
              <span className="modal-danger-icon" aria-hidden="true">🗑</span>
              <h3 id="clear-history-title">Clear All Chat History?</h3>
            </div>
            <p className="modal-confirm-text">
              Are you sure you want to permanently delete all saved chat conversations from your browser?
            </p>
            <p className="modal-confirm-subtext">
              This only removes conversation history stored on this device. Your study plans and progress records will remain intact.
            </p>
            <div className="modal-actions-cluster">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowClearHistoryModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger-confirm"
                onClick={handleConfirmClearHistory}
              >
                Delete All History
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Learning Data Reset Confirmation Modal */}
      {showResetModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reset-modal-title">
          <div className="confirm-modal-card">
            <div className="modal-header-row">
              <span className="modal-danger-icon" aria-hidden="true">⚠</span>
              <h3 id="reset-modal-title">Reset All Learning Records?</h3>
            </div>
            <p className="modal-confirm-text">
              Are you sure you want to reset your StudyPilot learning records? This will cleanly remove:
            </p>
            <ul className="reset-warning-list">
              <li>All active and past study plans</li>
              <li>All recorded study sessions and progress statistics</li>
              <li>Quiz scores and weak topic history</li>
              <li>Your customized learning profile preferences</li>
            </ul>
            <div className="modal-actions-cluster">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowResetModal(false)}
                disabled={resetting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger-confirm"
                onClick={handleResetData}
                disabled={resetting}
              >
                {resetting ? 'Resetting...' : 'Yes, Reset All Records'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
