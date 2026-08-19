import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { tryServiceClient, notifyAssignerOfClose } from '@/lib/complete-task'

/**
 * Tells the assigner about a task closed from inside the app.
 *
 * The other three ways to close a task run through completeTask, which sends this
 * itself. The checkbox on the board does not: it is a plain RLS update from the
 * browser, and that is worth keeping — RLS decides who may close what, with no
 * service role in the path. So the notice is a separate, deliberate call made
 * after the write has already succeeded.
 *
 * Authority is the caller's own session, and the task is read through their
 * client first: a viewer who cannot see the task cannot use this to find out
 * that it exists.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })

  const { commitment_id: commitmentId } =
    (await req.json().catch(() => ({}))) as { commitment_id?: string }
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
  // 200, not 503. The caller is a fire-and-forget from a checkbox that has already
  // done its job; a rejected response would only put a red error in the console of
  // someone whose task did close.
  if (!service.ok) return NextResponse.json({ ok: false, error: service.error })

  const result = await notifyAssignerOfClose(service.sb, commitmentId, user.id)
  return NextResponse.json({ ok: true, ...result })
}
