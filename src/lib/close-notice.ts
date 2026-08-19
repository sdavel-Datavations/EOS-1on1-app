import { punctualityOf, type Punctuality } from './metrics'

/**
 * Telling the assigner their task got closed.
 *
 * Kept apart from the sending so the rules are testable without Slack: who is
 * told, who is deliberately not, and how the result reads.
 */

export type CloseNoticeTask = {
  status: string
  creator_id: string | null
  due_date: string | null
  completed_at?: string | null
}

export type CloseNoticeDecision =
  | { notify: true; creatorId: string }
  | { notify: false; reason: string }

/**
 * Whether this close is worth a DM.
 *
 * The self-close skip is the important one. Most tasks in this app are written by
 * the person doing them, so without it the common case is the app telling you
 * what you just did.
 */
export function closeNoticeDecision(task: CloseNoticeTask, actorId: string): CloseNoticeDecision {
  if (task.status !== 'done') return { notify: false, reason: 'the task is not done' }
  if (!task.creator_id) return { notify: false, reason: 'no assigner is recorded on the task' }
  if (task.creator_id === actorId) return { notify: false, reason: 'the assigner closed it themselves' }
  return { notify: true, creatorId: task.creator_id }
}

/**
 * How the closing reads: "closed on time", "closed late", or nothing.
 *
 * Deliberately the same judgement as /metrics — `punctualityOf` decides both, so
 * a DM can never disagree with the dashboard about whether work was late. An
 * undated task says nothing rather than guessing, for the same reason the rate
 * leaves undated work out.
 */
export function punctualityLabel(task: CloseNoticeTask): string | null {
  const verdict: Punctuality | null = punctualityOf(task)
  if (verdict === 'on_time') return 'closed on time'
  if (verdict === 'late') return 'closed late'
  return null
}
