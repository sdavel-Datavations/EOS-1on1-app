import { test, expect } from '@playwright/test'
import { parseActionItems, extractDueDate, resolveOwner } from '../src/lib/parse-action-items'

// 2026-08-17 is a Monday.
const REF = '2026-08-17'

const parse = (input: string) => parseActionItems(input, REF)

test.describe('list formats', () => {
  test('reads dashes, asterisks, bullets and numbers alike', () => {
    const items = parse(`
- Send the Q3 scorecard
* Book the vendor call
• Draft the hiring plan
1. Review the pipeline forecast
2) Update the rock status
`)
    expect(items.map(i => i.title)).toEqual([
      'Send the Q3 scorecard',
      'Book the vendor call',
      'Draft the hiring plan',
      'Review the pipeline forecast',
      'Update the rock status',
    ])
  })

  test('reads plain lines with no markers', () => {
    expect(parse('Send the numbers\nBook the room').map(i => i.title)).toEqual([
      'Send the numbers',
      'Book the room',
    ])
  })

  test('unchecked boxes are open items; checked ones are already done', () => {
    const items = parse('- [ ] Send the numbers\n- [x] Book the room\n- [X] Draft the plan')
    expect(items.map(i => i.title)).toEqual(['Send the numbers'])
  })

  test('skips the notetaker\'s own headings', () => {
    const items = parse(`Action Items:
- Send the numbers
## Next Steps
- Book the room
Decisions:
- Approve the budget increase`)
    expect(items.map(i => i.title)).toEqual([
      'Send the numbers',
      'Book the room',
      'Approve the budget increase',
    ])
  })

  test('a heading-like phrase inside a real item is kept', () => {
    // "Action items" here is part of the task, not a heading.
    expect(parse('- Send the action items to Ashley').map(i => i.title)).toHaveLength(1)
  })
})

test.describe('owners', () => {
  test('reads a leading name', () => {
    for (const line of ['Sam: send the numbers', 'Sam - send the numbers', 'Sam — send the numbers', '[Sam] send the numbers']) {
      const [item] = parse(line)
      expect(item?.ownerName, line).toBe('Sam')
      expect(item?.title, line).toBe('send the numbers')
    }
  })

  test('reads a trailing name', () => {
    const [item] = parse('- Send the numbers (Sam)')
    expect(item.ownerName).toBe('Sam')
    expect(item.title).toBe('Send the numbers')
  })

  test('reads a two-word name', () => {
    const [item] = parse('Ashley Chen: draft the hiring plan')
    expect(item.ownerName).toBe('Ashley Chen')
  })

  test('leaves the owner null when none is stated', () => {
    expect(parse('- Send the numbers')[0].ownerName).toBeNull()
  })

  test('does not mistake an opening verb for a name', () => {
    // "Name to verb" is not supported precisely because of this: it reads
    // correctly for "Ashley to review the plan" and disastrously here, and
    // nothing in the line tells the two apart.
    for (const line of ['Need to send the numbers', 'Going to book the room', 'Have to draft the plan']) {
      const [item] = parse(line)
      expect(item?.ownerName, line).toBeNull()
      expect(item?.title, line).toBe(line)
    }
  })

  test('does not treat a sentence opener as an owner', () => {
    const [item] = parse('- Follow up with finance - they owe us the numbers')
    // The dash here separates clauses, not an owner from a task. A single
    // leading word before it would be a name; "Follow up with finance" is not.
    expect(item.ownerName).toBeNull()
  })
})

