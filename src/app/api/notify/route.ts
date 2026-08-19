import { NextResponse } from 'next/server'
import {
  postMessage, lookupUserByEmail, taskBlocks, slackConfigured, escapeMrkdwn,
  assignerConfirmationBlocks,
} from '@/lib/slack'
import { sendMail, mailConfigured, taskEmail, appBaseUrl } from '@/lib/mail'
import { signActionToken } from '@/lib/action-token'
import { serviceClient, tryServiceClient, logNotification } from '@/lib/complete-task'
import { describeDue, todayISO } from '@/lib/tracker'
import { createClient } from '@/lib/supabase-server'

/**
 * Sends one notification per open task that hasn't been notified yet.
 *
 * Deliberately one message per task rather than a digest: a threaded "done"
 * reply has to be unambiguous about which task it closes, and a single message
 * listing five tasks cannot be.
 *
 * Called by Vercel Cron on a schedule, or by a signed-in user to send now.
 */

export const maxDuration = 60

/** Notify tasks due within this many days; overdue ones always qualify. */
const HORIZON_DAYS = 7

type Row = {
  id: string
  title: string
  description: string | null
  due_date: string | null
  assignee_id: string | null
  creator_id: string | null
  meeting_id: string | null
  notify_slack: boolean
  notify_email: boolean
  meeting: { meeting_date: string } | null
  assignee: { id: string; full_name: string | null; email: string | null; slack_user_id: string | null } | null
  creator: { id: string; full_name: string | null; slack_user_id: string | null } | null
}

function firstName(fullName: string | null | undefined): string {
  return (fullName || '').trim().split(/\s+/)[0] || 'there'
}

function hasCronSecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  return Boolean(secret) && req.headers.get('authorization') === `Bearer ${secret}`
}

/**
 * Vercel Cron invokes the path with a GET, so this sends too.
 *
 * Unlike POST it accepts *only* the cron secret — never a session — so simply
 * opening the URL in a browser can't fire a round of notifications.
 */
export async function GET(req: Request) {
  if (!hasCronSecret(req)) {
    return NextResponse.json({ error: 'This endpoint requires the cron secret' }, { status: 401 })
  }
  // Marked as the scheduled pass so it can leave a heartbeat. A run that finds
  // nothing to send writes nothing otherwise, which makes "working" and "never
  // fired" indistinguishable in the log.
  return run(undefined, 'cron')
}

