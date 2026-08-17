import { test, expect } from '@playwright/test'
import { isDoneComment, stripSlackMarkup } from '../src/lib/done-intent'

// Closing the wrong task is worse than making someone press the button, so the
// interesting cases here are the ones that must NOT match.

test.describe('recognises a completion', () => {
  const yes = [
    'done',
    'Done',
    'done!',
    'DONE',
    'all done',
    'done ✅',
    '✅',
    '✔️',
    ':white_check_mark:',
    'did it',
    'finished',
    'completed',
    'complete',
    'sent it over',
    'shipped',
    'sorted',
    'handled it',
    'fixed',
    'this is done',
    'ok done',
  ]
  for (const text of yes) {
    test(`"${text}"`, () => expect(isDoneComment(text)).toBe(true))
  }
})

test.describe('refuses anything hedged, negated or deferred', () => {
  const no = [
    'not done',
    'not done yet',
    "it isn't done",
    'nope',
    'no not yet',
    'almost done',
    'nearly done',
    'half done',
    'mostly done',
    'partially done',
    "I'll get it done",
    'will do',
    "I'll finish tomorrow",
    'done by friday',
    'going to finish this',
    'trying to finish today',
    'should be done soon',
    'this will be done monday',
    'still working on it',
    'pending review',
    'maybe done',
  ]
  for (const text of no) {
    test(`"${text}"`, () => expect(isDoneComment(text)).toBe(false))
  }
})

test.describe('refuses questions', () => {
  const no = ['is this done?', 'done?', 'did you finish?', 'done, right?', 'who finished this?']
  for (const text of no) {
    test(`"${text}"`, () => expect(isDoneComment(text)).toBe(false))
  }
})

test.describe('refuses discussion', () => {
  test('a long message is a conversation, not a status update', () => {
    expect(
      isDoneComment(
        'I finished the first part of this but the second part needs the numbers from finance first',
      ),
    ).toBe(false)
  })

  test('mentioning done in passing does not close anything', () => {
    expect(isDoneComment('once the vendor replies we can call this done')).toBe(false)
  })
})

test.describe('edge cases', () => {
  test('empty and whitespace never match', () => {
    expect(isDoneComment('')).toBe(false)
    expect(isDoneComment('   ')).toBe(false)
    expect(isDoneComment('\n\t')).toBe(false)
  })

  test('unrelated short replies never match', () => {
    expect(isDoneComment('thanks')).toBe(false)
    expect(isDoneComment('ok')).toBe(false)
    expect(isDoneComment('👍')).toBe(false) // a thumbs up is not a completion
    expect(isDoneComment('sure')).toBe(false)
  })

  test('a mention alongside done still counts', () => {
    // Slack renders an @-mention as <@U123>, which must not be read as words.
    expect(isDoneComment('<@U01ABC> done')).toBe(true)
  })

  test('a bare link is not a completion', () => {
    expect(isDoneComment('<https://example.com/doc|the doc>')).toBe(false)
  })

  test('a link plus done counts', () => {
    expect(isDoneComment('done <https://example.com/pr|PR>')).toBe(true)
  })
})

test.describe('stripSlackMarkup', () => {
  test('removes mentions, channels and links', () => {
    // Markup becomes a space, so collapse runs before comparing.
    expect(stripSlackMarkup('<@U1> and <#C2|general> see <https://x|x>').replace(/\s+/g, ' ').trim())
      .toBe('and see')
  })
})
