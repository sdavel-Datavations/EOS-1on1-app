/**
 * Quarter arithmetic for Rocks.
 *
 * Works on YYYY-MM-DD strings for the same reason the due-date logic does: a Rock
 * belongs to a calendar quarter, and parsing a plain date into a Date object shifts
 * it by the viewer's UTC offset — which on 1 January or 1 July would place a Rock
 * in the wrong quarter entirely.
 */

export type Quarter = string // '2026-Q3'

export function quarterOf(dateISO: string): Quarter {
  const year = dateISO.slice(0, 4)
  const month = Number(dateISO.slice(5, 7))
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`
}

export function quarterLabel(q: Quarter): string {
  const [year, quarter] = q.split('-Q')
  const names: Record<string, string> = {
    '1': 'Jan–Mar',
    '2': 'Apr–Jun',
    '3': 'Jul–Sep',
    '4': 'Oct–Dec',
  }
  return `Q${quarter} ${year} · ${names[quarter] || ''}`.trim()
}

/** First and last day of the quarter, inclusive. */
export function quarterRange(q: Quarter): { start: string; end: string } {
  const [yearStr, quarterStr] = q.split('-Q')
  const year = Number(yearStr)
  const quarter = Number(quarterStr)
  const startMonth = (quarter - 1) * 3 + 1
  const endMonth = startMonth + 2
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    start: `${year}-${pad(startMonth)}-01`,
    end: `${year}-${pad(endMonth)}-${pad(lastDay)}`,
  }
}

export function shiftQuarter(q: Quarter, by: number): Quarter {
  const [yearStr, quarterStr] = q.split('-Q')
  // Zero-based quarter index across years, so December → January needs no special case.
  const index = Number(yearStr) * 4 + (Number(quarterStr) - 1) + by
  return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`
}

/** Quarters offered when creating a Rock: this one and the next. */
export function selectableQuarters(dateISO: string): Quarter[] {
  const current = quarterOf(dateISO)
  return [current, shiftQuarter(current, 1)]
}

export function isValidQuarter(q: string): boolean {
  return /^\d{4}-Q[1-4]$/.test(q)
}
