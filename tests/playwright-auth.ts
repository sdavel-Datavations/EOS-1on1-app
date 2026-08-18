import { Page, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

function loadDotenvIfNeeded() {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return
  try {
    const p = path.resolve(process.cwd(), '.env.local')
    if (!fs.existsSync(p)) return
    const contents = fs.readFileSync(p, 'utf8')
    contents.split(/\n/).forEach(line => {
      const m = line.match(/^\s*([^=#]+)=(.*)$/)
      if (m) {
        const key = m[1].trim()
        let val = m[2].trim()
        // strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        if (!process.env[key]) process.env[key] = val
      }
    })
  } catch {
    // ignore
  }
}

export function baseUrl() {
  return process.env.DEPLOY_URL || 'http://localhost:3000'
}

/**
 * True once the migration creating `table` has been applied. PostgREST answers
 * with PGRST205 while a table is absent from the schema cache.
 */
export async function tableExists(table: string) {
  loadDotenvIfNeeded()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return false
  const res = await fetch(`${url}/rest/v1/${table}?select=id&limit=1`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  })
  if (res.ok) return true
  return !(await res.text()).includes('PGRST205')
}

export const commitmentsTableExists = () => tableExists('weekly_commitments')
export const participantsTableExists = () => tableExists('meeting_participants')

/**
 * True once supabase-weekly-tracker.sql has been applied. Probes the column it
 * adds — the table itself predates that migration, so tableExists can't tell.
 */
export async function trackerReady() {
  loadDotenvIfNeeded()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return false
  const res = await fetch(`${url}/rest/v1/weekly_commitments?select=completed_at&limit=1`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  })
  return res.ok
}

/** True once supabase-access-control.sql has been applied. */
export async function invitationsReady() {
  return tableExists('invitations')
}

/**
 * Records an invitation, which signup requires.
 *
 * Tests invite and then sign up, the same order a real person goes through,
 * rather than having the dev user-creation route bypass the gate — a bypass would
 * leave the gate itself untested. Tolerates the table being absent so the suite
 * passes both before and after that migration.
 */
export async function invite(
  email: string,
  opts: { role?: string; managerId?: string | null; department?: string | null } = {},
) {
  loadDotenvIfNeeded()
  const resp = await fetch(`${baseUrl()}/api/dev/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      role: opts.role,
      managerId: opts.managerId ?? null,
      department: opts.department ?? null,
    }),
  })
  if (resp.ok) return
  const body = await resp.text()
  // Migration not applied yet: signup isn't gated, so there is nothing to record.
  if (body.includes('PGRST205') || body.includes('invitations')) return
  throw new Error(`dev invite failed (${resp.status}): ${body}`)
}

/** Creates a pre-confirmed user, so tests never wait on confirmation email. */
export async function createUser(email: string, password: string, fullName = '') {
  loadDotenvIfNeeded()
  const resp = await fetch(`${baseUrl()}/api/dev/create-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, fullName }),
  })
  if (!resp.ok) {
    throw new Error(`dev create-user failed (${resp.status}): ${await resp.text()}`)
  }
}

/**
 * Signs in through the app's own form.
 *
 * We deliberately do NOT inject a session directly: @supabase/ssr's
 * createBrowserClient persists sessions in document.cookie (chunked, base64-
 * prefixed), so seeding localStorage has no effect and the app stays logged out.
 * Driving the real form keeps this independent of supabase's storage format.
 */
export async function login(page: Page, email: string, password: string) {
  await page.goto('/')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()

  // The dashboard replaces the auth card once the session is established
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 15000 })
}

export async function seedAndLogin(page: Page, email: string, password: string, fullName = '') {
  await invite(email)
  await createUser(email, password, fullName)
  await login(page, email, password)
}

export default seedAndLogin
