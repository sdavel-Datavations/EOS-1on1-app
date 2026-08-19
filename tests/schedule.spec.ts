import { test, expect } from '@playwright/test'
import {
  weekdayInWeekOf, expectedDates, adherence, nextOccurrence, describeDate, describeMissed,
  type Schedule, type ScheduledMeeting,
} from '../src/lib/schedule'

// 2026-08-17 is a Monday, so that week runs Mon 17 → Sun 23.
const WEDNESDAY = 3
const TODAY = '2026-08-19' // itself a Wednesday

const weekly: Schedule = {
  id: 's1', manager_id: 'sam', report_id: 'ash',
  cadence: 'weekly', weekday: WEDNESDAY, active: true,
}

test.describe('weekdayInWeekOf', () => {
  test('finds the weekday inside the Monday-based week', () => {
    expect(weekdayInWeekOf('2026-08-19', 3)).toBe('2026-08-19') // Wed of that week
    expect(weekdayInWeekOf('2026-08-17', 3)).toBe('2026-08-19')
    expect(weekdayInWeekOf('2026-08-23', 3)).toBe('2026-08-19') // from the Sunday
    expect(weekdayInWeekOf('2026-08-19', 1)).toBe('2026-08-17') // Monday
  })

  test('Sunday is the end of the week, not the start', () => {
    // getUTCDay puts Sunday at 0, so a naive offset would send it six days back
    // into the previous week.
    expect(weekdayInWeekOf('2026-08-19', 0)).toBe('2026-08-23')
  })
})

test.describe('expectedDates', () => {
  test('one occurrence per week, on the chosen day', () => {
    expect(expectedDates(weekly, '2026-08-01', '2026-08-31')).toEqual([
      '2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26',
    ])
  })

  test('an occurrence before the range start is skipped, not included', () => {
    // The Wednesday of the week containing 6 Aug is the 5th, which is outside.
    expect(expectedDates(weekly, '2026-08-06', '2026-08-20')).toEqual(['2026-08-12', '2026-08-19'])
  })

  test('fortnightly lands on alternate weeks', () => {
    const fortnightly: Schedule = { ...weekly, cadence: 'fortnightly' }
    expect(expectedDates(fortnightly, '2026-08-01', '2026-09-30')).toEqual([
      '2026-08-05', '2026-08-19', '2026-09-02', '2026-09-16', '2026-09-30',
    ])
  })

  test('an inactive schedule expects nothing', () => {
    expect(expectedDates({ ...weekly, active: false }, '2026-08-01', '2026-08-31')).toEqual([])
  })

  test('a range shorter than the cadence can be empty', () => {
    expect(expectedDates(weekly, '2026-08-20', '2026-08-22')).toEqual([])
  })
})

test.describe('adherence', () => {
  const meetings: ScheduledMeeting[] = [
    { meeting_date: '2026-08-05', manager_id: 'sam', report_id: 'ash' },
    // moved from Wednesday the 12th to Thursday the 13th
    { meeting_date: '2026-08-13', manager_id: 'sam', report_id: 'ash' },
    // week of the 19th: none
    { meeting_date: '2026-08-19', manager_id: 'sam', report_id: 'someone-else' },
  ]

  test('a meeting moved within the week still counts as held', () => {
    // Otherwise the figure measures punctuality rather than whether people met.
    const a = adherence(weekly, meetings, '2026-08-01', '2026-08-31', TODAY)
    expect(a.held).toEqual(['2026-08-05', '2026-08-12'])
  })

  test('a week with no meeting is missed', () => {
    const a = adherence(weekly, meetings, '2026-08-01', '2026-08-12', TODAY)
    expect(a.missed).toEqual([])
    const later = adherence(weekly, meetings, '2026-08-01', '2026-08-31', '2026-08-31')
    expect(later.missed).toEqual(['2026-08-19', '2026-08-26'])
  })

  test('today’s 1-on-1 is not missed yet — the day is not over', () => {
    // TODAY is itself the Wednesday slot and no meeting exists for it. Calling that
    // missed at breakfast would make the current week always look bad.
    const a = adherence(weekly, meetings, '2026-08-01', '2026-08-31', TODAY)
    expect(a.expected).toHaveLength(4)
    expect(a.held).toHaveLength(2)
    expect(a.missed).toEqual([])
  })

  test('the same slot is missed once the day has passed', () => {
    const a = adherence(weekly, meetings, '2026-08-01', '2026-08-31', '2026-08-20')
    expect(a.missed).toEqual(['2026-08-19'])
  })

  test('somebody else’s 1-on-1 does not count as yours', () => {
    const a = adherence(weekly, meetings, '2026-08-17', '2026-08-23', '2026-08-23')
    expect(a.held).toEqual([])
    expect(a.missed).toEqual(['2026-08-19'])
  })

  test('every expectation is held, missed, or still to come', () => {
    const a = adherence(weekly, meetings, '2026-08-01', '2026-08-31', TODAY)
    // Pending includes today, since today is not yet missed
    const future = a.expected.filter(d => d >= TODAY)
    expect(a.held.length + a.missed.length + future.length).toBe(a.expected.length)
  })
})

