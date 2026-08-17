import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(req: Request) {
  // Dev-only: require service role key
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
  if (!SUPABASE_URL || !SERVICE) return NextResponse.json({ error: 'server not configured' }, { status: 500 })

  try {
    const body = await req.json()
    const { email } = body
    if (!email) return NextResponse.json({ error: 'missing email' }, { status: 400 })

    const sb = createClient(SUPABASE_URL, SERVICE)

    // find profile id by email
    // Try to find the auth user by email via the admin API, with a short retry loop
    let userId: string | null = null
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        // use admin listUsers (may return `users` or `data`) and search for email
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const listRes = await sb.auth.admin.listUsers()
        // support both shapes: { users: [...] } or { data: [...] }
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const users = listRes?.users || listRes?.data || []
        const found = (users || []).find((u: any) => u.email === email)
        if (found?.id) {
          userId = found.id
          break
        }
      } catch (e) {
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
