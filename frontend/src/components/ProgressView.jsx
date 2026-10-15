import { useCallback, useEffect, useState } from 'react'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

export function ProgressView({ onNavigateToPlanner, onAskInChat }) {
  const [progressData, setProgressData] = useState(null)
  const [weakTopicsReport, setWeakTopicsReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetchInsights = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [progRes, weakRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/progress`),
        fetch(`${API_BASE_URL}/api/weak-topics`),
      ])

      if (!progRes.ok) throw new Error(`Progress request failed (${progRes.status})`)
      const prog = await progRes.json()
      setProgressData(prog)

      if (weakRes.ok) {
        const weak = await weakRes.json()
        setWeakTopicsReport(weak)
      }
    } catch (err) {
      setError(err.message || 'Unable to retrieve progress insights.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false
    const loadInitial = async () => {
      try {
        const [progRes, weakRes] = await Promise.all([
          fetch(`${API_BASE_URL}/api/progress`),
          fetch(`${API_BASE_URL}/api/weak-topics`),
        ])

        if (!progRes.ok) throw new Error(`Progress request failed (${progRes.status})`)
        const prog = await progRes.json()
        if (!ignore) setProgressData(prog)

        if (weakRes.ok) {
          const weak = await weakRes.json()
          if (!ignore) setWeakTopicsReport(weak)
        }
      } catch (err) {
        if (!ignore) setError(err.message || 'Unable to retrieve progress insights.')
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    loadInitial()
    return () => {
      ignore = true
    }
  }, [])

  const weakTopics = weakTopicsReport?.weakTopics || []
  const completedHrs = progressData?.totalCompletedHours || 0
  const remainingHrs = progressData?.totalRemainingHours || 0
  const missedHrs = progressData?.totalMissedHours || 0
  const totalAllocated = progressData?.totalAllocatedHours || (completedHrs + remainingHrs) || 0
  const sumHrs = completedHrs + remainingHrs + missedHrs || 1
  const completedPct = Math.round((completedHrs / sumHrs) * 100)
  const remainingPct = Math.round((remainingHrs / sumHrs) * 100)
  const missedPct = Math.max(0, 100 - completedPct - remainingPct)

  return (
    <div className="progress-container">
      {/* Header */}
      <div className="progress-top-bar">
        <div className="progress-heading-group">
          <h2>Progress &amp; Analytics</h2>
          <p className="progress-subtitle">
            Overview of study hours, quiz accuracy, and areas for review.
          </p>
        </div>

        <button
          type="button"
          className="btn-secondary"
          onClick={fetchInsights}
          disabled={loading}
          title="Refresh insights"
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

      {loading && !progressData && (
        <div className="progress-loading-state">
          <div className="spinner" />
          <p>Loading study progress...</p>
        </div>
      )}

      {progressData && (progressData.totalPlans === 0 || !progressData.totalPlans) && completedHrs === 0 ? (
        <div className="empty-planner-state">
          <div className="empty-state-badge">📊</div>
          <h3>No Study Progress Recorded</h3>
          <p>
            You don't have any active study sessions or completed plans yet.
            Once you create a study plan with your AI tutor and log your sessions or quizzes, your workload analytics and mastery metrics will be tracked here.
          </p>
          <div className="empty-cta-group">
            <button
              type="button"
              className="btn-primary"
              onClick={() => onAskInChat?.("Hi! Let's create a personalized study plan.")}
            >
              <span>✦ Start with AI Tutor</span>
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onNavigateToPlanner?.()}
            >
              <span>Open Planner →</span>
            </button>
          </div>
        </div>
      ) : progressData && (
        <>
          {/* Top Metric Cards */}
          <div className="metrics-grid">
            <div className="metric-panel">
              <span className="metric-label">OVERALL COMPLETION</span>
              <strong className="metric-value accent-cyan">
                {progressData.overallProgress || '0%'}
              </strong>
              <div className="mini-progress-track">
                <div
                  className="mini-progress-bar cyan-bar"
                  style={{
                    width: `${Math.min(100, parseInt(progressData.overallProgress || '0', 10))}%`,
                  }}
                />
              </div>
            </div>

            <div className="metric-panel">
              <span className="metric-label">HOURS COMPLETED</span>
              <strong className="metric-value text-success">
                {completedHrs} hrs
              </strong>
              <span className="metric-sub">
                of {totalAllocated} allocated hrs
              </span>
            </div>

            <div className="metric-panel">
              <span className="metric-label">MISSED HOURS</span>
              <strong className={`metric-value ${missedHrs > 0 ? 'text-error' : 'text-success'}`}>
                {missedHrs} hrs
              </strong>
              <span className="metric-sub">
                {missedHrs > 0 ? 'Catch-up needed' : 'On schedule'}
              </span>
            </div>

            <div className="metric-panel">
              <span className="metric-label">QUIZ SCORE</span>
              <strong className="metric-value accent-violet">
                {progressData.averageQuizScore || '—'}
              </strong>
              <span className="metric-sub">
                {progressData.quizzesTaken || 0} quiz session{(progressData.quizzesTaken || 0) === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          {/* Simple Visual Workload Chart */}
          <div className="section-block">
            <h4 className="section-title">STUDY WORKLOAD BREAKDOWN</h4>
            <div className="progress-chart-card">
              <div className="chart-legend-row">
                <span className="legend-item">
                  <span className="legend-swatch swatch-done" /> Done: {completedHrs}h
                </span>
                <span className="legend-item">
                  <span className="legend-swatch swatch-remaining" /> Remaining: {remainingHrs}h
                </span>
                {missedHrs > 0 && (
                  <span className="legend-item">
                    <span className="legend-swatch swatch-missed" /> Missed: {missedHrs}h
                  </span>
                )}
              </div>

              <div
                className="stacked-workload-bar"
                role="img"
                aria-label={`Study workload: ${completedHrs}h completed, ${remainingHrs}h remaining, ${missedHrs}h missed`}
              >
                {completedPct > 0 && (
                  <div
                    className="stacked-segment segment-done"
                    style={{ width: `${completedPct}%` }}
                    title={`Completed: ${completedHrs}h (${completedPct}%)`}
                  />
                )}
                {remainingPct > 0 && (
                  <div
                    className="stacked-segment segment-remaining"
                    style={{ width: `${remainingPct}%` }}
                    title={`Remaining: ${remainingHrs}h (${remainingPct}%)`}
                  />
                )}
                {missedPct > 0 && (
                  <div
                    className="stacked-segment segment-missed"
                    style={{ width: `${missedPct}%` }}
                    title={`Missed: ${missedHrs}h (${missedPct}%)`}
                  />
                )}
              </div>

              <div className="chart-stats-summary">
                <span>Total Workload: <strong>{totalAllocated}h</strong></span>
                <span>Pacing: <strong>{missedHrs > 0 ? `${missedHrs}h behind` : 'On track'}</strong></span>
                <span>Completion: <strong>{progressData.overallProgress || '0%'}</strong></span>
              </div>
            </div>
          </div>

          {/* Weak Topics Section */}
          <div className="section-block">
            <div className="section-header-flex">
              <h4 className="section-title">
                AREAS FOR REVIEW ({weakTopics.length})
              </h4>
              {weakTopics.length > 0 && (
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => onAskInChat?.('Help me revise my weakest topic')}
                >
                  <span>✦ Practice in Tutor</span>
                </button>
              )}
            </div>

            {weakTopics.length === 0 ? (
              <div className="clean-status-card">
                <span className="clean-icon">✓</span>
                <div>
                  <strong>All benchmarks met</strong>
                  <p>No weak topics detected across your study plans and quizzes.</p>
                </div>
              </div>
            ) : (
              <div className="weak-topics-grid">
                {weakTopics.map((item, idx) => (
                  <div key={idx} className="weak-topic-card">
                    <div className="weak-topic-header">
                      <strong className="weak-subject-name">{item.subject}</strong>
                      {item.topic && item.topic !== item.subject && (
                        <span className="weak-concept-tag">{item.topic}</span>
                      )}
                    </div>

                    <div className="weak-reasons-list">
                      {item.reasons?.map((reason, rIdx) => (
                        <span key={rIdx} className="weak-reason-pill">{reason}</span>
                      ))}
                    </div>

                    <button
                      type="button"
                      className="weak-action-btn"
                      onClick={() =>
                        onAskInChat?.(`Help me revise my weak topic: ${item.subject}${item.topic ? ` (${item.topic})` : ''}`)
                      }
                      title={`Revise ${item.subject} with AI Tutor`}
                    >
                      <span>Revise in Tutor ↗</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Active Study Plans */}
          <div className="section-block">
            <div className="section-header-flex">
              <h4 className="section-title">ACTIVE PLANS ({progressData.totalPlans || 0})</h4>
              <button
                type="button"
                className="link-action-btn"
                onClick={() => onNavigateToPlanner?.()}
              >
                Open Planner →
              </button>
            </div>

            {(!progressData.activePlans || progressData.activePlans.length === 0) ? (
              <div className="empty-subtext">
                No active plans found.
              </div>
            ) : (
              <div className="active-plans-grid">
                {progressData.activePlans.map((p) => {
                  const pct = parseInt(p.progress || '0', 10)
                  return (
                    <div key={p.planId} className="active-plan-summary-card">
                      <div className="plan-summary-header">
                        <strong className="plan-summary-title">
                          {Array.isArray(p.subjects) ? p.subjects.join(', ') : 'Study Plan'}
                        </strong>
                        <span className="plan-days-badge">{p.daysRemaining} days left</span>
                      </div>

                      <div className="plan-summary-progress">
                        <div className="progress-bar-track">
                          <div
                            className="progress-bar-fill"
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span className="progress-pct-num">{p.progress}</span>
                      </div>

                      <div className="plan-summary-footer">
                        <span className="plan-id-sub">ID: {p.planId}</span>
                        <button
                          type="button"
                          className="link-btn-sm"
                          onClick={() => onNavigateToPlanner?.(p.planId)}
                        >
                          View Schedule →
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
