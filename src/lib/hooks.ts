import { useEffect, useState, useCallback } from 'react'
import { createClient } from './supabase'
import { findExactDuplicate, type ExistingItem } from './dedupe'
import { parseActionItems, resolveOwner } from './parse-action-items'
import type { Meeting, SegueNote, ScorecardItem, Headline, Issue, Todo, SectionTimer, Profile, Commitment, TrackedCommitment, Teammate, MeetingParticipant, ParticipantRole, ExtractedItem } from './types'

function getSupabase() {
  return createClient()
}

// ── Auth ──
export function useAuth() {
  const [user, setUser] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const getUser = async () => {
      const sb = getSupabase()
      const { data: { user: authUser } } = await sb.auth.getUser()
      if (authUser) {
        const { data } = await sb.from('profiles').select('*').eq('id', authUser.id).single()
        setUser(data)
      }
      setLoading(false)
    }
    getUser()

    const sb2 = getSupabase()
    const { data: { subscription } } = sb2.auth.onAuthStateChange(async (_, session) => {
      if (session?.user) {
        const { data } = await getSupabase().from('profiles').select('*').eq('id', session.user.id).single()
        setUser(data)
      } else {
        setUser(null)
      }
    })
    return () => subscription.unsubscribe()
  }, [])

  const signIn = async (email: string, password: string) => {
    return getSupabase().auth.signInWithPassword({ email, password })
  }

  const signUp = async (email: string, password: string, fullName: string) => {
    // In dev only, create the user through the admin endpoint so E2E runs don't
    // hit Supabase's confirmation-email rate limits. Production uses the normal
    // signUp flow below, with real email confirmation.
    if (process.env.NODE_ENV !== 'production') {
      try {
        await fetch('/api/dev/create-user', { method: 'POST', body: JSON.stringify({ email, password, fullName }), headers: { 'Content-Type': 'application/json' } })
      } catch {
        // ignore — fall through to the client signUp below
      }
      // Attempt to sign in directly
      for (let attempt = 0; attempt < 5; attempt++) {
        const signInRes = await getSupabase().auth.signInWithPassword({ email, password })
        if (!signInRes.error) return signInRes
        await new Promise(r => setTimeout(r, 300))
      }
      // fallback to client signUp
    }

    const res = await getSupabase().auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } }
    })
    return res
  }

  // Dev convenience: auto-confirm emails when running locally to speed E2E
  const devAutoConfirm = async (email: string) => {
    if (process.env.NODE_ENV === 'production') return
    try {
      await fetch('/api/dev/confirm', { method: 'POST', body: JSON.stringify({ email }), headers: { 'Content-Type': 'application/json' } })
    } catch (err) {
      // ignore
    }
  }

  const signOut = async () => {
    await getSupabase().auth.signOut()
    setUser(null)
  }

  return { user, loading, signIn, signUp, signOut }
}

// ── Meetings List ──
export function useMeetings(userId: string | undefined) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)

  const fetchMeetings = useCallback(async () => {
    if (!userId) {
      setMeetings([])
      setLoading(false)
      return
    }
    // No manager_id/report_id filter: RLS already limits this to meetings the
    // caller participates in, which also covers meetings they were added to.
    const sb = getSupabase()
    const { data } = await sb
      .from('meetings')
      .select('*, manager:profiles!meetings_manager_id_fkey(*), report:profiles!meetings_report_id_fkey(*)')
      .order('meeting_date', { ascending: false })
    setMeetings(data || [])
    setLoading(false)
  }, [userId])

  useEffect(() => { fetchMeetings() }, [fetchMeetings])

  return { meetings, loading, refetch: fetchMeetings }
}

