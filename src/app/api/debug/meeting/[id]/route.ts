import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase'
import { blockedInProduction } from '@/lib/dev-only'

export async function GET(_req: Request, context: any) {
  const blocked = blockedInProduction()
  if (blocked) return blocked

  const params = await context.params
  const { id } = params
  try {
    const supabase = createClient()
    const { data: meeting } = await supabase
      .from('meetings')
      .select('*, manager:profiles(id, full_name, email), report:profiles(id, full_name, email)')
      .eq('id', id)
      .maybeSingle()

    const { data: segueNotes } = await supabase.from('segue_notes').select('*').eq('meeting_id', id)
    const { data: headlines } = await supabase.from('headlines').select('*').eq('meeting_id', id)

    return NextResponse.json({ meeting, segueNotes, headlines })
  } catch (err) {
    // avoid exposing secrets — just return the error message
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
