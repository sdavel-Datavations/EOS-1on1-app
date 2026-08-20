/**
 * Reading the delivery log honestly.
 *
 * The panel this feeds used to call every failed row a failure, for all time. Two
 * config mistakes from one afternoon — a doubled @ and an unverified domain — sat
 * there permanently afterwards, long after email was working, which is the fastest
 * way to teach someone to ignore a monitoring panel.
 *
 * A failure is answered by a later success on the same channel. That is what these
 * functions decide, and why the count means "broken now" rather than "ever broke".
 */

export type DeliveryRow = {
  created_at: string
  channel: string
  event: string
  status: string
  detail: string | null
}

/** The channels that actually deliver something. `app` rows are audit, not delivery. */
export const DELIVERY_CHANNELS = ['slack', 'email'] as const

/**
 * Timestamps, not plain dates, so Date.parse is safe here: these carry an explicit
 * offset from Postgres. The YYYY-MM-DD rule the rest of the app follows exists
 * because a bare date parses as UTC midnight — that hazard does not apply.
 */
function isAfter(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b)
}

export function channelIsHealthy(
  lastSent: string | null,
  lastFailed: string | null,
): boolean {
  if (!lastFailed) return true
  if (!lastSent) return false
  return isAfter(lastSent, lastFailed)
}

/**
 * Splits failures into the ones still standing and the ones a later send answered.
 *
 * `lastSent` is per channel, because Slack working says nothing about email.
 */
export function partitionProblems(
  rows: DeliveryRow[],
  lastSent: Record<string, string | null>,
): { live: DeliveryRow[]; resolved: DeliveryRow[] } {
  const live: DeliveryRow[] = []
  const resolved: DeliveryRow[] = []
  for (const row of rows) {
    if (row.status !== 'failed') continue
    const success = lastSent[row.channel]
    if (success && isAfter(success, row.created_at)) resolved.push(row)
    else live.push(row)
  }
  return { live, resolved }
}

/** One line per channel, for the summary at the top. */
export function channelSummary(
  lastSent: Record<string, string | null>,
  lastFailed: Record<string, string | null>,
): { channel: string; healthy: boolean; lastSent: string | null; lastFailed: string | null }[] {
  return DELIVERY_CHANNELS.map(channel => ({
    channel,
    healthy: channelIsHealthy(lastSent[channel] ?? null, lastFailed[channel] ?? null),
    lastSent: lastSent[channel] ?? null,
    lastFailed: lastFailed[channel] ?? null,
  }))
}

/**
 * What to say about a channel in one line.
 *
 * "Never used" is deliberately distinct from "healthy": a channel that has sent
 * nothing has proved nothing, and saying otherwise is how the cron came to look
 * fine for a fortnight while never having run.
 */
export function channelVerdict(summary: {
  healthy: boolean
  lastSent: string | null
  lastFailed: string | null
}): 'healthy' | 'failing' | 'never used' {
  if (!summary.healthy) return 'failing'
  if (!summary.lastSent) return 'never used'
  return 'healthy'
}
