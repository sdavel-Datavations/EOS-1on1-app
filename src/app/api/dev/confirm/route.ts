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
    const { data: profile } = await sb.from('profiles').select('id').eq('email', email).maybeSingle()
    if (!profile?.id) return NextResponse.json({ error: 'user not found' }, { status: 404 })

    // attempt to mark user as confirmed via admin API
    try {
      const { data, error } = await sb.auth.admin.updateUserById(profile.id, { email_confirm: true })
      if (error) return NextResponse.json({ error }, { status: 500 })
      return NextResponse.json({ data })
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 })
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
