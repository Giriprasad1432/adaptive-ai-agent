import { useCallback, useEffect, useState, useMemo } from 'react'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

function isTestPlanId(id) {
  if (!id) return true
  return /^(?:test[_-]|repro[_-]|agent_e2e|adaptive_regress|adapt_preserve|eval[_-]|date-e2e-|success_|mock[_-])/i.test(id)
}

export function HistoryView({ onStartLearning, onNavigateToPlanner }) {
  const [plans, setPlans] = useState([])
  const [detailedPlans, setDetailedPlans] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterSubject, setFilterSubject] = useState('all')

  const fetchHistory = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE_URL}/api/plans`)
      if (!res.ok) throw new Error(`Failed to load plans (${res.status})`)

      const data = await res.json()
      const rawPlans = data.plans || []
      const cleanPlans = rawPlans.filter((p) => !isTestPlanId(p.planId))
      setPlans(cleanPlans)

      if (cleanPlans.length > 0) {
        const detailPromises = cleanPlans.slice(0, 10).map((p) =>
          fetch(`${API_BASE_URL}/api/plans/${encodeURIComponent(p.planId)}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        )
        const details = await Promise.all(detailPromises)
        const map = {}
        details.forEach((d) => {
          if (d && d.planId) map[d.planId] = d
        })
        setDetailedPlans(map)
      }
    } catch (err) {
      setError(err.message || 'Unable to load study history.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchHistory()
  }, [fetchHistory])

  // Aggregate all recorded sessions
  const allSessions = useMemo(() => {
    const list = []
    Object.values(detailedPlans).forEach((plan) => {
      if (Array.isArray(plan.sessions)) {
        plan.sessions.forEach((s) => {
          list.push({
            ...s,
            planId: plan.planId,
            planTitle: Object.keys(plan.subjects || {}).join(' & ') || plan.planId,
          })
        })
      }
    })

    // Sort newest first
    return list.sort((a, b) => {
      const dateA = new Date(a.date || a.timestamp || 0)
      const dateB = new Date(b.date || b.timestamp || 0)
      return dateB - dateA
    })
  }, [detailedPlans])

  const subjects = useMemo(() => {
    const set = new Set()
    allSessions.forEach((s) => {
      if (s.subject) set.add(s.subject)
    })
    return Array.from(set)
  }, [allSessions])

  const filteredSessions = useMemo(() => {
    if (filterSubject === 'all') return allSessions
    return allSessions.filter((s) => s.subject === filterSubject)
  }, [allSessions, filterSubject])

  const totalHours = useMemo(() => {
    return allSessions
      .filter((s) => s.status === 'completed')
      .reduce((sum, s) => sum + (Number(s.hoursSpent) || 0), 0)
  }, [allSessions])

  const completedCount = useMemo(() => {
    return allSessions.filter((s) => s.status === 'completed').length
  }, [allSessions])

  return (
    <div className="history-view-container">
      {/* Header */}
      <div className="history-top-bar">
        <div className="history-heading-group">
          <h2>Study History &amp; Session Logs</h2>
          <p className="history-subtitle">
            Chronological record of completed study sessions, topics covered, and hours logged.
          </p>
        </div>

        <button
          type="button"
          className="btn-secondary"
          onClick={fetchHistory}
          disabled={loading}
          title="Refresh history"
        >
          <span>↻ Refresh</span>
        </button>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          <span className="banner-icon">⚠</span>
          <span className="banner-text">{error}</span>
          <button type="button" className="banner-dismiss" onClick={() => setError('')}>✕</button>
        </div>
      )}

      {/* Summary KPI Cards if data exists */}
      {allSessions.length > 0 && (
        <div className="history-kpis-grid">
          <div className="history-kpi-card">
            <span className="kpi-icon icon-purple">🎯</span>
            <div className="kpi-info">
              <strong className="kpi-value">{completedCount}</strong>
              <span className="kpi-label">Completed Sessions</span>
            </div>
          </div>

          <div className="history-kpi-card">
            <span className="kpi-icon icon-blue">⏱</span>
            <div className="kpi-info">
              <strong className="kpi-value">{totalHours} hrs</strong>
              <span className="kpi-label">Total Time Studied</span>
            </div>
          </div>

          <div className="history-kpi-card">
            <span className="kpi-icon icon-cyan">📚</span>
            <div className="kpi-info">
              <strong className="kpi-value">{subjects.length}</strong>
              <span className="kpi-label">Active Subjects</span>
            </div>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      {subjects.length > 1 && (
        <div className="history-filter-strip">
          <span className="filter-label">Filter Subject:</span>
          <div className="filter-chips">
            <button
              type="button"
              className={`filter-chip ${filterSubject === 'all' ? 'active' : ''}`}
              onClick={() => setFilterSubject('all')}
            >
              All Subjects ({allSessions.length})
            </button>
            {subjects.map((sub) => (
              <button
                key={sub}
                type="button"
                className={`filter-chip ${filterSubject === sub ? 'active' : ''}`}
                onClick={() => setFilterSubject(sub)}
              >
                {sub}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && allSessions.length === 0 && (
        <div className="progress-loading-state">
          <div className="spinner" />
          <p>Retrieving session logs...</p>
        </div>
      )}

      {/* Clean Empty State (Requirement 1) */}
      {!loading && allSessions.length === 0 && (
        <div className="empty-planner-state">
          <div className="empty-state-badge">🕒</div>
          <h3>“Your completed study sessions will appear here.”</h3>
          <p>
            No sessions recorded yet. Log your study hours through your AI tutor or the study planner to start building your study history.
          </p>
          <div className="empty-cta-group">
            <button
              type="button"
              className="btn-primary"
              onClick={onStartLearning}
            >
              <span>✦ Start Learning</span>
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={onNavigateToPlanner}
            >
              <span>📋 View Study Planner</span>
            </button>
          </div>
        </div>
      )}

      {/* Sessions Table / Stream */}
      {filteredSessions.length > 0 && (
        <div className="history-table-card">
          <table className="history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Subject</th>
                <th>Duration</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {filteredSessions.map((session, idx) => {
                const dateStr = session.date || (session.timestamp ? new Date(session.timestamp).toLocaleDateString() : 'Recent')
                const isDone = session.status === 'completed'
                return (
                  <tr key={session.id || idx}>
                    <td className="cell-date">
                      <span className="date-badge">{dateStr}</span>
                    </td>
                    <td className="cell-subject">
                      <strong>{session.subject}</strong>
                      <span className="cell-plan-sub">{session.planTitle}</span>
                    </td>
                    <td className="cell-hours">
                      <span className="hours-pill">{session.hoursSpent ?? session.missedHours ?? 0} hrs</span>
                    </td>
                    <td className="cell-status">
                      <span className={`status-pill ${isDone ? 'status-done' : 'status-missed'}`}>
                        {isDone ? '✓ Completed' : '⚠ Missed'}
                      </span>
                    </td>
                    <td className="cell-notes">
                      <span className="notes-text">{session.notes || 'Routine study session'}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
