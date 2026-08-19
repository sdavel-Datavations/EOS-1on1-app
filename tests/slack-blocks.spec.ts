import { test, expect } from '@playwright/test'
import { reassignedBlocks, assignerConfirmationBlocks, reopenedBlocks, taskBlocks } from '../src/lib/slack'

const json = (blocks: unknown[]) => JSON.stringify(blocks)

test.describe('reassignedBlocks', () => {
  test('has no Mark done button', () => {
    // The whole reason this exists. The button closes by commitment id, not by who
    // pressed it, so leaving it live in the former owner's DM lets them close work
    // that is no longer theirs.
    const { blocks } = reassignedBlocks({ title: 'Wire the auth flow', toName: 'Ashley Rivera' })
    expect(json(blocks)).not.toContain('mark_done')
    expect(json(blocks)).not.toContain('actions')
  })

  test('says who has it now, so the message is not just a dead end', () => {
    const { text, blocks } = reassignedBlocks({ title: 'Wire the auth flow', toName: 'Ashley Rivera' })
    expect(json(blocks)).toContain('Ashley Rivera')
    expect(json(blocks)).toContain('nothing for you to do here')
    expect(text).toContain('Wire the auth flow')
  })

  test('a title with mrkdwn characters is escaped', () => {
    const { blocks } = reassignedBlocks({ title: '<script> & co', toName: 'A' })
    expect(json(blocks)).not.toContain('<script>')
  })
})

test.describe('assignerConfirmationBlocks', () => {
  test('is quiet: nothing to press, nothing to answer', () => {
    const { blocks } = assignerConfirmationBlocks({
      title: 'Wire the auth flow', toName: 'Ashley Rivera', dueLabel: 'Tomorrow',
    })
    expect(json(blocks)).not.toContain('mark_done')
    expect(json(blocks)).not.toContain('actions')
    // A single context block — the lightest thing Slack renders.
    expect(blocks).toHaveLength(1)
  })

  test('names the person and the task, so it needs no follow-up', () => {
    const { text, blocks } = assignerConfirmationBlocks({
      title: 'Wire the auth flow', toName: 'Ashley Rivera', dueLabel: 'Tomorrow',
    })
    expect(json(blocks)).toContain('Ashley Rivera')
    expect(json(blocks)).toContain('Wire the auth flow')
    expect(json(blocks)).toContain('Tomorrow')
    expect(text).toBe('Sent to Ashley Rivera: Wire the auth flow (Tomorrow)')
  })
})

test.describe('reopenedBlocks carries the current due date', () => {
  test('a redraw shows the date rather than the word Reopened', () => {
    // Updating the message someone already has is how a changed deadline reaches
    // them without sending a second DM about the same task.
    const { blocks } = reopenedBlocks({ title: 'Send the scorecard', commitmentId: 'x', dueLabel: 'In 3 days' })
    expect(json(blocks)).toContain('In 3 days')
    expect(json(blocks)).not.toContain('Reopened')
  })

  test('without a date it keeps the old wording', () => {
    const { blocks } = reopenedBlocks({ title: 'Send the scorecard', commitmentId: 'x' })
    expect(json(blocks)).toContain('Reopened')
  })

  test('the button survives either way, because the task is open', () => {
    for (const args of [
      { title: 't', commitmentId: 'x' },
      { title: 't', commitmentId: 'x', dueLabel: 'Today' },
    ]) {
      expect(json(reopenedBlocks(args).blocks)).toContain('mark_done')
    }
  })
})

test.describe('taskBlocks is unchanged by all this', () => {
  test('still carries the button and the due label', () => {
    const { blocks } = { blocks: taskBlocks({
      title: 'A task', dueLabel: 'Tomorrow', askedBy: 'Sam', meetingDate: null, commitmentId: 'x',
    }) }
    expect(json(blocks)).toContain('mark_done')
    expect(json(blocks)).toContain('Tomorrow')
  })
})
