import { createClient } from './supabase-server'
import { serviceClient } from './complete-task'
import type { SupabaseClient } from '@supabase/supabase-js'

export type Caller = {
  id: string
  access_level: 'member' | 'manager' | 'admin'
  isAdmin: boolean
  /** Service-role client. Only ever handed out after the checks above pass. */
  admin: SupabaseClient
}

export type CallerResult = { ok: true; caller: Caller } | { ok: false; status: number; error: string }

/**
 * Identifies the caller and their role before any privileged write.
 *
 * role and manager_id are deliberately not writable through the anon key — the
 * migration revokes column UPDATE — so these routes use the service role. That
 * makes establishing who is calling the entire access control, which is why the
 * role is read through the caller's own client rather than assumed.
 */
export async function requireCaller(): Promise<CallerResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, status: 401, error: 'Not signed in' }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, access_level')
    .eq('id', user.id)
    .maybeSingle()

  if (error || !profile) {
    return { ok: false, status: 403, error: 'No profile for this account' }
  }

  const accessLevel = (profile.access_level as Caller['access_level']) || 'member'
  return {
    ok: true,
    caller: { id: user.id, access_level: accessLevel, isAdmin: accessLevel === 'admin', admin: serviceClient() },
  }
}
