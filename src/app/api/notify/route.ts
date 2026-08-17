import { NextResponse } from 'next/server'
import { postMessage, lookupUserByEmail, taskBlocks, slackConfigured, escapeMrkdwn } from '@/lib/slack'
import { sendMail, mailConfigured, taskEmail, appBaseUrl } from '@/lib/mail'
import { signActionToken } from '@/lib/action-token'
import { serviceClient, logNotification } from '@/lib/complete-task'
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
  due_date: string | null
  assignee_id: string | null
  creator_id: string | null
  meeting_id: string | null
  notify_slack: boolean
  notify_email: boolean
  meeting: { meeting_date: string } | null
  assignee: { id: string; full_name: string | null; email: string | null; slack_user_id: string | null } | null
  creator: { full_name: string | null } | null
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
  return run()
}

/** Manual "send now": a signed-in user, or the cron secret. */
export async function POST(req: Request) {
  if (!hasCronSecret(req)) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json(
        { error: 'Not signed in, and no valid cron secret' },
        { status: 401 },
      )
    }
  }
  return run()
}

async function run() {

  const slackOn = slackConfigured()
  const mailOn = mailConfigured()
  if (!slackOn && !mailOn) {
    return NextResponse.json(
      { error: 'Neither Slack nor email is configured. Set SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET, or RESEND_API_KEY + NOTIFY_FROM_EMAIL.' },
      { status: 500 },
    )
  }

  const today = todayISO()
  const horizon = new Date(Date.now() + HORIZON_DAYS * 86400_000).toISOString().slice(0, 10)

  const sb = serviceClient()

  // Service role, because cron has no session. Scoped tightly: open, not yet
  // notified, and actually due soon — never a blanket read of the table.
  const { data, error } = await sb
    .from('weekly_commitments')
    .select(
      'id, title, due_date, assignee_id, creator_id, meeting_id, notify_slack, notify_email,' +
        ' meeting:meetings(meeting_date),' +
        ' assignee:profiles!weekly_commitments_assignee_id_fkey(id, full_name, email, slack_user_id),' +
        ' creator:profiles!weekly_commitments_creator_id_fkey(full_name)',
    )
    .eq('status', 'open')
    .is('notified_at', null)
    .or(`due_date.is.null,due_date.lte.${horizon}`)
    .limit(50)

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
    const askedBy = normalizeOne(row.creator)?.full_name || 'Someone on your team'
    const meetingDate = normalizeOne(row.meeting)?.meeting_date ?? null
    let delivered = false

    if (slackOn && row.notify_slack) {
      const res = await sendSlack(sb, { row, assignee, dueLabel, askedBy, meetingDate })
      outcome.slack = res
      if (res === 'sent') delivered = true
    }

    if (mailOn && row.notify_email && assignee.email) {
      const res = await sendEmail(sb, { row, assignee, dueLabel, askedBy, meetingDate })
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

  return NextResponse.json({
    considered: rows.length,
    notified: results.filter(r => r.slack === 'sent' || r.email === 'sent').length,
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
}

async function sendSlack(
  sb: ReturnType<typeof serviceClient>,
  { row, assignee, dueLabel, askedBy, meetingDate }: SendArgs,
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
    blocks: taskBlocks({ title: row.title, dueLabel, askedBy, meetingDate, commitmentId: row.id }),
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
  return 'sent'
}

async function sendEmail(
  sb: ReturnType<typeof serviceClient>,
  { row, assignee, dueLabel, askedBy, meetingDate }: SendArgs,
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
