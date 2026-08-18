import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { tryServiceClient, syncSlackMessage } from '@/lib/complete-task'

/**
 * Redraws a task's Slack message after it changed in the web app.
 *
 * Closing a task in the app is a direct RLS write from the browser, so no server
 * code runs and Slack never hears about it — leaving a live "Mark done" button on
 * a task that is already done, which invites pressing it repeatedly. The client
 * calls this afterwards.
 *
 * Uses the service role to reach Slack, so the caller's authority is established
 * first by reading the task through their own client: RLS decides, not this
 * handler.
 */
export async function POST(req: Request) {
  // Authenticate first: an anonymous caller should learn nothing about this
  // route's shape, not even which field it wants.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })

  const { commitment_id: commitmentId } = (await req.json().catch(() => ({}))) as {
    commitment_id?: string
  }
  if (!commitmentId) {
    return NextResponse.json({ error: 'commitment_id is required' }, { status: 400 })
  }

  const { data: visible } = await supabase
    .from('weekly_commitments')
    .select('id')
    .eq('id', commitmentId)
    .maybeSingle()
  if (!visible) return NextResponse.json({ error: 'No access to that task' }, { status: 403 })

  const service = tryServiceClient()
  if (!service.ok) return NextResponse.json({ error: service.error }, { status: 500 })

  await syncSlackMessage(service.sb, commitmentId)
  return NextResponse.json({ ok: true })
}
