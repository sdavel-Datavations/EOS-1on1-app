import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabaseClient() {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
  if (!SUPABASE_URL || !SERVICE) return null
  return createClient(SUPABASE_URL, SERVICE)
}

export async function GET(req: Request) {
  const sb = getSupabaseClient()
  if (!sb) return NextResponse.json({ error: 'server not configured' }, { status: 500 })
  const url = new URL(req.url)
  const meetingId = url.searchParams.get('meeting_id')
  if (!meetingId) return NextResponse.json({ error: 'missing meeting_id' }, { status: 400 })
  const { data, error } = await sb.from('weekly_commitments').select('*').eq('meeting_id', meetingId).order('created_at')
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ data })
}

export async function POST(req: Request) {
  const sb = getSupabaseClient()
  if (!sb) return NextResponse.json({ error: 'server not configured' }, { status: 500 })
  const body = await req.json()
  const { meeting_id, creator_id, assignee_id, title, description, due_date, notify_email, notify_slack } = body
  if (!meeting_id || !creator_id || !assignee_id || !title) return NextResponse.json({ error: 'missing fields' }, { status: 400 })
  const { data, error } = await sb.from('weekly_commitments').insert([{ meeting_id, creator_id, assignee_id, title, description: description || '', due_date: due_date || null, notify_email: !!notify_email, notify_slack: !!notify_slack }]).select().single()
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ data })
}
