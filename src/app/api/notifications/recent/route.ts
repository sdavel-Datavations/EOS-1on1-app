import { NextResponse } from 'next/server'
import { requireCaller } from '@/lib/require-admin'

/**
 * Recent delivery activity, for the admin panel on /metrics.
 *
 * notification_log is readable through RLS only for rows about yourself
 * (`user_id = auth.uid()`), which is right for a member and useless for whoever
 * has to notice that a DM to somebody else failed. So this reads it with the
 * service role, behind an admin check.
 *
 * Admin only rather than manager: the log carries rows for people outside any one
 * reporting line, and there is no per-row scoping here to narrow it with.
 */
export async function GET() {
  const result = await requireCaller()
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  if (!result.caller.isAdmin) {
    return NextResponse.json({ error: 'Admins only' }, { status: 403 })
  }

  const { data, error } = await result.caller.admin
    .from('notification_log')
    .select('created_at, channel, event, status, detail, commitment_id, user_id')
    .order('created_at', { ascending: false })
    .limit(40)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = data || []
  return NextResponse.json({
    rows,
    // The most recent scheduled pass, so "has the cron ever run" is answerable
    // without reading the database by hand.
    lastRun: rows.find(r => r.event === 'run') ?? null,
    problems: rows.filter(r => r.status === 'failed'),
  })
}