// ── Single Meeting with all data ──
export function useMeeting(meetingId: string) {
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [participants, setParticipants] = useState<MeetingParticipant[]>([])
  const [segueNotes, setSegueNotes] = useState<SegueNote[]>([])
  const [scorecardItems, setScorecardItems] = useState<ScorecardItem[]>([])
  const [headlines, setHeadlines] = useState<Headline[]>([])
  const [issues, setIssues] = useState<Issue[]>([])
  const [todos, setTodos] = useState<Todo[]>([])
  const [timers, setTimers] = useState<SectionTimer[]>([])
  const [loading, setLoading] = useState(true)
  const [participantsError, setParticipantsError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    const sb = getSupabase()
    const [meetingRes, participantRes, segueRes, scorecardRes, headlineRes, issueRes, todoRes, timerRes] = await Promise.all([
      sb.from('meetings').select('*, manager:profiles!meetings_manager_id_fkey(*), report:profiles!meetings_report_id_fkey(*)').eq('id', meetingId).single(),
      sb.from('meeting_participants').select('*, profile:profiles(*)').eq('meeting_id', meetingId).order('created_at'),
      sb.from('segue_notes').select('*').eq('meeting_id', meetingId),
      sb.from('scorecard_items').select('*').eq('meeting_id', meetingId).order('sort_order'),
      sb.from('headlines').select('*').eq('meeting_id', meetingId),
      sb.from('issues').select('*').eq('meeting_id', meetingId).order('sort_order'),
      sb.from('todos').select('*').eq('meeting_id', meetingId).order('sort_order'),
      sb.from('section_timers').select('*').eq('meeting_id', meetingId),
    ])
    setMeeting(meetingRes.data)
    setParticipants(participantRes.data || [])
    setParticipantsError(participantRes.error ? describeParticipantError(participantRes.error) : null)
    setSegueNotes(segueRes.data || [])
    setScorecardItems(scorecardRes.data || [])
    setHeadlines(headlineRes.data || [])
    setIssues(issueRes.data || [])
    setTodos(todoRes.data || [])
    setTimers(timerRes.data || [])
    setLoading(false)
  }, [meetingId])

  useEffect(() => { fetchAll() }, [fetchAll])

  return {
    meeting, participants, participantsError, segueNotes, scorecardItems, headlines, issues, todos, timers,
    loading, refetch: fetchAll,
  }
}

// ── Participants ──
export async function addParticipantByEmail(meetingId: string, email: string, role: ParticipantRole = 'participant') {
  const sb = getSupabase()
  // Via the RPC for the same reason as findProfileByEmail: someone you have never
  // shared a meeting with is invisible under the profiles policy by design.
  const { id, error: lookupError } = await findProfileByEmail(email)
  if (!id) return { error: lookupError || 'No account with that email.' }

  const { error } = await sb
    .from('meeting_participants')
    .insert({ meeting_id: meetingId, user_id: id, role })

  // 23505 = unique_violation on (meeting_id, user_id)
  if (error && error.code === '23505') return { error: 'Already a participant.' }
  if (error) return { error: describeParticipantError(error) }
  return { error: null }
}

export async function removeParticipant(id: string) {
  return getSupabase().from('meeting_participants').delete().eq('id', id)
}

/** PGRST205 means the table isn't in the schema cache — usually an unapplied migration. */
export function describeParticipantError(error: { code?: string; message: string }) {
  if (error.code === 'PGRST205') {
    return 'Participants table not found — run supabase-participants.sql in the Supabase SQL editor.'
  }
  return error.message
}

export function describeMeetingError(error: { code?: string; message: string }) {
  // 42501 here almost always means the meetings SELECT policy re-queries
  // public.meetings, so `insert ... returning` can't see its own row.
  if (error.code === '42501' || /row-level security/i.test(error.message)) {
    return 'The database rejected the new meeting (row-level security). Re-run supabase-participants.sql in the Supabase SQL editor.'
  }
  if (error.code === 'PGRST205') {
    return 'Meetings table not found — run supabase-schema.sql in the Supabase SQL editor.'
  }
  return error.message
}

