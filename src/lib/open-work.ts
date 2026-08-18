import type { TrackedCommitment } from './types'
import { todayISO } from './tracker'

/**
 * Still-open work pulled onto a meeting's agenda, subtasks nested under their
 * parent.
 */
export type OpenWorkItem = TrackedCommitment & { children?: OpenWorkItem[] }

export interface OpenWork {
  /** Commitments from earlier 1-on-1s that never got closed. */
  carried: OpenWorkItem[]
  /** Tasks raised during the week, belonging to no meeting. */
  midweek: OpenWorkItem[]
  /** Total open rows, counting nested subtasks. */
  count: number
  overdue: number
}

export const EMPTY_OPEN_WORK: OpenWork = { carried: [], midweek: [], count: 0, overdue: 0 }

export function isOverdue(item: { due_date: string | null }, today: string = todayISO()): boolean {
  return item.due_date !== null && item.due_date < today
}

/** Soonest first, undated last — whatever is most overdue leads the conversation. */
export function byDueDate<T extends { due_date: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    (a.due_date || '9999-12-31').localeCompare(b.due_date || '9999-12-31'),
  )
}

/**
 * Nests subtasks under their parent when the parent is open here too.
 *
 * Without this, one main task with eight open subtasks puts nine rows on the
 * agenda and buries everything else — the opposite of what a list you talk
 * through is for. A subtask whose parent is already closed, or invisible under
 * RLS, has nothing to nest under, so it stands on its own rather than being
 * dropped: it is still work someone owes.
 */
export function rollUpSubtasks(items: TrackedCommitment[]): OpenWorkItem[] {
  const byId = new Map(items.map(i => [i.id, i]))
  const children = new Map<string, OpenWorkItem[]>()
  const top: OpenWorkItem[] = []

  for (const item of items) {
    const parentId = item.parent_id
    // parentId === item.id would nest a row inside itself and drop it from the
    // agenda entirely. A trigger prevents it; losing work to a bad row is worse
    // than the cost of checking.
    if (parentId && parentId !== item.id && byId.has(parentId)) {
      children.set(parentId, [...(children.get(parentId) || []), { ...item }])
    } else {
      top.push({ ...item })
    }
  }

  for (const parent of top) {
    const kids = children.get(parent.id)
    if (kids) parent.children = byDueDate(kids)
  }
  return byDueDate(top)
}

/**
 * Everything the people in a meeting still owe, from anywhere but that meeting.
 *
 * Read onto the agenda, never copied on to it — the same rule Rocks follow. A
 * copy forks the task: closing one side leaves the other open, and the person
 * still owes work that one of the two lists now says is finished.
 */
export function partitionOpenWork(
  rows: TrackedCommitment[],
  meetingId: string,
  today: string = todayISO(),
): OpenWork {
  // A commitment raised in THIS meeting already has its own section below.
  // Listing it twice on one page reads as two separate obligations.
  const open = rows.filter(r => r.status === 'open' && r.meeting_id !== meetingId)

  return {
    carried: rollUpSubtasks(open.filter(r => r.meeting_id !== null)),
    midweek: rollUpSubtasks(open.filter(r => r.meeting_id === null)),
    count: open.length,
    overdue: open.filter(r => isOverdue(r, today)).length,
  }
}

/** Where a carried commitment came from, for the line under its title. */
export function sourceLabel(item: TrackedCommitment): string {
  if (!item.meeting_id) return 'Added during the week'
  const date = item.meeting?.meeting_date
  return date ? `From the 1-on-1 on ${date}` : 'From an earlier 1-on-1'
}

/** Rows in a group, counting nested subtasks — a header count you can trust. */
export function countRows(items: OpenWorkItem[]): number {
  return items.reduce((n, i) => n + 1 + (i.children?.length || 0), 0)
}
