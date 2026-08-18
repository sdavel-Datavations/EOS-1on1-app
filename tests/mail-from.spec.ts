import { test, expect } from '@playwright/test'
import { normalizeFromAddress } from '../src/lib/mail'

// Resend rejects anything that isn't `a@b.c` or `Name <a@b.c>`, and the ways a
// correct-looking value fails are invisible on screen.

test.describe('accepts and repairs', () => {
  const cases: [string, string][] = [
    ['1on1@marketing.task.datavations.com', '1on1@marketing.task.datavations.com'],
    ['  1on1@example.com  ', '1on1@example.com'],
    ['1on1@example.com\n', '1on1@example.com'],
    ['"1on1@example.com"', '1on1@example.com'],
    ["'1on1@example.com'", '1on1@example.com'],
    ['Datavations <1on1@example.com>', 'Datavations <1on1@example.com>'],
    ['Datavations 1-on-1 <1on1@example.com>', 'Datavations 1-on-1 <1on1@example.com>'],
    // Angle brackets forgotten — the most common way this goes wrong
    ['Datavations 1-on-1 1on1@example.com', 'Datavations 1-on-1 <1on1@example.com>'],
    ['"Datavations" <1on1@example.com>', 'Datavations <1on1@example.com>'],
    ['Datavations   <1on1@example.com>', 'Datavations <1on1@example.com>'],
  ]
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => {
      expect(normalizeFromAddress(input).from).toBe(expected)
    })
  }
})

test.describe('reports what is wrong', () => {
  test('a bare domain suggests an address on it', () => {
    const { from, error } = normalizeFromAddress('marketing.task.datavations.com')
    expect(from).toBeUndefined()
    expect(error).toContain('1on1@marketing.task.datavations.com')
  })

  test('empty is named as empty', () => {
    expect(normalizeFromAddress('').error).toContain('empty')
    expect(normalizeFromAddress(undefined).error).toContain('empty')
    expect(normalizeFromAddress('   ').error).toContain('empty')
  })

  test('nonsense with an @ is quoted back so it can be seen', () => {
    const { error } = normalizeFromAddress('not an @ address')
    expect(error).toContain('not a valid address')
  })

  test('a missing top-level domain is refused', () => {
    expect(normalizeFromAddress('1on1@localhost').from).toBeUndefined()
  })

  test('a doubled @ is refused, and the value is quoted back', () => {
    // This one cost a day of silent failures in production. Resend's own message
    // is a generic "Invalid `from` field" that names nothing, so the doubled @ is
    // invisible on screen and invisible in the logs. Quoting the value back is
    // what turned it into a thirty-second diagnosis from notification_log.
    //
    // Deliberately NOT repaired to a single @: every other repair here is
    // formatting noise that leaves the address itself alone, and rewriting who
    // mail claims to be from is a config error to fix, not to guess at.
    const { from, error } = normalizeFromAddress('noreply@@marketing.task.datavations.com')
    expect(from).toBeUndefined()
    expect(error).toContain('noreply@@marketing.task.datavations.com')
  })

  test('the corrected form of that same value is accepted', () => {
    expect(normalizeFromAddress('noreply@marketing.task.datavations.com').from)
      .toBe('noreply@marketing.task.datavations.com')
  })
})