// ── Create a new meeting + seed from previous ──
export async function createMeeting(managerId: string, reportId: string | null, date: string) {
  const sb = getSupabase()
  // Create meeting
  const { data: meeting, error } = await sb
    .from('meetings')
    .insert({ manager_id: managerId, report_id: reportId, meeting_date: date, status: 'prep' })
    .select()
    .single()

  if (error) return { data: null, error }
  if (!meeting) return { data: null, error: { message: 'The meeting was not created, and the database gave no reason.' } }

  // Seed membership — this is what grants access, so it goes first
  const participantRows: { meeting_id: string; user_id: string; role: ParticipantRole }[] = [
    { meeting_id: meeting.id, user_id: managerId, role: 'manager' },
  ]
  if (reportId) participantRows.push({ meeting_id: meeting.id, user_id: reportId, role: 'report' })
  await sb.from('meeting_participants').insert(participantRows)

  // Seed section timers
  const sectionKeys = ['segue', 'scorecard', 'headlines', 'ids', 'todos']
  await sb.from('section_timers').insert(
    sectionKeys.map(key => ({ meeting_id: meeting.id, section_key: key }))
  )

  // Seed segue notes for both users
  const segueInserts = [{ meeting_id: meeting.id, user_id: managerId }]
  if (reportId) segueInserts.push({ meeting_id: meeting.id, user_id: reportId })
  await sb.from('segue_notes').insert(segueInserts)

  // Seed headlines for both users
  const headlineInserts = [{ meeting_id: meeting.id, user_id: managerId }]
  if (reportId) headlineInserts.push({ meeting_id: meeting.id, user_id: reportId })
  await sb.from('headlines').insert(headlineInserts)

  // Carry forward from the previous meeting with this same pair — matching only
  // on manager would pull one report's to-dos into another report's 1-on-1.
  let prevQuery = sb
    .from('meetings')
    .select('id')
    .eq('manager_id', managerId)
    .lt('meeting_date', date)
    .order('meeting_date', { ascending: false })
    .limit(1)
  prevQuery = reportId ? prevQuery.eq('report_id', reportId) : prevQuery.is('report_id', null)
  const { data: prevMeeting } = await prevQuery.maybeSingle()

  if (prevMeeting) {
    const { data: prevTodos } = await sb
      .from('todos')
      .select('*')
      .eq('meeting_id', prevMeeting.id)
      .eq('done', false)

    if (prevTodos?.length) {
      await sb.from('todos').insert(
        prevTodos.map((t, i) => ({
          meeting_id: meeting.id,
          text: t.text,
          owner: t.owner,
          done: false,
          carried_from_id: t.id,
          is_new: false,
          sort_order: i,
        }))
      )
    }
  }

  // Seed default scorecard items from previous meeting (carry names forward)
  if (prevMeeting) {
    const { data: prevScorecard } = await sb
      .from('scorecard_items')
      .select('*')
      .eq('meeting_id', prevMeeting.id)
      .order('sort_order')

    if (prevScorecard?.length) {
      await sb.from('scorecard_items').insert(
        prevScorecard.map((s, i) => ({
          meeting_id: meeting.id,
          item_type: s.item_type,
          name: s.name,
          on_track: true, // reset status
          sort_order: i,
        }))
      )
    }
  }

  return { data: meeting, error: null }
}

// ── Upsert helpers (debounce in the component) ──
export async function updateSegueNote(id: string, fields: Partial<SegueNote>) {
  return getSupabase().from('segue_notes').update(fields).eq('id', id)
}

export async function upsertSegueNote(item: Partial<SegueNote> & { meeting_id: string; user_id: string }) {
  const sb = getSupabase()
  const { id, meeting_id, user_id, ...fields } = item
  if (id) {
    return sb.from('segue_notes').update(fields).eq('id', id)
  }
  // create new
  const insert = { meeting_id, user_id, personal_win: item.personal_win || '', professional_win: item.professional_win || '' }
  return sb.from('segue_notes').insert(insert).select().single()
}

export async function updateHeadline(id: string, content: string) {
  return getSupabase().from('headlines').update({ content }).eq('id', id)
}

export async function upsertHeadline(item: { id?: string; meeting_id: string; user_id: string; content: string }) {
  const sb = getSupabase()
  if (item.id) {
    return sb.from('headlines').update({ content: item.content }).eq('id', item.id)
  }
  return sb
    .from('headlines')
    .insert({ meeting_id: item.meeting_id, user_id: item.user_id, content: item.content })
    .select()
    .single()
}

export async function upsertScorecardItem(item: Partial<ScorecardItem> & { meeting_id: string }) {
  const sb = getSupabase()
  if (item.id) {
    return sb.from('scorecard_items').update(item).eq('id', item.id)
  }
  return sb.from('scorecard_items').insert(item).select().single()
}

export async function deleteScorecardItem(id: string) {
  return getSupabase().from('scorecard_items').delete().eq('id', id)
}

