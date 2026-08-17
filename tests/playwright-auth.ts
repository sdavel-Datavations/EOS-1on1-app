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

/**
 * True once supabase-commitments.sql has been applied. PostgREST answers with
 * PGRST205 while the table is absent from the schema cache.
 */
export async function commitmentsTableExists() {
  loadDotenvIfNeeded()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return false
  const res = await fetch(`${url}/rest/v1/weekly_commitments?select=id&limit=1`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  })
  if (res.ok) return true
  const body = await res.text()
  return !body.includes('PGRST205')
}

/**
 * Creates a pre-confirmed user via the dev admin endpoint, then signs in through
 * the app's own login form.
 *
 * We deliberately do NOT inject a session directly: @supabase/ssr's
 * createBrowserClient persists sessions in document.cookie (chunked, base64-
 * prefixed), so seeding localStorage has no effect and the app stays logged out.
 * Driving the real form keeps this independent of supabase's storage format.
 */
export async function seedAndLogin(page: Page, email: string, password: string, fullName = '') {
  loadDotenvIfNeeded()

  const baseURL = process.env.DEPLOY_URL || 'http://localhost:3000'
  const resp = await fetch(`${baseURL}/api/dev/create-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, fullName }),
  })
  if (!resp.ok) {
    throw new Error(`dev create-user failed (${resp.status}): ${await resp.text()}`)
  }

  await page.goto('/')
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()

  // The dashboard replaces the auth card once the session is established
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 15000 })
}

export default seedAndLogin
