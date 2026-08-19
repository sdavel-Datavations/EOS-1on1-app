import { test, expect } from '@playwright/test'
import { taskBlocks, clip } from '../src/lib/slack'
import { taskEmail, taskSubject, formatDueDate } from '../src/lib/mail'

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
    // Asserted on the divider the notes block draws, not on the card's own border:
    // the previous marker moved when the layout changed, which would have left this
    // passing for the wrong reason.
    const withNotes = taskEmail({ ...base, notes: 'something' })
    const without = taskEmail({ ...base, notes: '   ' })
    expect(withNotes.html).toContain('border-top:1px solid #eee')
    expect(without.html).not.toContain('border-top:1px solid #eee')
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

test.describe('taskSubject', () => {
  const base = { title: 'Test', askedBy: 'Sam Davel', dueLabel: 'Tomorrow', hasDueDate: true }

  test('says a task was assigned, and by whom, before anything else', () => {
    // The subject it replaced was "Tomorrow: Test", which in an inbox says neither
    // that work was handed over nor who handed it.
    expect(taskSubject(base)).toBe('Sam Davel assigned you a task: Test — due tomorrow')
  })

  test('does not claim someone assigned you your own task', () => {
    expect(taskSubject({ ...base, selfAssigned: true })).toBe('New task: Test — due tomorrow')
  })

  test('an overdue label already reads as a sentence and keeps no "due"', () => {
    expect(taskSubject({ ...base, dueLabel: '3 days overdue', overdue: true }))
      .toBe('Sam Davel assigned you a task: Test — 3 days overdue')
  })

  test('no due date adds no dangling suffix', () => {
    expect(taskSubject({ ...base, hasDueDate: false, dueLabel: 'No due date' }))
      .toBe('Sam Davel assigned you a task: Test')
  })
})

test.describe('formatDueDate', () => {
  test('names the right day', () => {
    // 2026-08-17 is a Monday, so the 20th is a Thursday.
    expect(formatDueDate('2026-08-17')).toBe('Mon 17 Aug 2026')
    expect(formatDueDate('2026-08-20')).toBe('Thu 20 Aug 2026')
  })

  test('does not slip a day west of Greenwich', () => {
    // new Date('2026-01-01') is UTC midnight, which is 31 Dec in most of the US.
    expect(formatDueDate('2026-01-01')).toBe('Thu 1 Jan 2026')
    expect(formatDueDate('2026-12-31')).toBe('Thu 31 Dec 2026')
  })

  test('missing or malformed input yields nothing rather than "Invalid Date"', () => {
    expect(formatDueDate(null)).toBe('')
    expect(formatDueDate('')).toBe('')
    expect(formatDueDate('not-a-date')).toBe('')
  })
})

test.describe('the assignment is stated in the body too', () => {
  const base = {
    firstName: 'Ashley',
    title: 'Wire the member auth flow',
    dueLabel: 'Tomorrow',
    askedBy: 'Sam Davel',
    meetingDate: null,
    completeUrl: 'https://example.com/done?token=x',
    dueDate: '2026-08-20',
  }

  test('names who assigned it, and labels the email as a new task', () => {
    const { html, text } = taskEmail(base)
    expect(html).toContain('New task assigned')
    expect(html).toContain('Sam Davel assigned you a task.')
    expect(text).toContain('Sam Davel assigned you a task.')
  })

  test('a self-assigned task says so instead', () => {
    const { html } = taskEmail({ ...base, selfAssigned: true })
    expect(html).toContain('You added this task for yourself.')
    expect(html).not.toContain('assigned you a task.')
  })

  test('the due date is spelled out, not just relative', () => {
    expect(taskEmail(base).html).toContain('Due tomorrow · Thu 20 Aug 2026')
  })

  test('an overdue task is coloured red rather than grey', () => {
    const { html } = taskEmail({ ...base, dueLabel: '2 days overdue', dueDate: '2026-08-17', overdue: true })
    expect(html).toContain('2 days overdue · Mon 17 Aug 2026')
    // Both the date text and the card's accent bar, since the bar is what carries
    // at a glance and a blue bar on a late task reads as fine.
    expect(html).toContain('border-left:4px solid #e74c3c')
  })

  test('a task that is not late keeps the blue accent', () => {
    expect(taskEmail(base).html).toContain('border-left:4px solid #2b7ba8')
  })

  test('the meeting a task came from is named readably, not as a raw date', () => {
    const { html } = taskEmail({ ...base, meetingDate: '2026-08-12' })
    expect(html).toContain('Raised in your 1-on-1 on Wed 12 Aug 2026.')
  })
})
