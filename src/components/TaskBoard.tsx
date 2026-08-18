'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  useMyCommitments,
  useTeammates,
  createStandaloneCommitment,
  findProfileByEmail,
  setCommitmentStatus,
  notifyCommitment,
  describeCommitmentError,
} from '@/lib/hooks'
import { groupByDue, describeDue, completedThisWeek, todayISO } from '@/lib/tracker'
import { BUCKET_ORDER, BUCKET_LABEL, COMPLETED_VIA_LABEL } from '@/lib/types'
import type { TrackedCommitment, DueBucket, TaskFilter } from '@/lib/types'

const BUCKET_TONE: Record<DueBucket, string> = {
  overdue: 'text-coral-red',
  today: 'text-steel-blue',
  this_week: 'text-gray',
  later: 'text-gray',
  no_date: 'text-gray',
}

const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'mine', label: 'Mine to do' },
  { key: 'assigned_by_me', label: 'I asked for' },
  { key: 'department', label: 'My department' },
]

export default function TaskBoard({
  userId, userName, department,
}: {
  userId: string
  userName: string
  department?: string | null
}) {
  const { commitments, loading, error, notificationsReady, refetch } = useMyCommitments(userId)
  const teammates = useTeammates(userId)

  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [assigneeId, setAssigneeId] = useState(userId)
  const [assigneeEmail, setAssigneeEmail] = useState('')
  const [notifySlack, setNotifySlack] = useState(true)
  const [notifyEmail, setNotifyEmail] = useState(true)
  const [shareWithDept, setShareWithDept] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [subtaskFor, setSubtaskFor] = useState<string | null>(null)
  const [subtaskTitle, setSubtaskTitle] = useState('')

  const today = todayISO()

  const visible = commitments.filter(c => {
    if (filter === 'mine') return c.assignee_id === userId
    if (filter === 'assigned_by_me') return c.creator_id === userId && c.assignee_id !== userId
    // Someone else's work, shared to the department I'm in — the "can I help?" view.
    // Compares the task's own department rather than just "not mine", so a report's
    // task I can see through the reporting line doesn't masquerade as departmental.
    if (filter === 'department') {
      return (
        c.assignee_id !== userId &&
        Boolean(c.visible_to_department) &&
        Boolean(department) &&
        (c.department || '').trim().toLowerCase() === (department || '').trim().toLowerCase()
      )
    }
    return true
  })
  // Subtasks render under their parent, never as their own bucket entry —
  // otherwise a main task and its five subtasks read as six unrelated rows.
  const subtasksOf = new Map<string, TrackedCommitment[]>()
  for (const c of visible) {
    if (!c.parent_id) continue
    const list = subtasksOf.get(c.parent_id) || []
    list.push(c)
    subtasksOf.set(c.parent_id, list)
  }
  const topLevel = visible.filter(c => !c.parent_id)

  const open = topLevel.filter(c => c.status === 'open')
  const done = completedThisWeek(topLevel.filter(c => c.status === 'done'), today)
  const groups = groupByDue(open, today)

  const nameFor = (id: string | null) => {
    if (!id) return 'Unassigned'
    if (id === userId) return 'You'
    return teammates.find(t => t.id === id)?.full_name || 'Someone else'
  }

  const add = async () => {
    if (!title.trim()) return
    setSaving(true)
    setSaveError(null)
    setNotice(null)

    // An email takes precedence over the dropdown: it's the escape hatch for a
    // teammate who isn't on any of your meetings, so the dropdown can't list them.
    let targetId = assigneeId
    let targetLabel = nameFor(assigneeId)
    if (assigneeEmail.trim()) {
      const { id, fullName, error: lookupError } = await findProfileByEmail(assigneeEmail)
      if (!id) {
        setSaveError(lookupError || 'Could not find that person.')
        setSaving(false)
        return
      }
      targetId = id
      targetLabel = fullName || assigneeEmail.trim()
    }

    const { data, error: createError } = await createStandaloneCommitment({
      creator_id: userId,
      assignee_id: targetId,
      title: title.trim(),
      due_date: dueDate || null,
      notify_slack: notifySlack,
      notify_email: notifyEmail,
      // Only meaningful for someone who is in a department; otherwise let the
      // database trigger decide.
      visible_to_department: department ? shareWithDept : undefined,
    })

    if (createError || !data) {
      setSaveError(createError ? describeCommitmentError(createError) : 'Could not add that task.')
      setSaving(false)
      return
    }

    setTitle('')
    setDueDate('')
    setAssigneeEmail('')
    await refetch()

    // Tell them now, not on tomorrow's cron run. This is also what creates the
    // Slack message a "done" reply gets matched back to, so without it the reply
    // path simply isn't available for this task.
    if (notifySlack || notifyEmail) {
      const { error: notifyError } = await notifyCommitment(data.id)
      // Name the assignee either way: knowing the task was created but the DM
      // failed is only useful if you also know who was meant to get it.
      const who = targetId === userId ? 'you' : targetLabel
      setNotice(
        notifyError
          ? `Task added for ${who}, but not sent: ${notifyError}`
          : `Task added and sent to ${who}.`,
      )
    } else {
      const who = targetId === userId ? 'you' : targetLabel
      setNotice(`Task added for ${who}. Nobody was notified.`)
    }
    setSaving(false)
  }

  const addSubtask = async (parent: TrackedCommitment) => {
    if (!subtaskTitle.trim()) return
    setBusyId(parent.id)
    setSaveError(null)

    const { data, error: createError } = await createStandaloneCommitment({
      creator_id: userId,
      // Defaults to whoever owns the main task; reassign afterwards if needed.
      assignee_id: parent.assignee_id || userId,
      title: subtaskTitle.trim(),
      due_date: parent.due_date,
      parent_id: parent.id,
      // A subtask is a piece of the parent, so notifying each one turns a single
      // handover into five DMs. The main task is what gets announced.
      notify_slack: false,
      notify_email: false,
    })

    if (createError || !data) {
      setSaveError(createError ? describeCommitmentError(createError) : 'Could not add that subtask.')
    } else {
      setSubtaskTitle('')
      setExpanded(prev => new Set(prev).add(parent.id))
      await refetch()
    }
    setBusyId(null)
  }

  const toggleExpanded = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggle = async (c: TrackedCommitment) => {
    setBusyId(c.id)
    setSaveError(null)
    const { error: toggleError } = await setCommitmentStatus(c.id, c.status === 'done' ? 'open' : 'done')
    if (toggleError) setSaveError(describeCommitmentError(toggleError))
    await refetch()
    setBusyId(null)
  }

  const resend = async (c: TrackedCommitment) => {
    setBusyId(c.id)
    setSaveError(null)
    setNotice(null)
    const { error: notifyError } = await notifyCommitment(c.id)
    setNotice(notifyError ? `Not sent: ${notifyError}` : `Sent to ${nameFor(c.assignee_id)}.`)
    await refetch()
    setBusyId(null)
  }

  const problem = saveError || error

  return (
    <div>
      {problem && (
        <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-4">{problem}</div>
      )}
      {notice && (
        <div className="bg-[#e8f0fe] text-steel-blue text-sm p-3 rounded-lg mb-4">{notice}</div>
      )}
      {!notificationsReady && (
        <div className="bg-amber-light text-[#e67e22] text-sm p-3 rounded-lg mb-4">
          Notifications aren&apos;t set up yet — run <strong>supabase-notifications.sql</strong> in the
          Supabase SQL editor. Tasks work fine meanwhile, but nobody gets told about them and
          closing one by replying &ldquo;done&rdquo; in Slack won&apos;t work.
        </div>
      )}

      {/* Add a task */}
      <div className="bg-white rounded-xl border border-light-gray p-5 mb-6">
        <div className="flex gap-2 items-end flex-wrap">
          <div className="flex-1 min-w-[220px]">
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Task</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add() }}
              placeholder="What needs doing?"
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
          <div>
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Owner</label>
            <select
              value={assigneeId}
              onChange={e => setAssigneeId(e.target.value)}
              disabled={assigneeEmail.trim().length > 0}
              className="border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none disabled:opacity-50"
            >
              <option value={userId}>{userName || 'Me'}</option>
              {teammates.map(t => (
                <option key={t.id} value={t.id}>{t.full_name || t.email}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">
              Or by email
            </label>
            <input
              type="email"
              value={assigneeEmail}
              onChange={e => { setAssigneeEmail(e.target.value); setSaveError(null) }}
              placeholder="teammate@datavations.com"
              className="border border-light-gray rounded-lg px-3 py-2 text-sm w-52 focus:border-steel-blue focus:outline-none"
            />
          </div>
          <button
            onClick={add}
            disabled={saving || !title.trim()}
            className="bg-steel-blue text-white font-semibold px-4 py-2 rounded-lg text-sm hover:bg-[#25698f] transition disabled:opacity-50"
          >
            {saving ? 'Adding...' : 'Add & Notify'}
          </button>
        </div>

        <div className="flex items-center gap-4 mt-3">
          <label className="flex items-center gap-1.5 text-xs text-gray cursor-pointer">
            <input type="checkbox" checked={notifySlack} onChange={e => setNotifySlack(e.target.checked)} />
            Slack DM — they can reply &ldquo;done&rdquo; to close it
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray cursor-pointer">
            <input type="checkbox" checked={notifyEmail} onChange={e => setNotifyEmail(e.target.checked)} />
            Email
          </label>
          {department && (
            <label className="flex items-center gap-1.5 text-xs text-gray cursor-pointer">
              <input
                type="checkbox"
                checked={shareWithDept}
                onChange={e => setShareWithDept(e.target.checked)}
              />
              Visible to {department}
            </label>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition ${
              filter === f.key
                ? 'bg-deep-purple text-white border-deep-purple'
                : 'bg-white text-gray border-light-gray hover:border-steel-blue'
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="text-xs text-gray ml-auto">
          {open.length} open{groups.overdue.length > 0 && ` · ${groups.overdue.length} overdue`}
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-gray">Loading tasks...</p>
      ) : open.length === 0 ? (
        <div className="bg-white rounded-xl border border-light-gray p-8 text-center">
          <p className="text-gray text-sm">
            Nothing open here. Tasks you add above and commitments from your 1-on-1s both land in
            this list.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {BUCKET_ORDER.filter(b => groups[b].length > 0).map(bucket => (
            <div key={bucket}>
              <div className={`text-[11px] font-bold uppercase tracking-wide mb-2 ${BUCKET_TONE[bucket]}`}>
                {BUCKET_LABEL[bucket]} · {groups[bucket].length}
              </div>
              <div className="space-y-2">
                {groups[bucket].map(c => (
                  <TaskGroup
                    key={c.id}
                    c={c}
                    userId={userId}
                    subtasks={subtasksOf.get(c.id) || []}
                    today={today}
                    nameFor={nameFor}
                    busyId={busyId}
                    notificationsReady={notificationsReady}
                    expanded={expanded.has(c.id)}
                    onExpand={() => toggleExpanded(c.id)}
                    onToggle={toggle}
                    onResend={resend}
                    subtaskOpen={subtaskFor === c.id}
                    onSubtaskOpen={() => {
                      setSubtaskFor(subtaskFor === c.id ? null : c.id)
                      setSubtaskTitle('')
                    }}
                    subtaskTitle={subtaskTitle}
                    onSubtaskTitle={setSubtaskTitle}
                    onSubtaskAdd={() => addSubtask(c)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div className="mt-6 pt-4 border-t border-light-gray">
          <div className="text-[11px] font-bold uppercase tracking-wide text-green mb-2">
            Done this week · {done.length}
          </div>
          <div className="space-y-2">
            {done.map(c => (
              <Row
                key={c.id}
                c={c}
                today={today}
                nameFor={nameFor}
                busy={busyId === c.id}
                notificationsReady={notificationsReady}
                userId={userId}
                onToggle={() => toggle(c)}
                onResend={() => resend(c)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({
  c, today, nameFor, busy, notificationsReady, userId, onToggle, onResend, flat,
}: {
  c: TrackedCommitment
  today: string
  nameFor: (id: string | null) => string
  busy: boolean
  notificationsReady: boolean
  userId: string
  onToggle: () => void
  onResend: () => void
  /** True when TaskGroup already draws the surrounding card. */
  flat?: boolean
}) {
  const isDone = c.status === 'done'
  const overdue = !isDone && c.due_date !== null && c.due_date < today
  // Departmental and oversight visibility are read-only, so showing a checkbox
  // that the database will refuse is worse than showing none.
  const canEdit = c.assignee_id === userId || c.creator_id === userId
  const completer = (c as TrackedCommitment & { completer?: { full_name: string | null } | null }).completer

  return (
    <div
      className={
        flat
          ? 'flex items-center gap-3 p-3'
          : 'flex items-center gap-3 p-3 bg-white border border-light-gray rounded-lg'
      }
    >
      {canEdit ? (
        <button
          onClick={onToggle}
          disabled={busy}
          title={isDone ? 'Mark as open' : 'Mark as done'}
          className={`w-6 h-6 rounded flex items-center justify-center text-xs border-2 flex-shrink-0 transition disabled:opacity-50 ${
            isDone ? 'bg-green border-green text-white' : 'border-light-gray text-transparent hover:border-green'
          }`}
        >
          ✓
        </button>
      ) : (
        <span
          title="Someone else's task — you can see it, but only they can close it"
          className={`w-6 h-6 rounded flex items-center justify-center text-xs border-2 border-dashed flex-shrink-0 ${
            isDone ? 'bg-green border-green text-white' : 'border-light-gray text-transparent'
          }`}
        >
          ✓
        </span>
      )}

      <div className="flex-1 min-w-0">
        <div className={`font-semibold text-sm ${isDone ? 'line-through text-gray' : 'text-near-black'}`}>
          {c.title}
          {/* Somebody else's task you can see because you share a department. */}
          {c.assignee_id !== userId && c.visible_to_department && c.department && (
            <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#e8f0fe] text-steel-blue align-middle">
              {c.department.toUpperCase()}
            </span>
          )}
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
          {/* How it was closed, so a Slack reply is visibly attributed */}
          {isDone && c.completed_via && (
            <span className="text-green">
              {' · closed '}
              {COMPLETED_VIA_LABEL[c.completed_via] || c.completed_via}
              {completer?.full_name ? ` by ${completer.full_name}` : ''}
            </span>
          )}
        </div>
      </div>

      {!isDone && notificationsReady && (
        <div className="flex-shrink-0">
          {c.notified_at ? (
            <button
              onClick={onResend}
              disabled={busy}
              title="Send the notification again"
              className="text-[10px] font-bold uppercase tracking-wide text-gray hover:text-steel-blue transition disabled:opacity-50"
            >
              {c.slack_ts ? 'Slack sent' : 'Sent'} · resend
            </button>
          ) : (
            <button
              onClick={onResend}
              disabled={busy}
              className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded border border-light-gray text-steel-blue hover:border-steel-blue transition disabled:opacity-50"
            >
              {busy ? 'Sending...' : 'Notify'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A top-level task plus its subtasks.
 *
 * Progress is counted rather than stored: a `2 of 5` derived from the rows can't
 * drift out of step with them, whereas a cached tally on the parent can.
 */
function TaskGroup({
  c, userId, subtasks, today, nameFor, busyId, notificationsReady, expanded, onExpand,
  onToggle, onResend, subtaskOpen, onSubtaskOpen, subtaskTitle, onSubtaskTitle, onSubtaskAdd,
}: {
  c: TrackedCommitment
  userId: string
  subtasks: TrackedCommitment[]
  today: string
  nameFor: (id: string | null) => string
  busyId: string | null
  notificationsReady: boolean
  expanded: boolean
  onExpand: () => void
  onToggle: (c: TrackedCommitment) => void
  onResend: (c: TrackedCommitment) => void
  subtaskOpen: boolean
  onSubtaskOpen: () => void
  subtaskTitle: string
  onSubtaskTitle: (value: string) => void
  onSubtaskAdd: () => void
}) {
  const total = subtasks.length
  const complete = subtasks.filter(s => s.status === 'done').length
  const overdue = subtasks.filter(
    s => s.status === 'open' && s.due_date !== null && s.due_date < today,
  ).length
  // An overdue subtask hidden inside a collapsed parent is the one thing this
  // layout could make worse than a flat list, so it opens itself.
  const isOpen = expanded || overdue > 0

  return (
    <div className={total > 0 ? 'border border-light-gray rounded-lg bg-white' : ''}>
      <Row
        c={c}
        today={today}
        nameFor={nameFor}
        busy={busyId === c.id}
        notificationsReady={notificationsReady}
        userId={userId}
        onToggle={() => onToggle(c)}
        onResend={() => onResend(c)}
        flat={total > 0}
      />

      <div className="flex items-center gap-3 px-3 pb-2 -mt-1 flex-wrap">
        {total > 0 && (
          <button
            onClick={onExpand}
            className="text-[11px] font-bold uppercase tracking-wide text-gray hover:text-steel-blue transition"
          >
            {isOpen ? '▾' : '▸'} {complete} of {total} done
            {overdue > 0 && <span className="text-coral-red"> · {overdue} overdue</span>}
          </button>
        )}
        {total > 0 && (
          <div className="h-1.5 rounded-full bg-light-gray flex-1 min-w-[80px] max-w-[160px] overflow-hidden">
            <div
              className="h-full bg-green rounded-full transition-all"
              style={{ width: `${Math.round((complete / total) * 100)}%` }}
            />
          </div>
        )}
        <button
          onClick={onSubtaskOpen}
          className="text-[11px] font-bold uppercase tracking-wide text-steel-blue hover:text-deep-purple transition"
        >
          {subtaskOpen ? 'Cancel' : '+ Subtask'}
        </button>
      </div>

      {subtaskOpen && (
        <div className="flex gap-2 px-3 pb-3">
          <input
            value={subtaskTitle}
            onChange={e => onSubtaskTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSubtaskAdd() }}
            placeholder="What's the next piece of this?"
            autoFocus
            className="flex-1 border border-light-gray rounded-lg px-3 py-1.5 text-sm focus:border-steel-blue focus:outline-none"
          />
          <button
            onClick={onSubtaskAdd}
            disabled={busyId === c.id || !subtaskTitle.trim()}
            className="bg-steel-blue text-white font-semibold px-3 py-1.5 rounded-lg text-xs hover:bg-[#25698f] transition disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}

      {isOpen && total > 0 && (
        <div className="pl-6 pr-3 pb-3 space-y-2 border-l-2 border-light-gray ml-3">
          {subtasks.map(sub => (
            <Row
              key={sub.id}
              c={sub}
              today={today}
              nameFor={nameFor}
              busy={busyId === sub.id}
              notificationsReady={notificationsReady}
              userId={userId}
              onToggle={() => onToggle(sub)}
              onResend={() => onResend(sub)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
