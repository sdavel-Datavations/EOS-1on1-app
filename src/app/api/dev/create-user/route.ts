import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(req: Request) {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
  if (!SUPABASE_URL || !SERVICE) return NextResponse.json({ error: 'server not configured' }, { status: 500 })

  try {
    const body = await req.json()
    const { email, password, fullName } = body
    if (!email || !password) return NextResponse.json({ error: 'missing fields' }, { status: 400 })

    const sb = createClient(SUPABASE_URL, SERVICE)

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      user_metadata: { full_name: fullName || '' },
      email_confirm: true,
    })
    if (error) return NextResponse.json({ error }, { status: 500 })

    // ensure a profiles row exists for the new user (admin createUser may bypass auth triggers)
    try {
      // data may be { user } or data.user depending on SDK shape
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const createdUser = data?.user || data
      const userId = createdUser?.id
      if (userId) {
        await sb.from('profiles').upsert({ id: userId, full_name: fullName || '', email }, { onConflict: 'id' })
      }
    } catch (e) {
      // ignore profile insert errors
    }

    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
