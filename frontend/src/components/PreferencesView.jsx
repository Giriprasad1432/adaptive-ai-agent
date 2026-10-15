import { useEffect, useState } from 'react'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

export function PreferencesView() {
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

  const [showResetModal, setShowResetModal] = useState(false)
  const [resetting, setResetting] = useState(false)

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

  return (
    <div className="preferences-container">
      <div className="preferences-top-bar">
        <div>
          <h2>Settings &amp; Personalization</h2>
          <p className="preferences-subtitle">
            Configure your AI tutor persona, learning goals, daily study capacity, and schedule.
          </p>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          <span className="banner-icon">⚠</span>
          <span className="banner-text">{error}</span>
          <button type="button" className="banner-dismiss" onClick={() => setError('')}>✕</button>
        </div>
      )}

      {success && (
        <div className="banner banner-success" role="status">
          <span className="banner-icon">✓</span>
          <span className="banner-text">{success}</span>
          <button type="button" className="banner-dismiss" onClick={() => setSuccess('')}>✕</button>
        </div>
      )}

      <form onSubmit={handleSave} className="preferences-form-card">
        {/* Group 1: Onboarding Profile & Goals */}
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
              placeholder="e.g. Master Java backend development, Crack DBMS for technical interviews"
              disabled={loading || saving}
            />
          </div>

          <div className="form-row">
            <div className="form-group flex-1">
              <label htmlFor="pref-subjects">Focus Subjects / Topics</label>
              <input
                id="pref-subjects"
                type="text"
                className="form-input"
                value={Array.isArray(prefs.subjects) ? prefs.subjects.join(', ') : (prefs.subjects || '')}
                onChange={(e) =>
                  setPrefs({
                    ...prefs,
                    subjects: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  })
                }
                placeholder="e.g. Java, Spring Boot, SQL"
                disabled={loading || saving}
              />
            </div>

            <div className="form-group flex-1">
              <label>Current Experience Level</label>
              <div className="radio-pill-group">
                {['beginner', 'intermediate', 'advanced'].map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    className={`radio-pill ${(prefs.currentLevel || prefs.targetDifficulty) === lvl ? 'active' : ''}`}
                    onClick={() => setPrefs({ ...prefs, currentLevel: lvl, targetDifficulty: lvl })}
                    disabled={loading || saving}
                  >
                    {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="pref-starting">Starting Knowledge &amp; Difficult Topics</label>
            <textarea
              id="pref-starting"
              className="form-textarea"
              rows={2}
              value={prefs.startingPoint || ''}
              onChange={(e) => setPrefs({ ...prefs, startingPoint: e.target.value })}
              placeholder="e.g. Comfortable with variables and loops; struggle with OOP polymorphism and recursion."
              disabled={loading || saving}
            />
          </div>
        </div>

        {/* Group 2: Tutor & Explanation Style */}
        <div className="pref-group-section">
          <h3 className="pref-group-title">💡 Tutor &amp; Content Delivery</h3>

          <div className="form-group">
            <label htmlFor="pref-style">Preferred Explanation Style</label>
            <select
              id="pref-style"
              className="form-select"
              value={prefs.preferredExplanationStyle || 'detailed'}
              onChange={(e) => setPrefs({ ...prefs, preferredExplanationStyle: e.target.value, learningPreference: e.target.value })}
              disabled={loading || saving}
            >
              <option value="detailed">Detailed — Step-by-step conceptual walkthroughs</option>
              <option value="short">Short — Concise bullet points &amp; key rules</option>
              <option value="code_first">Code-First — Code implementations and syntax</option>
              <option value="intuitive">Intuitive — Everyday analogies and mental models</option>
            </select>
          </div>

          <div className="form-row">
            <div className="form-group flex-1">
              <label htmlFor="pref-lang">Primary Language</label>
              <input
                id="pref-lang"
                type="text"
                className="form-input"
                value={prefs.preferredLanguage || ''}
                onChange={(e) => setPrefs({ ...prefs, preferredLanguage: e.target.value })}
                placeholder="e.g. Java, Python, C++, JavaScript"
                disabled={loading || saving}
              />
            </div>

            <div className="form-group flex-1">
              <label htmlFor="pref-schedule">Study Schedule</label>
              <input
                id="pref-schedule"
                type="text"
                className="form-input"
                value={prefs.studySchedule || ''}
                onChange={(e) => setPrefs({ ...prefs, studySchedule: e.target.value })}
                placeholder="e.g. Weekdays in evening, Daily, Weekends only"
                disabled={loading || saving}
              />
            </div>
          </div>
        </div>

        {/* Group 3: Study Capacity & Deadlines */}
        <div className="pref-group-section">
          <h3 className="pref-group-title">⏱ Study Capacity &amp; Timeline</h3>

          <div className="form-row">
            <div className="form-group flex-1">
              <label htmlFor="pref-hours">Daily Available Hours</label>
              <input
                id="pref-hours"
                type="number"
                step="0.5"
                min="0.5"
                max="12"
                className="form-input"
                value={prefs.defaultDailyAvailableHours || 2}
                onChange={(e) => setPrefs({ ...prefs, defaultDailyAvailableHours: Number(e.target.value) })}
                disabled={loading || saving}
              />
            </div>

            <div className="form-group flex-1">
              <label htmlFor="pref-deadline">Target Deadline / Exam Date</label>
              <input
                id="pref-deadline"
                type="text"
                className="form-input"
                value={prefs.targetDeadline || ''}
                onChange={(e) => setPrefs({ ...prefs, targetDeadline: e.target.value })}
                placeholder="e.g. 2026-12-15 or 30 days"
                disabled={loading || saving}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="pref-notes">Custom Notes for Tutor</label>
            <textarea
              id="pref-notes"
              className="form-textarea"
              rows={2}
              value={prefs.customNotes || ''}
              onChange={(e) => setPrefs({ ...prefs, customNotes: e.target.value })}
              placeholder="e.g. Prioritize practical examples; remind me to review weak topics periodically."
              disabled={loading || saving}
            />
          </div>
        </div>

        <div className="form-footer-actions">
          <button
            type="submit"
            className="btn-primary"
            disabled={loading || saving}
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </form>

      {/* Danger Zone: Explicit Data Reset */}
      <div className="danger-zone-card">
        <div className="danger-zone-header">
          <div>
            <h4 className="danger-zone-title">Reset Learning Data</h4>
            <p className="danger-zone-sub">
              Permanently clear saved study plans, session logs, and personalized preferences to start completely fresh.
            </p>
          </div>
          <button
            type="button"
            className="btn-danger"
            onClick={() => setShowResetModal(true)}
            disabled={loading || resetting}
          >
            Reset All Data
          </button>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showResetModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reset-modal-title">
          <div className="modal-card">
            <div className="modal-header">
              <h3 id="reset-modal-title" className="text-error">⚠ Reset All Learning Data?</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowResetModal(false)}
                disabled={resetting}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p>
                Are you sure you want to reset your StudyPilot experience? This will cleanly delete:
              </p>
              <ul className="reset-warning-list">
                <li>All active and past study plans</li>
                <li>All recorded study sessions and progress statistics</li>
                <li>Quiz scores and weak topic history</li>
                <li>Your customized profile preferences</li>
              </ul>
              <p className="text-muted">
                Your AI tutor will welcome you as a new user so you can start an onboarding conversation from scratch.
              </p>
            </div>
            <div className="modal-footer">
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
                className="btn-danger"
                onClick={handleResetData}
                disabled={resetting}
              >
                {resetting ? 'Resetting...' : 'Yes, Reset All Data'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
