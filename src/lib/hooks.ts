import { useEffect, useState, useCallback } from 'react'
import { createClient } from './supabase'
import type { Meeting, SegueNote, ScorecardItem, Headline, Issue, Todo, SectionTimer, Profile } from './types'

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
    return getSupabase().auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } }
    })
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
    if (!userId) return
    const sb = getSupabase()
    const { data } = await sb
      .from('meetings')
      .select('*, manager:profiles!meetings_manager_id_fkey(*), report:profiles!meetings_report_id_fkey(*)')
      .or(`manager_id.eq.${userId},report_id.eq.${userId}`)
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
  const [segueNotes, setSegueNotes] = useState<SegueNote[]>([])
  const [scorecardItems, setScorecardItems] = useState<ScorecardItem[]>([])
  const [headlines, setHeadlines] = useState<Headline[]>([])
  const [issues, setIssues] = useState<Issue[]>([])
  const [todos, setTodos] = useState<Todo[]>([])
  const [timers, setTimers] = useState<SectionTimer[]>([])
  const [loading, setLoading] = useState(true)

  const fetchAll = useCallback(async () => {
    const sb = getSupabase()
    const [meetingRes, segueRes, scorecardRes, headlineRes, issueRes, todoRes, timerRes] = await Promise.all([
      sb.from('meetings').select('*, manager:profiles!meetings_manager_id_fkey(*), report:profiles!meetings_report_id_fkey(*)').eq('id', meetingId).single(),
      sb.from('segue_notes').select('*').eq('meeting_id', meetingId),
      sb.from('scorecard_items').select('*').eq('meeting_id', meetingId).order('sort_order'),
      sb.from('headlines').select('*').eq('meeting_id', meetingId),
      sb.from('issues').select('*').eq('meeting_id', meetingId).order('sort_order'),
      sb.from('todos').select('*').eq('meeting_id', meetingId).order('sort_order'),
      sb.from('section_timers').select('*').eq('meeting_id', meetingId),
    ])
    setMeeting(meetingRes.data)
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
    meeting, segueNotes, scorecardItems, headlines, issues, todos, timers,
    loading, refetch: fetchAll,
  }
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

  // Carry forward incomplete todos from previous meeting
  const { data: prevMeeting } = await sb
    .from('meetings')
    .select('id')
    .or(`manager_id.eq.${managerId},report_id.eq.${managerId}`)
    .lt('meeting_date', date)
    .order('meeting_date', { ascending: false })
    .limit(1)
    .single()

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

export async function updateHeadline(id: string, content: string) {
  return getSupabase().from('headlines').update({ content }).eq('id', id)
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

// ── Search past issues/discussions ──
export async function searchPastMeetings(userId: string, query: string) {
  const sb = getSupabase()
  // Search issues
  const { data: issueResults } = await sb
    .from('issues')
    .select('*, meeting:meetings!inner(id, meeting_date, manager_id, report_id)')
    .or(`manager_id.eq.${userId},report_id.eq.${userId}`, { referencedTable: 'meetings' })
    .ilike('description', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(20)

  // Search todos
  const { data: todoResults } = await sb
    .from('todos')
    .select('*, meeting:meetings!inner(id, meeting_date, manager_id, report_id)')
    .or(`manager_id.eq.${userId},report_id.eq.${userId}`, { referencedTable: 'meetings' })
    .ilike('text', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(20)

  return { issues: issueResults || [], todos: todoResults || [] }
}
