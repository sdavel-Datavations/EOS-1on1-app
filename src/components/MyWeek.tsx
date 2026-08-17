'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  useMyCommitments,
  useTeammates,
  createStandaloneCommitment,
  setCommitmentStatus,
  describeCommitmentError,
} from '@/lib/hooks'
import { groupByDue, describeDue, completedThisWeek, todayISO } from '@/lib/tracker'
import { BUCKET_ORDER, BUCKET_LABEL } from '@/lib/types'
import type { TrackedCommitment, DueBucket } from '@/lib/types'

const BUCKET_TONE: Record<DueBucket, string> = {
  overdue: 'text-coral-red',
  today: 'text-steel-blue',
  this_week: 'text-gray',
  later: 'text-gray',
  no_date: 'text-gray',
}

export default function MyWeek({ userId, userName }: { userId: string; userName: string }) {
  const { commitments, loading, error, refetch } = useMyCommitments(userId)
  const teammates = useTeammates(userId)

  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [assigneeId, setAssigneeId] = useState(userId)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)

  const today = todayISO()
  const open = commitments.filter(c => c.status === 'open')
  const done = completedThisWeek(commitments.filter(c => c.status === 'done'), today)
  const groups = groupByDue(open, today)

  const nameFor = (id: string) =>
    id === userId ? 'You' : teammates.find(t => t.id === id)?.full_name || 'Someone else'

  const add = async () => {
    if (!title.trim()) return
    setSaving(true)
    setSaveError(null)
    const { error } = await createStandaloneCommitment({
      creator_id: userId,
      assignee_id: assigneeId,
      title: title.trim(),
      due_date: dueDate || null,
    })
    if (error) {
      setSaveError(describeCommitmentError(error))
    } else {
      setTitle('')
      setDueDate('')
      await refetch()
    }
    setSaving(false)
  }

  const toggle = async (c: TrackedCommitment) => {
    setSaveError(null)
    const { error } = await setCommitmentStatus(c.id, c.status === 'done' ? 'open' : 'done')
    if (error) setSaveError(describeCommitmentError(error))
    await refetch()
  }

  const problem = saveError || error

  return (
    <div className="bg-white rounded-xl border border-light-gray p-6 mb-8">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold text-deep-purple mb-1">My Week</h2>
        {open.length > 0 && (
          <span className="text-xs text-gray">
            {open.length} open{groups.overdue.length > 0 && ` · ${groups.overdue.length} overdue`}
          </span>
        )}
      </div>
      <div className="w-14 h-[3px] bg-steel-blue rounded mb-4" />

      {problem && (
        <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-4">{problem}</div>
      )}

      {/* Quick add — a task that came up mid-week belongs to no meeting */}
      <div className="flex gap-2 items-end flex-wrap mb-5">
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Task</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add() }}
            placeholder="Add a task for this week"
            className="border border-light-gray rounded-lg px-3 py-2 text-sm w-full focus:border-steel-blue focus:outline-none"
          />
        </div>
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Due</label>
          <input
            type="date"
            value={dueDate}
            onChange={e => setDueDate(e.target.value)}
            className="border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
          />
        </div>
        {teammates.length > 0 && (
          <div>
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Owner</label>
            <select
              value={assigneeId}
              onChange={e => setAssigneeId(e.target.value)}
              className="border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
            >
              <option value={userId}>{userName || 'Me'}</option>
              {teammates.map(t => (
                <option key={t.id} value={t.id}>{t.full_name || t.email}</option>
              ))}
            </select>
          </div>
        )}
        <button
          onClick={add}
          disabled={saving || !title.trim()}
          className="bg-steel-blue text-white font-semibold px-4 py-2 rounded-lg text-sm hover:bg-[#25698f] transition disabled:opacity-50"
        >
          {saving ? 'Adding...' : 'Add Task'}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray">Loading tasks...</p>
      ) : open.length === 0 ? (
        <p className="text-sm text-gray">
          Nothing open. Tasks you add here and commitments from your 1-on-1s both land in this list.
        </p>
      ) : (
        <div className="space-y-4">
          {BUCKET_ORDER.filter(b => groups[b].length > 0).map(bucket => (
            <div key={bucket}>
              <div className={`text-[11px] font-bold uppercase tracking-wide mb-2 ${BUCKET_TONE[bucket]}`}>
                {BUCKET_LABEL[bucket]} · {groups[bucket].length}
              </div>
              <div className="space-y-2">
                {groups[bucket].map(c => (
                  <Row key={c.id} c={c} today={today} nameFor={nameFor} onToggle={() => toggle(c)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div className="mt-5 pt-4 border-t border-light-gray">
          <button
            onClick={() => setShowDone(!showDone)}
            className="text-xs font-bold uppercase tracking-wide text-gray hover:text-steel-blue transition"
          >
            {showDone ? '▾' : '▸'} Done this week · {done.length}
          </button>
          {showDone && (
            <div className="space-y-2 mt-2">
              {done.map(c => (
                <Row key={c.id} c={c} today={today} nameFor={nameFor} onToggle={() => toggle(c)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({
  c, today, nameFor, onToggle,
}: {
  c: TrackedCommitment
  today: string
  nameFor: (id: string) => string
  onToggle: () => void
}) {
  const isDone = c.status === 'done'
  const overdue = !isDone && c.due_date !== null && c.due_date < today

  return (
    <div className="flex items-center gap-3 p-3 border border-light-gray rounded-lg">
      <button
        onClick={onToggle}
        title={isDone ? 'Mark as open' : 'Mark as done'}
        className={`w-6 h-6 rounded flex items-center justify-center text-xs border-2 flex-shrink-0 transition ${
          isDone ? 'bg-green border-green text-white' : 'border-light-gray text-transparent hover:border-green'
        }`}
      >
        ✓
      </button>
      <div className="flex-1 min-w-0">
        <div className={`font-semibold text-sm ${isDone ? 'line-through text-gray' : 'text-near-black'}`}>
          {c.title}
        </div>
        <div className="text-xs text-gray">
          {nameFor(c.assignee_id)}
          {' · '}
          <span className={overdue ? 'text-coral-red font-semibold' : ''}>
            {isDone ? 'Done' : describeDue(c.due_date, today)}
          </span>
          {c.meeting_id && (
            <>
              {' · '}
              <Link href={`/meeting/${c.meeting_id}`} className="hover:text-steel-blue underline">
                from {c.meeting?.meeting_date || '1-on-1'}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
