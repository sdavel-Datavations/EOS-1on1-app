import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'

/**
 * Removes the accounts and data the suite created.
 *
 * Without this, every run left users, meetings and tasks behind — 222 accounts
 * and 142 meetings had accumulated before the first clean-up, which made the
 * team page unusable and the assignee pickers meaningless.
 *
 * example.com is IANA-reserved for documentation and testing, so it can never be
 * a real address. That makes it a safe boundary: anything else is left alone.
 */
export default async function globalTeardown() {
  if (process.env.SKIP_TEST_CLEANUP === '1') return

  const env: Record<string, string> = {}
  try {
    const contents = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf8')
    for (const line of contents.split(/\n/)) {
      const m = line.match(/^\s*([^=#]+)=(.*)$/)
      if (m) env[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '')
    }
  } catch {
    return
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) return

  const sb = createClient(url, service, { auth: { persistSession: false } })

  const { data: profiles } = await sb.from('profiles').select('id, email')
  const testUsers = (profiles || []).filter(p => /@example\.com$/i.test(p.email || ''))
  if (testUsers.length === 0) return

  const ids = testUsers.map(p => p.id)
  const chunks = <T,>(a: T[], n: number): T[][] =>
    a.length ? [a.slice(0, n), ...chunks(a.slice(n), n)] : []

  // Meetings first: their FK to profiles has no ON DELETE, so a user cannot be
  // removed while a meeting still references them. Child rows cascade off the
  // meeting.
  for (const c of chunks(ids, 100)) {
    await sb.from('meetings').delete().or(`manager_id.in.(${c.join(',')}),report_id.in.(${c.join(',')})`)
    await sb.from('weekly_commitments').delete().or(`assignee_id.in.(${c.join(',')}),creator_id.in.(${c.join(',')})`)
  }
  for (const c of chunks(testUsers.map(p => p.email as string), 100)) {
    await sb.from('invitations').delete().in('email', c)
  }

  /*
   * Invitations that never became accounts.
   *
   * The loop above only clears invitations for test users it found as profiles, so
   * an invite that was recorded and never signed up survived every run and
   * accumulated in the live table. Matched on the address rather than on a profile,
   * since by definition there is no profile to match.
   */
  const { data: strayInvites } = await sb
    .from('invitations')
    .delete()
    .like('email', '%@example.com')
    .select('email')
  for (const id of ids) {
    await sb.auth.admin.deleteUser(id)
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n[teardown] removed ${ids.length} test account(s) and their data` +
    (strayInvites?.length ? `, plus ${strayInvites.length} unused invitation(s)` : ''),
  )
}
