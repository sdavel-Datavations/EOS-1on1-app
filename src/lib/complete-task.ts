import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import { updateMessage, closedBlocks, reopenedBlocks, slackConfigured } from './slack'
import { describeDue } from './tracker'

/**
 * Closing a task from outside the app.
 *
 * A Slack reply and an emailed link both arrive with no Supabase session, so
 * these run with the service role and RLS is not what protects them. Authority
 * comes from the caller instead — a verified Slack signature, or a signed token
 * — and every one of them is required to prove the actor may touch the specific
 * task before anything is written. Each attempt is logged either way.
 */

export type CompletionVia = 'slack_reply' | 'slack_button' | 'email_link'

export function serviceClient(): SupabaseClient {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error(MISSING_SERVICE_ROLE)
  return createServiceClient(url, key, { auth: { persistSession: false } })
}

export const MISSING_SERVICE_ROLE =
  'SUPABASE_SERVICE_ROLE_KEY is not set on the server. Notifications and Slack replies need it, ' +
  'because neither has a user session to act through.'

/**
 * serviceClient() without the throw.
 *
 * Letting it throw produced a 500 with an empty body, which told nobody anything
 * — the reason only existed in a log the user could not see. Every route that
 * needs the service role reports the missing configuration instead.
 */
export function tryServiceClient(): { ok: true; sb: SupabaseClient } | { ok: false; error: string } {
  try {
    return { ok: true, sb: serviceClient() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : MISSING_SERVICE_ROLE }
  }
}

export type TaskRow = {
  id: string
  title: string
  status: 'open' | 'done'
  assignee_id: string | null
  creator_id: string | null
  meeting_id: string | null
  slack_channel: string | null
  slack_ts: string | null
}

const TASK_COLUMNS = 'id, title, status, assignee_id, creator_id, meeting_id, slack_channel, slack_ts'

/** Append-only audit record. Never throws: losing a log line must not fail a request. */
export async function logNotification(
  sb: SupabaseClient,
  row: {
    commitment_id?: string | null
    user_id?: string | null
    channel: 'slack' | 'email' | 'app'
    event: 'notify' | 'complete' | 'error' | 'run'
    status: 'sent' | 'failed' | 'skipped' | 'ok'
    detail?: string
  },
) {
  try {
    await sb.from('notification_log').insert({
      commitment_id: row.commitment_id ?? null,
      user_id: row.user_id ?? null,
      channel: row.channel,
      event: row.event,
      status: row.status,
      // Truncated: detail carries upstream error strings, which can be long.
      detail: (row.detail || '').slice(0, 500),
    })
  } catch {
    // Deliberately swallowed.
  }
}

export async function findTaskByThread(
  sb: SupabaseClient,
  channel: string,
  threadTs: string,
): Promise<TaskRow | null> {
  const { data } = await sb
    .from('weekly_commitments')
    .select(TASK_COLUMNS)
    .eq('slack_channel', channel)
    .eq('slack_ts', threadTs)
    .maybeSingle()
  return (data as TaskRow) || null
}

export async function findTaskById(sb: SupabaseClient, id: string): Promise<TaskRow | null> {
  const { data } = await sb.from('weekly_commitments').select(TASK_COLUMNS).eq('id', id).maybeSingle()
  return (data as TaskRow) || null
}

/** Resolves a Slack user id to a profile, caching the mapping on first sight. */
export async function profileForSlackUser(
  sb: SupabaseClient,
  slackUserId: string,
  lookupEmail: (userId: string) => Promise<{ email?: string; error?: string }>,
): Promise<{ id: string; full_name: string | null } | null> {
  const { data: cached } = await sb
    .from('profiles')
    .select('id, full_name')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()
  if (cached) return cached as { id: string; full_name: string | null }

  const { email } = await lookupEmail(slackUserId)
  if (!email) return null

  const { data: profile } = await sb
    .from('profiles')
    .select('id, full_name')
    .ilike('email', email)
    .maybeSingle()
  if (!profile) return null

  await sb.from('profiles').update({ slack_user_id: slackUserId }).eq('id', profile.id)
  return profile as { id: string; full_name: string | null }
}


/**
 * Brings the Slack message in line with the task.
 *
 * Called after every state change, from whichever surface made it, so the app and
 * Slack cannot disagree. Without this a task closed in the web app leaves a live
 * "Mark done" button sitting in Slack, and somebody presses it repeatedly
 * wondering why nothing happens.
 *
 * Never throws and never blocks the caller's result: the task is already closed
 * in the database, and failing to redraw a message must not undo that.
 */
