import { NextResponse } from 'next/server'

/**
 * Blocks a route in production unless explicitly opted in.
 *
 * For unauthenticated scaffolding — the debug dumps and the dev auth helpers.
 * These are safe locally and have no business answering on a public deployment,
 * whatever RLS happens to allow at the time.
 */
export function blockedInProduction(): NextResponse | null {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_AUTH_ROUTES !== 'true') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return null
}
