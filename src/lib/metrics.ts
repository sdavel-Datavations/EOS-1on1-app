import { todayISO } from './tracker'

/**
 * Accountability metrics.
 *
 * Everything here is a pure function over rows so the arithmetic can be tested
 * without a database, and so the definitions live in one place. A number like
 * "on-time rate" changes how people behave, so what it counts has to be written
 * down rather than implied by a query.
 */

export interface MetricTask {
  id: string
  assignee_id: string
  creator_id: string
  status: string
  due_date: string | null
  completed_at?: string | null
  completed_via?: string | null
  created_at: string
}

export interface MetricEvent {
  commitment_id: string
  event: string
}

export type Punctuality = 'on_time' | 'late' | 'no_due_date'

/**
 * How a finished task landed against its deadline. Null while it is still open.
 *
 * A task with no due date is neither punctual nor late. Counting those as on time
 * flatters everyone and would make the headline number meaningless, since most
 * tasks can be created without a date at all.
 */
export function punctualityOf(task: MetricTask): Punctuality | null {
  if (task.status !== 'done') return null
  if (!task.due_date) return 'no_due_date'
  if (!task.completed_at) return 'no_due_date'
  // Both compared as plain dates. completed_at is a timestamp, so it is cut to its
  // date: finishing at 4pm on the due date is on time, not eight hours late.
  return task.completed_at.slice(0, 10) <= task.due_date ? 'on_time' : 'late'
}

/** Open and already past its date. */
export function isOverdueTask(task: MetricTask, today: string = todayISO()): boolean {
  return task.status !== 'done' && task.due_date !== null && task.due_date < today
}

/** Whole days between two plain dates, never negative. */
export function ageInDays(from: string, today: string = todayISO()): number {
  const [ay, am, ad] = from.slice(0, 10).split('-').map(Number)
  const [by, bm, bd] = today.split('-').map(Number)
  const days = Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
  return days > 0 ? days : 0
}

export interface PersonStats {
  personId: string
  open: number
  overdue: number
  /** Days since the oldest still-open task was created. Null when nothing is open. */
  oldestOpenDays: number | null
  closed: number
  onTime: number
  late: number
  /** Finished, but with no deadline to be judged against. */
  undated: number
  /** Open tasks carrying no due date — work nobody has committed to a date for. */
  openUndated: number
  /** Times a deadline on their work was moved. The integrity check on onTimeRate. */
  deadlinesMoved: number
  assignedOut: number
}

/**
 * One person's numbers.
 *
 * `since` and `until` bound the closed-work figures only. Open work is open
 * regardless of when it was raised, and cutting it to a window would hide exactly
 * the stale items this is meant to surface — which is also why comparing two
 * periods can only ever compare the closed-work half.
 */
export function statsFor(
  personId: string,
  tasks: MetricTask[],
  events: MetricEvent[] = [],
  opts: { since?: string; until?: string; today?: string } = {},
): PersonStats {
  const today = opts.today ?? todayISO()
  const mine = tasks.filter(t => t.assignee_id === personId)
  const open = mine.filter(t => t.status !== 'done')

  const closedInWindow = mine.filter(t => {
    if (t.status !== 'done') return false
    if (!opts.since && !opts.until) return true
    // A task closed before completed_at existed has no date to place it, so it
    // stays out of a windowed count rather than being credited to this period.
    if (!t.completed_at) return false
    const on = t.completed_at.slice(0, 10)
    if (opts.since && on < opts.since) return false
    if (opts.until && on > opts.until) return false
    return true
  })

  const punctuality = closedInWindow.map(punctualityOf)
  const movedIds = new Set(
    events.filter(e => e.event === 'due_date_changed').map(e => e.commitment_id),
  )

  const oldest = open.reduce<number | null>((worst, t) => {
    const age = ageInDays(t.created_at, today)
    return worst === null || age > worst ? age : worst
  }, null)

  return {
    personId,
    open: open.length,
    overdue: open.filter(t => isOverdueTask(t, today)).length,
    oldestOpenDays: oldest,
    closed: closedInWindow.length,
    onTime: punctuality.filter(p => p === 'on_time').length,
    late: punctuality.filter(p => p === 'late').length,
    undated: punctuality.filter(p => p === 'no_due_date').length,
    openUndated: open.filter(t => !t.due_date).length,
    deadlinesMoved: mine.filter(t => movedIds.has(t.id)).length,
    // Work they handed to somebody else. Self-assigned tasks are not assignments.
    assignedOut: tasks.filter(t => t.creator_id === personId && t.assignee_id !== personId).length,
  }
}

/**
 * On-time share of the work that could be judged, as a percentage.
 *
 * Null rather than zero when there is nothing datable to measure, and null below
 * `minimum`: with three closed tasks, one late reads as 33% and swings to 0% next
 * week. A number that moves that much on one task misleads more than a blank.
 */
export function onTimeRate(stats: PersonStats, minimum = 4): number | null {
  const judged = stats.onTime + stats.late
  if (judged < minimum) return null
  return Math.round((stats.onTime / judged) * 100)
}

export interface FlowEdge {
  creatorId: string
  assigneeId: string
  count: number
}

/**
 * Who creates work for whom, busiest first.
 *
 * Self-assigned tasks are excluded: they say something about a person's own load,
 * not about work flowing between people, and they would swamp everything else.
 */
export function assignmentFlow(tasks: MetricTask[]): FlowEdge[] {
  const counts = new Map<string, FlowEdge>()
  for (const t of tasks) {
    if (t.creator_id === t.assignee_id) continue
    const key = `${t.creator_id}>${t.assignee_id}`
    const edge = counts.get(key) || { creatorId: t.creator_id, assigneeId: t.assignee_id, count: 0 }
    edge.count += 1
    counts.set(key, edge)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

/** How finished work got closed — tells you whether Slack is earning its keep. */
export function closureChannels(tasks: MetricTask[]): { via: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const t of tasks) {
    if (t.status !== 'done') continue
    const via = t.completed_via || 'unrecorded'
    counts.set(via, (counts.get(via) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([via, count]) => ({ via, count }))
    .sort((a, b) => b.count - a.count)
}

/** Shifts a plain date by whole days. UTC arithmetic, so no offset can move it. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

/** `since` for a rolling window of whole days, as a plain date. */
export function windowStart(days: number, today: string = todayISO()): string {
  return addDays(today, -days)
}

/** Days covered by a range, counting both ends. */
export function rangeLength(from: string, to: string): number {
  const [ay, am, ad] = from.split('-').map(Number)
  const [by, bm, bd] = to.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000) + 1
}

/**
 * The equal-length window ending the day before `from`.
 *
 * Same length rather than same calendar month, so a comparison is never flattered
 * or punished by one period simply being longer than the other.
 */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const length = rangeLength(from, to)
  const prevTo = addDays(from, -1)
  return { from: addDays(prevTo, -(length - 1)), to: prevTo }
}
