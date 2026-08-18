import { test, expect } from '@playwright/test'
import { bucketFor, endOfWeek, daysUntil, describeDue, groupByDue, completedThisWeek, completedBuckets, startOfWeek, todayISO } from '../src/lib/tracker'

// 2026-08-17 is a Monday, so the week runs Mon 17th → Sun 23rd.
const MONDAY = '2026-08-17'

test.describe('endOfWeek', () => {
  test('runs to the coming Sunday', () => {
    expect(endOfWeek(MONDAY)).toBe('2026-08-23')
    expect(endOfWeek('2026-08-19')).toBe('2026-08-23') // Wednesday
    expect(endOfWeek('2026-08-22')).toBe('2026-08-23') // Saturday
  })

  test('on a Sunday the week ends that same day', () => {
    expect(endOfWeek('2026-08-23')).toBe('2026-08-23')
  })

  test('crosses a month boundary', () => {
    expect(endOfWeek('2026-08-31')).toBe('2026-09-06') // Monday the 31st
  })
})

test.describe('bucketFor', () => {
  test('separates overdue, today, this week and later', () => {
    expect(bucketFor('2026-08-16', MONDAY)).toBe('overdue')
    expect(bucketFor('2026-08-17', MONDAY)).toBe('today')
    expect(bucketFor('2026-08-20', MONDAY)).toBe('this_week')
    expect(bucketFor('2026-08-23', MONDAY)).toBe('this_week') // inclusive Sunday
    expect(bucketFor('2026-08-24', MONDAY)).toBe('later')
  })

  test('an undated task is never overdue', () => {
    expect(bucketFor(null, MONDAY)).toBe('no_date')
  })

  test('compares dates as plain strings, not instants', () => {
    // The bug this guards: parsing '2026-08-17' as a Date yields UTC midnight,
    // which is the 16th anywhere west of Greenwich — so a task due today would
    // render as overdue. Nothing here should depend on the machine's timezone.
    expect(bucketFor(MONDAY, MONDAY)).toBe('today')
    expect(bucketFor('2026-01-01', '2026-01-01')).toBe('today')
    expect(bucketFor('2026-12-31', '2026-12-31')).toBe('today')
  })
})

test.describe('daysUntil', () => {
  test('counts forwards and backwards across months', () => {
    expect(daysUntil('2026-08-20', MONDAY)).toBe(3)
    expect(daysUntil('2026-08-14', MONDAY)).toBe(-3)
    expect(daysUntil('2026-09-01', MONDAY)).toBe(15)
  })

  test('is unaffected by a DST transition', () => {
    // US DST ends 2026-11-01. A naive (b - a) / 86400000 would give 7.04 days
    // here and round wrong without the Math.round.
    expect(daysUntil('2026-11-05', '2026-10-29')).toBe(7)
  })
})

test.describe('describeDue', () => {
  test('reads naturally near today', () => {
    expect(describeDue('2026-08-17', MONDAY)).toBe('Today')
    expect(describeDue('2026-08-18', MONDAY)).toBe('Tomorrow')
    expect(describeDue('2026-08-16', MONDAY)).toBe('1 day overdue')
    expect(describeDue('2026-08-14', MONDAY)).toBe('3 days overdue')
    expect(describeDue('2026-08-21', MONDAY)).toBe('In 4 days')
    expect(describeDue(null, MONDAY)).toBe('No due date')
  })
})

test.describe('groupByDue', () => {
  const items = [
    { id: 'later', due_date: '2026-09-01' },
    { id: 'overdue-old', due_date: '2026-08-01' },
    { id: 'undated', due_date: null },
    { id: 'today', due_date: '2026-08-17' },
    { id: 'overdue-recent', due_date: '2026-08-16' },
    { id: 'this-week', due_date: '2026-08-20' },
  ]

  test('files every item into exactly one bucket', () => {
    const g = groupByDue(items, MONDAY)
    expect(g.overdue.map(i => i.id)).toEqual(['overdue-old', 'overdue-recent'])
    expect(g.today.map(i => i.id)).toEqual(['today'])
    expect(g.this_week.map(i => i.id)).toEqual(['this-week'])
    expect(g.later.map(i => i.id)).toEqual(['later'])
    expect(g.no_date.map(i => i.id)).toEqual(['undated'])

    const total = Object.values(g).reduce((n, b) => n + b.length, 0)
    expect(total).toBe(items.length)
  })

  test('sorts each bucket soonest first', () => {
    const g = groupByDue(items, MONDAY)
    expect(g.overdue[0].id).toBe('overdue-old') // the more overdue one leads
  })

  test('always returns all buckets so callers can render a fixed order', () => {
    const g = groupByDue([], MONDAY)
    expect(Object.keys(g).sort()).toEqual(['later', 'no_date', 'overdue', 'this_week', 'today'])
  })
})

