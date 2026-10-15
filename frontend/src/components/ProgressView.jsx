import { useCallback, useEffect, useState, useMemo } from 'react'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

function isTestPlanId(id) {
  if (!id) return true
  return /^(?:test[_-]|repro[_-]|agent_e2e|adaptive_regress|adapt_preserve|eval[_-]|date-e2e-|success_|mock[_-])/i.test(id)
}

export function ProgressView({ onNavigateToPlanner, onAskInChat }) {
  const [progressData, setProgressData] = useState(null)
  const [weakTopicsReport, setWeakTopicsReport] = useState(null)
  const [plansList, setPlansList] = useState([])
  const [detailedPlans, setDetailedPlans] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [hoveredSubject, setHoveredSubject] = useState(null)
  const [hoveredSegment, setHoveredSegment] = useState(null)

  const fetchInsights = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [progRes, weakRes, plansRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/progress`),
        fetch(`${API_BASE_URL}/api/weak-topics`),
        fetch(`${API_BASE_URL}/api/plans`),
      ])

      if (!progRes.ok) throw new Error(`Progress request failed (${progRes.status})`)
      const prog = await progRes.json()
      setProgressData(prog)

      if (weakRes.ok) {
        const weak = await weakRes.json()
        setWeakTopicsReport(weak)
      }

      if (plansRes.ok) {
        const plansData = await plansRes.json()
        const rawList = plansData.plans || []
        const list = rawList.filter((p) => !isTestPlanId(p.planId))
        setPlansList(list)

        // Fetch detailed data for up to 3 plans to extract subject & session metrics
        if (list.length > 0) {
          const detailPromises = list.slice(0, 3).map((p) =>
            fetch(`${API_BASE_URL}/api/plans/${encodeURIComponent(p.planId)}`)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
          const details = await Promise.all(detailPromises)
          const detailMap = {}
          details.forEach((d) => {
            if (d && d.planId) detailMap[d.planId] = d
          })
          setDetailedPlans(detailMap)
        }
      }
    } catch (err) {
      setError(err.message || 'Unable to retrieve progress insights.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchInsights()
  }, [fetchInsights])

  const weakTopics = weakTopicsReport?.weakTopics || []
  const completedHrs = progressData?.totalCompletedHours || 0
  const remainingHrs = progressData?.totalRemainingHours || 0
  const missedHrs = progressData?.totalMissedHours || 0
  const totalAllocated = progressData?.totalAllocatedHours || (completedHrs + remainingHrs) || 0
  const sumHrs = completedHrs + remainingHrs + missedHrs || 1

  const completedPct = Math.round((completedHrs / sumHrs) * 100)
  const remainingPct = Math.round((remainingHrs / sumHrs) * 100)
  const missedPct = Math.max(0, 100 - completedPct - remainingPct)

  // Derive aggregated subject metrics across all loaded detailed plans
  const subjectMetrics = useMemo(() => {
    const map = {}
    Object.values(detailedPlans).forEach((plan) => {
      if (plan.subjects && typeof plan.subjects === 'object') {
        Object.entries(plan.subjects).forEach(([subjectName, sData]) => {
          if (!map[subjectName]) {
            map[subjectName] = {
              name: subjectName,
              targetHours: 0,
              completedHours: 0,
              remainingHours: 0,
              priority: sData.priority || 'medium',
            }
          }
          map[subjectName].targetHours += sData.targetHours || 0
          map[subjectName].completedHours += sData.completedHours || 0
          map[subjectName].remainingHours += sData.remainingHours || 0
        })
      }
    })

    // If detailed plans have no subjects, fallback to activePlans summary subjects
    if (Object.keys(map).length === 0 && progressData?.activePlans) {
      progressData.activePlans.forEach((p) => {
        const subs = Array.isArray(p.subjects) ? p.subjects : []
        subs.forEach((s) => {
          if (!map[s]) {
            map[s] = {
              name: s,
              targetHours: Math.round(totalAllocated / Math.max(1, subs.length)),
              completedHours: Math.round(completedHrs / Math.max(1, subs.length)),
              remainingHours: Math.round(remainingHrs / Math.max(1, subs.length)),
              priority: 'high',
            }
          }
        })
      })
    }

    return Object.values(map)
  }, [detailedPlans, progressData, completedHrs, remainingHrs, totalAllocated])

  // Aggregate recent sessions across detailed plans for activity timeline
  const recentSessions = useMemo(() => {
    const all = []
    Object.values(detailedPlans).forEach((plan) => {
      if (Array.isArray(plan.sessions)) {
        all.push(...plan.sessions)
      }
    })
    // Sort chronologically or by ID
    return all.slice(-7)
  }, [detailedPlans])

  // SVG Donut Calculations
  const radius = 64
  const circumference = 2 * Math.PI * radius
  const strokeCompleted = (completedPct / 100) * circumference
  const strokeRemaining = (remainingPct / 100) * circumference
  const strokeMissed = (missedPct / 100) * circumference

  const offsetCompleted = 0
  const offsetRemaining = -strokeCompleted
  const offsetMissed = -(strokeCompleted + strokeRemaining)

  return (
    <div className="progress-container">
      {/* Header */}
      <div className="progress-top-bar">
        <div className="progress-heading-group">
          <h2>Learning Analytics &amp; Progress</h2>
          <p className="progress-subtitle">
            Real-time tracking of study hours, subject mastery, pacing, and retention.
          </p>
        </div>

        <button
          type="button"
          className="btn-secondary"
          onClick={fetchInsights}
          disabled={loading}
          title="Refresh insights from server"
          aria-label="Refresh progress insights"
        >
          <span>↻ Refresh</span>
        </button>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          <span className="banner-icon" aria-hidden="true">⚠</span>
          <span className="banner-text">{error}</span>
          <button type="button" className="banner-dismiss" onClick={() => setError('')}>✕</button>
        </div>
      )}

      {loading && !progressData && (
        <div className="progress-loading-state">
          <div className="spinner" />
          <p>Analyzing study records and performance metrics...</p>
        </div>
      )}

      {!loading && (plansList.length === 0 || ((progressData?.totalPlans === 0 || !progressData?.totalPlans) && completedHrs === 0)) ? (
        <div className="empty-planner-state">
          <div className="empty-state-badge">📊</div>
          <h3>“Your learning journey starts here.”</h3>
          <p>
            No progress recorded yet. Start a conversation with your AI tutor to discover your goals, build a curriculum, and track your daily study hours.
          </p>
          <div className="empty-cta-group">
            <button
              type="button"
              className="btn-primary"
              onClick={() => onAskInChat?.("Hi! Let's create a personalized study plan.")}
            >
              <span>✦ Start Learning</span>
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => onNavigateToPlanner?.()}
            >
              <span>View Study Planner →</span>
            </button>
          </div>
        </div>
      ) : progressData && (
        <>
          {/* Key Stat Metric Cards */}
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
                {missedHrs > 0 ? 'Catch-up recommended' : 'On schedule'}
              </span>
            </div>

            <div className="metric-panel">
              <span className="metric-label">QUIZ ACCURACY</span>
              <strong className="metric-value accent-violet">
                {progressData.averageQuizScore || '—'}
              </strong>
              <span className="metric-sub">
                {progressData.quizzesTaken || 0} quiz checkpoint{(progressData.quizzesTaken || 0) === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          {/* VISUAL GRAPH 1: WORKLOAD DISTRIBUTION & DONUT GAUGE */}
          <div className="analytics-section-card">
            <div className="section-header-flex">
              <div>
                <h4 className="section-title">WORKLOAD TIME ALLOCATION</h4>
                <p className="section-subtitle">Real breakdown of completed study time versus remaining workload</p>
              </div>
              <span className="badge-pacing">
                {missedHrs > 0 ? `${missedHrs}h Behind Schedule` : '✓ On Pace'}
              </span>
            </div>

            <div className="donut-chart-layout">
              {/* SVG Donut Chart */}
              <div className="donut-visual-wrap">
                <svg
                  className="donut-svg"
                  width="180"
                  height="180"
                  viewBox="0 0 180 180"
                  role="img"
                  aria-label={`Donut chart showing ${completedPct}% completed, ${remainingPct}% remaining, ${missedPct}% missed`}
                >
                  <circle
                    className="donut-bg-ring"
                    cx="90"
                    cy="90"
                    r={radius}
                    fill="none"
                    stroke="var(--border-subtle)"
                    strokeWidth="18"
                  />
                  {completedPct > 0 && (
                    <circle
                      className="donut-segment segment-completed"
                      cx="90"
                      cy="90"
                      r={radius}
                      fill="none"
                      stroke="var(--status-success)"
                      strokeWidth="18"
                      strokeDasharray={`${strokeCompleted} ${circumference}`}
                      strokeDashoffset={offsetCompleted}
                      onMouseEnter={() => setHoveredSegment('completed')}
                      onMouseLeave={() => setHoveredSegment(null)}
                    >
                      <title>{`Completed: ${completedHrs} hrs (${completedPct}%)`}</title>
                    </circle>
                  )}
                  {remainingPct > 0 && (
                    <circle
                      className="donut-segment segment-remaining"
                      cx="90"
                      cy="90"
                      r={radius}
                      fill="none"
                      stroke="var(--accent-primary)"
                      strokeWidth="18"
                      strokeDasharray={`${strokeRemaining} ${circumference}`}
                      strokeDashoffset={offsetRemaining}
                      onMouseEnter={() => setHoveredSegment('remaining')}
                      onMouseLeave={() => setHoveredSegment(null)}
                    >
                      <title>{`Remaining: ${remainingHrs} hrs (${remainingPct}%)`}</title>
                    </circle>
                  )}
                  {missedPct > 0 && (
                    <circle
                      className="donut-segment segment-missed"
                      cx="90"
                      cy="90"
                      r={radius}
                      fill="none"
                      stroke="var(--status-error)"
                      strokeWidth="18"
                      strokeDasharray={`${strokeMissed} ${circumference}`}
                      strokeDashoffset={offsetMissed}
                      onMouseEnter={() => setHoveredSegment('missed')}
                      onMouseLeave={() => setHoveredSegment(null)}
                    >
                      <title>{`Missed: ${missedHrs} hrs (${missedPct}%)`}</title>
                    </circle>
                  )}
                </svg>

                <div className="donut-center-metric">
                  <span className="donut-center-pct">{progressData.overallProgress || `${completedPct}%`}</span>
                  <span className="donut-center-lbl">Done</span>
                </div>
              </div>

              {/* Legend and Detailed Metric Breakdown */}
              <div className="donut-legend-col">
                <div className={`legend-stat-row ${hoveredSegment === 'completed' ? 'highlight' : ''}`}>
                  <div className="legend-indicator dot-success" />
                  <div className="legend-label-col">
                    <strong>Completed Study</strong>
                    <span>Actual hours logged through verified sessions</span>
                  </div>
                  <div className="legend-val-col">
                    <span className="val-hours">{completedHrs} hrs</span>
                    <span className="val-pct">{completedPct}%</span>
                  </div>
                </div>

                <div className={`legend-stat-row ${hoveredSegment === 'remaining' ? 'highlight' : ''}`}>
                  <div className="legend-indicator dot-accent" />
                  <div className="legend-label-col">
                    <strong>Remaining Workload</strong>
                    <span>Scheduled upcoming study capacity</span>
                  </div>
                  <div className="legend-val-col">
                    <span className="val-hours">{remainingHrs} hrs</span>
                    <span className="val-pct">{remainingPct}%</span>
                  </div>
                </div>

                <div className={`legend-stat-row ${hoveredSegment === 'missed' ? 'highlight' : ''}`}>
                  <div className="legend-indicator dot-error" />
                  <div className="legend-label-col">
                    <strong>Missed Sessions</strong>
                    <span>Sessions requiring adaptive rescheduling</span>
                  </div>
                  <div className="legend-val-col">
                    <span className="val-hours">{missedHrs} hrs</span>
                    <span className="val-pct">{missedPct}%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* VISUAL GRAPH 2: SUBJECT-WISE PROGRESS COMPARISON */}
          <div className="analytics-section-card">
            <div className="section-header-flex">
              <div>
                <h4 className="section-title">SUBJECT-WISE PROGRESS &amp; CAPACITY</h4>
                <p className="section-subtitle">Real completed hours versus remaining target per subject</p>
              </div>
              <span className="badge-stat">{subjectMetrics.length} Subjects Tracked</span>
            </div>

            {subjectMetrics.length === 0 ? (
              <div className="empty-subtext">No subject metrics available. Create a plan to view subject progression.</div>
            ) : (
              <div className="subject-bars-list">
                {subjectMetrics.map((sub) => {
                  const subTotal = (sub.completedHours + sub.remainingHours) || 1
                  const subDonePct = Math.min(100, Math.round((sub.completedHours / subTotal) * 100))
                  const isHovered = hoveredSubject === sub.name

                  return (
                    <div
                      key={sub.name}
                      className={`subject-bar-row ${isHovered ? 'hovered' : ''}`}
                      onMouseEnter={() => setHoveredSubject(sub.name)}
                      onMouseLeave={() => setHoveredSubject(null)}
                    >
                      <div className="subject-meta-left">
                        <strong className="subject-row-name">{sub.name}</strong>
                        <span className={`priority-tag priority-${sub.priority}`}>
                          {sub.priority.toUpperCase()}
                        </span>
                      </div>

                      <div className="subject-track-container">
                        <div
                          className="subject-progress-track"
                          role="progressbar"
                          aria-valuenow={subDonePct}
                          aria-valuemin="0"
                          aria-valuemax="100"
                          aria-label={`${sub.name}: ${subDonePct}% completed`}
                        >
                          <div
                            className="subject-progress-fill"
                            style={{ width: `${subDonePct}%` }}
                          />
                        </div>
                        <div className="subject-track-ticks">
                          <span>0h</span>
                          <span>{sub.completedHours}h logged</span>
                          <span>{sub.targetHours || (sub.completedHours + sub.remainingHours)}h target</span>
                        </div>
                      </div>

                      <div className="subject-meta-right">
                        <strong className="subject-pct-text">{subDonePct}%</strong>
                        <span className="subject-hours-sub">{sub.remainingHours}h left</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* VISUAL GRAPH 3: RECENT STUDY SESSIONS & REVISION LOG */}
          {recentSessions.length > 0 && (
            <div className="analytics-section-card">
              <div className="section-header-flex">
                <div>
                  <h4 className="section-title">VERIFIED STUDY ACTIVITY TIMELINE</h4>
                  <p className="section-subtitle">Chronological record of completed and adapted study sessions</p>
                </div>
                <span className="badge-stat">{recentSessions.length} Recent Sessions</span>
              </div>

              <div className="sessions-timeline-grid">
                {recentSessions.map((sess, idx) => (
                  <div key={idx} className={`session-log-card status-${sess.status || 'completed'}`}>
                    <div className="session-card-header">
                      <span className="session-subject-title">{sess.subject}</span>
                      <span className={`session-status-pill status-${sess.status}`}>
                        {sess.status === 'completed' ? '✓ Completed' : '⚠ Missed'}
                      </span>
                    </div>
                    <div className="session-card-metrics">
                      <div className="metric-tiny">
                        <span className="label">Hours</span>
                        <strong className="val">{sess.hoursSpent ?? (sess.status === 'completed' ? sess.scheduledHours : 0)}h</strong>
                      </div>
                      {sess.date && (
                        <div className="metric-tiny">
                          <span className="label">Date</span>
                          <strong className="val">{sess.date}</strong>
                        </div>
                      )}
                    </div>
                    {sess.notes && (
                      <p className="session-card-note">{sess.notes}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Weak Topics Section */}
          <div className="analytics-section-card">
            <div className="section-header-flex">
              <div>
                <h4 className="section-title">
                  TARGETED REVISION &amp; WEAK TOPICS ({weakTopics.length})
                </h4>
                <p className="section-subtitle">Identified gaps from quiz checkpoint performance and missed sessions</p>
              </div>
              {weakTopics.length > 0 && (
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => onAskInChat?.('Help me revise my weakest topic')}
                >
                  <span>✦ Revise in Tutor</span>
                </button>
              )}
            </div>

            {weakTopics.length === 0 ? (
              <div className="clean-status-card">
                <span className="clean-icon" aria-hidden="true">✓</span>
                <div>
                  <strong>All benchmarks met</strong>
                  <p>No weak topics or knowledge gaps detected across your verified sessions and quizzes.</p>
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
          <div className="analytics-section-card">
            <div className="section-header-flex">
              <div>
                <h4 className="section-title">ACTIVE STUDY PLANS ({progressData.totalPlans || plansList.length || 0})</h4>
                <p className="section-subtitle">Overall progress completion rates per plan</p>
              </div>
              <button
                type="button"
                className="link-action-btn"
                onClick={() => onNavigateToPlanner?.()}
              >
                Open Full Planner →
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
