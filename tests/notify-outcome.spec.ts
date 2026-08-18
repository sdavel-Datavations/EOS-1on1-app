import { test, expect } from '@playwright/test'
import { summarizeNotify, notifyNotice } from '../src/lib/notify-outcome'

test.describe('summarizeNotify', () => {
  test('a channel that was never asked for is not a problem', () => {
    // notify_slack false means the key is simply absent from the outcome.
    expect(summarizeNotify({ email: 'sent' })).toEqual({ sent: ['email'], problems: [] })
    expect(summarizeNotify({})).toEqual({ sent: [], problems: [] })
    expect(summarizeNotify(undefined)).toEqual({ sent: [], problems: [] })
  })

  test('a partial send reports both halves', () => {
    // The bug this replaced: `slack === 'sent' || email === 'sent'` made this
    // whole case read as success, so a broken email setup said nothing at all.
    const s = summarizeNotify({ slack: 'sent', email: 'The domain is not verified.' })
    expect(s.sent).toEqual(['slack'])
    expect(s.problems).toEqual([{ channel: 'email', reason: 'The domain is not verified.' }])
  })

  test('a skip is a problem too, because nothing arrived either way', () => {
    const s = summarizeNotify({ email: 'skipped: no email address' })
    expect(s.sent).toEqual([])
    expect(s.problems).toEqual([{ channel: 'email', reason: 'no email address' }])
  })

  test('both channels working is reported as both', () => {
    expect(summarizeNotify({ slack: 'sent', email: 'sent' }).sent).toEqual(['slack', 'email'])
  })

  test('both failing keeps both reasons', () => {
    const s = summarizeNotify({ slack: 'not_in_channel', email: 'domain not verified' })
    expect(s.sent).toEqual([])
    expect(s.problems).toHaveLength(2)
  })
})

test.describe('notifyNotice', () => {
  test('names the failing channel and why, even when the other one worked', () => {
    const notice = notifyNotice(
      summarizeNotify({ slack: 'sent', email: 'The domain is not verified.' }),
      'you',
    )
    expect(notice).toBe('Sent to you by Slack. Email failed: The domain is not verified.')
  })

  test('a clean send stays short', () => {
    expect(notifyNotice(summarizeNotify({ slack: 'sent', email: 'sent' }), 'Ashley'))
      .toBe('Sent to Ashley by Slack and Email.')
  })

  test('nothing sent says so plainly', () => {
    expect(notifyNotice(summarizeNotify({ email: 'domain not verified' }), 'you'))
      .toBe('Not sent to you. Email failed: domain not verified.')
  })

  test('no channel configured is distinguished from a failure', () => {
    expect(notifyNotice(summarizeNotify({}), 'you'))
      .toBe('Nothing was sent — no channel is configured for this task.')
  })
})
