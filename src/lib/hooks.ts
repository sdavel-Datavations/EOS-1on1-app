import { useEffect, useState, useCallback } from 'react'
import { createClient } from './supabase'
import type { Meeting, SegueNote, ScorecardItem, Headline, Issue, Todo, SectionTimer, Profile, Commitment, MeetingParticipant, ParticipantRole } from './types'

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
  const { data: profile, error: lookupError } = await sb
    .from('profiles')
    .select('id')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle()

  if (lookupError) return { error: lookupError.message }
  if (!profile) return { error: 'No account with that email. They need to sign up first.' }

  const { error } = await sb
    .from('meeting_participants')
    .insert({ meeting_id: meetingId, user_id: profile.id, role })

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

// ── Create a new meeting + seed from previous ──
export async function createMeeting(managerId: string, reportId: string | null, date: string) {
  const sb = getSupabase()
  // Create meeting
  const { data: meeting, error } = await sb
    .from('meetings')
    .insert({ manager_id: managerId, report_id: reportId, meeting_date: date, status: 'prep' })
    .select()
    .single()

  if (error || !meeting) return { error }

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

  return { data: meeting }
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

export async function updateCommitment(id: string, fields: Partial<Commitment>) {
  return getSupabase().from('weekly_commitments').update(fields).eq('id', id)
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
