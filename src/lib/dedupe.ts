/**
 * Deterministic duplicate detection for extracted items.
 *
 * This is a backstop, not the main mechanism: the model compares extracted items
 * against the existing agenda semantically ("send me the numbers" vs "share Q3
 * figures"), which string matching can't do. What this catches is the case the
 * model is most likely to miss — re-running extraction on the same transcript,
 * where the wording is identical and a duplicate would otherwise slip through.
 */

export type ExistingItem = { kind: 'todo' | 'commitment'; id: string; text: string }

// Applied after punctuation has already become whitespace, which is why the
// contractions appear split: "I'll" normalizes to "i ll" before we get here.
const LEADING_FILLER = /^(please|to|will|i ll|we ll|i will|we will)\s+/

/** Lowercases, strips punctuation and leading filler verbs, collapses whitespace. */
export function normalizeTitle(title: string): string {
  let s = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Repeat so stacked filler collapses too ("I'll please send" -> "send")
  let previous: string
  do {
    previous = s
    s = s.replace(LEADING_FILLER, '')
  } while (s !== previous)

  return s
}

/** Returns the existing item whose normalized text matches exactly, if any. */
export function findExactDuplicate(
  title: string,
  existing: ExistingItem[],
): { kind: 'todo' | 'commitment'; id: string } | null {
  const normalized = normalizeTitle(title)
  if (!normalized) return null
  const hit = existing.find(e => normalizeTitle(e.text) === normalized)
  return hit ? { kind: hit.kind, id: hit.id } : null
}
