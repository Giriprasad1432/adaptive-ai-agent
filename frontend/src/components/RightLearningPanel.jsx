import { useCallback, useEffect, useState, useMemo } from 'react'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

// Helper to filter out test fixture plan IDs
function isTestPlanId(id) {
  if (!id) return true
  return /^(?:test[_-]|repro[_-]|agent_e2e|adaptive_regress|adapt_preserve|eval[_-]|date-e2e-|success_|mock[_-])/i.test(id)
}

function getSubjectIcon(subjectName = '') {
  const lower = subjectName.toLowerCase()
  if (lower.includes('java') || lower.includes('code') || lower.includes('program') || lower.includes('python')) {
    return { icon: '</>', colorClass: 'icon-code' }
  }
  if (lower.includes('data') || lower.includes('dbms') || lower.includes('sql') || lower.includes('database')) {
    return { icon: '💾', colorClass: 'icon-db' }
  }
  if (lower.includes('web') || lower.includes('react') || lower.includes('html') || lower.includes('network')) {
    return { icon: '🌐', colorClass: 'icon-web' }
  }
  if (lower.includes('math') || lower.includes('logic') || lower.includes('algo')) {
    return { icon: '📐', colorClass: 'icon-math' }
  }
  return { icon: '📚', colorClass: 'icon-general' }
}

