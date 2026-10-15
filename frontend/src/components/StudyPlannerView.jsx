import { useCallback, useEffect, useState } from 'react'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

function isTestPlanId(id) {
  if (!id) return true
  return /^(?:test[_-]|repro[_-]|agent_e2e|adaptive_regress|adapt_preserve|eval[_-]|date-e2e-|success_|mock[_-])/i.test(id)
}

export function StudyPlannerView({ onAskInChat, activePlanId: initialActivePlanId }) {
  const [plans, setPlans] = useState([])
  const [activePlanId, setActivePlanId] = useState(initialActivePlanId || '')
  const [currentPlan, setCurrentPlan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showSessionModal, setShowSessionModal] = useState(false)
  const [showAdaptModal, setShowAdaptModal] = useState(false)
  const [planToDelete, setPlanToDelete] = useState(null)
  const [deletingPlan, setDeletingPlan] = useState(false)
  const [activeDetailTab, setActiveDetailTab] = useState('sessions') // 'sessions' | 'history'

  // Create Form State
  const [newSubjects, setNewSubjects] = useState('')
  const [planMode, setPlanMode] = useState('duration') // 'duration' or 'exam'
  const [durationDays, setDurationDays] = useState(7)
  const [examDate, setExamDate] = useState('')
  const [dailyHours, setDailyHours] = useState(2)
  const [subjectPriority, setSubjectPriority] = useState('high')

  // Record Session Form State
  const [sessionSubject, setSessionSubject] = useState('')
  const [sessionHours, setSessionHours] = useState(2)
  const [sessionStatus, setSessionStatus] = useState('completed')
  const [sessionNotes, setSessionNotes] = useState('')
  const [sessionDate, setSessionDate] = useState('')

  // Adapt Schedule Form State
  const [adaptReason, setAdaptReason] = useState('Adjusting schedule for missed sessions')
  const [adaptNewHours, setAdaptNewHours] = useState('')

  // Load plan summaries (for manual refresh / actions)
  const fetchPlans = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE_URL}/api/plans`)
      if (!res.ok) {
        throw new Error(`Failed to load plans (${res.status})`)
      }
      const data = await res.json()
      const rawList = data.plans || []
      const list = rawList.filter((p) => !isTestPlanId(p.planId))
      setPlans(list)

      if (list.length > 0) {
        const nextId = activePlanId && list.some((p) => p.planId === activePlanId)
          ? activePlanId
          : list[0].planId
        setActivePlanId(nextId)
      } else {
        setCurrentPlan(null)
      }
    } catch (err) {
      setError(err.message || 'Unable to retrieve study plans.')
    } finally {
      setLoading(false)
    }
  }, [activePlanId])

  // Load detailed plan (for manual refresh / actions)
  const fetchPlanDetails = useCallback(async (id) => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_BASE_URL}/api/plans/${encodeURIComponent(id)}`)
      if (!res.ok) {
        throw new Error(`Failed to retrieve plan "${id}" (${res.status})`)
      }
      const plan = await res.json()
      setCurrentPlan(plan)
      if (plan.subjects) {
        const firstSub = Object.keys(plan.subjects)[0]
        if (firstSub) setSessionSubject(firstSub)
      }
    } catch (err) {
      setError(err.message || 'Unable to load plan details.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let ignore = false
    const loadInitialPlans = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/plans`)
        if (!res.ok) throw new Error(`Failed to load plans (${res.status})`)
        const data = await res.json()
        const rawList = data.plans || []
        const list = rawList.filter((p) => !isTestPlanId(p.planId))
        if (!ignore) {
          setPlans(list)
          if (list.length > 0) {
            setActivePlanId((prev) => (prev && list.some((p) => p.planId === prev) ? prev : list[0].planId))
          } else {
            setCurrentPlan(null)
          }
        }
      } catch (err) {
        if (!ignore) setError(err.message || 'Unable to retrieve study plans.')
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    loadInitialPlans()
    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (!activePlanId) return
    let ignore = false
    const loadInitialDetails = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/plans/${encodeURIComponent(activePlanId)}`)
        if (!res.ok) throw new Error(`Failed to retrieve plan "${activePlanId}" (${res.status})`)
        const plan = await res.json()
        if (!ignore) {
          setCurrentPlan(plan)
          if (plan.subjects) {
            const firstSub = Object.keys(plan.subjects)[0]
            if (firstSub) setSessionSubject(firstSub)
          }
        }
      } catch (err) {
        if (!ignore) setError(err.message || 'Unable to load plan details.')
      }
    }

    loadInitialDetails()
    return () => {
      ignore = true
    }
  }, [activePlanId])

  // Create Plan Handler
  const handleCreatePlan = async (e) => {
    e.preventDefault()
    setActionLoading(true)
    setError('')
    setSuccessMsg('')

    const subjectsArr = newSubjects
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    if (subjectsArr.length === 0) {
      setError('Please provide at least one subject.')
      setActionLoading(false)
      return
    }

    const priorities = {}
    subjectsArr.forEach((s) => {
      priorities[s] = subjectPriority
    })

    const payload = {
      subjects: subjectsArr,
      dailyAvailableHours: Number(dailyHours),
      priorities,
    }

    if (planMode === 'exam' && examDate) {
      payload.examDate = examDate
    } else {
      payload.durationDays = Number(durationDays)
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await res.json()

      if (!res.ok || result.error) {
        throw new Error(result.error || 'Failed to create study plan.')
      }

      setSuccessMsg(result.message || `Study plan "${result.planId}" created successfully!`)
      setShowCreateModal(false)
      setActivePlanId(result.planId)
      fetchPlans()
    } catch (err) {
      setError(err.message || 'Could not create study plan.')
    } finally {
      setActionLoading(false)
    }
  }

  // Record Session Handler
  const handleRecordSession = async (e) => {
    e.preventDefault()
    if (!currentPlan) return
    setActionLoading(true)
    setError('')
    setSuccessMsg('')

    const payload = {
      subject: sessionSubject,
      hoursSpent: Number(sessionHours),
      status: sessionStatus,
      notes: sessionNotes || undefined,
      date: sessionDate || undefined,
    }

    if (sessionStatus === 'missed') {
      payload.missedHours = Number(sessionHours) || 2
      payload.hoursSpent = 0
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/plans/${encodeURIComponent(currentPlan.planId)}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await res.json()

      if (!res.ok || result.error) {
        throw new Error(result.error || 'Failed to record session.')
      }

      setSuccessMsg(result.message || `Study session for "${sessionSubject}" recorded!`)
      setShowSessionModal(false)
      setSessionNotes('')
      fetchPlanDetails(currentPlan.planId)
      fetchPlans()
    } catch (err) {
      setError(err.message || 'Could not record study session.')
    } finally {
      setActionLoading(false)
    }
  }

  // Adapt Plan Handler
  const handleAdaptPlan = async (e) => {
    e.preventDefault()
    if (!currentPlan) return
    setActionLoading(true)
    setError('')
    setSuccessMsg('')

    const payload = {
      reason: adaptReason,
    }

    if (adaptNewHours && Number(adaptNewHours) > 0) {
      payload.newDailyAvailableHours = Number(adaptNewHours)
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/plans/${encodeURIComponent(currentPlan.planId)}/adapt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await res.json()

      if (!res.ok || result.error) {
        throw new Error(result.error || 'Failed to adapt study plan.')
      }

      setSuccessMsg(result.message || 'Study plan adapted successfully!')
      setShowAdaptModal(false)
      fetchPlanDetails(currentPlan.planId)
      fetchPlans()
    } catch (err) {
      setError(err.message || 'Could not adapt study schedule.')
    } finally {
      setActionLoading(false)
    }
  }

  // Delete Plan Handler (Compliant with existing backend APIs and error reporting)
  const handleDeletePlan = async () => {
    if (!planToDelete) return
    setDeletingPlan(true)
    setError('')
    setSuccessMsg('')
    try {
      const res = await fetch(`${API_BASE_URL}/api/plans/${encodeURIComponent(planToDelete.planId)}`, {
        method: 'DELETE',
      })

      if (!res.ok) {
        if (res.status === 404 || res.status === 405 || res.status === 501) {
          throw new Error(
            'Individual study-plan deletion is currently unavailable. To reset your learning plans, visit Settings > Danger Zone.'
          )
        }
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete plan. Please try again.')
      }

      // If backend confirms deletion
      const remaining = plans.filter((p) => p.planId !== planToDelete.planId)
      setPlans(remaining)
      if (activePlanId === planToDelete.planId) {
        setActivePlanId(remaining.length > 0 ? remaining[0].planId : '')
      }
      setSuccessMsg(`Study plan "${planToDelete.planId}" deleted successfully.`)
      setPlanToDelete(null)
      fetchPlans()
    } catch (err) {
      // On failure, keep the plan visible and display clear honest error
      setError(err.message || 'Unable to delete study plan.')
      setPlanToDelete(null)
    } finally {
      setDeletingPlan(false)
    }
  }

  const subjectsList = currentPlan?.subjects ? Object.entries(currentPlan.subjects) : []

  return (
    <div className="planner-container">
      {/* Action Header */}
      <div className="planner-top-bar">
        <div className="planner-heading-group">
          <h2>Study Planner</h2>
          <p className="planner-subtitle">
            Organize subjects, track daily hours, and adapt schedules.
          </p>
        </div>

        <div className="planner-actions-row">
          <button
            type="button"
            className="btn-primary"
            onClick={() => setShowCreateModal(true)}
            title="Create a new study plan"
          >
            <span>＋ New Plan</span>
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={fetchPlans}
            disabled={loading}
            title="Refresh saved plans"
          >
            <span>↻ Refresh</span>
          </button>
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <div className="banner banner-error" role="alert">
          <span className="banner-icon">⚠</span>
          <span className="banner-text">{error}</span>
          <button type="button" className="banner-dismiss" onClick={() => setError('')}>✕</button>
        </div>
      )}

      {successMsg && (
        <div className="banner banner-success" role="status">
          <span className="banner-icon">✓</span>
          <span className="banner-text">{successMsg}</span>
          <button type="button" className="banner-dismiss" onClick={() => setSuccessMsg('')}>✕</button>
        </div>
      )}

      {/* Plans selector tab strip */}
      {plans.length > 0 && (
        <div className="plan-selector-strip" role="tablist" aria-label="Saved Study Plans">
          <span className="strip-label">SAVED PLANS ({plans.length}):</span>
          <div className="strip-scroll">
            {plans.map((p) => {
              const isActive = p.planId === activePlanId
              const subNames = Array.isArray(p.subjects) ? p.subjects.join(', ') : 'Study Plan'
              return (
                <div
                  key={p.planId}
                  role="tab"
                  aria-selected={isActive}
                  className={`plan-tab-chip ${isActive ? 'active' : ''}`}
                  onClick={() => setActivePlanId(p.planId)}
                >
                  <span className="chip-subject">{subNames}</span>
                  <span className="chip-progress">{p.overallProgress}</span>
                  <button
                    type="button"
                    className="chip-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPlanToDelete(p)
                    }}
                    title={`Delete plan "${p.planId}"`}
                    aria-label={`Delete plan "${p.planId}"`}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!loading && plans.length === 0 && (
        <div className="empty-planner-state">
          <div className="empty-state-badge">📋</div>
          <h3>“No study plan yet. Let's create one together.”</h3>
          <p>
            Your tasks will appear after your study plan is created.
            Start a conversation with your AI tutor to discover your goals, starting level, and preferred schedule.
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
              onClick={() => setShowCreateModal(true)}
            >
              <span>＋ Create Custom Plan Manually</span>
            </button>
          </div>
        </div>
      )}

      {/* Active Plan Detail View */}
      {currentPlan && (
        <div className="plan-detail-card">
          <div className="plan-card-header">
            <div className="plan-title-col">
              <div className="plan-badges-row">
                <span className="plan-id-tag">Plan ID: {currentPlan.planId}</span>
                <span className="plan-mode-tag">
                  {currentPlan.planningMode === 'exam' ? '🎯 Exam-Driven' : '⏱ Goal-Driven'}
                </span>
                {currentPlan.examDate && (
                  <span className="plan-deadline-tag">Exam: {currentPlan.examDate}</span>
                )}
              </div>
              <h3 className="plan-main-title">
                {subjectsList.map(([name]) => name).join(' • ')}
              </h3>
            </div>

            <div className="plan-header-cta-group">
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setShowSessionModal(true)}
                title="Log a completed or missed study session"
              >
                <span>📝 Log Session</span>
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setShowAdaptModal(true)}
                title="Re-balance schedule for missed hours"
              >
                <span>⚡ Adapt Schedule</span>
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() =>
                  onAskInChat?.(`Quiz me on ${subjectsList[0]?.[0] || 'this study plan'}`)
                }
                title="Practice quiz in AI Tutor"
              >
                <span>✦ Practice Quiz</span>
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm btn-delete-plan-action"
                onClick={() => setPlanToDelete(currentPlan)}
                title={`Delete study plan "${currentPlan.planId}"`}
                aria-label={`Delete study plan "${currentPlan.planId}"`}
              >
                <span>🗑 Delete Plan</span>
              </button>
            </div>
          </div>

          {/* Key Metrics Grid */}
          <div className="metrics-grid">
            <div className="metric-panel">
              <span className="metric-label">OVERALL PROGRESS</span>
              <strong className="metric-value accent-cyan">{currentPlan.overallProgress || '0%'}</strong>
              <div className="mini-progress-track">
                <div
                  className="mini-progress-bar cyan-bar"
                  style={{
                    width: `${Math.min(100, parseInt(currentPlan.overallProgress || '0', 10))}%`,
                  }}
                />
              </div>
            </div>

            <div className="metric-panel">
              <span className="metric-label">DAILY CAPACITY</span>
              <strong className="metric-value">{currentPlan.dailyStudyHours} hrs / day</strong>
              <span className="metric-sub">
                {currentPlan.durationDays || currentPlan.daysRemaining} days duration
              </span>
            </div>

            <div className="metric-panel">
              <span className="metric-label">COMPLETED WORKLOAD</span>
              <strong className="metric-value text-success">
                {currentPlan.totalCompletedHours || 0} hrs
              </strong>
              <span className="metric-sub">
                of {currentPlan.totalAllocatedHours || 0} allocated hrs
              </span>
            </div>

            <div className="metric-panel">
              <span className="metric-label">REMAINING WORKLOAD</span>
              <strong className="metric-value accent-violet">
                {currentPlan.totalRemainingHours || 0} hrs
              </strong>
              <span className="metric-sub">
                {currentPlan.totalMissedHours > 0
                  ? `${currentPlan.totalMissedHours} hrs missed (catch-up needed)`
                  : 'On track'}
              </span>
            </div>
          </div>

          {/* Subject Breakdown & Upcoming Tasks */}
          <div className="section-block">
            <h4 className="section-title">TASKS &amp; SUBJECT ALLOCATIONS</h4>
            <div className="subjects-cards-grid">
              {subjectsList.map(([name, data]) => {
                const pct = data.progressPercentage ?? 0
                return (
                  <div key={name} className="subject-item-card">
                    <div className="subject-header-row">
                      <strong className="subject-name">{name}</strong>
                      <span className={`priority-tag priority-${data.priority || 'medium'}`}>
                        {data.priority || 'medium'}
                      </span>
                    </div>

                    <div className="subject-hours-row">
                      <span>Done: <strong>{data.completedHours || 0}h</strong></span>
                      <span>Left: <strong>{data.remainingHours || 0}h</strong></span>
                      <span>Total: <strong>{data.allocatedHours || 0}h</strong></span>
                    </div>

                    <div className="subject-progress-wrap">
                      <div className="progress-bar-track">
                        <div
                          className="progress-bar-fill"
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                      <span className="progress-pct-num">{pct}%</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Secondary Information: Tabbed Sessions & Adaptation History */}
          <div className="section-block planner-secondary-block">
            <div className="detail-tabs-header">
              <div className="detail-tabs-group" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeDetailTab === 'sessions'}
                  className={`detail-tab-btn ${activeDetailTab === 'sessions' ? 'active' : ''}`}
                  onClick={() => setActiveDetailTab('sessions')}
                >
                  Recent Sessions ({currentPlan.sessions?.length || 0})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeDetailTab === 'history'}
                  className={`detail-tab-btn ${activeDetailTab === 'history' ? 'active' : ''}`}
                  onClick={() => setActiveDetailTab('history')}
                >
                  Schedule Adaptations ({currentPlan.adaptationHistory?.length || 0})
                </button>
              </div>

              {activeDetailTab === 'sessions' && (
                <button
                  type="button"
                  className="link-action-btn"
                  onClick={() => setShowSessionModal(true)}
                >
                  ＋ Log session
                </button>
              )}
            </div>

            {activeDetailTab === 'sessions' ? (
              (!currentPlan.sessions || currentPlan.sessions.length === 0) ? (
                <p className="empty-subtext">No sessions recorded yet.</p>
              ) : (
                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Subject</th>
                        <th>Hours</th>
                        <th>Status</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentPlan.sessions.slice(-8).reverse().map((sess, i) => (
                        <tr key={sess.id || i}>
                          <td>{sess.date || 'Today'}</td>
                          <td><strong>{sess.subject}</strong></td>
                          <td>{sess.hoursSpent}h</td>
                          <td>
                            <span
                              className={`badge ${
                                sess.status === 'completed'
                                  ? 'badge-success'
                                  : sess.status === 'missed'
                                  ? 'badge-error'
                                  : 'badge-warning'
                              }`}
                            >
                              {sess.status}
                            </span>
                          </td>
                          <td className="notes-col">{sess.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : (
              (!currentPlan.adaptationHistory || currentPlan.adaptationHistory.length === 0) ? (
                <p className="empty-subtext">No schedule adaptations recorded yet.</p>
              ) : (
                <div className="adaptation-timeline">
                  {currentPlan.adaptationHistory.slice(-5).reverse().map((adapt, i) => (
                    <div key={adapt.id || i} className="adapt-event-item">
                      <div className="adapt-dot">⚡</div>
                      <div className="adapt-info">
                        <div className="adapt-header">
                          <strong className="adapt-reason">{adapt.reason}</strong>
                          <span className="adapt-time">
                            {adapt.timestamp ? new Date(adapt.timestamp).toLocaleDateString() : 'Recent'}
                          </span>
                        </div>
                        <p className="adapt-desc">
                          {adapt.daysRemaining} days remaining
                          {adapt.recommendedDailyHours && ` • ${adapt.recommendedDailyHours}h daily target`}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* CREATE PLAN MODAL */}
      {showCreateModal && (
        <div className="modal-backdrop" onClick={() => setShowCreateModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Create Adaptive Study Plan</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowCreateModal(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreatePlan} className="modal-form">
              <div className="form-group">
                <label htmlFor="create-subjects">
                  Subjects (comma-separated)
                </label>
                <input
                  id="create-subjects"
                  type="text"
                  className="form-input"
                  value={newSubjects}
                  onChange={(e) => setNewSubjects(e.target.value)}
                  placeholder="e.g. DBMS, Operating Systems"
                  required
                />
              </div>

              <div className="form-group">
                <label>Target Mode</label>
                <div className="radio-pill-group">
                  <button
                    type="button"
                    className={`radio-pill ${planMode === 'duration' ? 'active' : ''}`}
                    onClick={() => setPlanMode('duration')}
                  >
                    Duration (Days)
                  </button>
                  <button
                    type="button"
                    className={`radio-pill ${planMode === 'exam' ? 'active' : ''}`}
                    onClick={() => setPlanMode('exam')}
                  >
                    Exam Date
                  </button>
                </div>
              </div>

              {planMode === 'duration' ? (
                <div className="form-group">
                  <label htmlFor="create-days">Duration (Days)</label>
                  <input
                    id="create-days"
                    type="number"
                    min="1"
                    max="180"
                    className="form-input"
                    value={durationDays}
                    onChange={(e) => setDurationDays(e.target.value)}
                    required
                  />
                </div>
              ) : (
                <div className="form-group">
                  <label htmlFor="create-exam-date">Exam Date</label>
                  <input
                    id="create-exam-date"
                    type="date"
                    className="form-input"
                    value={examDate}
                    onChange={(e) => setExamDate(e.target.value)}
                    required
                  />
                </div>
              )}

              <div className="form-group">
                <label htmlFor="create-daily-hours">Daily Available Hours</label>
                <input
                  id="create-daily-hours"
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="12"
                  className="form-input"
                  value={dailyHours}
                  onChange={(e) => setDailyHours(e.target.value)}
                  required
                />
              </div>

              <div className="form-toggle-row">
                <button
                  type="button"
                  className="btn-text-toggle"
                  onClick={() => setShowAdvancedCreate((prev) => !prev)}
                >
                  {showAdvancedCreate ? '− Hide advanced options' : '＋ Advanced options'}
                </button>
              </div>

              {showAdvancedCreate && (
                <div className="form-group">
                  <label htmlFor="create-priority">Initial Priority</label>
                  <select
                    id="create-priority"
                    className="form-select"
                    value={subjectPriority}
                    onChange={(e) => setSubjectPriority(e.target.value)}
                  >
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Creating...' : 'Create Plan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* RECORD SESSION MODAL */}
      {showSessionModal && currentPlan && (
        <div className="modal-backdrop" onClick={() => setShowSessionModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Record Study Session</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowSessionModal(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleRecordSession} className="modal-form">
              <div className="form-group">
                <label htmlFor="session-subject">Subject</label>
                <select
                  id="session-subject"
                  className="form-select"
                  value={sessionSubject}
                  onChange={(e) => setSessionSubject(e.target.value)}
                  required
                >
                  {subjectsList.map(([name]) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>

              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="session-hours">Hours</label>
                  <input
                    id="session-hours"
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="12"
                    className="form-input"
                    value={sessionHours}
                    onChange={(e) => setSessionHours(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="session-status">Session Status</label>
                  <select
                    id="session-status"
                    className="form-select"
                    value={sessionStatus}
                    onChange={(e) => setSessionStatus(e.target.value)}
                  >
                    <option value="completed">Completed</option>
                    <option value="partially_completed">Partially Completed</option>
                    <option value="missed">Missed Session</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="session-date">Session Date (Optional, defaults to today)</label>
                <input
                  id="session-date"
                  type="date"
                  className="form-input"
                  value={sessionDate}
                  onChange={(e) => setSessionDate(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="session-notes">Session Notes / Reflection</label>
                <textarea
                  id="session-notes"
                  className="form-textarea"
                  rows={2}
                  value={sessionNotes}
                  onChange={(e) => setSessionNotes(e.target.value)}
                  placeholder="e.g. Mastered B-trees and indexing mechanisms; took practice questions."
                />
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowSessionModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Saving...' : 'Save Session'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ADAPT SCHEDULE MODAL */}
      {showAdaptModal && currentPlan && (
        <div className="modal-backdrop" onClick={() => setShowAdaptModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Adapt Study Schedule</h3>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowAdaptModal(false)}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAdaptPlan} className="modal-form">
              <div className="form-group">
                <label htmlFor="adapt-reason">Reason</label>
                <input
                  id="adapt-reason"
                  type="text"
                  className="form-input"
                  value={adaptReason}
                  onChange={(e) => setAdaptReason(e.target.value)}
                  placeholder="e.g. Missed session; need catch-up"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="adapt-hours">New Daily Hours (Optional)</label>
                <input
                  id="adapt-hours"
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="12"
                  className="form-input"
                  value={adaptNewHours}
                  onChange={(e) => setAdaptNewHours(e.target.value)}
                  placeholder={`Current: ${currentPlan.dailyStudyHours} hrs/day`}
                />
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowAdaptModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Adapting...' : 'Adapt Schedule'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Plan Confirmation Dialog */}
      {planToDelete && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-plan-dialog-title">
          <div className="confirm-modal-card">
            <div className="modal-header-row">
              <span className="modal-danger-icon" aria-hidden="true">🗑</span>
              <h3 id="delete-plan-dialog-title">Delete Study Plan</h3>
            </div>
            <p className="modal-confirm-text">
              Are you sure you want to delete study plan <strong>"{planToDelete.planId}"</strong>?
            </p>
            <p className="modal-confirm-subtext">
              Subjects: {Array.isArray(planToDelete.subjects) ? planToDelete.subjects.join(', ') : Object.keys(planToDelete.subjects || {}).join(', ') || 'General Study'}
            </p>
            <div className="modal-actions-cluster">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setPlanToDelete(null)}
                disabled={deletingPlan}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger-confirm"
                onClick={handleDeletePlan}
                disabled={deletingPlan}
              >
                {deletingPlan ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
