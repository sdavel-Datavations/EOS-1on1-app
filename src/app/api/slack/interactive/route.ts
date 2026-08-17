import { NextResponse } from 'next/server'
import { verifySlackSignature, getUserEmail } from '@/lib/slack'
import {
  serviceClient,
  findTaskById,
  profileForSlackUser,
  completeTask,
  logNotification,
} from '@/lib/complete-task'

/** The "Mark done" button. Unlike a thread reply, this needs no interpretation. */
export async function POST(req: Request) {
  const rawBody = await req.text()

  const verdict = verifySlackSignature({
    rawBody,
    timestamp: req.headers.get('x-slack-request-timestamp'),
    signature: req.headers.get('x-slack-signature'),
  })
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: 401 })
  }

  // Interactivity arrives form-encoded with the JSON in a `payload` field.
  const payloadRaw = new URLSearchParams(rawBody).get('payload')
  if (!payloadRaw) return NextResponse.json({ error: 'Missing payload' }, { status: 400 })

  let payload: {
    type?: string
    user?: { id?: string }
    actions?: { action_id?: string; value?: string }[]
  }
  try {
    payload = JSON.parse(payloadRaw)
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const action = payload.actions?.[0]
  const slackUserId = payload.user?.id
  if (payload.type !== 'block_actions' || action?.action_id !== 'mark_done' || !action.value || !slackUserId) {
    return NextResponse.json({ ok: true })
  }

  const sb = serviceClient()

  const task = await findTaskById(sb, action.value)
  if (!task) {
    return NextResponse.json({ response_type: 'ephemeral', text: "That task no longer exists." })
  }

  const profile = await profileForSlackUser(sb, slackUserId, getUserEmail)
  if (!profile) {
    await logNotification(sb, {
      commitment_id: task.id,
      channel: 'slack',
      event: 'error',
      status: 'failed',
      detail: `no profile matches Slack user ${slackUserId}`,
    })
    return NextResponse.json({
      response_type: 'ephemeral',
      text: "I couldn't match your Slack account to a 1-on-1 profile, so I've left this open.",
    })
  }

  const result = await completeTask(sb, task, profile.id, 'slack_button')
  if (!result.ok) {
    return NextResponse.json({ response_type: 'ephemeral', text: `Couldn't close that: ${result.error}` })
  }

  // replace_original rewrites the message in place, so the button can't be
  // pressed again and the message reflects reality.
  return NextResponse.json({
    replace_original: true,
    text: `✅ ${task.title}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *${task.title}*\nClosed by <@${slackUserId}>${result.alreadyDone ? ' (was already done)' : ''}`,
        },
      },
    ],
  })
}