/**
 * Manual "send now": a signed-in user, or the cron secret.
 *
 * Accepts an optional { commitment_id } to send just that one task immediately —
 * a task handed to someone mid-week is useless if they hear about it tomorrow,
 * and the Slack message is also what makes "reply done" possible at all.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { commitment_id?: string }
  const commitmentId = body.commitment_id

  if (!hasCronSecret(req)) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json(
        { error: 'Not signed in, and no valid cron secret' },
        { status: 401 },
      )
    }

    // The send itself runs with the service role, so the caller's authority has
    // to be established first. This read goes through the caller's own client,
    // which means RLS — not this handler — decides whether they may see the task.
    if (commitmentId) {
      const { data: visible } = await supabase
        .from('weekly_commitments')
        .select('id')
        .eq('id', commitmentId)
        .maybeSingle()
      if (!visible) {
        return NextResponse.json({ error: 'No access to that task' }, { status: 403 })
      }
    }
  }

  return run(commitmentId)
}

async function run(commitmentId?: string, source: 'cron' | 'manual' = 'manual') {
  // The service client comes first so a scheduled pass can leave a heartbeat even
  // when it cannot send anything. Bailing out before writing one would mean a cron
  // that ran and failed looked identical to a cron that never ran — which is the
  // exact ambiguity the heartbeat exists to remove.
  const service = tryServiceClient()
  if (!service.ok) return NextResponse.json({ error: service.error }, { status: 500 })
  const sb = service.sb

  const slackOn = slackConfigured()
  const mailOn = mailConfigured()
  if (!slackOn && !mailOn) {
    const detail = 'cron: no channel configured — set SLACK_BOT_TOKEN or RESEND_API_KEY + NOTIFY_FROM_EMAIL'
    if (source === 'cron') {
      await logNotification(sb, { channel: 'app', event: 'run', status: 'failed', detail })
    }
    return NextResponse.json(
      { error: 'Neither Slack nor email is configured. Set SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET, or RESEND_API_KEY + NOTIFY_FROM_EMAIL.' },
      { status: 500 },
    )
  }

  const today = todayISO()
  const horizon = new Date(Date.now() + HORIZON_DAYS * 86400_000).toISOString().slice(0, 10)

  // Service role, because cron has no session. Scoped tightly: open, not yet
  // notified, and actually due soon — never a blanket read of the table.
  const COLUMNS =
    'id, title, description, due_date, assignee_id, creator_id, meeting_id, notify_slack, notify_email,' +
    ' meeting:meetings(meeting_date),' +
    ' assignee:profiles!weekly_commitments_assignee_id_fkey(id, full_name, email, slack_user_id),' +
    ' creator:profiles!weekly_commitments_creator_id_fkey(id, full_name, slack_user_id)'

  let query = sb.from('weekly_commitments').select(COLUMNS).eq('status', 'open')

  if (commitmentId) {
    // An explicit request skips both the horizon and the already-notified filter:
    // the user asked for this task, now. Re-sending replaces slack_ts, so replies
    // land on the newest message rather than a stale thread.
    query = query.eq('id', commitmentId)
  } else {
    query = query.is('notified_at', null).or(`due_date.is.null,due_date.lte.${horizon}`).limit(50)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: `Could not read tasks: ${error.message}` }, { status: 500 })
  }

  const rows = (data || []) as unknown as Row[]
  const results: { id: string; slack?: string; email?: string }[] = []

  for (const row of rows) {
    const assignee = normalizeOne(row.assignee)
    const outcome: { id: string; slack?: string; email?: string } = { id: row.id }

    if (!assignee?.id) {
      outcome.slack = 'skipped: no assignee'
      await logNotification(sb, {
        commitment_id: row.id, channel: 'app', event: 'notify', status: 'skipped',
        detail: 'no assignee',
      })
      results.push(outcome)
      continue
    }

    const dueLabel = row.due_date ? describeDue(row.due_date, today) : 'No due date'
    const overdue = Boolean(row.due_date && row.due_date < today)
    const creator = normalizeOne(row.creator)
    const askedBy = creator?.full_name || 'Someone on your team'
    const meetingDate = normalizeOne(row.meeting)?.meeting_date ?? null
    let delivered = false

    if (slackOn && row.notify_slack) {
      const res = await sendSlack(sb, { row, assignee, dueLabel, askedBy, meetingDate, overdue, creator })
      outcome.slack = res
      if (res === 'sent') delivered = true
    }

    if (mailOn && row.notify_email && assignee.email) {
      const res = await sendEmail(sb, { row, assignee, dueLabel, askedBy, meetingDate, overdue, creator })
      outcome.email = res
      if (res === 'sent') delivered = true
    }

    // Only claim it's notified if something actually went out, so a transient
    // failure gets retried on the next run instead of being silently dropped.
    if (delivered) {
      await sb.from('weekly_commitments').update({ notified_at: new Date().toISOString() }).eq('id', row.id)
    }

    results.push(outcome)
  }

  const notified = results.filter(r => r.slack === 'sent' || r.email === 'sent').length

  /*
   * The heartbeat. Written on every scheduled pass, including the quiet ones.
   *
   * Without it the log only records sends, so a cron that never fires looks
   * exactly like a cron that fires and finds nothing due — and the difference is
   * the whole notification system silently not running.
   */
  if (source === 'cron') {
    const failures = results.filter(
      r => (r.slack && r.slack !== 'sent') || (r.email && r.email !== 'sent'),
    ).length
    await logNotification(sb, {
      channel: 'app',
      event: 'run',
      status: failures > 0 ? 'failed' : 'ok',
      detail: `cron: considered ${rows.length}, notified ${notified}` +
        (failures > 0 ? `, ${failures} with a problem` : ''),
    })
  }

  return NextResponse.json({
    considered: rows.length,
    notified,
    channels: { slack: slackOn, email: mailOn },
    results,
  })
}

/** PostgREST returns an embedded relation as an array even when it's to-one. */
function normalizeOne<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? value[0] ?? null : value
}

type SendArgs = {
  row: Row
  assignee: { id: string; full_name: string | null; email: string | null; slack_user_id: string | null }
  dueLabel: string
  askedBy: string
  meetingDate: string | null
  /** Computed once from the loop's `today`, so it cannot disagree with dueLabel. */
  overdue: boolean
  creator: { id: string; full_name: string | null; slack_user_id: string | null } | null
}

