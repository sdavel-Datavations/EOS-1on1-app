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

export async function sendMail(args: {
  to: string
  subject: string
  html: string
  text: string
}): Promise<{ error?: string }> {
  const key = process.env.RESEND_API_KEY
  const from = process.env.NOTIFY_FROM_EMAIL
  if (!key || !from) return { error: 'RESEND_API_KEY or NOTIFY_FROM_EMAIL is not configured' }

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
}): { subject: string; html: string; text: string } {
  const context = args.meetingDate
    ? `${args.askedBy} raised this in your 1-on-1 on ${args.meetingDate}.`
    : `${args.askedBy} added this during the week.`

  const subject = `${args.dueLabel}: ${args.title}`

  const text = [
    `Hi ${args.firstName},`,
    '',
    args.title,
    args.dueLabel,
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