export async function upsertIssue(item: Partial<Issue> & { meeting_id: string }) {
  const sb = getSupabase()
  if (item.id) {
    return sb.from('issues').update(item).eq('id', item.id)
  }
  return sb.from('issues').insert(item).select().single()
}

export async function deleteIssue(id: string) {
  return getSupabase().from('issues').delete().eq('id', id)
}

export async function upsertTodo(item: Partial<Todo> & { meeting_id: string }) {
  const sb = getSupabase()
  if (item.id) {
    return sb.from('todos').update(item).eq('id', item.id)
  }
  return sb.from('todos').insert(item).select().single()
}

export async function deleteTodo(id: string) {
  return getSupabase().from('todos').delete().eq('id', id)
}

export async function updateMeeting(id: string, fields: Partial<Meeting>) {
  return getSupabase().from('meetings').update(fields).eq('id', id)
}

/**
 * Deletes a meeting and, by FK cascade, everything on its agenda.
 *
 * Selects the deleted row back so a zero-row result can be reported. Without a
 * DELETE policy RLS simply permits nothing and PostgREST still returns success,
 * so "nothing happened" is otherwise indistinguishable from "deleted".
 */
export async function deleteMeeting(id: string) {
  const { data, error } = await getSupabase().from('meetings').delete().eq('id', id).select('id')
  if (error) return { error: error.message }
  if (!data || data.length === 0) {
    return {
      error: 'Nothing was deleted. Run supabase-delete-meetings.sql in the Supabase SQL editor — and note only the meeting organiser can delete a meeting.',
    }
  }
  return { error: null }
}

export async function updateSectionTimer(id: string, fields: Partial<SectionTimer>) {
  return getSupabase().from('section_timers').update(fields).eq('id', id)
}

// ── Weekly Commitments ──
export function useCommitments(meetingId: string) {
  const [commitments, setCommitments] = useState<Commitment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchCommitments = useCallback(async () => {
    const { data, error } = await getSupabase()
      .from('weekly_commitments')
      .select('*')
      .eq('meeting_id', meetingId)
      .order('created_at')
    setError(error ? describeCommitmentError(error) : null)
    setCommitments(data || [])
    setLoading(false)
  }, [meetingId])

  useEffect(() => { fetchCommitments() }, [fetchCommitments])

  return { commitments, loading, error, refetch: fetchCommitments }
}

/** PGRST205 means the table isn't in the schema cache — usually an unapplied migration. */
export function describeCommitmentError(error: { code?: string; message: string }) {
  if (error.code === 'PGRST205') {
    return 'Commitments table not found — run supabase-commitments.sql in the Supabase SQL editor.'
  }
  return error.message
}

export async function createCommitment(item: {
  meeting_id: string
  creator_id: string
  assignee_id: string
  title: string
  description?: string
  due_date?: string | null
  notify_email?: boolean
  notify_slack?: boolean
}) {
  return getSupabase()
    .from('weekly_commitments')
    .insert({
      meeting_id: item.meeting_id,
      creator_id: item.creator_id,
      assignee_id: item.assignee_id,
      title: item.title,
      description: item.description || '',
      due_date: item.due_date || null,
      notify_email: item.notify_email ?? true,
      notify_slack: item.notify_slack ?? false,
    })
    .select()
    .single()
}

/**
 * A task added mid-week, belonging to no meeting.
 *
 * notify_slack defaults to TRUE here, unlike a commitment raised in a meeting.
 * Closing a task by replying "done" only works if a Slack message exists to reply
 * to — with this off, the whole reply path is silently unavailable for exactly
 * the tasks most likely to want it.
 */
export async function createStandaloneCommitment(item: {
  creator_id: string
  assignee_id: string
  title: string
  due_date?: string | null
  notify_email?: boolean
  notify_slack?: boolean
}) {
  return getSupabase()
    .from('weekly_commitments')
    .insert({
      meeting_id: null,
      creator_id: item.creator_id,
      assignee_id: item.assignee_id,
      title: item.title,
      description: '',
      due_date: item.due_date || null,
      notify_email: item.notify_email ?? true,
      notify_slack: item.notify_slack ?? true,
    })
    .select()
    .single()
}

/**
 * Toggle done/open. Stamps completed_at in the same write so the tracker can
 * report what got finished this week — a status column alone can't say when.
 */