test.describe('nextOccurrence', () => {
  test('today counts as next when it is the day', () => {
    expect(nextOccurrence(weekly, TODAY)).toBe('2026-08-19')
  })

  test('otherwise it is the coming one', () => {
    expect(nextOccurrence(weekly, '2026-08-20')).toBe('2026-08-26')
  })

  test('an inactive schedule has no next', () => {
    expect(nextOccurrence({ ...weekly, active: false }, TODAY)).toBeNull()
  })
})

test.describe('wording', () => {
  test('describeDate names the day, since that is what people act on', () => {
    expect(describeDate('2026-08-26')).toBe('Wednesday 26 Aug')
    expect(describeDate('2026-08-23')).toBe('Sunday 23 Aug')
  })

  test('one miss reads as a week, several read as the cadence stopping', () => {
    expect(describeMissed([])).toBeNull()
    expect(describeMissed(['2026-08-19'])).toBe('Missed the week of Wednesday 19 Aug')
    expect(describeMissed(['2026-08-12', '2026-08-19'])).toContain('Missed 2 of these')
    expect(describeMissed(['2026-08-12', '2026-08-19'])).toContain('Wednesday 19 Aug')
  })
})

test.describe('a schedule is not blamed for weeks before it existed', () => {
  const meetings: ScheduledMeeting[] = []

  test('weeks before created_at are not expected at all', () => {
    // A cadence set today would otherwise open with "missed 8 of the last 8",
    // which is untrue and the fastest way to get the panel ignored.
    const fresh: Schedule = { ...weekly, created_at: '2026-08-18T09:00:00Z' }
    const a = adherence(fresh, meetings, '2026-06-24', '2026-08-31', '2026-08-31')
    expect(a.expected).toEqual(['2026-08-19', '2026-08-26'])
    expect(a.missed).toEqual(['2026-08-19', '2026-08-26'])
  })

  test('an older schedule still covers the whole window', () => {
    const old: Schedule = { ...weekly, created_at: '2026-01-01T09:00:00Z' }
    const a = adherence(old, meetings, '2026-08-01', '2026-08-31', '2026-08-31')
    expect(a.expected).toHaveLength(4)
    expect(a.missed).toHaveLength(4)
  })

  test('no created_at behaves as before, so older rows are unaffected', () => {
    const a = adherence(weekly, meetings, '2026-08-01', '2026-08-31', '2026-08-31')
    expect(a.expected).toHaveLength(4)
  })

  test('a schedule created today has nothing to answer for yet', () => {
    const today: Schedule = { ...weekly, created_at: '2026-08-19T09:00:00Z' }
    const a = adherence(today, meetings, '2026-06-24', '2026-08-31', '2026-08-19')
    // The 19th is today and not yet missed; everything else is in the future.
    expect(a.missed).toEqual([])
  })
})
