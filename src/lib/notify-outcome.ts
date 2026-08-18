/**
 * Reading the per-channel results of a notification send.
 *
 * The route reports each channel separately, and the old caller collapsed that
 * with `slack === 'sent' || email === 'sent'`. Slack sending was therefore enough
 * to report success, so a failing email said nothing in the UI and existed only
 * in notification_log. Someone asking "why didn't I get an email" was told the
 * task had been sent.
 */

export type ChannelOutcome = { slack?: string; email?: string }

export interface NotifySummary {
  /** Channels that actually delivered. */
  sent: string[]
  /** Channels that were asked for and did not deliver, and why. */
  problems: { channel: string; reason: string }[]
}

const CHANNELS = ['slack', 'email'] as const

const LABEL: Record<string, string> = { slack: 'Slack', email: 'Email' }

export function summarizeNotify(outcome: ChannelOutcome | null | undefined): NotifySummary {
  const sent: string[] = []
  const problems: { channel: string; reason: string }[] = []

  for (const channel of CHANNELS) {
    const value = outcome?.[channel]
    // Absent means the task never asked for this channel. Not a problem.
    if (!value) continue
    if (value === 'sent') {
      sent.push(channel)
      continue
    }
    // 'skipped: no email address' is not an error, but it is still a reason
    // nothing arrived — which is precisely what the person asking needs.
    problems.push({ channel, reason: value.replace(/^skipped:\s*/i, '') })
  }

  return { sent, problems }
}

function endStopped(reason: string): string {
  const trimmed = reason.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function listOf(channels: string[]): string {
  const names = channels.map(c => LABEL[c] || c)
  if (names.length <= 1) return names[0] || ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * One sentence naming what went out and what did not.
 *
 * A partial send has to read as a partial send. "Sent" alone, when only one of
 * two channels worked, is the thing that hid a broken email setup for a day.
 */
export function notifyNotice(summary: NotifySummary, who: string): string {
  const { sent, problems } = summary

  if (problems.length === 0) {
    return sent.length
      ? `Sent to ${who} by ${listOf(sent)}.`
      : 'Nothing was sent — no channel is configured for this task.'
  }

  const head = sent.length ? `Sent to ${who} by ${listOf(sent)}.` : `Not sent to ${who}.`
  // Vendor messages sometimes end in a full stop and sometimes do not, and a
  // reason that trails off mid-sentence reads as truncated rather than terse.
  const detail = problems
    .map(p => `${LABEL[p.channel] || p.channel} failed: ${endStopped(p.reason)}`)
    .join(' ')
  return `${head} ${detail}`
}