test.describe('completedThisWeek', () => {
  test('includes Monday itself and excludes the week before', () => {
    const done = completedThisWeek(
      [
        { id: 'monday', completed_at: '2026-08-17T09:00:00Z' },
        { id: 'last-friday', completed_at: '2026-08-14T09:00:00Z' },
        { id: 'sunday-prior', completed_at: '2026-08-16T23:59:00Z' },
        { id: 'never', completed_at: null },
      ],
      '2026-08-19',
    )
    expect(done.map(i => i.id)).toEqual(['monday'])
  })

  test('counts back to Monday when today is Sunday', () => {
    // getUTCDay() is 0 on Sunday; a naive `- getUTCDay() + 1` would jump forward
    // to the next day instead of back six.
    const done = completedThisWeek(
      [
        { id: 'this-monday', completed_at: '2026-08-17T12:00:00Z' },
        { id: 'prior-sunday', completed_at: '2026-08-16T12:00:00Z' },
      ],
      '2026-08-23',
    )
    expect(done.map(i => i.id)).toEqual(['this-monday'])
  })
})

test.describe('todayISO', () => {
  test('formats the local date, zero padded', () => {
    expect(todayISO(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
    expect(todayISO(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31')
  })
})

test.describe('completedBuckets', () => {
  // 2026-08-19 is a Wednesday; that week starts Monday 2026-08-17.
  const REF = '2026-08-19'
  const items = [
    { id: 'today', completed_at: '2026-08-19T09:00:00Z' },
    { id: 'monday', completed_at: '2026-08-17T09:00:00Z' },
    { id: 'earlier-month', completed_at: '2026-08-04T09:00:00Z' },
    { id: 'month-first', completed_at: '2026-08-01T00:00:00Z' },
    { id: 'earlier-year', completed_at: '2026-03-15T09:00:00Z' },
    { id: 'year-first', completed_at: '2026-01-01T00:00:00Z' },
    { id: 'last-year', completed_at: '2025-12-31T23:00:00Z' },
    { id: 'no-timestamp', completed_at: null },
  ]

  test('files each item into exactly one range', () => {
    const g = completedBuckets(items, REF)
    expect(g.week.map(i => i.id)).toEqual(['today', 'monday'])
    expect(g.month.map(i => i.id)).toEqual(['earlier-month', 'month-first'])
    expect(g.year.map(i => i.id)).toEqual(['earlier-year', 'year-first'])
    // A row closed before completed_at existed is kept, not dropped — losing it
    // would look like work that never happened.
    expect(g.older.map(i => i.id).sort()).toEqual(['last-year', 'no-timestamp'])

    const total = Object.values(g).reduce((n, b) => n + b.length, 0)
    expect(total).toBe(items.length)
  })

  test('ranges do not overlap, so a total across sections is a real total', () => {
    const g = completedBuckets(items, REF)
    const ids = Object.values(g).flat().map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('newest first within each range', () => {
    const g = completedBuckets(items, REF)
    expect(g.week[0].id).toBe('today')
    expect(g.month[0].id).toBe('earlier-month')
  })

  test('boundaries are inclusive at the start of week, month and year', () => {
    expect(completedBuckets([{ completed_at: '2026-08-17T00:00:00Z' }], REF).week).toHaveLength(1)
    expect(completedBuckets([{ completed_at: '2026-08-01T00:00:00Z' }], REF).month).toHaveLength(1)
    expect(completedBuckets([{ completed_at: '2026-01-01T00:00:00Z' }], REF).year).toHaveLength(1)
  })

  test('startOfWeek counts back to Monday, including from a Sunday', () => {
    expect(startOfWeek('2026-08-19')).toBe('2026-08-17') // Wednesday
    expect(startOfWeek('2026-08-17')).toBe('2026-08-17') // Monday itself
    expect(startOfWeek('2026-08-23')).toBe('2026-08-17') // Sunday, back six days
  })
})