test.describe('due dates', () => {
  test('reads an ISO date', () => {
    const [item] = parse('- Send the numbers by 2026-08-21')
    expect(item.dueDate).toBe('2026-08-21')
    expect(item.title).toBe('Send the numbers')
  })

  test('reads a month and day', () => {
    expect(parse('- Send the numbers due Aug 21')[0].dueDate).toBe('2026-08-21')
    expect(parse('- Send the numbers by August 21st')[0].dueDate).toBe('2026-08-21')
  })

  test('rolls a passed month/day into next year', () => {
    // Reference is August; February has gone.
    expect(parse('- Send the numbers by Feb 3')[0].dueDate).toBe('2027-02-03')
  })

  test('reads today and tomorrow', () => {
    expect(parse('- Send the numbers today')[0].dueDate).toBe('2026-08-17')
    expect(parse('- Send the numbers tomorrow')[0].dueDate).toBe('2026-08-18')
  })

  test('reads a weekday as the next such day', () => {
    expect(parse('- Send the numbers by Friday')[0].dueDate).toBe('2026-08-21')
    // Reference is itself a Monday, so "by Monday" means the next one.
    expect(parse('- Send the numbers by Monday')[0].dueDate).toBe('2026-08-24')
  })

  test('leaves vague deadlines alone rather than guessing', () => {
    // A wrong date on someone's task is worse than none, and the reviewer sees
    // the original wording regardless.
    for (const line of ['- Send the numbers by EOW', '- Send the numbers next sprint', '- Send the numbers soon']) {
      expect(parse(line)[0].dueDate, line).toBeNull()
    }
  })

  test('a line with no date has none', () => {
    expect(parse('- Send the numbers')[0].dueDate).toBeNull()
  })
})

test.describe('owner and date together', () => {
  test('pulls both out and leaves a clean title', () => {
    const [item] = parse('- Sam: send the Q3 scorecard by Friday')
    expect(item.ownerName).toBe('Sam')
    expect(item.dueDate).toBe('2026-08-21')
    expect(item.title).toBe('send the Q3 scorecard')
  })
})

test.describe('noise and duplicates', () => {
  test('collapses items repeated between a summary and a list', () => {
    const items = parse(`Send the numbers
- Send the numbers!
* send the NUMBERS`)
    expect(items).toHaveLength(1)
  })

  test('drops fragments too short to be an action', () => {
    expect(parse('- ok\n- yes\n- Send the numbers').map(i => i.title)).toEqual(['Send the numbers'])
  })

  test('ignores blank lines and whitespace', () => {
    expect(parse('\n\n   \n- Send the numbers\n\n')).toHaveLength(1)
  })

  test('empty input yields nothing', () => {
    expect(parse('')).toEqual([])
    expect(parse('   \n  ')).toEqual([])
  })

  test('keeps the raw line for the reviewer', () => {
    const [item] = parse('  - Sam: send the numbers by Friday  ')
    expect(item.raw).toBe('- Sam: send the numbers by Friday')
  })
})

test.describe('extractDueDate in isolation', () => {
  test('removes the date text it consumed', () => {
    expect(extractDueDate('send the numbers by 2026-08-21', REF)).toEqual({
      text: 'send the numbers',
      dueDate: '2026-08-21',
    })
  })

  test('returns the text untouched when there is no date', () => {
    expect(extractDueDate('send the numbers', REF)).toEqual({
      text: 'send the numbers',
      dueDate: null,
    })
  })

  test('rejects an impossible day rather than inventing one', () => {
    expect(extractDueDate('send it by Feb 99', REF).dueDate).toBeNull()
  })
})

test.describe('resolveOwner', () => {
  const people = [
    { id: 'a', full_name: 'Sam Davel', email: 'sam@example.com' },
    { id: 'b', full_name: 'Ashley Chen', email: 'ashley@example.com' },
  ]

  test('matches a full name, a first name, an email and a prefix', () => {
    expect(resolveOwner('Sam Davel', people)?.id).toBe('a')
    expect(resolveOwner('sam', people)?.id).toBe('a')
    expect(resolveOwner('ASHLEY', people)?.id).toBe('b')
    expect(resolveOwner('ashley@example.com', people)?.id).toBe('b')
    expect(resolveOwner('Ash', people)?.id).toBe('b')
  })

  test('refuses to guess when the name is ambiguous', () => {
    const twoSams = [
      { id: 'a', full_name: 'Sam Davel' },
      { id: 'b', full_name: 'Sam Patel' },
    ]
    expect(resolveOwner('Sam', twoSams)).toBeNull()
  })

  test('returns null for an unknown or empty name', () => {
    expect(resolveOwner('Nobody', people)).toBeNull()
    expect(resolveOwner(null, people)).toBeNull()
    expect(resolveOwner('   ', people)).toBeNull()
  })
})
