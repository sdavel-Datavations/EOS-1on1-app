import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

/**
 * Signed, expiring, single-purpose tokens for links sent by email.
 *
 * An email recipient has no session, so the link itself has to carry the
 * authority to act. It is scoped to one commitment and one action, expires, and
 * is signed — so it can't be edited to close somebody else's task, and a leaked
 * old email stops working.
 */

const SEPARATOR = '.'
const DEFAULT_TTL_DAYS = 14

export type ActionName = 'complete'

export type TokenPayload = { commitmentId: string; action: ActionName; expiresAt: number }

function secret(): string {
  const value = process.env.ACTION_TOKEN_SECRET
  if (!value || value.length < 32) {
    throw new Error('ACTION_TOKEN_SECRET is missing or shorter than 32 characters')
  }
  return value
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url')
}

export function signActionToken(
  commitmentId: string,
  action: ActionName = 'complete',
  ttlMs: number = DEFAULT_TTL_DAYS * 86400_000,
): string {
  const expiresAt = Date.now() + ttlMs
  const body = [commitmentId, action, String(expiresAt)].join(SEPARATOR)
  return `${Buffer.from(body).toString('base64url')}${SEPARATOR}${sign(body)}`
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; error: string }

export function verifyActionToken(token: string, now: number = Date.now()): VerifyResult {
  if (!token) return { ok: false, error: 'Missing token' }

  const cut = token.lastIndexOf(SEPARATOR)
  if (cut <= 0) return { ok: false, error: 'Malformed token' }

  const encoded = token.slice(0, cut)
  const provided = token.slice(cut + 1)

  let body: string
  try {
    body = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return { ok: false, error: 'Malformed token' }
  }

  // Compare before parsing, so an unsigned payload is never interpreted.
  // secret() throws when unconfigured; verification must still answer cleanly,
  // since this runs on a public link anyone can open.
  let expected: string
  try {
    expected = sign(body)
  } catch {
    return { ok: false, error: 'Email links are not configured on this server' }
  }
  if (!safeEqual(provided, expected)) return { ok: false, error: 'Invalid token' }

  const [commitmentId, action, expiresAt] = body.split(SEPARATOR)
  if (!commitmentId || action !== 'complete' || !expiresAt) {
    return { ok: false, error: 'Malformed token' }
  }
  if (Number(expiresAt) < now) return { ok: false, error: 'This link has expired' }

  return { ok: true, payload: { commitmentId, action, expiresAt: Number(expiresAt) } }
}

/** Constant-time compare that tolerates length differences without leaking them. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual throws on unequal lengths, so hash both to a fixed width first.
  const ah = createHmac('sha256', 'compare').update(ab).digest()
  const bh = createHmac('sha256', 'compare').update(bb).digest()
  return timingSafeEqual(ah, bh)
}

/** For generating a value to paste into ACTION_TOKEN_SECRET. */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}
