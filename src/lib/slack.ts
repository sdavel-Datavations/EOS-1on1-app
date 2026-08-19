import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Minimal Slack Web API client over fetch, plus request-signature verification.
 *
 * Note Slack answers most API errors with HTTP 200 and `{ ok: false, error }`,
 * so response.ok is not a success check here.
 */

const API = 'https://slack.com/api'

/** Slack rejects requests whose timestamp is outside this window, and so do we. */
const MAX_SIGNATURE_AGE_SECONDS = 300

function botToken(): string {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN is not configured')
  return token
}

export function slackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET)
}

async function call<T>(method: string, body: unknown): Promise<T & { ok: boolean; error?: string }> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken()}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })
  return (await res.json()) as T & { ok: boolean; error?: string }
}

export type PostedMessage = { channel: string; ts: string }

export async function postMessage(args: {
  channel: string
  text: string
  blocks?: unknown[]
  thread_ts?: string
}): Promise<{ data?: PostedMessage; error?: string }> {
  const json = await call<{ channel: string; ts: string }>('chat.postMessage', args)
  if (!json.ok) return { error: json.error || 'chat.postMessage failed' }
  return { data: { channel: json.channel, ts: json.ts } }
}

/** Requires the users:read.email scope. */
export async function lookupUserByEmail(email: string): Promise<{ userId?: string; error?: string }> {
  const res = await fetch(`${API}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${botToken()}` },
  })
  const json = (await res.json()) as { ok: boolean; error?: string; user?: { id: string } }
  if (!json.ok || !json.user) return { error: json.error || 'users.lookupByEmail failed' }
  return { userId: json.user.id }
}

export async function getUserEmail(userId: string): Promise<{ email?: string; error?: string }> {
  const res = await fetch(`${API}/users.info?user=${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${botToken()}` },
  })
  const json = (await res.json()) as {
    ok: boolean
    error?: string
    user?: { profile?: { email?: string } }
  }
  if (!json.ok || !json.user?.profile?.email) return { error: json.error || 'no email on that Slack user' }
  return { email: json.user.profile.email }
}

/**
 * Verifies X-Slack-Signature over the *raw* body.
 *
 * The body must be the exact bytes Slack sent — re-serialising parsed JSON
 * changes whitespace and key order and the HMAC no longer matches. Read it with
 * `await req.text()` and parse afterwards.
 */
export function verifySlackSignature(args: {
  rawBody: string
  timestamp: string | null
  signature: string | null
  nowSeconds?: number
}): { ok: true } | { ok: false; error: string } {
  const secret = process.env.SLACK_SIGNING_SECRET
  if (!secret) return { ok: false, error: 'SLACK_SIGNING_SECRET is not configured' }
  if (!args.timestamp || !args.signature) return { ok: false, error: 'Missing Slack signature headers' }

  const ts = Number(args.timestamp)
  if (!Number.isFinite(ts)) return { ok: false, error: 'Bad Slack timestamp' }

  // Replay window. Without this a captured request stays valid forever.
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > MAX_SIGNATURE_AGE_SECONDS) {
    return { ok: false, error: 'Slack timestamp outside the replay window' }
  }

  const expected =
    'v0=' + createHmac('sha256', secret).update(`v0:${args.timestamp}:${args.rawBody}`).digest('hex')

  const a = Buffer.from(expected)
  const b = Buffer.from(args.signature)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'Slack signature mismatch' }
  }
  return { ok: true }
}

/** A task message: the ask, its context, and an unambiguous way to close it. */
export function taskBlocks(args: {
  title: string
  dueLabel: string
  askedBy: string
  meetingDate: string | null
  commitmentId: string
  notes?: string | null
}): unknown[] {
  const notes = clip((args.notes || '').trim(), 700)
  const context = args.meetingDate
    ? `${args.askedBy} · from your 1-on-1 on ${args.meetingDate}`
    : `${args.askedBy} · added during the week`

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escapeMrkdwn(args.title)}*\n${args.dueLabel}` },
    },
    // The context someone was given the task with. Without it the DM is a title
    // and a date, and the assignee has to come and ask what was actually meant.
    ...(notes
      ? [{ type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(notes) } }]
      : []),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: context }],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: 'mark_done',
          style: 'primary',
          text: { type: 'plain_text', text: 'Mark done' },
          value: args.commitmentId,
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Or just reply “done” in this thread._' }],
    },
  ]
}

/**
 * Trims to a length that still reads as a message rather than a document.
 * Slack accepts 3000 characters in a section, but a DM that long gets skimmed and
 * the Mark done button scrolls off. The full text stays in the app.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  // Break on a word so the cut does not land mid-word.
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** Slack mrkdwn treats these as formatting; a task title is literal text. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Rewrites a message already sent. Requires chat:write, and only works on a
 * message this bot posted.
 *
 * This is what keeps Slack and the app from disagreeing: a task closed anywhere —
 * the web app, an emailed link, a reply, the button — leaves a Slack message
 * still showing a live "Mark done" button unless the message itself is rewritten.
 */
export async function updateMessage(args: {
  channel: string
  ts: string
  text: string
  blocks?: unknown[]
}): Promise<{ error?: string }> {
  const json = await call<Record<string, never>>('chat.update', args)
  return json.ok ? {} : { error: json.error || 'chat.update failed' }
}

/** The closed state: no button, and a record of who closed it and how. */
export function closedBlocks(args: {
  title: string
  byName?: string | null
  via?: string | null
}): { text: string; blocks: unknown[] } {
  const how: Record<string, string> = {
    app: 'in the app',
    slack_reply: 'by replying here',
    slack_button: 'from this message',
    email_link: 'from the email link',
  }
  const detail = [args.byName ? `Closed by ${args.byName}` : 'Closed', args.via ? how[args.via] || args.via : '']
    .filter(Boolean)
    .join(' ')

  return {
    text: `✅ ${args.title}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `✅ ~${escapeMrkdwn(args.title)}~` },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: detail }] },
    ],
  }
}

/** Reopened in the app: the button comes back, because it works again. */
export function reopenedBlocks(args: { title: string; commitmentId: string }): {
  text: string
  blocks: unknown[]
} {
  return {
    text: args.title,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${escapeMrkdwn(args.title)}*\nReopened` } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'mark_done',
            style: 'primary',
            text: { type: 'plain_text', text: 'Mark done' },
            value: args.commitmentId,
          },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Or just reply “done” in this thread._' }] },
    ],
  }
}
