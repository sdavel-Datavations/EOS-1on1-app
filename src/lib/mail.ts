import { Resend } from 'resend'

export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM_EMAIL)
}

/**
 * Public base URL, for links that have to work from someone's inbox.
 * VERCEL_PROJECT_PRODUCTION_URL is injected by Vercel and points at the stable
 * production domain, unlike VERCEL_URL which is per-deployment.
 */
export function appBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  return 'http://localhost:3000'
}


/**
 * Normalises NOTIFY_FROM_EMAIL into something Resend accepts.
 *
 * Resend rejects anything that isn't `a@b.c` or `Name <a@b.c>`, and the ways a
 * correct-looking value fails that are invisible on screen: a stray newline from a
 * copy-paste, surrounding quotes kept literally by the dashboard, or a display
 * name without angle brackets. Rather than fail with Resend's generic message,
 * repair what is repairable and say precisely what is wrong otherwise.
 */
export function normalizeFromAddress(raw: string | undefined): { from?: string; error?: string } {
  let value = (raw || '').replace(/[\r\n\t]+/g, ' ').trim()
  if (!value) return { error: 'NOTIFY_FROM_EMAIL is empty' }

  // Dashboards often keep quotes as part of the value.
  const quoted = value.match(/^(['"])(.*)\1$/)
  if (quoted) value = quoted[2].trim()
  value = value.replace(/\s+/g, ' ')

  const BARE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/
  const NAMED = /^(.+?)\s*<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>$/

  if (BARE.test(value)) return { from: value }

  const named = value.match(NAMED)
  if (named) return { from: `${named[1].replace(/^["']|["']$/g, '').trim()} <${named[2]}>` }

  // "Datavations 1-on-1 1on1@example.com" — a display name with the brackets
  // forgotten, which is the most common way this goes wrong.
  const parts = value.split(' ')
  const last = parts[parts.length - 1]
  if (parts.length > 1 && BARE.test(last)) {
    return { from: `${parts.slice(0, -1).join(' ')} <${last}>` }
  }

  if (!value.includes('@')) {
    return {
      error: `NOTIFY_FROM_EMAIL must be an address, not a domain — try 1on1@${value.replace(/^@/, '')}`,
    }
  }

  return { error: `NOTIFY_FROM_EMAIL is not a valid address: "${value}"` }
}

export async function sendMail(args: {
  to: string
  subject: string
  html: string
  text: string
}): Promise<{ error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { error: 'RESEND_API_KEY is not configured' }

  const { from, error: fromError } = normalizeFromAddress(process.env.NOTIFY_FROM_EMAIL)
  if (!from) return { error: fromError || 'NOTIFY_FROM_EMAIL is not configured' }

  try {
    const { error } = await new Resend(key).emails.send({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    })
    return error ? { error: error.message } : {}
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'send failed' }
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * '2026-08-20' -> 'Thu 20 Aug 2026'.
 *
 * Built from the parts in UTC rather than parsed from the string: new
 * Date('2026-08-20') is UTC midnight, which prints as the 19th anywhere west of
 * Greenwich — so a task due tomorrow would name yesterday in the email.
 */
export function formatDueDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return ''
  const dt = new Date(Date.UTC(y, m - 1, d))
  return `${DAYS[dt.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`
}

/**
 * The subject line has one job: say that work has been handed to you, by whom,
 * and when it is wanted — in that order, because an inbox shows the front of the
 * line and little else. "Tomorrow: Test" met none of that.
 */
export function taskSubject(args: {
  title: string
  askedBy: string
  dueLabel: string
  hasDueDate: boolean
  selfAssigned?: boolean
  overdue?: boolean
}): string {
  const head = args.selfAssigned
    ? `New task: ${args.title}`
    : `${args.askedBy} assigned you a task: ${args.title}`
  if (!args.hasDueDate) return head
  // "3 days overdue" already reads as a sentence; "Tomorrow" needs the verb.
  return args.overdue
    ? `${head} — ${args.dueLabel.toLowerCase()}`
    : `${head} — due ${args.dueLabel.toLowerCase()}`
}

/** The email twin of the Slack task message. */
export function taskEmail(args: {
  firstName: string
  title: string
  dueLabel: string
  askedBy: string
  meetingDate: string | null
  completeUrl: string
  notes?: string | null
  dueDate?: string | null
  selfAssigned?: boolean
  overdue?: boolean
}): { subject: string; html: string; text: string } {
  const notes = (args.notes || '').trim()
  const hasDueDate = Boolean(args.dueDate)

  const subject = taskSubject({
    title: args.title,
    askedBy: args.askedBy,
    dueLabel: args.dueLabel,
    hasDueDate,
    selfAssigned: args.selfAssigned,
    overdue: args.overdue,
  })

  const dueText = hasDueDate
    ? `${args.overdue ? args.dueLabel : `Due ${args.dueLabel.toLowerCase()}`} · ${formatDueDate(args.dueDate)}`
    : 'No due date'

  const who = args.selfAssigned
    ? 'You added this task for yourself.'
    : `${args.askedBy} assigned you a task.`

  const origin = args.meetingDate
    ? `Raised in your 1-on-1 on ${formatDueDate(args.meetingDate) || args.meetingDate}.`
    : 'Added during the week.'

  const text = [
    `Hi ${args.firstName},`,
    '',
    who,
    '',
    `TASK: ${args.title}`,
    dueText,
    ...(notes ? ['', notes] : []),
    '',
    origin,
    '',
    `Mark it done: ${args.completeUrl}`,
  ].join('\n')

  const dueColour = args.overdue ? '#e74c3c' : '#666'
  // The accent bar carries the same signal as the date text. A blue bar on a task
  // three days late reads as fine at a glance, which is the glance that matters.
  const accent = args.overdue ? '#e74c3c' : '#2b7ba8'

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;color:#1a1a1a">
  <p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5b2c6f">
    New task assigned
  </p>
  <p style="margin:0 0 4px;font-size:14px">Hi ${escapeHtml(args.firstName)},</p>
  <p style="margin:0 0 18px;font-size:14px">${escapeHtml(who)}</p>

  <div style="border:1px solid #e5e5e5;border-left:4px solid ${accent};border-radius:8px;padding:14px 16px;margin:0 0 20px">
    <p style="margin:0 0 6px;font-size:18px;font-weight:700;line-height:1.3">${escapeHtml(args.title)}</p>
    <p style="margin:0;font-size:13px;font-weight:600;color:${dueColour}">${escapeHtml(dueText)}</p>
    ${notes ? `<div style="white-space:pre-wrap;margin:12px 0 0;padding-top:12px;border-top:1px solid #eee;font-size:14px;line-height:1.5">${escapeHtml(notes)}</div>` : ''}
  </div>

  <p style="margin:0 0 20px">
    <a href="${escapeHtml(args.completeUrl)}"
       style="background:#2b7ba8;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block">
      Mark done
    </a>
  </p>

  <p style="margin:0 0 4px;color:#999;font-size:12px">${escapeHtml(origin)}</p>
  <p style="margin:0;color:#999;font-size:12px">Datavations · Weekly 1-on-1</p>
</div>`.trim()

  return { subject, html, text }
}
