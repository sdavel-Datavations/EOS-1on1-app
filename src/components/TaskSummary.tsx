'use client'

import Link from 'next/link'
import { useMyCommitments } from '@/lib/hooks'
import { groupByDue, todayISO } from '@/lib/tracker'

/**
 * Compact task count for the dashboard, linking to the full board.
 *
 * The board itself lives at /tasks rather than here: the dashboard is about
 * meetings, and having the whole task manager on it made both harder to scan.
 */
export default function TaskSummary({ userId }: { userId: string }) {
  const { commitments, loading } = useMyCommitments(userId)

  const today = todayISO()
  const open = commitments.filter(c => c.status === 'open')
  const groups = groupByDue(open, today)
  const dueNow = groups.overdue.length + groups.today.length

  return (
    <Link
      href="/tasks"
      className="block bg-white rounded-xl border border-light-gray p-5 mb-8 hover:border-steel-blue transition"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-deep-purple mb-1">Tasks</h2>
          <div className="w-14 h-[3px] bg-steel-blue rounded mb-2" />
          <p className="text-sm text-gray">
            {loading
              ? 'Loading...'
              : open.length === 0
                ? 'Nothing open. Add a task or two.'
                : `${open.length} open${dueNow > 0 ? ` · ${dueNow} needing attention today` : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {!loading && groups.overdue.length > 0 && (
            <span className="bg-red-light text-coral-red text-xs font-bold px-2.5 py-1 rounded-full">
              {groups.overdue.length} overdue
            </span>
          )}
          <span className="text-steel-blue font-semibold text-sm">View →</span>
        </div>
      </div>
    </Link>
  )
}
