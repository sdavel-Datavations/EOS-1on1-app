import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { blockedInProduction } from '@/lib/dev-only'
import { upsertInvitation } from '@/lib/invitations'

/**
 * Dev-only: records an invitation so a test account can be created.
 *
 * Signup is gated on public.invitations, and deliberately so. Rather than letting
 * the dev user-creation route quietly bypass that gate — which would leave the
 * gate untested — tests invite first and then sign up, the same order a real
 * person goes through.
 */
export async function POST(req: Request) {
  const blocked = blockedInProduction()
  if (blocked) return blocked

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) return NextResponse.json({ error: 'server not configured' }, { status: 500 })

  const { email, role, managerId, department } = (await req.json().catch(() => ({}))) as {
    email?: string
    role?: string
    managerId?: string | null
    department?: string | null
  }
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 })

  const sb = createClient(url, service, { auth: { persistSession: false } })
  const { error } = await upsertInvitation(sb, {
    email,
    access_level: role || 'member',
    manager_id: managerId ?? null,
    department: department ?? null,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
