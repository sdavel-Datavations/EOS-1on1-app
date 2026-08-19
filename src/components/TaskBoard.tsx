'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  useMyCommitments,
  useTeammates,
  createStandaloneCommitment,
  updateCommitment,
  deleteCommitment,
  reassignCommitment,
  syncTaskSlackMessage,
  findProfileByEmail,
  setCommitmentStatus,
  notifyCommitment,
  describeCommitmentError,
} from '@/lib/hooks'
import { groupByDue, describeDue, completedBuckets, DONE_BUCKET_LABEL, DONE_BUCKET_ORDER, todayISO } from '@/lib/tracker'
import type { DoneBucket } from '@/lib/tracker'
import { BUCKET_ORDER, BUCKET_LABEL, COMPLETED_VIA_LABEL } from '@/lib/types'
import type { TrackedCommitment, DueBucket, TaskFilter } from '@/lib/types'
import { isTopLevel } from '@/lib/open-work'
import { notifyNotice } from '@/lib/notify-outcome'

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
  userId, userName, department, accessLevel,
}: {
  userId: string
  userName: string
  department?: string | null
  accessLevel?: string | null
}) {
  // The admin exemption on due dates exists so a task created by someone who has
  // left can still have its date corrected. Mirrored by a database trigger, so the
  // rule holds even if this check is bypassed.
  const isAdmin = accessLevel === 'admin'
  const { commitments, loading, error, notificationsReady, refetch } = useMyCommitments(userId)
  const teammates = useTeammates(userId)

  const [title, setTitle] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
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
  const [subtaskAssignee, setSubtaskAssignee] = useState(userId)
  const [subtaskDue, setSubtaskDue] = useState('')
  const [openDone, setOpenDone] = useState<Set<DoneBucket>>(new Set(['week']))
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)

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
  //
  // Unless the parent is not visible. Someone can hand you one piece of a task
  // whose whole RLS does not show you, and a row that is neither top level nor
  // drawn by a parent renders nowhere: work assigned to you that you cannot see.
  const visibleIds = new Set(visible.map(c => c.id))
  const subtasksOf = new Map<string, TrackedCommitment[]>()
  for (const c of visible) {
    if (isTopLevel(c, visibleIds)) continue
    const list = subtasksOf.get(c.parent_id!) || []
    list.push(c)
    subtasksOf.set(c.parent_id!, list)
  }
  const topLevel = visible.filter(c => isTopLevel(c, visibleIds))

  const open = topLevel.filter(c => c.status === 'open')
  const doneGroups = completedBuckets(topLevel.filter(c => c.status === 'done'), today)
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
      description: notes,
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
    setNotes('')
    setAssigneeEmail('')
    await refetch()

    // Tell them now, not on tomorrow's cron run. This is also what creates the
    // Slack message a "done" reply gets matched back to, so without it the reply
    // path simply isn't available for this task.
    if (notifySlack || notifyEmail) {
      const { error: notifyError, summary } = await notifyCommitment(data.id)
      // Name the assignee either way: knowing the task was created but the DM
      // failed is only useful if you also know who was meant to get it.
      const who = targetId === userId ? 'you' : targetLabel
      setNotice(
        notifyError
          ? `Task added for ${who}, but not sent: ${notifyError}`
          : `Task added. ${notifyNotice(summary, who)}`,
      )
    } else {
      const who = targetId === userId ? 'you' : targetLabel
      setNotice(`Task added for ${who}. Nobody was notified.`)
    }
    setSaving(false)
  }

  // Same people the main form offers. A teammate who shares no meeting with you
  // is not listed here — the main form's "or by email" escape hatch has no room
  // in a row this narrow, so create the piece and reassign it from there.
  const ownerOptions = [
    { id: userId, label: userName || 'Me' },
    ...teammates.map(t => ({ id: t.id, label: t.full_name || t.email })),
  ]

  const addSubtask = async (parent: TrackedCommitment) => {
    if (!subtaskTitle.trim()) return
    setBusyId(parent.id)
    setSaveError(null)
    setNotice(null)

    const owner = subtaskAssignee || parent.assignee_id || userId
    // Notify only when this piece goes to someone other than whoever owns the
    // main task. Splitting your own task into five pieces should be silent; five
    // DMs for one handover is what the old blanket `false` was avoiding. But that
    // also meant handing a piece to someone else told them nothing at all, which
    // is the worse failure: work assigned and never mentioned.
    const handover = owner !== (parent.assignee_id || userId)

    const { data, error: createError } = await createStandaloneCommitment({
      creator_id: userId,
      assignee_id: owner,
      title: subtaskTitle.trim(),
      // Pre-filled from the parent but its own from here: work runs in stages,
      // and a piece waiting on someone else is rarely due when the whole is.
      due_date: subtaskDue || null,
      parent_id: parent.id,
      notify_slack: handover && notifySlack,
      notify_email: handover && notifyEmail,
    })

    if (createError || !data) {
      setSaveError(createError ? describeCommitmentError(createError) : 'Could not add that subtask.')
      setBusyId(null)
      return
    }

    setSubtaskTitle('')
    setExpanded(prev => new Set(prev).add(parent.id))
    await refetch()

    if (handover && (notifySlack || notifyEmail)) {
      const { error: notifyError, summary } = await notifyCommitment(data.id)
      const who = nameFor(owner)
      setNotice(
        notifyError
          ? `Subtask added for ${who}, but not sent: ${notifyError}`
          : `Subtask added. ${notifyNotice(summary, who)}`,
      )
    }
    setBusyId(null)
  }

  const remove = async (c: TrackedCommitment) => {
    setBusyId(c.id)
    setSaveError(null)
    setNotice(null)
    const { error: failure } = await deleteCommitment(c.id)
    if (failure) {
      setSaveError(describeCommitmentError(failure))
    } else {
      const kids = subtasksOf.get(c.id)?.length || 0
      setNotice(
        kids > 0
          ? `Deleted "${c.title}" and its ${kids} subtask${kids === 1 ? '' : 's'}.`
          : `Deleted "${c.title}".`,
      )
    }
    setConfirmingDelete(null)
    await refetch()
    setBusyId(null)
  }

  const toggleDone = (bucket: DoneBucket) =>
    setOpenDone(prev => {
      const next = new Set(prev)
      if (next.has(bucket)) next.delete(bucket)
      else next.add(bucket)
      return next
    })

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
    const { error: notifyError, summary } = await notifyCommitment(c.id)
    setNotice(
      notifyError ? `Not sent: ${notifyError}` : notifyNotice(summary, nameFor(c.assignee_id)),
    )
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

        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={notes ? 3 : 1}
          placeholder="Notes and context — background, links, what &ldquo;done&rdquo; looks like (optional)"
          className="mt-2 w-full border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none resize-y"
        />

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
                    onSaved={refetch}
                    onDelete={remove}
                    confirmingDelete={confirmingDelete}
                    onConfirmDelete={setConfirmingDelete}
                    subtaskCount={subtasksOf.get(c.id)?.length || 0}
                    subtaskOpen={subtaskFor === c.id}
                    onSubtaskOpen={() => {
                      setSubtaskFor(subtaskFor === c.id ? null : c.id)
                      setSubtaskTitle('')
                      setSubtaskAssignee(c.assignee_id || userId)
                      setSubtaskDue(c.due_date || '')
                    }}
                    subtaskTitle={subtaskTitle}
                    onSubtaskTitle={setSubtaskTitle}
                    subtaskAssignee={subtaskAssignee}
                    onSubtaskAssignee={setSubtaskAssignee}
                    subtaskDue={subtaskDue}
                    onSubtaskDue={setSubtaskDue}
                    onNotice={setNotice}
                    isAdmin={isAdmin}
                    ownerOptions={ownerOptions}
                    onSubtaskAdd={() => addSubtask(c)}
                    orphaned={Boolean(c.parent_id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {DONE_BUCKET_ORDER.some(b => doneGroups[b].length > 0) && (
        <div className="mt-6 pt-4 border-t border-light-gray space-y-3">
          {DONE_BUCKET_ORDER.filter(b => doneGroups[b].length > 0).map(bucket => (
            <div key={bucket}>
              <button
                onClick={() => toggleDone(bucket)}
                className="text-[11px] font-bold uppercase tracking-wide text-green hover:text-[#2d8a47] transition"
              >
                {openDone.has(bucket) ? '▾' : '▸'} {DONE_BUCKET_LABEL[bucket]} · {doneGroups[bucket].length}
              </button>
              {openDone.has(bucket) && (
                <div className="space-y-2 mt-2">
                  {doneGroups[bucket].map(c => (
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
                      onSaved={refetch}
                      onDelete={remove}
                      confirmingDelete={confirmingDelete}
                      onConfirmDelete={setConfirmingDelete}
                      subtaskCount={subtasksOf.get(c.id)?.length || 0}
                      subtaskOpen={subtaskFor === c.id}
                      onSubtaskOpen={() => {
                        setSubtaskFor(subtaskFor === c.id ? null : c.id)
                        setSubtaskTitle('')
                        setSubtaskAssignee(c.assignee_id || userId)
                        setSubtaskDue(c.due_date || '')
                      }}
                      subtaskTitle={subtaskTitle}
                      onSubtaskTitle={setSubtaskTitle}
                      subtaskAssignee={subtaskAssignee}
                      onSubtaskAssignee={setSubtaskAssignee}
                      subtaskDue={subtaskDue}
                      onSubtaskDue={setSubtaskDue}
                      onNotice={setNotice}
                      isAdmin={isAdmin}
                      ownerOptions={ownerOptions}
                      onSubtaskAdd={() => addSubtask(c)}
                      orphaned={Boolean(c.parent_id)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

    </div>
  )
}


/**
 * Notes and context on a task, editable in place.
 *
 * Collapsed by default: on a board of twenty tasks, twenty paragraphs of context
 * stops being a list. The notes travel with the task into Slack and email, so
 * they are usually read by whoever was handed it rather than whoever wrote it.
 */
function TaskNotes({ c, canEdit, onSaved }: {
  c: TrackedCommitment
  canEdit: boolean
  onSaved: () => void
}) {
  const existing = (c.description || '').trim()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(existing)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setError(null)
    // updateCommitment selects the row back, so an RLS refusal surfaces here
    // rather than looking like a save that worked.
    const { error: failure } = await updateCommitment(c.id, { description: draft.trim() })
    if (failure) {
      setError(describeCommitmentError(failure))
      setSaving(false)
      return
    }
    setEditing(false)
    setOpen(true)
    setSaving(false)
    onSaved()
  }

  if (editing) {
    return (
      <div className="mt-2">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={3}
          autoFocus
          placeholder="Background, links, what done looks like..."
          className="w-full border border-light-gray rounded-lg px-2 py-1.5 text-xs focus:border-steel-blue focus:outline-none resize-y"
        />
        <div className="flex gap-2 mt-1">
          <button
            onClick={save}
            disabled={saving}
            className="bg-steel-blue text-white font-semibold px-2.5 py-1 rounded text-[11px] hover:bg-[#25698f] transition disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={() => { setEditing(false); setDraft(existing); setError(null) }}
            className="text-[11px] font-bold uppercase tracking-wide text-gray hover:text-steel-blue transition"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-[11px] text-coral-red mt-1">{error}</p>}
      </div>
    )
  }

  if (!existing) {
    return canEdit ? (
      <button
        onClick={() => { setDraft(''); setEditing(true) }}
        className="text-[11px] font-bold uppercase tracking-wide text-gray hover:text-steel-blue transition mt-0.5"
      >
        + Notes
      </button>
    ) : null
  }

  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(!open)}
        className="text-[11px] font-bold uppercase tracking-wide text-steel-blue hover:text-deep-purple transition"
      >
        {open ? '▾' : '▸'} Notes
      </button>
      {open && (
        <div className="mt-1 text-xs text-near-black whitespace-pre-wrap border-l-2 border-light-gray pl-2">
          {existing}
          {canEdit && (
            <button
              onClick={() => { setDraft(existing); setEditing(true) }}
              className="block mt-1 text-[11px] font-bold uppercase tracking-wide text-gray hover:text-steel-blue transition"
            >
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Changing who owns a task and when it is due, after the fact.
 *
 * Both live behind one control because they are usually changed together: work
 * moves to someone else because it is waiting on them, and the date moves with
 * it. Reassigning goes through a route so the previous owner's Slack message can
 * be retired — see src/app/api/tasks/reassign/route.ts.
 */
function RowFields({ c, canEdit, canSetDue, ownerOptions, onSaved, onNotice }: {
  c: TrackedCommitment
  canEdit: boolean
  /** Only the assigner (or an admin) may move a date. Mirrored by a DB trigger. */
  canSetDue: boolean
  ownerOptions: { id: string; label: string }[]
  onSaved: () => void
  onNotice: (message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [owner, setOwner] = useState(c.assignee_id)
  const [due, setDue] = useState(c.due_date || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canEdit) return null

  const start = () => {
    // Read from the row each time it opens: the board refetches underneath, and a
    // stale draft would silently write back an old owner or date.
    setOwner(c.assignee_id)
    setDue(c.due_date || '')
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    // Belt and braces: the input is disabled when this is false, and a trigger
    // rejects it server-side regardless.
    const dueChanged = canSetDue && (c.due_date || '') !== due
    const ownerChanged = owner !== c.assignee_id
    if (!dueChanged && !ownerChanged) {
      setEditing(false)
      return
    }

    setSaving(true)
    setError(null)

    // Date first. When both change, the notification the new owner receives should
    // carry the date they are actually being held to, not the one they inherited.
    if (dueChanged) {
      const { error: failure } = await updateCommitment(c.id, { due_date: due || null })
      if (failure) {
        setError(describeCommitmentError(failure))
        setSaving(false)
        return
      }
    }

    if (ownerChanged) {
      const { error: failure, toName } = await reassignCommitment(c.id, owner)
      if (failure) {
        setError(failure)
        setSaving(false)
        return
      }
      const who = toName || 'them'
      const { error: notifyError, summary } = await notifyCommitment(c.id)
      onNotice(
        notifyError
          ? `Reassigned to ${who}, but not sent: ${notifyError}`
          : `Reassigned. ${notifyNotice(summary, who)}`,
      )
    } else if (dueChanged) {
      // Redraw the message they already have rather than sending a second one
      // about the same task. Fire and forget: the date is already saved.
      syncTaskSlackMessage(c.id)
      onNotice('Due date updated.')
    }

    setEditing(false)
    setSaving(false)
    onSaved()
  }

  if (!editing) {
    return (
      <button
        onClick={start}
        className="text-[11px] font-bold uppercase tracking-wide text-gray hover:text-steel-blue transition"
      >
        Owner &amp; date
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2 flex-wrap mt-1">
      <select
        value={owner}
        onChange={e => setOwner(e.target.value)}
        aria-label="Task owner"
        className="border border-light-gray rounded px-2 py-1 text-xs focus:border-steel-blue focus:outline-none"
      >
        {ownerOptions.map(o => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
        {/* The current owner may not be in the list — they can be someone you no
            longer share a meeting with. Without this the select would silently
            show the first option and reassign on save. */}
        {!ownerOptions.some(o => o.id === c.assignee_id) && (
          <option value={c.assignee_id}>Current owner</option>
        )}
      </select>
      <input
        type="date"
        value={due}
        onChange={e => setDue(e.target.value)}
        aria-label="Task due date"
        disabled={!canSetDue}
        title={canSetDue ? undefined : 'Only the person who assigned this task can change its due date'}
        className="border border-light-gray rounded px-2 py-1 text-xs focus:border-steel-blue focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
      />
      {!canSetDue && (
        <span className="text-[10px] text-gray">Date is the assigner&apos;s to change</span>
      )}
      <button
        onClick={save}
        disabled={saving}
        className="bg-steel-blue text-white font-semibold px-2.5 py-1 rounded text-[11px] hover:bg-[#25698f] transition disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
      <button
        onClick={() => { setEditing(false); setError(null) }}
        className="text-[11px] font-bold uppercase tracking-wide text-gray hover:text-steel-blue transition"
      >
        Cancel
      </button>
      {error && <p className="text-[11px] text-coral-red w-full">{error}</p>}
    </div>
  )
}

function Row({
  c, today, nameFor, busy, notificationsReady, userId, onToggle, onResend, onSaved,
  ownerOptions, onNotice, isAdmin, onDelete, confirmingDelete, onConfirmDelete,
  deleteAlsoRemoves = 0, flat, orphaned,
}: {
  c: TrackedCommitment
  today: string
  nameFor: (id: string | null) => string
  busy: boolean
  notificationsReady: boolean
  userId: string
  onToggle: () => void
  onResend: () => void
  onSaved: () => void
  ownerOptions: { id: string; label: string }[]
  onNotice: (message: string) => void
  isAdmin: boolean
  onDelete: () => void
  confirmingDelete: boolean
  onConfirmDelete: () => void
  /** Subtasks that would go with it, since parent_id cascades in the database. */
  deleteAlsoRemoves?: number
  /** True when TaskGroup already draws the surrounding card. */
  flat?: boolean
  /**
   * A subtask standing at top level because its parent is not ours to see.
   * Without saying so, the title arrives as a fragment with no hint it is part
   * of anything larger.
   */
  orphaned?: boolean
}) {
  const isDone = c.status === 'done'
  const overdue = !isDone && c.due_date !== null && c.due_date < today
  // Departmental and oversight visibility are read-only, so showing a checkbox
  // that the database will refuse is worse than showing none.
  const canEdit = c.assignee_id === userId || c.creator_id === userId
  // Being handed work does not come with the authority to rewrite when it is
  // wanted, so only the person who assigned it may move the date. Delegating it
  // onward is a different question and stays open to whoever holds it.
  const canSetDue = c.creator_id === userId || isAdmin
  const completer = (c as TrackedCommitment & { completer?: { full_name: string | null } | null }).completer

  // An overdue task reads red at the row level, not just in its date text: the
  // date is the smallest thing on the row and easy to skim past.
  // items-start, not items-center: with notes expanded the row grows tall and a
  // centred checkbox drifts away from the title it belongs to.
  const base = 'flex items-start gap-3 p-3'
  const surface = overdue
    ? 'bg-red-light border-coral-red'
    : 'bg-white border-light-gray'

  return (
    <div
      data-testid="task-row"
      className={
        flat
          ? `${base} ${overdue ? 'border-l-4 border-coral-red bg-red-light rounded-r-lg' : ''}`
          : `${base} border rounded-lg ${surface}${overdue ? ' border-l-4' : ''}`
      }
    >
      {canEdit ? (
        <button
          onClick={onToggle}
          disabled={busy}
          title={isDone ? 'Mark as open' : 'Mark as done'}
          className={`w-6 h-6 mt-px rounded flex items-center justify-center text-xs border-2 flex-shrink-0 transition disabled:opacity-50 ${
            isDone ? 'bg-green border-green text-white' : 'border-light-gray text-transparent hover:border-green'
          }`}
        >
          ✓
        </button>
      ) : (
        <span
          title="Someone else's task — you can see it, but only they can close it"
          className={`w-6 h-6 mt-px rounded flex items-center justify-center text-xs border-2 border-dashed flex-shrink-0 ${
            isDone ? 'bg-green border-green text-white' : 'border-light-gray text-transparent'
          }`}
        >
          ✓
        </span>
      )}

      <div className="flex-1 min-w-0">
        <div
          className={`font-semibold text-sm ${
            isDone ? 'line-through text-gray' : overdue ? 'text-coral-red' : 'text-near-black'
          }`}
        >
          {c.title}
          {/* Somebody else's task you can see because you share a department. */}
          {overdue && (
            <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-coral-red text-white align-middle">
              MISSED
            </span>
          )}
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
          {orphaned && <> · one piece of a larger task</>}
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
        <div className="flex items-center gap-3 flex-wrap">
          <TaskNotes c={c} canEdit={canEdit} onSaved={onSaved} />
          <RowFields
            c={c}
            canEdit={canEdit}
            canSetDue={canSetDue}
            ownerOptions={ownerOptions}
            onSaved={onSaved}
            onNotice={onNotice}
          />
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

      {/* Deleting is offered on done tasks too: a finished task is exactly the
          kind you want off the board. Only for people the database will actually
          let through — departmental and oversight viewers are read-only. */}
      {canEdit && (
        <div className="flex-shrink-0">
          {confirmingDelete ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-gray whitespace-nowrap">
                {deleteAlsoRemoves > 0
                  ? `Delete this and its ${deleteAlsoRemoves} subtask${deleteAlsoRemoves === 1 ? '' : 's'}?`
                  : 'Delete?'}
              </span>
              <button
                onClick={onDelete}
                disabled={busy}
                className="bg-coral-red text-white text-[10px] font-semibold px-2 py-1 rounded disabled:opacity-50"
              >
                {busy ? 'Deleting...' : 'Delete'}
              </button>
              <button
                onClick={onConfirmDelete}
                className="border border-light-gray text-gray text-[10px] font-semibold px-2 py-1 rounded"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={onConfirmDelete}
              title="Delete this task"
              className="text-[10px] font-bold uppercase tracking-wide text-gray hover:text-coral-red transition"
            >
              Delete
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
  onToggle, onResend, onSaved, onDelete, confirmingDelete, onConfirmDelete, subtaskCount,
  subtaskOpen, onSubtaskOpen, subtaskTitle, onSubtaskTitle,
  subtaskAssignee, onSubtaskAssignee, subtaskDue, onSubtaskDue, onNotice, isAdmin,
  ownerOptions, onSubtaskAdd, orphaned,
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
  onSaved: () => void
  onDelete: (c: TrackedCommitment) => void
  confirmingDelete: string | null
  onConfirmDelete: (id: string | null) => void
  subtaskCount: number
  subtaskOpen: boolean
  onSubtaskOpen: () => void
  subtaskTitle: string
  onSubtaskTitle: (value: string) => void
  subtaskAssignee: string
  onSubtaskAssignee: (value: string) => void
  subtaskDue: string
  onSubtaskDue: (value: string) => void
  onNotice: (message: string) => void
  isAdmin: boolean
  ownerOptions: { id: string; label: string }[]
  onSubtaskAdd: () => void
  /** This row is itself a subtask whose parent is not visible. */
  orphaned?: boolean
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
    <div
      data-testid="task-group"
      className={
        total > 0
          ? `border rounded-lg ${overdue > 0 ? 'border-coral-red bg-red-light' : 'border-light-gray bg-white'}`
          : ''
      }
    >
      <Row
        c={c}
        today={today}
        nameFor={nameFor}
        busy={busyId === c.id}
        notificationsReady={notificationsReady}
        userId={userId}
        onToggle={() => onToggle(c)}
        onResend={() => onResend(c)}
        onSaved={onSaved}
        ownerOptions={ownerOptions}
        onNotice={onNotice}
        isAdmin={isAdmin}
        onDelete={() => onDelete(c)}
        confirmingDelete={confirmingDelete === c.id}
        onConfirmDelete={() => onConfirmDelete(confirmingDelete === c.id ? null : c.id)}
        deleteAlsoRemoves={subtaskCount}
        flat={total > 0}
        orphaned={orphaned}
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
        {/* Subtasks are one level deep, enforced by a trigger. Offering the button
            on a row that is itself a subtask only produces a database error. */}
        {!orphaned && (
          <button
            onClick={onSubtaskOpen}
            className="text-[11px] font-bold uppercase tracking-wide text-steel-blue hover:text-deep-purple transition"
          >
            {subtaskOpen ? 'Cancel' : '+ Subtask'}
          </button>
        )}
      </div>

      {subtaskOpen && (
        <div className="flex gap-2 px-3 pb-3 flex-wrap">
          <input
            value={subtaskTitle}
            onChange={e => onSubtaskTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSubtaskAdd() }}
            placeholder="What's the next piece of this?"
            autoFocus
            className="flex-1 min-w-[180px] border border-light-gray rounded-lg px-3 py-1.5 text-sm focus:border-steel-blue focus:outline-none"
          />
          <input
            type="date"
            value={subtaskDue}
            onChange={e => onSubtaskDue(e.target.value)}
            aria-label="Subtask due date"
            className="border border-light-gray rounded-lg px-2 py-1.5 text-sm focus:border-steel-blue focus:outline-none"
          />
          <select
            value={subtaskAssignee}
            onChange={e => onSubtaskAssignee(e.target.value)}
            aria-label="Subtask owner"
            className="border border-light-gray rounded-lg px-2 py-1.5 text-sm focus:border-steel-blue focus:outline-none"
          >
            {ownerOptions.map(o => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
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
              onSaved={onSaved}
              ownerOptions={ownerOptions}
              onNotice={onNotice}
              isAdmin={isAdmin}
              onDelete={() => onDelete(sub)}
              confirmingDelete={confirmingDelete === sub.id}
              onConfirmDelete={() => onConfirmDelete(confirmingDelete === sub.id ? null : sub.id)}
              deleteAlsoRemoves={0}
            />
          ))}
        </div>
      )}
    </div>
  )
}
