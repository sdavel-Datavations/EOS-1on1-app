import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { tryServiceClient, logNotification } from '@/lib/complete-task'
import { updateMessage, reassignedBlocks, slackConfigured } from '@/lib/slack'

/**
 * Hands an existing task to someone else.
 *
 * A plain RLS update from the browser would be enough to change the column, but
 * it would leave the previous owner's Slack DM sitting there — still telling them
 * to do the task, and still carrying a Mark done button that closes by commitment
 * id rather than by who pressed it. They could close work that is no longer
 * theirs. So the handover runs here, where the service role can reach Slack.
 *
 * The caller's authority is established by doing the update through their own
 * client: RLS decides, not this handler. Departmental and oversight viewers can
 * see a task without being able to move it, and that distinction is the whole
 * point of those being separate read-only policies.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })

  const { commitment_id: commitmentId, assignee_id: assigneeId } =
    (await req.json().catch(() => ({}))) as { commitment_id?: string; assignee_id?: string }

  if (!commitmentId || !assigneeId) {
    return NextResponse.json({ error: 'commitment_id and assignee_id are required' }, { status: 400 })
  }

  // Read it as the caller, which both proves access and captures the Slack
  // pointers before the update clears them.
  const { data: before } = await supabase
    .from('weekly_commitments')
    .select('id, title, assignee_id, slack_channel, slack_ts')
    .eq('id', commitmentId)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'No access to that task' }, { status: 403 })

  if (before.assignee_id === assigneeId) {
    return NextResponse.json({ ok: true, unchanged: true })
  }

  const service = tryServiceClient()
  if (!service.ok) return NextResponse.json({ error: service.error }, { status: 500 })
  const sb = service.sb

  // Refuse an id that is nobody, rather than parking the task on a user who does
  // not exist and cannot ever close it.
  const { data: target } = await sb
    .from('profiles')
    .select('id, full_name, email')
    .eq('id', assigneeId)
    .maybeSingle()
  if (!target) return NextResponse.json({ error: 'No account for that person' }, { status: 400 })

  // Through the caller's client, so RLS refuses anyone who may only look.
  // notified_at is cleared so the new owner actually gets told; the Slack pointers
  // are cleared so a "done" reply is never matched to the old owner's thread.
  const { data: updated, error } = await supabase
    .from('weekly_commitments')
    .update({ assignee_id: assigneeId, notified_at: null, slack_channel: null, slack_ts: null })
    .eq('id', commitmentId)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: 'You can see that task but not reassign it. Only the person it is for, the person who created it, or someone in its 1-on-1 can.' },
      { status: 403 },
    )
  }

  // Retire the old DM. Best effort: the handover has already happened in the
  // database, and failing the request now would invite a retry that reassigns
  // nothing and confuses the caller.
  const toName = target.full_name || target.email || 'someone else'
  if (slackConfigured() && before.slack_channel && before.slack_ts) {
    const { text, blocks } = reassignedBlocks({ title: before.title as string, toName })
    const { error: slackError } = await updateMessage({
      channel: before.slack_channel as string,
      ts: before.slack_ts as string,
      text,
      blocks,
    })
    await logNotification(sb, {
      commitment_id: commitmentId,
      user_id: before.assignee_id as string,
      channel: 'slack',
      event: 'notify',
      status: slackError ? 'failed' : 'sent',
      detail: slackError ? `retire on reassign: ${slackError}` : `retired for previous owner, now ${toName}`,
    })
  }

  return NextResponse.json({ ok: true, toName })
}