async function sendSlack(
  sb: ReturnType<typeof serviceClient>,
  { row, assignee, dueLabel, askedBy, meetingDate, creator }: SendArgs,
): Promise<string> {
  let slackUserId = assignee.slack_user_id

  if (!slackUserId) {
    if (!assignee.email) return 'skipped: no email to look up in Slack'
    const { userId, error } = await lookupUserByEmail(assignee.email)
    if (!userId) {
      await logNotification(sb, {
        commitment_id: row.id, user_id: assignee.id, channel: 'slack', event: 'notify',
        status: 'failed', detail: `users.lookupByEmail: ${error}`,
      })
      return `failed: ${error}`
    }
    slackUserId = userId
    // Cached so the next send is one API call, not two.
    await sb.from('profiles').update({ slack_user_id: slackUserId }).eq('id', assignee.id)
  }

  // A user id as the channel opens or reuses the DM.
  const { data, error } = await postMessage({
    channel: slackUserId,
    text: `Hi ${firstName(assignee.full_name)} — ${escapeMrkdwn(row.title)} (${dueLabel})`,
    blocks: taskBlocks({
      title: row.title, dueLabel, askedBy, meetingDate, commitmentId: row.id,
      notes: row.description,
    }),
  })

  if (error || !data) {
    await logNotification(sb, {
      commitment_id: row.id, user_id: assignee.id, channel: 'slack', event: 'notify',
      status: 'failed', detail: `chat.postMessage: ${error}`,
    })
    return `failed: ${error}`
  }

  // The thread anchor: a "done" reply is matched back to this task by these two.
  await sb
    .from('weekly_commitments')
    .update({ slack_channel: data.channel, slack_ts: data.ts })
    .eq('id', row.id)

  await logNotification(sb, {
    commitment_id: row.id, user_id: assignee.id, channel: 'slack', event: 'notify',
    status: 'sent', detail: `dm ${data.channel}`,
  })

  await confirmToAssigner(sb, { row, assignee, creator, dueLabel })
  return 'sent'
}

/**
 * Tells whoever handed out the task that it landed.
 *
 * Only when the task went to someone else — nobody needs telling they told
 * themselves — and only once the assignee's DM has actually been delivered, so
 * this can never claim a send that did not happen.
 *
 * Failures are logged and swallowed. The assignee has the task either way, and
 * failing the whole send over a courtesy note would mean retrying a DM that
 * already arrived.
 */
async function confirmToAssigner(
  sb: ReturnType<typeof serviceClient>,
  { row, assignee, creator, dueLabel }: Pick<SendArgs, 'row' | 'assignee' | 'creator' | 'dueLabel'>,
): Promise<void> {
  if (!creator?.id || creator.id === assignee.id) return
  if (!creator.slack_user_id) return

  const { text, blocks } = assignerConfirmationBlocks({
    title: row.title,
    toName: assignee.full_name || 'them',
    dueLabel,
  })

  const { error } = await postMessage({ channel: creator.slack_user_id, text, blocks })

  await logNotification(sb, {
    commitment_id: row.id,
    user_id: creator.id,
    channel: 'slack',
    event: 'notify',
    status: error ? 'failed' : 'sent',
    detail: error ? `assigner confirmation: ${error}` : 'assigner confirmation',
  })
}

async function sendEmail(
  sb: ReturnType<typeof serviceClient>,
  { row, assignee, dueLabel, askedBy, meetingDate, overdue }: SendArgs,
): Promise<string> {
  if (!assignee.email) return 'skipped: no email address'

  let completeUrl: string
  try {
    completeUrl = `${appBaseUrl()}/api/tasks/done?token=${signActionToken(row.id)}`
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'token signing failed'
    await logNotification(sb, {
      commitment_id: row.id, user_id: assignee.id, channel: 'email', event: 'notify',
      status: 'failed', detail,
    })
    return `failed: ${detail}`
  }

  const { subject, html, text } = taskEmail({
    firstName: firstName(assignee.full_name),
    title: row.title,
    dueLabel,
    askedBy,
    meetingDate,
    completeUrl,
    notes: row.description,
    dueDate: row.due_date,
    // A task you wrote for yourself should not claim someone assigned it to you.
    selfAssigned: row.creator_id === assignee.id,
    overdue,
  })

  const { error } = await sendMail({ to: assignee.email, subject, html, text })
  if (error) {
    await logNotification(sb, {
      commitment_id: row.id, user_id: assignee.id, channel: 'email', event: 'notify',
      status: 'failed', detail: error,
    })
    return `failed: ${error}`
  }

  await logNotification(sb, {
    commitment_id: row.id, user_id: assignee.id, channel: 'email', event: 'notify',
    status: 'sent', detail: '',
  })
  return 'sent'
}
