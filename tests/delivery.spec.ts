import { test, expect } from '@playwright/test'
import {
  channelIsHealthy, partitionProblems, channelSummary, channelVerdict,
  type DeliveryRow,
} from '../src/lib/delivery'

const row = (over: Partial<DeliveryRow>): DeliveryRow => ({
  created_at: '2026-08-18T17:00:00+00:00',
  channel: 'email',
  event: 'notify',
  status: 'failed',
  detail: null,
  ...over,
})

test.describe('channelIsHealthy', () => {
  test('a later success answers an earlier failure', () => {
    expect(channelIsHealthy('2026-08-19T09:00:00+00:00', '2026-08-18T17:00:00+00:00')).toBe(true)
  })

  test('a failure after the last success is still standing', () => {
    expect(channelIsHealthy('2026-08-18T09:00:00+00:00', '2026-08-19T17:00:00+00:00')).toBe(false)
  })

  test('never failed is healthy', () => {
    expect(channelIsHealthy('2026-08-19T09:00:00+00:00', null)).toBe(true)
  })

  test('failed and never succeeded is not healthy', () => {
    expect(channelIsHealthy(null, '2026-08-18T17:00:00+00:00')).toBe(false)
  })

  test('nothing either way is healthy, and channelVerdict calls it never used', () => {
    expect(channelIsHealthy(null, null)).toBe(true)
    expect(channelVerdict({ healthy: true, lastSent: null, lastFailed: null })).toBe('never used')
  })
})

test.describe('partitionProblems', () => {
  // The four rows that prompted this: two config mistakes from one afternoon,
  // still being reported as current the next day.
  const theAfternoon = [
    row({ created_at: '2026-08-18T19:25:00+00:00', detail: 'domain is not verified' }),
    row({ created_at: '2026-08-18T17:50:00+00:00', detail: 'domain is not verified' }),
    row({ created_at: '2026-08-18T17:18:00+00:00', detail: 'NOTIFY_FROM_EMAIL is not a valid address' }),
    row({ created_at: '2026-08-18T15:18:00+00:00', detail: 'Invalid `from` field' }),
  ]

  test('a success the next day answers all of them', () => {
    const { live, resolved } = partitionProblems(theAfternoon, { email: '2026-08-19T09:00:00+00:00' })
    expect(live).toHaveLength(0)
    expect(resolved).toHaveLength(4)
  })

  test('without a later success they all stand', () => {
    const { live, resolved } = partitionProblems(theAfternoon, { email: null })
    expect(live).toHaveLength(4)
    expect(resolved).toHaveLength(0)
  })

  test('a success answers only the failures that came before it', () => {
    const rows = [
      row({ created_at: '2026-08-19T12:00:00+00:00', detail: 'after the success' }),
      row({ created_at: '2026-08-18T12:00:00+00:00', detail: 'before the success' }),
    ]
    const { live, resolved } = partitionProblems(rows, { email: '2026-08-19T09:00:00+00:00' })
    expect(live.map(r => r.detail)).toEqual(['after the success'])
    expect(resolved.map(r => r.detail)).toEqual(['before the success'])
  })

  test('Slack working does not answer an email failure', () => {
    const rows = [row({ channel: 'email', created_at: '2026-08-18T12:00:00+00:00' })]
    const { live } = partitionProblems(rows, { slack: '2026-08-19T09:00:00+00:00', email: null })
    expect(live).toHaveLength(1)
  })

  test('skipped is not a failure — a quiet run is not a broken one', () => {
    const rows = [row({ status: 'skipped', detail: 'no channel configured' })]
    const { live, resolved } = partitionProblems(rows, { email: null })
    expect(live).toHaveLength(0)
    expect(resolved).toHaveLength(0)
  })
})

test.describe('channelSummary', () => {
  test('reports both delivery channels even when one has no history', () => {
    const s = channelSummary({ email: '2026-08-19T09:00:00+00:00' }, {})
    expect(s.map(c => c.channel)).toEqual(['slack', 'email'])
    expect(channelVerdict(s.find(c => c.channel === 'slack')!)).toBe('never used')
    expect(channelVerdict(s.find(c => c.channel === 'email')!)).toBe('healthy')
  })

  test('a standing failure reads as failing', () => {
    const s = channelSummary({ email: '2026-08-18T09:00:00+00:00' }, { email: '2026-08-19T17:00:00+00:00' })
    expect(channelVerdict(s.find(c => c.channel === 'email')!)).toBe('failing')
  })
})
