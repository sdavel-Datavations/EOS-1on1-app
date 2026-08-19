import { test, expect } from '@playwright/test'
import {
  punctualityOf, isOverdueTask, ageInDays, statsFor, onTimeRate,
  assignmentFlow, closureChannels, windowStart, addDays, rangeLength, previousRange,
  type MetricTask,
} from '../src/lib/metrics'

const TODAY = '2026-08-19'

function task(over: Partial<MetricTask> & { id: string }): MetricTask {
  return {
    assignee_id: 'ash',
    creator_id: 'sam',
    status: 'open',
    due_date: null,
    completed_at: null,
    completed_via: null,
    created_at: '2026-08-01T09:00:00Z',
    ...over,
  }
}

test.describe('punctualityOf', () => {
  test('finishing on the due date is on time, not late', () => {
    // completed_at is a timestamp and due_date a plain date. Comparing them
    // directly would make 4pm on the due date eight hours late.
    expect(punctualityOf(task({
      id: 'a', status: 'done', due_date: '2026-08-18', completed_at: '2026-08-18T16:00:00Z',
    }))).toBe('on_time')
  })

  test('a day past is late', () => {
    expect(punctualityOf(task({
      id: 'a', status: 'done', due_date: '2026-08-18', completed_at: '2026-08-19T09:00:00Z',
    }))).toBe('late')
  })

  test('no due date is neither', () => {
    // Counting these as on time flatters everyone, and most tasks can be created
    // with no date at all — so it would hollow out the headline number.
    expect(punctualityOf(task({ id: 'a', status: 'done', completed_at: '2026-08-19T09:00:00Z' })))
      .toBe('no_due_date')
  })

  test('an open task has no verdict yet', () => {
    expect(punctualityOf(task({ id: 'a', due_date: '2026-08-01' }))).toBeNull()
  })

  test('closed before completed_at existed cannot be judged', () => {
    expect(punctualityOf(task({ id: 'a', status: 'done', due_date: '2026-08-18' })))
      .toBe('no_due_date')
  })
})

test.describe('isOverdueTask', () => {
  test('only open work can be overdue', () => {
    expect(isOverdueTask(task({ id: 'a', due_date: '2026-08-18' }), TODAY)).toBe(true)
    expect(isOverdueTask(task({ id: 'a', due_date: '2026-08-18', status: 'done' }), TODAY)).toBe(false)
    expect(isOverdueTask(task({ id: 'a', due_date: TODAY }), TODAY)).toBe(false)
    expect(isOverdueTask(task({ id: 'a' }), TODAY)).toBe(false)
  })
})

test.describe('ageInDays', () => {
  test('counts whole days from a timestamp', () => {
    expect(ageInDays('2026-08-01T09:00:00Z', TODAY)).toBe(18)
    expect(ageInDays('2026-08-19T09:00:00Z', TODAY)).toBe(0)
  })

  test('never negative, so a future-dated row cannot read as fresher than new', () => {
    expect(ageInDays('2026-09-01', TODAY)).toBe(0)
  })
})

test.describe('statsFor', () => {
  const tasks: MetricTask[] = [
    task({ id: 'o1', due_date: '2026-08-10' }),                                    // open, overdue
    task({ id: 'o2', due_date: '2026-08-30' }),                                    // open, fine
    task({ id: 'o3' }),                                                            // open, undated
    task({ id: 'd1', status: 'done', due_date: '2026-08-12', completed_at: '2026-08-11T09:00:00Z' }),
    task({ id: 'd2', status: 'done', due_date: '2026-08-12', completed_at: '2026-08-15T09:00:00Z' }),
    task({ id: 'd3', status: 'done', completed_at: '2026-08-15T09:00:00Z' }),
    task({ id: 'other', assignee_id: 'someone-else' }),
    task({ id: 'handed', creator_id: 'ash', assignee_id: 'content-1' }),
  ]

  test('counts only the person’s own work', () => {
    const s = statsFor('ash', tasks, [], { today: TODAY })
    expect(s.open).toBe(3)
    expect(s.overdue).toBe(1)
    expect(s.closed).toBe(3)
    expect(s.onTime).toBe(1)
    expect(s.late).toBe(1)
    expect(s.undated).toBe(1)
    expect(s.openUndated).toBe(1)
  })

  test('oldest open is the age of the longest-standing open item', () => {
    const s = statsFor('ash', tasks, [], { today: TODAY })
    expect(s.oldestOpenDays).toBe(18)
  })

  test('nothing open means no oldest, rather than zero', () => {
    // Zero would read as "something opened today", which is the opposite.
    const s = statsFor('nobody', tasks, [], { today: TODAY })
    expect(s.oldestOpenDays).toBeNull()
    expect(s.open).toBe(0)
  })

  test('the window bounds closed work but never open work', () => {
    // Cutting open work to a window would hide the stale items this exists to find.
    const s = statsFor('ash', tasks, [], { today: TODAY, since: '2026-08-14' })
    expect(s.closed).toBe(2)
    expect(s.open).toBe(3)
  })

  test('work handed to others is counted separately from self-assigned', () => {
    expect(statsFor('ash', tasks, [], { today: TODAY }).assignedOut).toBe(1)
    // sam created everything except 'handed': six for ash plus one for someone-else
    expect(statsFor('sam', tasks, [], { today: TODAY }).assignedOut).toBe(7)
  })

  test('moved deadlines are counted, which is what keeps on-time honest', () => {
    const s = statsFor('ash', tasks, [
      { commitment_id: 'd1', event: 'due_date_changed' },
      { commitment_id: 'd1', event: 'due_date_changed' },
      { commitment_id: 'o1', event: 'reassigned' },
    ], { today: TODAY })
    // Two events on one task is still one task whose deadline moved
    expect(s.deadlinesMoved).toBe(1)
  })
})

