import { test, expect } from '@playwright/test'
import { taskBlocks, clip } from '../src/lib/slack'
import { taskEmail } from '../src/lib/mail'

test.describe('clip', () => {
  test('leaves short text alone', () => {
    expect(clip('short', 100)).toBe('short')
    expect(clip('', 10)).toBe('')
  })

  test('breaks on a word rather than mid-word', () => {
    const out = clip('alpha beta gamma delta', 14)
    expect(out).toBe('alpha beta…')
    expect(out).not.toContain('gam…')
  })

  test('still cuts when there is no sensible word break', () => {
    // A single long token has no space to fall back to, so a hard cut is right —
    // returning the whole thing would defeat the cap.
    const out = clip('a'.repeat(50), 10)
    expect(out.length).toBeLessThanOrEqual(11)
    expect(out.endsWith('…')).toBe(true)
  })
})

test.describe('notes reach Slack', () => {
  const base = {
    title: 'Build HIRI Pulse Member edition',
    dueLabel: 'Due Friday',
    askedBy: 'Sam Davel',
    meetingDate: null,
    commitmentId: 'abc',
  }

  function textOf(blocks: unknown[]): string {
    return JSON.stringify(blocks)
  }

  test('the notes appear in the message', () => {
    const blocks = taskBlocks({ ...base, notes: 'Start from the pricing doc in Drive.' })
    expect(textOf(blocks)).toContain('Start from the pricing doc in Drive.')
  })

  test('no notes adds no empty block', () => {
    // An empty section is rejected by Slack outright, so this is not cosmetic.
    const withOut = taskBlocks({ ...base, notes: '' })
    const withNull = taskBlocks({ ...base })
    const withSpaces = taskBlocks({ ...base, notes: '   \n  ' })
    expect(withOut.length).toBe(withNull.length)
    expect(withSpaces.length).toBe(withNull.length)
  })

  test('adding notes adds exactly one block', () => {
    const without = taskBlocks({ ...base }).length
    const withNotes = taskBlocks({ ...base, notes: 'context' }).length
    expect(withNotes).toBe(without + 1)
  })

  test('the Mark done button survives long notes', () => {
    // The button is the whole point of the DM; notes must not push it out.
    const blocks = taskBlocks({ ...base, notes: 'word '.repeat(500) })
    expect(textOf(blocks)).toContain('mark_done')
    expect(textOf(blocks).length).toBeLessThan(3000)
  })

  test('mrkdwn characters in notes are escaped, not rendered', () => {
    const blocks = taskBlocks({ ...base, notes: '<script>&' })
    expect(textOf(blocks)).not.toContain('<script>')
  })
})

test.describe('notes reach email', () => {
  const base = {
    firstName: 'Ashley',
    title: 'Wire the member auth flow',
    dueLabel: 'Due Friday',
    askedBy: 'Sam Davel',
    meetingDate: null,
    completeUrl: 'https://example.com/done?token=x',
  }

  test('the notes appear in both the html and the plain text', () => {
    const { html, text } = taskEmail({ ...base, notes: 'Use the staging tenant.' })
    expect(html).toContain('Use the staging tenant.')
    expect(text).toContain('Use the staging tenant.')
  })

  test('no notes leaves no empty block behind', () => {
    const { html } = taskEmail({ ...base, notes: '   ' })
    expect(html).not.toContain('border-left:3px solid')
  })

  test('html in notes is escaped', () => {
    const { html } = taskEmail({ ...base, notes: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('the done link is still present with notes', () => {
    const { html, text } = taskEmail({ ...base, notes: 'context' })
    expect(html).toContain(base.completeUrl)
    expect(text).toContain(base.completeUrl)
  })
})