export async function syncSlackMessage(sb: SupabaseClient, taskId: string): Promise<void> {
  if (!slackConfigured()) return

  try {
    const { data } = await sb
      .from('weekly_commitments')
      .select('id, title, status, due_date, slack_channel, slack_ts, completed_via, completer:profiles!weekly_commitments_completed_by_fkey(full_name)')
      .eq('id', taskId)
      .maybeSingle()

    if (!data?.slack_channel || !data?.slack_ts) return

    const embedded = (data as { completer?: { full_name: string | null } | { full_name: string | null }[] | null }).completer
    const completer = Array.isArray(embedded) ? embedded[0] : embedded

    const message =
      data.status === 'done'
        ? closedBlocks({
            title: data.title as string,
            byName: completer?.full_name ?? null,
            via: (data.completed_via as string) ?? null,
          })
        : reopenedBlocks({
            title: data.title as string,
            commitmentId: data.id as string,
            dueLabel: data.due_date ? describeDue(data.due_date as string) : 'No due date',
          })

    const { error } = await updateMessage({
      channel: data.slack_channel as string,
      ts: data.slack_ts as string,
      text: message.text,
      blocks: message.blocks,
    })

    if (error) {
      await logNotification(sb, {
        commitment_id: taskId,
        channel: 'slack',
        event: 'error',
        status: 'failed',
        detail: `chat.update: ${error}`,
      })
    }
  } catch {
    // Redrawing a message is never worth failing a request over.
  }
}

export type CompleteResult =
  | { ok: true; alreadyDone: boolean; title: string }
  | { ok: false; error: string }

/**
 * Marks a task done on behalf of someone who reached us from Slack or email.
 *
 * `actorId` must already be authenticated by the caller. We still check the
 * actor is a party to the task rather than trusting that, so a Slack user in the
 * workspace can't close a task that has nothing to do with them.
 */
export async function completeTask(
  sb: SupabaseClient,
  task: TaskRow,
  actorId: string,
  via: CompletionVia,
): Promise<CompleteResult> {
  const isParty = task.assignee_id === actorId || task.creator_id === actorId
  if (!isParty && task.meeting_id) {
    const { data: membership } = await sb
      .from('meeting_participants')
      .select('id')
      .eq('meeting_id', task.meeting_id)
      .eq('user_id', actorId)
      .maybeSingle()
    if (!membership) {
      await logNotification(sb, {
        commitment_id: task.id,
        user_id: actorId,
        channel: via === 'email_link' ? 'email' : 'slack',
        event: 'error',
        status: 'failed',
        detail: `actor is not a party to this task (via ${via})`,
      })
      return { ok: false, error: 'You are not a participant on that task.' }
    }
  } else if (!isParty) {
    await logNotification(sb, {
      commitment_id: task.id,
      user_id: actorId,
      channel: via === 'email_link' ? 'email' : 'slack',
      event: 'error',
      status: 'failed',
      detail: `actor is not a party to this standalone task (via ${via})`,
    })
    return { ok: false, error: 'You are not a party to that task.' }
  }

  // Idempotent: Slack retries deliveries, and email links get clicked twice.
  if (task.status === 'done') {
    // Still redraw. This is precisely the case where Slack is out of date — the
    // task was closed elsewhere, or closed before this sync existed — so pressing
    // the button again is how someone tries to fix a message that looks wrong.
    // Returning here without redrawing meant a stale message could never heal.
    await syncSlackMessage(sb, task.id)
    return { ok: true, alreadyDone: true, title: task.title }
  }

  const { data, error } = await sb
    .from('weekly_commitments')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      completed_by: actorId,
      completed_via: via,
    })
    .eq('id', task.id)
    .eq('status', 'open') // lost-update guard against a concurrent close
    .select('id')

  if (error) {
    await logNotification(sb, {
      commitment_id: task.id,
      user_id: actorId,
      channel: via === 'email_link' ? 'email' : 'slack',
      event: 'error',
      status: 'failed',
      detail: error.message,
    })
    return { ok: false, error: error.message }
  }

  // Zero rows means someone else closed it between the read and the write.
  const alreadyDone = !data || data.length === 0

  await logNotification(sb, {
    commitment_id: task.id,
    user_id: actorId,
    channel: via === 'email_link' ? 'email' : 'slack',
    event: 'complete',
    status: 'ok',
    detail: alreadyDone ? `already closed (via ${via})` : `closed via ${via}`,
  })

  // One place for this, so all four surfaces leave Slack in the same state.
  await syncSlackMessage(sb, task.id)

  return { ok: true, alreadyDone, title: task.title }
}
