import { test, expect } from '@playwright/test'
import { signActionToken, verifyActionToken, generateSecret } from '../src/lib/action-token'
import { verifySlackSignature } from '../src/lib/slack'
import { createHmac } from 'node:crypto'

const SECRET = 'a'.repeat(48)
const OTHER_SECRET = 'b'.repeat(48)
const ID = '11111111-2222-3333-4444-555555555555'

test.beforeEach(() => {
  process.env.ACTION_TOKEN_SECRET = SECRET
})

test.describe('action tokens', () => {
  test('a freshly signed token verifies and carries its commitment id', () => {
    const result = verifyActionToken(signActionToken(ID))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.commitmentId).toBe(ID)
      expect(result.payload.action).toBe('complete')
    }
  })

  test('an expired token is refused', () => {
    const token = signActionToken(ID, 'complete', -1000)
    const result = verifyActionToken(token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('expired')
  })

  test('a token signed with a different secret is refused', () => {
    const token = signActionToken(ID)
    process.env.ACTION_TOKEN_SECRET = OTHER_SECRET
    expect(verifyActionToken(token).ok).toBe(false)
  })

  test('swapping in another commitment id is refused', () => {
    // The attack this exists to stop: edit the payload to close someone else's
    // task. The signature covers the id, so a re-encoded body fails.
    const token = signActionToken(ID)
    const [, signature] = [token.slice(0, token.lastIndexOf('.')), token.slice(token.lastIndexOf('.') + 1)]
    const forgedBody = ['99999999-9999-9999-9999-999999999999', 'complete', String(Date.now() + 10_000)].join('.')
    const forged = `${Buffer.from(forgedBody).toString('base64url')}.${signature}`
    expect(verifyActionToken(forged).ok).toBe(false)
  })

  test('extending the expiry is refused', () => {
    const token = signActionToken(ID, 'complete', -1000)
    const signature = token.slice(token.lastIndexOf('.') + 1)
    const body = [ID, 'complete', String(Date.now() + 86400_000)].join('.')
    const forged = `${Buffer.from(body).toString('base64url')}.${signature}`
    expect(verifyActionToken(forged).ok).toBe(false)
  })

  test('malformed input is refused rather than thrown', () => {
    for (const bad of ['', 'nonsense', 'no-separator', '.', 'a.b.c']) {
      expect(verifyActionToken(bad).ok).toBe(false)
    }
  })

  test('a short secret is rejected outright', () => {
    process.env.ACTION_TOKEN_SECRET = 'tooshort'
    expect(() => signActionToken(ID)).toThrow(/32 characters/)
  })

  test('generateSecret produces something long enough to use', () => {
    expect(generateSecret().length).toBeGreaterThanOrEqual(32)
  })
})

test.describe('slack signature verification', () => {
  const SIGNING_SECRET = 'slack-signing-secret-value'
  const body = 'token=x&team_id=T1&payload=%7B%7D'

  function sign(rawBody: string, ts: string, secret = SIGNING_SECRET) {
    return 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex')
  }

  test.beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET
  })

  test('accepts a correctly signed request', () => {
    const ts = '1700000000'
    const result = verifySlackSignature({
      rawBody: body,
      timestamp: ts,
      signature: sign(body, ts),
      nowSeconds: Number(ts) + 5,
    })
    expect(result.ok).toBe(true)
  })

  test('rejects a body that changed after signing', () => {
    const ts = '1700000000'
    const result = verifySlackSignature({
      rawBody: body + '&injected=1',
      timestamp: ts,
      signature: sign(body, ts),
      nowSeconds: Number(ts) + 5,
    })
    expect(result.ok).toBe(false)
  })

  test('rejects a replay outside the five minute window', () => {
    const ts = '1700000000'
    const result = verifySlackSignature({
      rawBody: body,
      timestamp: ts,
      signature: sign(body, ts),
      nowSeconds: Number(ts) + 301,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('replay window')
  })

  test('rejects a future timestamp just as readily', () => {
    const ts = '1700000000'
    expect(
      verifySlackSignature({
        rawBody: body,
        timestamp: ts,
        signature: sign(body, ts),
        nowSeconds: Number(ts) - 400,
      }).ok,
    ).toBe(false)
  })

  test('rejects a signature made with the wrong secret', () => {
    const ts = '1700000000'
    expect(
      verifySlackSignature({
        rawBody: body,
        timestamp: ts,
        signature: sign(body, ts, 'wrong-secret'),
        nowSeconds: Number(ts) + 5,
      }).ok,
    ).toBe(false)
  })

  test('rejects missing headers', () => {
    expect(verifySlackSignature({ rawBody: body, timestamp: null, signature: null }).ok).toBe(false)
    expect(verifySlackSignature({ rawBody: body, timestamp: 'abc', signature: 'v0=x' }).ok).toBe(false)
  })

  test('fails closed when the signing secret is absent', () => {
    delete process.env.SLACK_SIGNING_SECRET
    const ts = '1700000000'
    const result = verifySlackSignature({
      rawBody: body,
      timestamp: ts,
      signature: sign(body, ts),
      nowSeconds: Number(ts) + 5,
    })
    expect(result.ok).toBe(false)
  })
})
