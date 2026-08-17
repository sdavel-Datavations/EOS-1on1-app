import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Supabase client for route handlers, acting as the signed-in caller.
 *
 * This is the only way a route handler learns who is calling. Reads the session
 * from the cookies @supabase/ssr's browser client writes, so every query runs
 * under that user's RLS policies rather than with the service role.
 */
export async function createClient() {
  const cookieStore = await cookies()
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Called from a context that can't set cookies (e.g. a plain GET
          // handler). Session refresh still works for the current request.
        }
      },
    },
  })
}

export type MeetingAccess =
  | { ok: true; userId: string; supabase: Awaited<ReturnType<typeof createClient>> }
  | { ok: false; status: 401 | 403; error: string }

/**
 * Verifies the caller is signed in and can reach this meeting.
 *
 * The meeting lookup deliberately goes through the caller's own client, so RLS
 * — not this function — is what decides access. A meeting the caller can't see
 * returns no row, which we report as 403.
 */
export async function requireMeetingAccess(meetingId: string): Promise<MeetingAccess> {
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return { ok: false, status: 401, error: 'Not signed in' }
  }

  const { data: meeting } = await supabase
    .from('meetings')
    .select('id')
    .eq('id', meetingId)
    .maybeSingle()

  if (!meeting) {
    return { ok: false, status: 403, error: 'No access to this meeting' }
  }

  return { ok: true, userId: user.id, supabase }
}
