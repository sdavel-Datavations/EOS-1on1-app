import { Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
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
  } catch (e) {
    // ignore
  }
}

export async function seedAndLogin(page: Page, email: string, password: string, fullName = '') {
  loadDotenvIfNeeded()
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

  // create user via dev admin endpoint (no confirmation emails)
  try {
    const resp = await fetch('http://localhost:3000/api/dev/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, fullName }),
    })
    try {
      const j = await resp.json()
      // eslint-disable-next-line no-console
      console.log('dev create-user response', j)
    } catch (e) {
      // ignore
    }
  } catch (err) {
    // ignore
  }

  // sign in via anon key to get a session
  const sb = createClient(baseUrl, anon)
  const signInRes = await sb.auth.signInWithPassword({ email, password })
  // eslint-disable-next-line no-console
  console.log('signInRes', JSON.stringify(signInRes?.error ? { error: signInRes.error } : { ok: !!signInRes.data }))
  const session = signInRes?.data?.session || null
  // eslint-disable-next-line no-console
  console.log('session', JSON.stringify(session))

  // compute storage key used by supabase-js
  const projRef = new URL(baseUrl).hostname.split('.')[0]
  const storageKey = `sb-${projRef}-auth-token`

  // write session to localStorage before navigation
  await page.addInitScript(({ key, sess }) => {
    try {
      localStorage.setItem(key, JSON.stringify(sess))
    } catch (e) {
      // ignore
    }
  }, { key: storageKey, sess: session })
}

export default seedAndLogin
