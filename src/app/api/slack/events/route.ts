import { NextResponse } from 'next/server'
import { verifySlackSignature, postMessage, getUserEmail, slackConfigured } from '@/lib/slack'
import { isDoneComment } from '@/lib/done-intent'
import {
  serviceClient,
  findTaskByThread,
  profileForSlackUser,
  completeTask,
  logNotification,
} from '@/lib/complete-task'

/**
 * Slack Events API endpoint — replying "done" in a task's thread closes it.
 *
 * Slack expects a 200 within three seconds and retries otherwise, so every
 * outcome short of a failed signature check answers 200. A retry that arrives
 * anyway is harmless: completeTask is idempotent.
 */
export async function POST(req: Request) {
  // The raw bytes, because the signature covers them exactly. Parsing first and
  // re-serialising changes whitespace and key order, and the HMAC won't match.
  const rawBody = await req.text()

  const verdict = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get('x-slack-request-timestamp'),
    signature: req.headers.get('x-slack-signature'),
  })
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: 401 })
  }

  let body: {
    type?: string
    challenge?: string
    event?: {
      type?: string
      subtype?: string
      bot_id?: string
      user?: string
      text?: string
      channel?: string
      thread_ts?: string
      ts?: string
    }
  }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // One-time handshake when the URL is first saved in the Slack app config.
  if (body.type === 'url_verification') {
    return NextResponse.json({ challenge: body.challenge })
  }

  const event = body.event
  if (body.type !== 'event_callback' || event?.type !== 'message') {
    return NextResponse.json({ ok: true })
  }

  // Our own confirmations land in these threads too; answering them would loop.
  if (event.bot_id || event.subtype) return NextResponse.json({ ok: true })

  const { channel, thread_ts: threadTs, user: slackUserId, text } = event
  // No thread_ts means a top-level message, which answers no particular task.
  if (!channel || !threadTs || !slackUserId || !text) return NextResponse.json({ ok: true })

  if (!isDoneComment(text)) return NextResponse.json({ ok: true })

  const sb = serviceClient()

  const task = await findTaskByThread(sb, channel, threadTs)
  if (!task) return NextResponse.json({ ok: true })

  const profile = await profileForSlackUser(sb, slackUserId, getUserEmail)
  if (!profile) {
    await logNotification(sb, {
      commitment_id: task.id,
      channel: 'slack',
      event: 'error',
      status: 'failed',
      detail: `no profile matches Slack user ${slackUserId}`,
    })
    if (slackConfigured()) {
      await postMessage({
        channel,
        thread_ts: threadTs,
        text: "I couldn't match your Slack account to a 1-on-1 profile, so I've left this open. Sign in with the same email and try again.",
      })
    }
    return NextResponse.json({ ok: true })
  }

  const result = await completeTask(sb, task, profile.id, 'slack_reply')

  await postMessage({
    channel,
    thread_ts: threadTs,
    text: result.ok
      ? result.alreadyDone
        ? `Already closed — “${task.title}” was done before this.`
        : `Done. “${task.title}” is closed.`
      : `Couldn't close that: ${result.error}`,
  })

  return NextResponse.json({ ok: true })
}
