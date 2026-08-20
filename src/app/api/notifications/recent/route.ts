import { NextResponse } from 'next/server'
import { requireCaller } from '@/lib/require-admin'
import { DELIVERY_CHANNELS } from '@/lib/delivery'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Delivery activity, for the admin-only /delivery page.
 *
 * notification_log is readable through RLS only for rows about yourself
 * (`user_id = auth.uid()`), which is right for a member and useless for whoever
 * has to notice that a DM to somebody else failed. So this reads it with the
 * service role, behind an admin check.
 *
 * Admin only rather than manager: the log carries rows for people outside any one
 * reporting line, and there is no per-row scoping here to narrow it with.
 */

/** Newest row matching a status on a channel, or null. */
async function newest(
  sb: SupabaseClient,
  channel: string,
  status: string,
): Promise<string | null> {
  const { data } = await sb
    .from('notification_log')
    .select('created_at')
    .eq('channel', channel)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data?.created_at as string) ?? null
}

export async function GET() {
  const result = await requireCaller()
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  if (!result.caller.isAdmin) {
    return NextResponse.json({ error: 'Admins only' }, { status: 403 })
  }
  const sb = result.caller.admin

  // Whether a channel is healthy turns on its most recent success, which can sit
  // far outside any recent-rows window once the log has any volume. Asking for it
  // directly is the difference between "email is broken" and "email was broken
  // yesterday" — a distinction the old panel could not make, and got wrong.
  const lastSent: Record<string, string | null> = {}
  const lastFailed: Record<string, string | null> = {}
  for (const channel of DELIVERY_CHANNELS) {
    lastSent[channel] = await newest(sb, channel, 'sent')
    lastFailed[channel] = await newest(sb, channel, 'failed')
  }

  const { data: failures, error } = await sb
    .from('notification_log')
    .select('created_at, channel, event, status, detail')
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: feed } = await sb
    .from('notification_log')
    .select('created_at, channel, event, status, detail, commitment_id, user_id')
    .order('created_at', { ascending: false })
    .limit(40)

  const { data: runRow } = await sb
    .from('notification_log')
    .select('created_at, channel, event, status, detail')
    .eq('event', 'run')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    rows: feed || [],
    failures: failures || [],
    lastSent,
    lastFailed,
    // The most recent scheduled pass, asked for directly rather than found in the
    // feed — one quiet week of activity would push it off the end.
    lastRun: runRow ?? null,
  })
}