export async function setCommitmentStatus(id: string, status: 'open' | 'done') {
  const result = await updateCommitment(id, {
    status,
    completed_at: status === 'done' ? new Date().toISOString() : null,
  })
  // Before supabase-weekly-tracker.sql runs there is no completed_at column.
  // Ticking a box off is more important than recording when, so fall back to
  // the status alone rather than failing the whole write.
  if (result.error && isMissingColumn(result.error, 'completed_at')) {
    return updateCommitment(id, { status })
  }
  return result
}

function isMissingColumn(error: { code?: string; message: string }, column: string) {
  return (
    (error.code === 'PGRST204' || /does not exist|could not find/i.test(error.message)) &&
    error.message.includes(column)
  )
}

/**
 * Every commitment that is mine to do or mine to follow up on, across all
 * meetings — the tracker's view. Commitments otherwise only surface inside the
 * meeting that produced them, which is no use on a Wednesday.
 */
export function useMyCommitments(userId: string | undefined) {
  const [commitments, setCommitments] = useState<TrackedCommitment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // False until supabase-notifications.sql runs. The board still works; the
  // notify controls and the "closed via" line are hidden.
  const [notificationsReady, setNotificationsReady] = useState(true)

  const fetchMine = useCallback(async () => {
    if (!userId) return
    const sb = getSupabase()

    // Assigned to me, or assigned by me to someone else — a manager needs to see
    // what he's waiting on, not just what he owes.
    const mine = `assignee_id.eq.${userId},creator_id.eq.${userId}`
    const run = (columns: string) =>
      sb
        .from('weekly_commitments')
        .select(columns)
        .or(mine)
        .order('due_date', { ascending: true, nullsFirst: false })

    const BASE = '*, meeting:meetings(meeting_date)'
    const WITH_NOTIFICATIONS = `${BASE}, completer:profiles!weekly_commitments_completed_by_fkey(full_name)`

    let { data, error } = await run(WITH_NOTIFICATIONS)

    // The embed fails outright when completed_by doesn't exist yet, which is a
    // pending migration rather than a real error.
    if (error && /completed_by|does not exist|could not find/i.test(error.message)) {
      setNotificationsReady(false)
      ;({ data, error } = await run(BASE))
    } else if (!error) {
      setNotificationsReady(true)
    }

    setError(error ? describeCommitmentError(error) : null)
    setCommitments((data as unknown as TrackedCommitment[]) || [])
    setLoading(false)
  }, [userId])

  useEffect(() => { fetchMine() }, [fetchMine])

  return { commitments, loading, error, notificationsReady, refetch: fetchMine }
}

/**
 * Sends this task's notification now, rather than waiting for the nightly run.
 *
 * A task raised mid-week and handed to someone is useless if they hear about it
 * tomorrow — and the Slack message is also what makes "reply done" possible at
 * all, since a threaded reply is matched back to the task by its message id.
 */
export async function notifyCommitment(id: string): Promise<{ error: string | null; sent?: boolean }> {
  try {
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitment_id: id }),
    })
    const json = await res.json()
    if (!res.ok) return { error: json.error || 'Could not send the notification' }
    const outcome = json.results?.[0]
    const sent = outcome?.slack === 'sent' || outcome?.email === 'sent'
    if (!sent) {
      const why = [outcome?.slack, outcome?.email].filter(Boolean).join('; ')
      return { error: why || 'Nothing was sent — no channel is configured for this task.' }
    }
    return { error: null, sent: true }
  } catch {
    return { error: 'Could not reach the notification service.' }
  }
}

/**
 * Resolves an email to an account, for handing a task to someone who isn't on
 * any of your meetings yet.
 *
 * The owner dropdown lists only people you share a meeting with, which is the
 * common case but excludes a teammate you've simply never had a 1-on-1 with.
 * They still need an account: there is nobody to notify otherwise.
 */
