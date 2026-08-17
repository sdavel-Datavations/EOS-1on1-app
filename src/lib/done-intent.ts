/**
 * Decides whether a Slack thread reply means "this task is finished".
 *
 * Deliberately conservative: closing someone's task wrongly is worse than
 * making them press the button. Anything hedged, deferred, negated, or asked as
 * a question is rejected, and only short replies are considered at all — a long
 * message is a discussion, not a status update.
 */

/** Words that flip or defer the meaning, however affirmative the rest looks. */
const DISQUALIFIERS = new Set([
  'not', 'nt', 'no', 'nope', 'never', 'cant', 'cannot', 'wont', 'isnt', 'arent', 'havent', 'hasnt',
  'almost', 'nearly', 'partially', 'partly', 'half', 'mostly', 'kinda', 'sorta', 'about',
  'will', 'll', 'gonna', 'going', 'shall', 'plan', 'planning', 'try', 'trying',
  'tomorrow', 'later', 'soon', 'tonight', 'eventually', 'yet', 'still', 'pending',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'when', 'if', 'unless', 'once', 'should', 'would', 'could', 'maybe', 'might',
  'who', 'what', 'why', 'how', 'whether',
])

/** Words that assert completion. */
const AFFIRMATIVES = new Set([
  'done', 'complete', 'completed', 'finished', 'finish', 'did', 'sent', 'shipped',
  'sorted', 'handled', 'closed', 'resolved', 'delivered', 'fixed',
])

/**
 * Contractions, which have to be matched before punctuation is stripped:
 * removing the apostrophe collapses "I'll" to "ill" and "isn't" to "isnt", so a
 * plain word-list check on the stripped text misses the future tense entirely.
 */
const DISQUALIFYING_PATTERNS = [
  /\b(?:i|we|you|he|she|they|it)['’]?ll\b/, // I'll, we'll — intent, not completion
  /n['’]t\b/, // isn't, don't, haven't, won't
]

const DONE_EMOJI = ['✅', '✔️', '✔', '☑️', '☑', '🏁', 'white_check_mark', 'heavy_check_mark', 'ballot_box_with_check']

/** Longer than this and it's a conversation, not a status update. */
const MAX_WORDS = 6

/** Strips Slack's own markup: <@U123>, <#C123|name>, <https://x|label>. */
export function stripSlackMarkup(text: string): string {
  return text.replace(/<[^>]*>/g, ' ')
}

export function isDoneComment(raw: string): boolean {
  if (!raw?.trim()) return false

  const stripped = stripSlackMarkup(raw)

  // A question is never a completion, wherever the mark falls.
  if (stripped.includes('?')) return false

  const hasDoneEmoji = DONE_EMOJI.some(e => stripped.includes(e))

  const lowered = stripped.toLowerCase()
  if (DISQUALIFYING_PATTERNS.some(p => p.test(lowered))) return false

  // :white_check_mark: style shortcodes, then punctuation, to plain words.
  const words = lowered
    .replace(/:([a-z0-9_+-]+):/g, ' $1 ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)

  // A bare ✅ carries no words at all, and that is a clear enough signal.
  if (words.length === 0) return hasDoneEmoji

  if (words.length > MAX_WORDS) return false
  if (words.some(w => DISQUALIFIERS.has(w))) return false

  return hasDoneEmoji || words.some(w => AFFIRMATIVES.has(w))
}
