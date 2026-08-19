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

/** The email twin of the Slack task message. */
export function taskEmail(args: {
  firstName: string
  title: string
  dueLabel: string
  askedBy: string
  meetingDate: string | null
  completeUrl: string
  notes?: string | null
}): { subject: string; html: string; text: string } {
  const notes = (args.notes || '').trim()
  const context = args.meetingDate
    ? `${args.askedBy} raised this in your 1-on-1 on ${args.meetingDate}.`
    : `${args.askedBy} added this during the week.`

  const subject = `${args.dueLabel}: ${args.title}`

  const text = [
    `Hi ${args.firstName},`,
    '',
    args.title,
    args.dueLabel,
    ...(notes ? ['', notes] : []),
    '',
    context,
    '',
    `Mark it done: ${args.completeUrl}`,
  ].join('\n')

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;color:#1a1a1a">
  <p>Hi ${escapeHtml(args.firstName)},</p>
  <p style="font-size:17px;font-weight:600;margin:0 0 4px">${escapeHtml(args.title)}</p>
  <p style="margin:0 0 16px;color:#666;font-size:14px">${escapeHtml(args.dueLabel)}</p>
  ${notes ? `<div style="white-space:pre-wrap;border-left:3px solid #e5e5e5;padding-left:12px;margin:0 0 16px;font-size:14px;line-height:1.5">${escapeHtml(notes)}</div>` : ''}
  <p style="color:#666;font-size:14px">${escapeHtml(context)}</p>
  <p style="margin:24px 0">
    <a href="${escapeHtml(args.completeUrl)}"
       style="background:#2b7ba8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px">
      Mark done
    </a>
  </p>
  <p style="color:#999;font-size:12px">Datavations · Weekly 1-on-1</p>
</div>`.trim()

  return { subject, html, text }
}
