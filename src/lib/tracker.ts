import type { DueBucket } from './types'

// Due dates are stored as plain `date` values, so everything here works on
// YYYY-MM-DD strings. Parsing them into Date objects and comparing instants
// shifts them by the viewer's UTC offset, which is how a task due today starts
// showing as overdue for anyone west of Greenwich.

/** Today as a local YYYY-MM-DD — local, because "overdue" means overdue where the user is. */
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** The coming Sunday, inclusive. On a Sunday that's today. */
export function endOfWeek(today: string): string {
  const [y, m, d] = today.split('-').map(Number)
  // UTC arithmetic on a date-only value: no offset to shift it.
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + ((7 - dt.getUTCDay()) % 7))
  return dt.toISOString().slice(0, 10)
}

export function bucketFor(dueDate: string | null, today: string = todayISO()): DueBucket {
  if (!dueDate) return 'no_date'
  if (dueDate < today) return 'overdue'
  if (dueDate === today) return 'today'
  return dueDate <= endOfWeek(today) ? 'this_week' : 'later'
}

/** Whole days between two plain dates. Negative when `date` is in the past. */
export function daysUntil(date: string, today: string = todayISO()): number {
  const [ay, am, ad] = today.split('-').map(Number)
  const [by, bm, bd] = date.split('-').map(Number)
  const a = Date.UTC(ay, am - 1, ad)
  const b = Date.UTC(by, bm - 1, bd)
  return Math.round((b - a) / 86400000)
}

export function describeDue(dueDate: string | null, today: string = todayISO()): string {
  if (!dueDate) return 'No due date'
  const days = daysUntil(dueDate, today)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return '1 day overdue'
  if (days < 0) return `${-days} days overdue`
  return `In ${days} days`
}

/**
 * Group by due bucket, each bucket sorted soonest-first with undated last.
 * Buckets are always present (possibly empty) so callers can render in a fixed
 * order without existence checks.
 */
export function groupByDue<T extends { due_date: string | null }>(
  items: T[],
  today: string = todayISO(),
): Record<DueBucket, T[]> {
  const groups: Record<DueBucket, T[]> = {
    overdue: [], today: [], this_week: [], later: [], no_date: [],
  }
  for (const item of items) groups[bucketFor(item.due_date, today)].push(item)
  for (const bucket of Object.values(groups)) {
    bucket.sort((a, b) => (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31'))
  }
  return groups
}

/** Completed on or after the start of the current week (Monday). */
export function completedThisWeek<T extends { completed_at: string | null }>(
  items: T[],
  today: string = todayISO(),
): T[] {
  const [y, m, d] = today.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  // getUTCDay: 0 = Sunday, so Sunday counts back six days to the prior Monday.
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7))
  const monday = dt.toISOString().slice(0, 10)
  return items.filter(i => i.completed_at && i.completed_at.slice(0, 10) >= monday)
}

/** Monday of the week containing `today`. */
export function startOfWeek(today: string): string {
  const [y, m, d] = today.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  // getUTCDay is 0 on Sunday, so Sunday counts back six days rather than forward.
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7))
  return dt.toISOString().slice(0, 10)
}

export type DoneBucket = 'week' | 'month' | 'year' | 'older'

export const DONE_BUCKET_LABEL: Record<DoneBucket, string> = {
  week: 'Done this week',
  month: 'Earlier this month',
  year: 'Earlier this year',
  older: 'Older',
}

export const DONE_BUCKET_ORDER: DoneBucket[] = ['week', 'month', 'year', 'older']

/**
 * Groups completed work into ranges, newest first within each.
 *
 * Mutually exclusive rather than cumulative: "this month" means the part of the
 * month that isn't already under "this week", so a total across the sections is a
 * real total and nothing is counted twice.
 *
 * Anything with no completed_at lands in `older` rather than being dropped — those
 * are rows closed before completed_at existed, and losing them from the history
 * would look like work that never happened.
 */
export function completedBuckets<T extends { completed_at?: string | null }>(
  items: T[],
  today: string = todayISO(),
): Record<DoneBucket, T[]> {
  const weekStart = startOfWeek(today)
  const monthStart = `${today.slice(0, 7)}-01`
  const yearStart = `${today.slice(0, 4)}-01-01`

  const groups: Record<DoneBucket, T[]> = { week: [], month: [], year: [], older: [] }

  for (const item of items) {
    const on = item.completed_at ? item.completed_at.slice(0, 10) : null
    if (!on) groups.older.push(item)
    else if (on >= weekStart) groups.week.push(item)
    else if (on >= monthStart) groups.month.push(item)
    else if (on >= yearStart) groups.year.push(item)
    else groups.older.push(item)
  }

  for (const bucket of Object.values(groups)) {
    bucket.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
  }
  return groups
}