export async function findProfileByEmail(
  email: string,
): Promise<{ id?: string; fullName?: string; error?: string }> {
  const cleaned = email.trim().toLowerCase()
  if (!cleaned) return { error: 'Enter an email address.' }

  // An RPC, not a select: profiles is scoped to people you actually work with, so
  // a direct query can't reach a teammate who shares no meeting with you yet.
  // find_profile_by_email answers one exact address and returns no list, so the
  // directory stays closed to enumeration.
  const sb = getSupabase()
  let { data, error } = await sb.rpc('find_profile_by_email', { p_email: cleaned })

  // Before supabase-access-control.sql the function doesn't exist and profiles is
  // still readable directly, so fall back rather than breaking a working flow on
  // a migration that hasn't run yet.
  if (error && (error.code === 'PGRST202' || /function|schema cache/i.test(error.message))) {
    const direct = await sb
      .from('profiles')
      .select('id, full_name')
      .eq('email', cleaned)
      .maybeSingle()
    data = direct.data ? [direct.data] : []
    error = direct.error
  }

  if (error) return { error: error.message }

  const match = Array.isArray(data) ? data[0] : data
  if (!match?.id) return { error: `No account for ${cleaned} — they need an invitation first.` }
  return { id: match.id as string, fullName: (match.full_name as string) || undefined }
}

/** People who share at least one meeting with this user — the plausible assignees. */
export function useTeammates(userId: string | undefined) {
  const [teammates, setTeammates] = useState<Teammate[]>([])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    ;(async () => {
      const sb = getSupabase()
      const { data: mine } = await sb
        .from('meeting_participants')
        .select('meeting_id')
        .eq('user_id', userId)
      const meetingIds = (mine || []).map(m => m.meeting_id)
      if (meetingIds.length === 0) return

      const { data: others } = await sb
        .from('meeting_participants')
        .select('user_id, profile:profiles(id, full_name, email)')
        .in('meeting_id', meetingIds)
        .neq('user_id', userId)

      // PostgREST types an embedded relation as an array even when the FK makes
      // it to-one, so normalise rather than assuming either shape.
      const byId = new Map<string, Teammate>()
      for (const row of others || []) {
        const embedded = (row as unknown as { profile: Teammate | Teammate[] | null }).profile
        const p = Array.isArray(embedded) ? embedded[0] : embedded
        if (p?.id) byId.set(p.id, p)
      }
      if (!cancelled) {
        setTeammates([...byId.values()].sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '')))
      }
    })()
    return () => { cancelled = true }
  }, [userId])

  return teammates
}

export async function updateCommitment(id: string, fields: Partial<Commitment>) {
  // .select() so an RLS-blocked update surfaces instead of returning success
  // with zero rows affected — otherwise the checkbox appears to toggle and
  // silently reverts on the next load.
  const { data, error } = await getSupabase()
    .from('weekly_commitments')
    .update(fields)
    .eq('id', id)
    .select('id')

  if (error) return { error }
  if (!data || data.length === 0) {
    return { error: { message: 'That change did not save — you may not have access to this commitment.' } }
  }
  return { error: null }
}

// ── Action-item import ──
/**
 * Turns a pasted action-item list into pending review-queue rows.
 *
 * Granola, Gemini and Otter already produce this list with the AI you're paying
 * for there, so nothing here calls a model. Parsing is a formatting problem;
 * every item still goes to the same queue a human confirms before it reaches the
 * shared agenda.
 */
export async function importActionItems(args: {
  meetingId: string
  rawText: string
  target: 'commitment' | 'todo' | 'issue'
  participants: { id: string; full_name?: string; email?: string }[]
  userId: string
  /** Anchors relative dates like "by Friday" — the meeting's own date. */
  referenceDate: string
  sourceRef?: string | null
}): Promise<{ count: number; duplicates: number; error: string | null }> {
  const parsed = parseActionItems(args.rawText, args.referenceDate)
  if (parsed.length === 0) {
    return { count: 0, duplicates: 0, error: null }
  }

  const sb = getSupabase()

  // What's already on the agenda, so a re-paste doesn't duplicate it.
  const [todoRes, commitmentRes] = await Promise.all([
    sb.from('todos').select('id, text').eq('meeting_id', args.meetingId).eq('done', false),
    sb.from('weekly_commitments').select('id, title').eq('meeting_id', args.meetingId).eq('status', 'open'),
  ])

  const existing: ExistingItem[] = [
    ...(todoRes.data || []).map(t => ({ kind: 'todo' as const, id: t.id as string, text: t.text as string })),
    ...(commitmentRes.data || []).map(c => ({ kind: 'commitment' as const, id: c.id as string, text: c.title as string })),
  ].filter(e => e.text?.trim())

  const rows = parsed.map(item => {
    const owner = resolveOwner(item.ownerName, args.participants)
    const duplicate = findExactDuplicate(item.title, existing)
    return {
      meeting_id: args.meetingId,
      source: 'upload',
      source_ref: args.sourceRef || null,
      extracted_by: args.userId,
      target: args.target,
      title: item.title,
      owner_id: owner?.id ?? null,
      due_date: item.dueDate,
      // The line exactly as pasted. There is no model quote to show, and the
      // original wording is what a reviewer needs to judge a mangled parse.
      evidence: item.raw,
      duplicate_of_kind: duplicate?.kind ?? null,
      duplicate_of_id: duplicate?.id ?? null,
      status: 'pending' as const,
    }
  })

  const { data, error } = await sb.from('extracted_items').insert(rows).select('id')
  if (error) {
    return { count: 0, duplicates: 0, error: describeExtractionError(error) }
  }

  return {
    count: data?.length ?? 0,
    duplicates: rows.filter(r => r.duplicate_of_id).length,
    error: null,
  }
}

