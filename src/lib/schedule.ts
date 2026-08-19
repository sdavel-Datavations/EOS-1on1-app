import { todayISO, startOfWeek } from './tracker'
import { addDays } from './metrics'

/**
 * Recurring 1-on-1s, and working out which weeks got skipped.
 *
 * Nothing here creates a meeting. A scheduled row that stood in for a meeting
 * would look identical to one that happened, so the schedule would hide exactly
 * the gaps it exists to show. Expected dates are computed; whether each one was
 * held is answered by looking for a real meeting.
 */

export type Cadence = 'weekly' | 'fortnightly'

export interface Schedule {
  id: string
  manager_id: string
  report_id: string
  cadence: Cadence
  /** 0 = Sunday, matching getUTCDay(). */
  weekday: number
  active: boolean
  /** When the schedule was set. Weeks before it are not misses. */
  created_at?: string | null
}

export interface ScheduledMeeting {
  meeting_date: string
  manager_id: string
  report_id: string | null
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: 'Every week',
  fortnightly: 'Every other week',
}

/** The date of `weekday` within the Monday-based week containing `date`. */
export function weekdayInWeekOf(date: string, weekday: number): string {
  const monday = startOfWeek(date)
  // Monday is 1 in getUTCDay terms; Sunday (0) is the last day of a Monday-based
  // week, so it lands six days on rather than six days back.
  const offset = weekday === 0 ? 6 : weekday - 1
  return addDays(monday, offset)
}

/**
 * Every date the 1-on-1 was expected between `from` and `to`, inclusive.
 *
 * Fortnightly counts from the first expected date inside the range rather than
 * from an anchor on the schedule: without a recorded start date, any anchor would
 * be invented, and the alternate-week pattern is what matters, not its phase.
 */
export function expectedDates(schedule: Schedule, from: string, to: string): string[] {
  if (!schedule.active) return []
  const step = schedule.cadence === 'fortnightly' ? 14 : 7
  const dates: string[] = []

  let cursor = weekdayInWeekOf(from, schedule.weekday)
  // The occurrence in the first week can fall before the range starts.
  while (cursor < from) cursor = addDays(cursor, 7)

  // Bounded by the range, but guarded anyway: a caller passing a decade would
  // otherwise build a list nobody wants.
  while (cursor <= to && dates.length < 520) {
    dates.push(cursor)
    cursor = addDays(cursor, step)
  }
  return dates
}

export interface Adherence {
  expected: string[]
  /** Expected dates with a meeting in the same week. */
  held: string[]
  /** Expected dates with no meeting that week, excluding any still in the future. */
  missed: string[]
}

/**
 * Which expected 1-on-1s happened.
 *
 * Matched by week rather than by exact date: a Wednesday slot moved to Thursday is
 * the same 1-on-1, and marking it missed would make the figure a measure of
 * punctuality rather than of whether people are actually meeting.
 *
 * An expectation on or after `today` is neither held nor missed. Today's 1-on-1 may
 * still be this afternoon, and marking it missed at breakfast would make the
 * current week always look bad.
 */
export function adherence(
  schedule: Schedule,
  meetings: ScheduledMeeting[],
  from: string,
  to: string,
  today: string = todayISO(),
): Adherence {
  // Never blame a schedule for weeks that predate it. A cadence set today would
  // otherwise open with "missed 8 of the last 8", which is both untrue and the
  // fastest way to get the whole panel ignored.
  const began = schedule.created_at ? schedule.created_at.slice(0, 10) : from
  const start = began > from ? began : from
  const expected = expectedDates(schedule, start, to)

  const weeksMet = new Set(
    meetings
      .filter(m => m.manager_id === schedule.manager_id && m.report_id === schedule.report_id)
      .map(m => startOfWeek(m.meeting_date)),
  )

  const held: string[] = []
  const missed: string[] = []
  for (const date of expected) {
    if (weeksMet.has(startOfWeek(date))) held.push(date)
    else if (date < today) missed.push(date)
  }

  return { expected, held, missed }
}

/** The next expected date on or after `today`, or null if the schedule is off. */
export function nextOccurrence(schedule: Schedule, today: string = todayISO()): string | null {
  if (!schedule.active) return null
  const horizon = addDays(today, schedule.cadence === 'fortnightly' ? 21 : 14)
  return expectedDates(schedule, today, horizon)[0] ?? null
}

/** 'Wednesday 26 Aug' — enough to act on without being a full date. */
export function describeDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return `${WEEKDAYS[dt.getUTCDay()]} ${d} ${dt.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

/**
 * How a run of missed weeks should read.
 *
 * One miss is an ordinary week. Three in a row is the cadence having quietly
 * stopped, and it is worth saying so in those terms rather than as a count.
 */
export function describeMissed(missed: string[]): string | null {
  if (missed.length === 0) return null
  if (missed.length === 1) return `Missed the week of ${describeDate(missed[0])}`
  return `Missed ${missed.length} of these — most recently the week of ${describeDate(missed[missed.length - 1])}`
}
