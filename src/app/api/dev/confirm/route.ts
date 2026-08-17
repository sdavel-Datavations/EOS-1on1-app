import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(req: Request) {
  // Dev-only: this endpoint is unauthenticated and uses the service role key,
  // so it must never be reachable from a production deployment.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_AUTH_ROUTES !== 'true') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
  if (!SUPABASE_URL || !SERVICE) return NextResponse.json({ error: 'server not configured' }, { status: 500 })

  try {
    const body = await req.json()
    const { email } = body
    if (!email) return NextResponse.json({ error: 'missing email' }, { status: 400 })

    const sb = createClient(SUPABASE_URL, SERVICE)

    // Try to find the auth user by email via the admin API, with a short retry loop
    let userId: string | null = null
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        // listUsers is paginated; the newest signup lands on page 1 in dev
        const { data } = await sb.auth.admin.listUsers()
        const found = data.users.find(u => u.email === email)
        if (found?.id) {
          userId = found.id
          break
        }
      } catch {
        // ignore and retry
      }
      // wait 300ms before retrying
      await new Promise(r => setTimeout(r, 300))
    }

    if (!userId) return NextResponse.json({ error: 'user not found' }, { status: 404 })

    // attempt to mark user as confirmed via admin API
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const { data, error } = await sb.auth.admin.updateUserById(userId, { email_confirm: true })
      if (error) return NextResponse.json({ error }, { status: 500 })
      return NextResponse.json({ data })
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 })
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