test.describe('onTimeRate', () => {
  const base = statsFor('ash', [], [], { today: TODAY })

  test('is null below the minimum, because small numbers lie', () => {
    // One late out of three reads as 33% and swings to 0% next week.
    expect(onTimeRate({ ...base, onTime: 2, late: 1 })).toBeNull()
    expect(onTimeRate({ ...base, onTime: 2, late: 1 }, 3)).toBe(67)
  })

  test('undated work is excluded from the denominator', () => {
    expect(onTimeRate({ ...base, onTime: 4, late: 0, undated: 20 })).toBe(100)
  })

  test('null when there is nothing datable at all', () => {
    expect(onTimeRate({ ...base, onTime: 0, late: 0, undated: 9 })).toBeNull()
  })
})

test.describe('assignmentFlow', () => {
  test('self-assigned work is not a handover', () => {
    const flow = assignmentFlow([
      task({ id: 'a', creator_id: 'sam', assignee_id: 'sam' }),
      task({ id: 'b', creator_id: 'sam', assignee_id: 'ash' }),
      task({ id: 'c', creator_id: 'sam', assignee_id: 'ash' }),
      task({ id: 'd', creator_id: 'ash', assignee_id: 'content-1' }),
    ])
    expect(flow).toEqual([
      { creatorId: 'sam', assigneeId: 'ash', count: 2 },
      { creatorId: 'ash', assigneeId: 'content-1', count: 1 },
    ])
  })

  test('empty in, empty out', () => {
    expect(assignmentFlow([])).toEqual([])
  })
})

test.describe('closureChannels', () => {
  test('groups finished work by how it was closed', () => {
    const channels = closureChannels([
      task({ id: 'a', status: 'done', completed_via: 'slack_button' }),
      task({ id: 'b', status: 'done', completed_via: 'slack_button' }),
      task({ id: 'c', status: 'done', completed_via: 'app' }),
      task({ id: 'd', status: 'done' }),
      task({ id: 'e' }),
    ])
    expect(channels).toEqual([
      { via: 'slack_button', count: 2 },
      { via: 'app', count: 1 },
      { via: 'unrecorded', count: 1 },
    ])
  })
})

test.describe('windowStart', () => {
  test('counts back whole days across a month boundary', () => {
    expect(windowStart(30, TODAY)).toBe('2026-07-20')
    expect(windowStart(7, TODAY)).toBe('2026-08-12')
    expect(windowStart(0, TODAY)).toBe(TODAY)
  })
})

test.describe('date ranges', () => {
  test('addDays crosses month and year ends without drifting', () => {
    expect(addDays('2026-08-19', 1)).toBe('2026-08-20')
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2026-08-19', 0)).toBe('2026-08-19')
  })

  test('rangeLength counts both ends', () => {
    // A single day is a range of one, not zero — otherwise a one-day comparison
    // window would have nothing to compare against.
    expect(rangeLength('2026-08-19', '2026-08-19')).toBe(1)
    expect(rangeLength('2026-08-01', '2026-08-31')).toBe(31)
    expect(rangeLength('2026-07-20', '2026-08-19')).toBe(31)
  })

  test('previousRange is the same length, ending the day before', () => {
    // Same length rather than the previous calendar month, so neither period is
    // flattered simply by being longer.
    expect(previousRange('2026-08-01', '2026-08-31')).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    expect(previousRange('2026-08-19', '2026-08-19')).toEqual({ from: '2026-08-18', to: '2026-08-18' })
    const prev = previousRange('2026-07-20', '2026-08-19')
    expect(rangeLength(prev.from, prev.to)).toBe(31)
    expect(prev.to).toBe('2026-07-19')
  })
})

test.describe('statsFor with a closed window', () => {
  const tasks: MetricTask[] = [
    task({ id: 'in', status: 'done', due_date: '2026-08-10', completed_at: '2026-08-10T09:00:00Z' }),
    task({ id: 'before', status: 'done', due_date: '2026-07-01', completed_at: '2026-07-01T09:00:00Z' }),
    task({ id: 'after', status: 'done', due_date: '2026-08-18', completed_at: '2026-08-18T09:00:00Z' }),
    task({ id: 'open1', due_date: '2026-08-01' }),
  ]

  test('until excludes work closed after the window', () => {
    const s = statsFor('ash', tasks, [], { since: '2026-08-05', until: '2026-08-15', today: TODAY })
    expect(s.closed).toBe(1)
  })

  test('open work ignores the window entirely', () => {
    // Comparing two periods can only compare closed work; "open" is a fact about
    // now, and windowing it would hide the stale items this exists to surface.
    const narrow = statsFor('ash', tasks, [], { since: '2026-08-05', until: '2026-08-15', today: TODAY })
    const wide = statsFor('ash', tasks, [], { since: '2026-01-01', until: '2026-12-31', today: TODAY })
    expect(narrow.open).toBe(1)
    expect(wide.open).toBe(1)
    expect(narrow.overdue).toBe(1)
  })

  test('the two halves of a comparison do not overlap', () => {
    const from = '2026-08-05', to = '2026-08-15'
    const prev = previousRange(from, to)
    const current = statsFor('ash', tasks, [], { since: from, until: to, today: TODAY })
    const before = statsFor('ash', tasks, [], { since: prev.from, until: prev.to, today: TODAY })
    // 'in' falls in the current window; 'before' (1 Jul) is outside both
    expect(current.closed).toBe(1)
    expect(before.closed).toBe(0)
    expect(prev.to < from).toBe(true)
  })
})
