import { test, expect } from '@playwright/test'
import { partitionOpenWork, rollUpSubtasks, byDueDate, isOverdue, countRows, sourceLabel } from '../src/lib/open-work'
import type { TrackedCommitment } from '../src/lib/types'

const TODAY = '2026-08-19'
const THIS_MEETING = 'meeting-now'

function task(over: Partial<TrackedCommitment> & { id: string }): TrackedCommitment {
  return {
    meeting_id: null,
    creator_id: 'creator',
    assignee_id: 'assignee',
    title: over.id,
    description: '',
    due_date: null,
    status: 'open',
    notify_email: true,
    notify_slack: true,
    notified: false,
    completed_at: null,
    created_at: '2026-08-01T00:00:00Z',
    meeting: null,
    ...over,
  }
}

test.describe('partitionOpenWork', () => {
  test('splits carried commitments from mid-week tasks', () => {
    const work = partitionOpenWork([
      task({ id: 'midweek' }),
      task({ id: 'carried', meeting_id: 'meeting-past', meeting: { meeting_date: '2026-08-12' } }),
    ], THIS_MEETING, TODAY)

    expect(work.midweek.map(i => i.id)).toEqual(['midweek'])
    expect(work.carried.map(i => i.id)).toEqual(['carried'])
    expect(work.count).toBe(2)
  })

  test('leaves out this meeting’s own commitments', () => {
    // They already have their own section on the page. Listing a commitment twice
    // reads as two separate obligations, and closing one leaves the other ticking.
    const work = partitionOpenWork([
      task({ id: 'here', meeting_id: THIS_MEETING }),
      task({ id: 'elsewhere', meeting_id: 'meeting-past' }),
    ], THIS_MEETING, TODAY)

    expect(work.count).toBe(1)
    expect(work.carried.map(i => i.id)).toEqual(['elsewhere'])
  })

  test('leaves out anything already done', () => {
    const work = partitionOpenWork([
      task({ id: 'done', status: 'done', completed_at: '2026-08-18T10:00:00Z' }),
      task({ id: 'open' }),
    ], THIS_MEETING, TODAY)

    expect(work.count).toBe(1)
    expect(work.midweek.map(i => i.id)).toEqual(['open'])
  })

  test('counts what is past its due date', () => {
    const work = partitionOpenWork([
      task({ id: 'late', due_date: '2026-08-18' }),
      task({ id: 'today', due_date: TODAY }),
      task({ id: 'soon', due_date: '2026-08-30' }),
      task({ id: 'undated' }),
    ], THIS_MEETING, TODAY)

    expect(work.overdue).toBe(1)
    expect(work.count).toBe(4)
  })

  test('an empty set produces every group, so the caller needs no existence checks', () => {
    const work = partitionOpenWork([], THIS_MEETING, TODAY)
    expect(work).toEqual({ carried: [], midweek: [], count: 0, overdue: 0 })
  })

  test('count includes nested subtasks, so the header is a real total', () => {
    const work = partitionOpenWork([
      task({ id: 'parent' }),
      task({ id: 'child', parent_id: 'parent' }),
    ], THIS_MEETING, TODAY)

    expect(work.midweek).toHaveLength(1)
    expect(work.count).toBe(2)
    expect(countRows(work.midweek)).toBe(2)
  })
})

test.describe('isOverdue', () => {
  test('is strictly before today, so a task due today is not yet missed', () => {
    expect(isOverdue({ due_date: '2026-08-18' }, TODAY)).toBe(true)
    expect(isOverdue({ due_date: TODAY }, TODAY)).toBe(false)
    expect(isOverdue({ due_date: '2026-08-20' }, TODAY)).toBe(false)
  })

  test('an undated task is never overdue', () => {
    expect(isOverdue({ due_date: null }, TODAY)).toBe(false)
  })

  test('compares as plain strings, so the answer does not move with the timezone', () => {
    expect(isOverdue({ due_date: '2026-01-01' }, '2026-01-01')).toBe(false)
    expect(isOverdue({ due_date: '2025-12-31' }, '2026-01-01')).toBe(true)
  })
})

test.describe('rollUpSubtasks', () => {
  test('nests a subtask under its parent instead of listing it alongside', () => {
    const rows = rollUpSubtasks([
      task({ id: 'parent' }),
      task({ id: 'a', parent_id: 'parent' }),
      task({ id: 'b', parent_id: 'parent' }),
    ])
    expect(rows.map(r => r.id)).toEqual(['parent'])
    expect(rows[0].children?.map(c => c.id)).toEqual(['a', 'b'])
  })

  test('an orphaned subtask stands on its own rather than vanishing', () => {
    // Its parent is closed, or invisible under RLS. Either way someone still owes
    // the work, so dropping it would hide a real obligation.
    const rows = rollUpSubtasks([task({ id: 'orphan', parent_id: 'parent-not-here' })])
    expect(rows.map(r => r.id)).toEqual(['orphan'])
    expect(rows[0].children).toBeUndefined()
  })

  test('a row claiming itself as its parent is not swallowed', () => {
    const rows = rollUpSubtasks([task({ id: 'loop', parent_id: 'loop' })])
    expect(rows.map(r => r.id)).toEqual(['loop'])
  })

  test('nothing is lost or duplicated', () => {
    const input = [
      task({ id: 'p1' }),
      task({ id: 'c1', parent_id: 'p1' }),
      task({ id: 'p2' }),
      task({ id: 'orphan', parent_id: 'gone' }),
    ]
    const rows = rollUpSubtasks(input)
    const ids = rows.flatMap(r => [r.id, ...(r.children || []).map(c => c.id)])
    expect(ids.sort()).toEqual(['c1', 'orphan', 'p1', 'p2'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('subtasks sort soonest first, like their parents', () => {
    const rows = rollUpSubtasks([
      task({ id: 'parent' }),
      task({ id: 'later', parent_id: 'parent', due_date: '2026-09-01' }),
      task({ id: 'sooner', parent_id: 'parent', due_date: '2026-08-20' }),
    ])
    expect(rows[0].children?.map(c => c.id)).toEqual(['sooner', 'later'])
  })

  test('does not mutate what it was given', () => {
    const input = [task({ id: 'parent' }), task({ id: 'child', parent_id: 'parent' })]
    rollUpSubtasks(input)
    expect(input).toHaveLength(2)
    expect((input[0] as { children?: unknown[] }).children).toBeUndefined()
  })
})

test.describe('byDueDate', () => {
  test('soonest first with undated last, so the most overdue leads', () => {
    const sorted = byDueDate([
      { id: 'undated', due_date: null },
      { id: 'sep', due_date: '2026-09-01' },
      { id: 'aug', due_date: '2026-08-02' },
    ])
    expect(sorted.map(i => i.id)).toEqual(['aug', 'sep', 'undated'])
  })
})

test.describe('sourceLabel', () => {
  test('names where a row came from', () => {
    expect(sourceLabel(task({ id: 'x' }))).toBe('Added during the week')
    expect(sourceLabel(task({
      id: 'y', meeting_id: 'm', meeting: { meeting_date: '2026-08-12' },
    }))).toBe('From the 1-on-1 on 2026-08-12')
  })

  test('still says something useful when the meeting date did not come back', () => {
    // The embed can be null when RLS hides the meeting row but the commitment is
    // visible via assignee_id. "From an earlier 1-on-1" beats a blank or "null".
    expect(sourceLabel(task({ id: 'z', meeting_id: 'm', meeting: null })))
      .toBe('From an earlier 1-on-1')
  })
})
