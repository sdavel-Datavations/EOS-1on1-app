import { test, expect } from '@playwright/test'
import { normalizeTitle, findExactDuplicate, type ExistingItem } from '../src/lib/dedupe'

test.describe('normalizeTitle', () => {
  test('ignores case, punctuation and spacing', () => {
    expect(normalizeTitle('Send the Q3 numbers!')).toBe(normalizeTitle('send  the q3   numbers'))
  })

  test('strips leading filler verbs so phrasing differences collapse', () => {
    expect(normalizeTitle("I'll send the report")).toBe('send the report')
    expect(normalizeTitle('Please send the report')).toBe('send the report')
    expect(normalizeTitle('To send the report')).toBe('send the report')
  })

  test('keeps distinct actions distinct', () => {
    expect(normalizeTitle('send the report')).not.toBe(normalizeTitle('read the report'))
  })

  test('returns empty for input with no letters or digits', () => {
    expect(normalizeTitle('   ---  ')).toBe('')
  })
})

test.describe('findExactDuplicate', () => {
  const existing: ExistingItem[] = [
    { kind: 'todo', id: 'todo-1', text: 'Send the Q3 numbers' },
    { kind: 'commitment', id: 'commit-1', text: 'Book the offsite venue' },
  ]

  test('matches across punctuation and filler differences', () => {
    expect(findExactDuplicate("I'll send the Q3 numbers.", existing)).toEqual({
      kind: 'todo',
      id: 'todo-1',
    })
  })

  test('reports the commitment kind when that is what matched', () => {
    expect(findExactDuplicate('book the offsite venue', existing)).toEqual({
      kind: 'commitment',
      id: 'commit-1',
    })
  })

  test('returns null for a genuinely new item', () => {
    expect(findExactDuplicate('Draft the hiring plan', existing)).toBeNull()
  })

  test('does not match a reworded commitment — that is the model\'s job, not this backstop', () => {
    expect(findExactDuplicate('Share the third quarter figures', existing)).toBeNull()
  })

  test('never matches on empty input', () => {
    expect(findExactDuplicate('   ', existing)).toBeNull()
    expect(findExactDuplicate('x', [{ kind: 'todo', id: 't', text: '  ' }])).toBeNull()
  })
})
