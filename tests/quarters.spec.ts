import { test, expect } from '@playwright/test'
import { quarterOf, quarterLabel, quarterRange, shiftQuarter, selectableQuarters, isValidQuarter } from '../src/lib/quarters'

test.describe('quarterOf', () => {
  test('maps every month to its quarter', () => {
    const expected: [string, string][] = [
      ['2026-01-15', '2026-Q1'], ['2026-02-01', '2026-Q1'], ['2026-03-31', '2026-Q1'],
      ['2026-04-01', '2026-Q2'], ['2026-06-30', '2026-Q2'],
      ['2026-07-01', '2026-Q3'], ['2026-09-30', '2026-Q3'],
      ['2026-10-01', '2026-Q4'], ['2026-12-31', '2026-Q4'],
    ]
    for (const [date, quarter] of expected) {
      expect(quarterOf(date), date).toBe(quarter)
    }
  })

  test('boundary days are not shifted by a timezone', () => {
    // The bug this guards: parsing '2026-07-01' as a Date gives UTC midnight,
    // which is 30 June anywhere west of Greenwich — putting a Q3 Rock in Q2.
    expect(quarterOf('2026-01-01')).toBe('2026-Q1')
    expect(quarterOf('2026-07-01')).toBe('2026-Q3')
    expect(quarterOf('2026-12-31')).toBe('2026-Q4')
  })
})

test.describe('quarterRange', () => {
  test('covers the whole quarter inclusively', () => {
    expect(quarterRange('2026-Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' })
    expect(quarterRange('2026-Q2')).toEqual({ start: '2026-04-01', end: '2026-06-30' })
    expect(quarterRange('2026-Q3')).toEqual({ start: '2026-07-01', end: '2026-09-30' })
    expect(quarterRange('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' })
  })

  test('gets February right in a leap year', () => {
    expect(quarterRange('2028-Q1').end).toBe('2028-03-31')
    // A Q1 range must still start on 1 January regardless of February's length
    expect(quarterRange('2028-Q1').start).toBe('2028-01-01')
  })

  test('every day of a quarter falls inside its own range', () => {
    for (const q of ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']) {
      const { start, end } = quarterRange(q)
      expect(quarterOf(start)).toBe(q)
      expect(quarterOf(end)).toBe(q)
    }
  })
})

test.describe('shiftQuarter', () => {
  test('moves forward and back within a year', () => {
    expect(shiftQuarter('2026-Q1', 1)).toBe('2026-Q2')
    expect(shiftQuarter('2026-Q3', -1)).toBe('2026-Q2')
  })

  test('crosses the year boundary in both directions', () => {
    expect(shiftQuarter('2026-Q4', 1)).toBe('2027-Q1')
    expect(shiftQuarter('2026-Q1', -1)).toBe('2025-Q4')
    expect(shiftQuarter('2026-Q1', -5)).toBe('2024-Q4')
    expect(shiftQuarter('2026-Q4', 5)).toBe('2028-Q1')
  })

  test('shifting by zero is identity', () => {
    expect(shiftQuarter('2026-Q2', 0)).toBe('2026-Q2')
  })
})

test.describe('selectableQuarters', () => {
  test('offers the current quarter and the next', () => {
    expect(selectableQuarters('2026-08-19')).toEqual(['2026-Q3', '2026-Q4'])
    // Planning in December means the next Rock is Q1 of the following year
    expect(selectableQuarters('2026-12-01')).toEqual(['2026-Q4', '2027-Q1'])
  })
})

test.describe('quarterLabel and validation', () => {
  test('reads as a person would say it', () => {
    expect(quarterLabel('2026-Q3')).toBe('Q3 2026 · Jul–Sep')
    expect(quarterLabel('2026-Q1')).toBe('Q1 2026 · Jan–Mar')
  })

  test('rejects anything that is not a quarter', () => {
    for (const good of ['2026-Q1', '2026-Q4', '1999-Q2']) expect(isValidQuarter(good)).toBe(true)
    for (const bad of ['2026-Q5', '2026-Q0', '26-Q1', '2026Q1', 'Q1-2026', '', '2026-q1']) {
      expect(isValidQuarter(bad), bad).toBe(false)
    }
  })
})