export function RightLearningPanel({
  activePlanId,
  onNavigateToView,
  onStartLearning,
  onClose,
}) {
  const [plans, setPlans] = useState([])
  const [activePlan, setActivePlan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [completedTasks, setCompletedTasks] = useState({})
  const [markingTaskId, setMarkingTaskId] = useState(null)

  const loadData = useCallback(async () => {
    try {
      const plansRes = await fetch(`${API_BASE_URL}/api/plans`)
      if (!plansRes.ok) return

      const plansData = await plansRes.json()
      const rawList = plansData.plans || []
      // Filter out automated test fixtures
      const cleanPlans = rawList.filter((p) => !isTestPlanId(p.planId))
      setPlans(cleanPlans)

      // Determine which plan to show in detail
      const selectedId =
        activePlanId && cleanPlans.some((p) => p.planId === activePlanId)
          ? activePlanId
          : cleanPlans.length > 0
          ? cleanPlans[cleanPlans.length - 1].planId
          : null

      if (selectedId) {
        const detailRes = await fetch(
          `${API_BASE_URL}/api/plans/${encodeURIComponent(selectedId)}`
        )
        if (detailRes.ok) {
          const detail = await detailRes.json()
          setActivePlan(detail)
        }
      } else {
        setActivePlan(null)
      }
    } catch {
      // Graceful fallback on network glitch
    } finally {
      setLoading(false)
    }
  }, [activePlanId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Extract aggregated metrics from real active plan or plans list
  const metrics = useMemo(() => {
    if (!activePlan && plans.length === 0) {
      return {
        overallPercentage: 0,
        totalPlans: 0,
        totalSessions: 0,
        totalStudyHours: 0,
      }
    }

    const totalPlans = plans.length
    const sessions = Array.isArray(activePlan?.sessions) ? activePlan.sessions : []
    const totalSessions = sessions.filter((s) => s.status === 'completed').length
    const totalStudyHours =
      activePlan?.totalCompletedHours ??
      sessions.reduce((acc, s) => acc + (s.status === 'completed' ? s.hoursSpent || 0 : 0), 0)

    let overallPercentage = 0
    if (activePlan?.overallProgressPercentage !== undefined) {
      overallPercentage = Math.round(activePlan.overallProgressPercentage)
    } else if (activePlan?.totalAllocatedHours > 0) {
      overallPercentage = Math.round(
        (totalStudyHours / activePlan.totalAllocatedHours) * 100
      )
    }

    return {
      overallPercentage: Math.min(100, Math.max(0, overallPercentage)),
      totalPlans,
      totalSessions,
      totalStudyHours,
    }
  }, [activePlan, plans])

  // Subject breakdown from real active plan
  const subjects = useMemo(() => {
    if (!activePlan?.subjects || typeof activePlan.subjects !== 'object') {
      return []
    }
    return Object.entries(activePlan.subjects).map(([name, data]) => {
      const pct = data.progressPercentage ?? (data.allocatedHours > 0
        ? Math.round((data.completedHours / data.allocatedHours) * 100)
        : 0)
      return {
        name,
        percentage: Math.min(100, Math.max(0, pct)),
        allocatedHours: data.allocatedHours || 0,
        completedHours: data.completedHours || 0,
        ...getSubjectIcon(name),
      }
    })
  }, [activePlan])

  // Upcoming Tasks generated from actual plan curriculum or schedule
  const upcomingTasks = useMemo(() => {
    if (!activePlan) return []

    const tasks = []
    const subjectNames = Object.keys(activePlan.subjects || {})

    // If plan has explicit modules or curriculum
    if (Array.isArray(activePlan.modules) && activePlan.modules.length > 0) {
      activePlan.modules.forEach((mod, idx) => {
        tasks.push({
          id: `mod-${idx}`,
          title: mod.title,
          schedule: idx === 0 ? 'Today' : idx === 1 ? 'Tomorrow' : `Day ${idx + 1}`,
          duration: mod.duration || '2h',
          subject: mod.subject || subjectNames[0] || 'Core',
          badgeColor: idx % 3 === 0 ? 'badge-pink' : idx % 3 === 1 ? 'badge-blue' : 'badge-green',
        })
      })
    } else if (subjectNames.length > 0) {
      // Generate clean scheduled task items from plan subjects
      subjectNames.forEach((subName, idx) => {
        const subData = activePlan.subjects[subName]
        const remaining = subData.remainingHours || 2
        tasks.push({
          id: `task-${subName}-${idx}`,
          title: `${subName} Study & Core Concepts`,
          schedule: idx === 0 ? 'Today' : idx === 1 ? 'Tomorrow' : 'Upcoming',
          duration: `${Math.min(remaining, activePlan.dailyAvailableHours || 2)}h`,
          subject: subName,
          badgeColor: idx % 3 === 0 ? 'badge-pink' : idx % 3 === 1 ? 'badge-blue' : 'badge-green',
        })
      })
    }

    return tasks.slice(0, 4)
  }, [activePlan])

  // Mark task as complete using backend session recording
  const handleToggleTask = async (task) => {
    if (!activePlan || markingTaskId) return
    const isDone = completedTasks[task.id]
    if (isDone) return

    setMarkingTaskId(task.id)
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/plans/${encodeURIComponent(activePlan.planId)}/sessions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject: task.subject,
            hoursSpent: parseInt(task.duration, 10) || 1,
            status: 'completed',
            notes: `Completed task: ${task.title}`,
          }),
        }
      )
      if (res.ok) {
        setCompletedTasks((prev) => ({ ...prev, [task.id]: true }))
        loadData()
      }
    } catch {
      // Ignore network error on quick click
    } finally {
      setMarkingTaskId(null)
    }
  }

  // Radial chart SVG calculations
  const radius = 46
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (metrics.overallPercentage / 100) * circumference

  const hasData = plans.length > 0 && activePlan

  return (
    <aside className="right-learning-panel" aria-label="Learning Progress Dashboard">
      <div className="right-panel-inner">
        {/* Mobile close button */}
        <div className="right-panel-mobile-header">
          <span className="right-panel-title">Learning Dashboard</span>
          <button
            type="button"
            className="right-panel-close-btn"
            onClick={onClose}
            aria-label="Close dashboard panel"
          >
            ✕
          </button>
        </div>

        {/* SECTION 1: Your Learning Progress */}
        <section className="dashboard-card progress-overview-card">
          <div className="card-header-row">
            <h3 className="card-title">Your Learning Progress</h3>
            <button
              type="button"
              className="card-action-link"
              onClick={() => onNavigateToView?.('progress')}
              title="View full progress analytics"
            >
              View Details →
            </button>
          </div>

          <div className="progress-ring-block">
            <div className="ring-visual-wrap">
              <svg className="progress-radial-svg" width="112" height="112" viewBox="0 0 112 112">
                <circle
                  className="radial-bg-track"
                  cx="56"
                  cy="56"
                  r={radius}
                  strokeWidth="9"
                />
                <circle
                  className="radial-progress-bar"
                  cx="56"
                  cy="56"
                  r={radius}
                  strokeWidth="9"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                />
              </svg>
              <div className="ring-center-content">
                <span className="ring-percent-value">{metrics.overallPercentage}%</span>
                <span className="ring-percent-sub">Overall</span>
              </div>
            </div>

            <div className="ring-stats-column">
              <div className="stat-row">
                <span className="stat-icon-wrap icon-purple">📑</span>
                <div className="stat-text-wrap">
                  <strong className="stat-number">{metrics.totalPlans}</strong>
                  <span className="stat-label">Study Plans</span>
                </div>
              </div>

              <div className="stat-row">
                <span className="stat-icon-wrap icon-cyan">🎯</span>
                <div className="stat-text-wrap">
                  <strong className="stat-number">{metrics.totalSessions}</strong>
                  <span className="stat-label">Sessions</span>
                </div>
              </div>

              <div className="stat-row">
                <span className="stat-icon-wrap icon-blue">⏱</span>
                <div className="stat-text-wrap">
                  <strong className="stat-number">{metrics.totalStudyHours}h</strong>
                  <span className="stat-label">Total Study Time</span>
                </div>
              </div>
            </div>
          </div>

          {!hasData && (
            <div className="panel-empty-notice">
              <p className="empty-notice-lead">“Your learning journey starts here.”</p>
              <p className="empty-notice-sub">
                No progress recorded yet. Start a conversation with your AI tutor to set up your plan.
              </p>
              <button
                type="button"
                className="btn-panel-action"
                onClick={onStartLearning}
              >
                <span>✦ Start Learning</span>
              </button>
            </div>
          )}
        </section>

        {/* SECTION 2: Subject Progress */}
        <section className="dashboard-card subject-progress-card">
          <div className="card-header-row">
            <h3 className="card-title">Subject Progress</h3>
            <button
              type="button"
              className="card-action-link"
              onClick={() => onNavigateToView?.('progress')}
              title="View all subjects"
            >
              View All →
            </button>
          </div>

          {subjects.length > 0 ? (
            <div className="subject-bars-list">
              {subjects.map((sub) => (
                <div key={sub.name} className="subject-bar-row">
                  <div className={`subject-icon-box ${sub.colorClass}`} aria-hidden="true">
                    <span>{sub.icon}</span>
                  </div>
                  <div className="subject-bar-main">
                    <div className="subject-name-row">
                      <span className="subject-title">{sub.name}</span>
                      <span className="subject-percent">{sub.percentage}%</span>
                    </div>
                    <div className="progress-track-h">
                      <div
                        className="progress-fill-h"
                        style={{ width: `${sub.percentage}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel-empty-subcard">
              <span className="empty-subcard-icon">📚</span>
              <p className="empty-subcard-text">No subject progress recorded yet.</p>
              <span className="empty-subcard-hint">
                Subjects and mastery metrics appear once your study plan begins.
              </span>
            </div>
          )}
        </section>

        {/* SECTION 3: Current Study Plan */}
        <section className="dashboard-card current-plan-card">
          <div className="card-header-row">
            <h3 className="card-title">Current Study Plan</h3>
            <button
              type="button"
              className="card-action-link"
              onClick={() => onNavigateToView?.('planner')}
              title="View full study plan"
            >
              View Plan →
            </button>
          </div>

          {activePlan ? (
            <div className="plan-summary-pill-card">
              <div className="plan-summary-header">
                <div className="plan-summary-icon-wrap" aria-hidden="true">
                  <span>☕</span>
                </div>
                <div className="plan-summary-details">
                  <h4 className="plan-summary-name">
                    {Object.keys(activePlan.subjects || {}).join(' & ') || 'Active Study Plan'}
                  </h4>
                  <p className="plan-summary-meta">
                    {activePlan.planningMode === 'exam'
                      ? `Exam: ${activePlan.examDate || 'Scheduled'}`
                      : `${activePlan.durationDays || 7} Days • ${activePlan.dailyAvailableHours || 2}h/day`}
                  </p>
                </div>
              </div>
              <div className="plan-summary-bar-row">
                <div className="progress-track-h mini-track">
                  <div
                    className="progress-fill-h"
                    style={{ width: `${metrics.overallPercentage}%` }}
                  />
                </div>
                <span className="plan-summary-pct">{metrics.overallPercentage}%</span>
              </div>
            </div>
          ) : (
            <div className="panel-empty-subcard">
              <span className="empty-subcard-icon">📋</span>
              <p className="empty-subcard-text">“No study plan yet. Let's create one together.”</p>
              <button
                type="button"
                className="btn-panel-action"
                onClick={onStartLearning}
              >
                <span>＋ Create Plan with AI</span>
              </button>
            </div>
          )}
        </section>

        {/* SECTION 4: Upcoming Tasks */}
        <section className="dashboard-card upcoming-tasks-card">
          <div className="card-header-row">
            <h3 className="card-title">Upcoming Tasks</h3>
            <button
              type="button"
              className="card-action-link"
              onClick={() => onNavigateToView?.('planner')}
              title="View all upcoming tasks"
            >
              View All →
            </button>
          </div>

          {upcomingTasks.length > 0 ? (
            <div className="tasks-checklist">
              {upcomingTasks.map((task) => {
                const isChecked = completedTasks[task.id]
                return (
                  <div
                    key={task.id}
                    className={`task-item-row ${isChecked ? 'completed' : ''}`}
                    onClick={() => handleToggleTask(task)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleToggleTask(task)
                      }
                    }}
                    aria-label={`Task: ${task.title}. ${isChecked ? 'Completed' : 'Click to complete'}`}
                  >
                    <div className={`task-badge-dot ${task.badgeColor}`} aria-hidden="true" />
                    <div className="task-content-main">
                      <strong className="task-heading">{task.title}</strong>
                      <span className="task-schedule-meta">
                        {task.schedule} • {task.duration}
                      </span>
                    </div>
                    <div className={`task-checkbox-circle ${isChecked ? 'checked' : ''}`}>
                      {isChecked ? '✓' : ''}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="panel-empty-subcard">
              <span className="empty-subcard-icon">⏳</span>
              <p className="empty-subcard-text">“Your tasks will appear after your study plan is created.”</p>
              <span className="empty-subcard-hint">
                Tasks sync dynamically with your daily study schedule.
              </span>
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
