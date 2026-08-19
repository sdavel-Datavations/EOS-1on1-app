import { test, expect } from '@playwright/test'
import { closeNoticeDecision, punctualityLabel } from '../src/lib/close-notice'
import { closeNoticeBlocks } from '../src/lib/slack'

const ASSIGNER = 'assigner-id'
const DOER = 'doer-id'

const task = (over: Partial<Parameters<typeof closeNoticeDecision>[0]> = {}) => ({
  status: 'done',
  creator_id: ASSIGNER,
  due_date: '2026-08-20',
  completed_at: '2026-08-19T16:00:00Z',
  ...over,
})

test.describe('closeNoticeDecision', () => {
  test('the assigner hears when someone else closes their task', () => {
    const d = closeNoticeDecision(task(), DOER)
    expect(d).toEqual({ notify: true, creatorId: ASSIGNER })
  })

  test('closing your own task tells you nothing', () => {
    const d = closeNoticeDecision(task(), ASSIGNER)
    expect(d).toEqual({ notify: false, reason: 'the assigner closed it themselves' })
  })

  test('a task with no assigner recorded notifies nobody', () => {
    const d = closeNoticeDecision(task({ creator_id: null }), DOER)
    expect(d.notify).toBe(false)
  })

  test('an open task is not a close', () => {
    const d = closeNoticeDecision(task({ status: 'open' }), DOER)
    expect(d).toEqual({ notify: false, reason: 'the task is not done' })
  })

  test('every refusal carries a reason, so silence can be explained', () => {
    for (const t of [task({ status: 'open' }), task({ creator_id: null }), task()]) {
      const d = closeNoticeDecision(t, ASSIGNER)
      if (!d.notify) expect(d.reason.length).toBeGreaterThan(0)
    }
  })
})

test.describe('punctualityLabel', () => {
  test('finishing on the due date is on time, whatever the hour', () => {
    expect(punctualityLabel(task({ due_date: '2026-08-19', completed_at: '2026-08-19T23:30:00Z' })))
      .toBe('closed on time')
  })

  test('a day past the due date is late', () => {
    expect(punctualityLabel(task({ due_date: '2026-08-19', completed_at: '2026-08-20T01:00:00Z' })))
      .toBe('closed late')
  })

  test('an undated task is neither, and says so by saying nothing', () => {
    expect(punctualityLabel(task({ due_date: null }))).toBeNull()
  })

  test('an open task has no verdict', () => {
    expect(punctualityLabel(task({ status: 'open' }))).toBeNull()
  })
})

test.describe('closeNoticeBlocks', () => {
  test('names the closer and the task, and carries no button', () => {
    const { text, blocks } = closeNoticeBlocks({
      title: 'Draft the Q3 landing page',
      closerName: 'Ashley Rivera',
      dueLabel: 'Thu 20 Aug 2026',
      punctuality: 'closed on time',
    })
    expect(text).toContain('Ashley Rivera')
    expect(text).toContain('Draft the Q3 landing page')
    const json = JSON.stringify(blocks)
    expect(json).toContain('Thu 20 Aug 2026')
    expect(json).toContain('closed on time')
    // Nothing to action: an assigner being told is not an assigner being asked.
    expect(json).not.toContain('button')
    expect(json).not.toContain('mark_done')
  })

  test('an undated task stays a single line', () => {
    const { blocks } = closeNoticeBlocks({
      title: 'Tidy the backlog',
      closerName: 'Ashley Rivera',
      dueLabel: null,
      punctuality: null,
    })
    expect(JSON.stringify(blocks)).not.toContain('\\n')
  })

  test('a very long title is clipped rather than filling the DM', () => {
    const { blocks } = closeNoticeBlocks({
      title: 'x'.repeat(400),
      closerName: 'Ashley Rivera',
      dueLabel: null,
      punctuality: null,
    })
    expect(JSON.stringify(blocks).length).toBeLessThan(300)
  })

  // Slack only requires &, < and > to be escaped, and escapeMrkdwn does exactly
  // those — so a title cannot smuggle in a link, which is the part that matters.
  // Asterisks still render as bold here, the same as in every other message the
  // app sends; that is cosmetic and deliberately left alone.
  test('a title cannot smuggle a clickable link into the notice', () => {
    const { blocks } = closeNoticeBlocks({
      title: 'Read <https://example.com|this>',
      closerName: 'Ashley Rivera',
      dueLabel: null,
      punctuality: null,
    })
    const json = JSON.stringify(blocks)
    expect(json).not.toContain('<https://example.com|this>')
    expect(json).toContain('&lt;https://example.com|this&gt;')
  })
})