// ── Extraction review queue ──
export function useExtractedItems(meetingId: string) {
  const [items, setItems] = useState<ExtractedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchItems = useCallback(async () => {
    const { data, error } = await getSupabase()
      .from('extracted_items')
      .select('*')
      .eq('meeting_id', meetingId)
      .eq('status', 'pending')
      .order('created_at')
    setError(error ? describeExtractionError(error) : null)
    setItems(data || [])
    setLoading(false)
  }, [meetingId])

  useEffect(() => { fetchItems() }, [fetchItems])

  return { items, loading, error, refetch: fetchItems }
}

/** PGRST205 means the table isn't in the schema cache — usually an unapplied migration. */
export function describeExtractionError(error: { code?: string; message: string }) {
  if (error.code === 'PGRST205') {
    return 'Extracted items table not found — run supabase-transcripts.sql in the Supabase SQL editor.'
  }
  return error.message
}

/**
 * Accepts a staged item onto the agenda: creates the real row, then records what
 * it became so the decision is auditable and can't be double-applied.
 */
export async function acceptExtractedItem(item: ExtractedItem, reviewerId: string) {
  const sb = getSupabase()
  let createdId: string | null = null

  if (item.target === 'commitment') {
    const { data, error } = await createCommitment({
      meeting_id: item.meeting_id,
      creator_id: reviewerId,
      assignee_id: item.owner_id || reviewerId,
      title: item.title,
      due_date: item.due_date,
    })
    if (error) return { error: error.message }
    createdId = data?.id ?? null
  } else if (item.target === 'issue') {
    const { data, error } = await sb
      .from('issues')
      .insert({ meeting_id: item.meeting_id, description: item.title, priority: 'M' })
      .select()
      .single()
    if (error) return { error: error.message }
    createdId = data?.id ?? null
  } else {
    const { data, error } = await sb
      .from('todos')
      .insert({ meeting_id: item.meeting_id, text: item.title, done: false, is_new: true })
      .select()
      .single()
    if (error) return { error: error.message }
    createdId = data?.id ?? null
  }

  const { error } = await sb
    .from('extracted_items')
    .update({
      status: 'accepted',
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
      accepted_kind: item.target,
      accepted_id: createdId,
    })
    .eq('id', item.id)

  return { error: error?.message ?? null }
}

export async function rejectExtractedItem(id: string, reviewerId: string) {
  const { error } = await getSupabase()
    .from('extracted_items')
    .update({ status: 'rejected', reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq('id', id)
  return { error: error?.message ?? null }
}

// ── Search past issues/discussions ──
export async function searchPastMeetings(query: string) {
  const sb = getSupabase()
  // The !inner join plus RLS on meetings scopes these to the caller's meetings,
  // including ones they only participate in.
  const { data: issueResults } = await sb
    .from('issues')
    .select('*, meeting:meetings!inner(id, meeting_date, manager_id, report_id)')
    .ilike('description', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(20)

  const { data: todoResults } = await sb
    .from('todos')
    .select('*, meeting:meetings!inner(id, meeting_date, manager_id, report_id)')
    .ilike('text', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(20)

  return { issues: issueResults || [], todos: todoResults || [] }
}
