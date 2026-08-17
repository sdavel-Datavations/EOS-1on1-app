import { normalizeTitle } from './dedupe'

/**
 * Parses a pasted action-item list — the kind Granola, Gemini, or Otter already
 * produce at the end of a meeting summary.
 *
 * This replaces the model call that used to do extraction. The AI work has
 * already happened in the notetaker; what's left is reading its output, which is
 * a formatting problem rather than a judgment one. Deliberately conservative:
 * anything it can't confidently read stays in the title, where a human reviewing
 * the queue will see it, rather than being guessed at and silently dropped.
 */

export type ParsedItem = {
  title: string
  /** Whatever name the line attributed it to, unresolved. */
  ownerName: string | null
  /** YYYY-MM-DD, only when the line stated something unambiguous. */
  dueDate: string | null
  /** The line exactly as pasted, kept as provenance for the reviewer. */
  raw: string
}

/** Bullets, numbers, and markdown checkboxes, in any combination. */
const LIST_MARKER = /^\s*(?:[-*•·–—+>]|\d+[.)]|\(\d+\))\s*(?:\[[ xX]\]\s*)?/

/**
 * Headings a notetaker puts above the list. Matched only when the line is
 * nothing but the heading, so "Action items for Ashley to own" stays an item.
 */
const HEADING = /^\s*(?:#{1,6}\s*)?(?:action items?|next steps?|follow[- ]?ups?|to[- ]?dos?|tasks?|decisions?|takeaways?|summary|notes?|attendees?|agenda)\s*:?\s*$/i

/** A name, or a first and last name. */
const NAME = `[\\p{L}][\\p{L}'’.-]*(?:\\s+[\\p{L}][\\p{L}'’.-]*)?`

/**
 * "[Sam] send it" — the bracket is the delimiter, so no colon or dash follows.
 * Kept separate from the punctuated form below, which requires one.
 */
const LEADING_OWNER_BRACKET = new RegExp(`^\\s*\\[(${NAME})\\]\\s*`, 'u')

/**
 * "Sam: send it" / "Sam - send it" / "Sam — send it".
 *
 * Note there is deliberately no "Sam to send it" form. It reads correctly for
 * "Ashley to review the plan" but turns "Need to send the numbers" into an owner
 * called Need and a title missing its first two words, and nothing in the line
 * distinguishes the two cases.
 */
const LEADING_OWNER = new RegExp(`^\\s*(${NAME})\\s*(?::|[-–—]\\s)\\s*`, 'u')

/** "(Sam)" / "— Sam" / "[Sam]" at the end. */
const TRAILING_OWNER = /\s*[([—–-]\s*(?:owner|assigned to)?\s*:?\s*([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*)?)\s*[)\]]?\s*$/u

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

/** Words that mean the line is a heading-ish fragment rather than an action. */
const MIN_TITLE_WORDS = 2

function toISO(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Pulls a due date out of a line and returns the line without it.
 *
 * Only patterns with one reading are accepted. "by EOW" or "next sprint" are
 * left alone — a wrong date on someone's task is worse than no date, and the
 * reviewer can see the original text either way.
 */
export function extractDueDate(
  text: string,
  reference: string,
): { text: string; dueDate: string | null } {
  const patterns: { re: RegExp; resolve: (m: RegExpMatchArray) => string | null }[] = [
    // ISO, the only fully unambiguous numeric form
    { re: /\b(?:\(?\s*(?:due|by|before)\s*:?\s*)?(\d{4})-(\d{2})-(\d{2})\)?/i,
      resolve: m => toISO(Number(m[1]), Number(m[2]), Number(m[3])) },

    // "due Aug 21" / "by August 21st"
    { re: new RegExp(`\\b(?:due|by|before)\\s*:?\\s*(${MONTHS.map(m => m.slice(0, 3)).join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'),
      resolve: m => {
        const month = MONTHS.findIndex(x => x.startsWith(m[1].toLowerCase())) + 1
        const day = Number(m[2])
        if (!month || day < 1 || day > 31) return null
        // Assume the reference year, rolling forward if that date has passed.
        const year = Number(reference.slice(0, 4))
        const candidate = toISO(year, month, day)
        return candidate < reference ? toISO(year + 1, month, day) : candidate
      } },

    { re: /\b(?:due\s+)?today\b/i, resolve: () => reference },
    { re: /\b(?:due\s+)?tomorrow\b/i, resolve: () => addDays(reference, 1) },

    // "by Friday" — the next such weekday strictly after the reference date
    { re: new RegExp(`\\b(?:due|by|before|on)\\s+(?:next\\s+)?(${WEEKDAYS.join('|')})\\b`, 'i'),
      resolve: m => nextWeekday(reference, WEEKDAYS.indexOf(m[1].toLowerCase())) },
  ]

  for (const { re, resolve } of patterns) {
    const match = text.match(re)
    if (!match) continue
    const dueDate = resolve(match)
    if (!dueDate) continue
    return { text: text.replace(re, ' ').replace(/\s+/g, ' ').trim(), dueDate }
  }

  return { text, dueDate: null }
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

function nextWeekday(iso: string, weekday: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const delta = (weekday - dt.getUTCDay() + 7) % 7 || 7
  dt.setUTCDate(dt.getUTCDate() + delta)
  return dt.toISOString().slice(0, 10)
}

/** Trailing sentence punctuation, but not a closing paren that belongs to the text. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[\s,;:.]+$/, '').trim()
}

export function parseActionItems(input: string, reference: string): ParsedItem[] {
  if (!input?.trim()) return []

  const seen = new Set<string>()
  const items: ParsedItem[] = []

  for (const rawLine of input.split(/\r?\n/)) {
    const raw = rawLine.trim()
    if (!raw) continue
    if (HEADING.test(raw)) continue

    let text = raw.replace(LIST_MARKER, '').trim()
    if (!text) continue

    // A checked-off box means it's already done, so it isn't a next step.
    if (/^\s*(?:[-*•]\s*)?\[[xX]\]/.test(raw)) continue

    let ownerName: string | null = null

    const bracketed = text.match(LEADING_OWNER_BRACKET)
    const leading = bracketed || text.match(LEADING_OWNER)
    if (leading) {
      ownerName = leading[1].replace(/[.:]$/, '')
      text = text.slice(leading[0].length).trim()
    } else {
      const trailing = text.match(TRAILING_OWNER)
      if (trailing) {
        ownerName = trailing[1]
        text = text.slice(0, trailing.index).trim()
      }
    }

    const withDate = extractDueDate(text, reference)
    const title = tidy(withDate.text)

    // Too short to be an action once the owner and date are removed — usually a
    // stray fragment or a heading the pattern above didn't catch.
    if (title.split(/\s+/).filter(Boolean).length < MIN_TITLE_WORDS) continue

    // Notetakers repeat items between a summary and a list; collapse those.
    const key = normalizeTitle(title)
    if (!key || seen.has(key)) continue
    seen.add(key)

    items.push({ title, ownerName, dueDate: withDate.dueDate, raw })
  }

  return items
}

/**
 * Matches a parsed owner name to a meeting participant.
 *
 * Exact full name, then first name, then a unique prefix. Returns null on any
 * ambiguity — two people called Sam means the reviewer decides, not this.
 */
export function resolveOwner<T extends { id: string; full_name?: string; email?: string }>(
  ownerName: string | null,
  participants: T[],
): T | null {
  if (!ownerName) return null
  const needle = ownerName.trim().toLowerCase()
  if (!needle) return null

  const nameOf = (p: T) => (p.full_name || '').trim().toLowerCase()

  const exact = participants.filter(p => nameOf(p) === needle)
  if (exact.length === 1) return exact[0]

  const byFirstName = participants.filter(p => nameOf(p).split(/\s+/)[0] === needle)
  if (byFirstName.length === 1) return byFirstName[0]

  const byEmail = participants.filter(p => (p.email || '').toLowerCase() === needle)
  if (byEmail.length === 1) return byEmail[0]

  const byPrefix = participants.filter(p => nameOf(p).startsWith(needle))
  if (byPrefix.length === 1) return byPrefix[0]

  return null
}
