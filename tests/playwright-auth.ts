import { Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

export async function seedAndLogin(page: Page, email: string, password: string, fullName = '') {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

  // create user via dev admin endpoint (no confirmation emails)
  try {
    await fetch('http://localhost:3000/api/dev/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, fullName }),
    })
  } catch (err) {
    // ignore
  }

  // sign in via anon key to get a session
  const sb = createClient(baseUrl, anon)
  const { data: signInData } = await sb.auth.signInWithPassword({ email, password })
  const session = signInData?.session || null

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
