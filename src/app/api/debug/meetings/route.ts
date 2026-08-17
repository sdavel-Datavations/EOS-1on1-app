import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase'
import { blockedInProduction } from '@/lib/dev-only'

export async function GET() {
  const blocked = blockedInProduction()
  if (blocked) return blocked

  try {
    const supabase = createClient()
    const { data } = await supabase
      .from('meetings')
      .select('id, meeting_date, status, manager:profiles(id, full_name, email), report:profiles(id, full_name, email)')
      .order('meeting_date', { ascending: false })
      .limit(10)

    return NextResponse.json({ data })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
