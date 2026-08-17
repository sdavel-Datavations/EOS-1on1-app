import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { requireMeetingAccess } from '@/lib/supabase-server'
import { findExactDuplicate, type ExistingItem } from '@/lib/dedupe'

// An Opus 5 extraction runs with thinking on, so a long transcript can take well
// past a default serverless limit. Streaming keeps the HTTP connection alive;
// this raises the platform's own ceiling.
export const maxDuration = 300

const ExtractionSchema = z.object({
  items: z.array(
    z.object({
      title: z.string().describe('The action, as a short imperative phrase.'),
      target: z
        .enum(['todo', 'commitment', 'issue'])
        .describe(
          "'commitment' if it has a clear owner and lands during the week, 'todo' for an action with no date, 'issue' for an unresolved problem raised but not solved.",
        ),
      owner_index: z
        .number()
        .int()
        .nullable()
        .describe('Index into the participants list, or null if no owner was named.'),
      due_date: z
        .string()
        .nullable()
        .describe('YYYY-MM-DD if a date was actually stated or clearly implied, else null.'),
      evidence: z
        .string()
        .describe('A short verbatim quote from the transcript that justifies this item.'),
      confidence: z.enum(['high', 'medium', 'low']),
      duplicate_of_index: z
        .number()
        .int()
        .nullable()
        .describe('Index into the existing items list if this repeats one, else null.'),
    }),
  ),
})

const SYSTEM_PROMPT = `You extract next steps from a 1-on-1 meeting transcript for an EOS-style weekly agenda.

Extract only commitments that were actually made in the conversation. A statement of intent by a named person ("I'll get you the Q3 numbers") is a commitment; speculation, brainstorming, and things explicitly deferred are not. Do not invent owners or dates that were not stated or clearly implied.

Attribute each item to the person who committed to doing it, not the person who asked for it.

You are given the items already on this agenda. If an extracted item is the same commitment as one of them — even worded completely differently — set duplicate_of_index to that item's index. Judge by whether doing one would satisfy the other, not by shared words.

Quote the transcript verbatim in the evidence field, short enough to be scannable. A human reviews every item before it reaches the shared agenda, and the evidence is what they use to decide, so it must be traceable to the transcript rather than paraphrased.

Prefer fewer, higher-quality items over exhaustive coverage. Return an empty list if nothing was actually committed to.`

export async function POST(req: Request) {
  let body: { meeting_id?: string; transcript?: string; source?: string; source_ref?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { meeting_id, transcript, source = 'upload', source_ref = null } = body
  if (!meeting_id || !transcript?.trim()) {
    return NextResponse.json({ error: 'meeting_id and transcript are required' }, { status: 400 })
  }
  if (source !== 'upload' && source !== 'granola') {
    return NextResponse.json({ error: 'source must be "upload" or "granola"' }, { status: 400 })
  }

  // Authenticate before touching server config, so an anonymous caller learns
  // nothing about how this deployment is set up.
  const access = await requireMeetingAccess(meeting_id)
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }
  const { supabase, userId } = access

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server.' },
      { status: 500 },
    )
  }

  // Participants give the model the only names it may attribute work to.
  const { data: memberships } = await supabase
    .from('meeting_participants')
    .select('user_id, role, profile:profiles(full_name, email)')
    .eq('meeting_id', meeting_id)
    .order('created_at')

  const participants = (memberships || []).map(m => {
    const profile = m.profile as { full_name?: string; email?: string } | null
    return {
      user_id: m.user_id as string,
      name: profile?.full_name || profile?.email || 'Unknown',
      role: m.role as string,
    }
  })

  if (participants.length === 0) {
    return NextResponse.json(
      { error: 'This meeting has no participants yet — run supabase-participants.sql and add participants first.' },
      { status: 400 },
    )
  }

  // Everything already on the agenda, for the dedupe pass.
  const [todoRes, commitmentRes] = await Promise.all([
    supabase.from('todos').select('id, text').eq('meeting_id', meeting_id).eq('done', false),
    supabase.from('weekly_commitments').select('id, title').eq('meeting_id', meeting_id).eq('status', 'open'),
  ])

  const existing: ExistingItem[] = [
    ...(todoRes.data || []).map(t => ({ kind: 'todo' as const, id: t.id as string, text: t.text as string })),
    ...(commitmentRes.data || []).map(c => ({ kind: 'commitment' as const, id: c.id as string, text: c.title as string })),
  ].filter(e => e.text?.trim())

  const participantList = participants.map((p, i) => `${i}. ${p.name} (${p.role})`).join('\n')
  const existingList = existing.length
    ? existing.map((e, i) => `${i}. [${e.kind}] ${e.text}`).join('\n')
    : '(none)'

  const client = new Anthropic()

  let parsed: z.infer<typeof ExtractionSchema>
  try {
    // Streamed so a long transcript can't trip an HTTP request timeout.
    const stream = client.messages.stream({
      model: 'claude-opus-5',
      max_tokens: 64000,
      system: SYSTEM_PROMPT,
      output_config: { format: zodOutputFormat(ExtractionSchema) },
      messages: [
        {
          role: 'user',
          content: `Participants (attribute owners by index):
${participantList}

Items already on this agenda (for duplicate_of_index):
${existingList}

Transcript:
${transcript}`,
        },
      ],
    })

    const message = await stream.finalMessage()

    if (message.stop_reason === 'refusal') {
      return NextResponse.json(
        { error: 'The model declined to process this transcript.' },
        { status: 422 },
      )
    }

    const text = message.content.find(b => b.type === 'text')
    if (!text || text.type !== 'text') {
      return NextResponse.json({ error: 'No extraction returned' }, { status: 502 })
    }
    parsed = ExtractionSchema.parse(JSON.parse(text.text))
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: 'Rate limited — try again shortly.' }, { status: 429 })
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json({ error: `Extraction failed: ${err.message}` }, { status: 502 })
    }
    // eslint-disable-next-line no-console
    console.error('Extraction failed', err)
    return NextResponse.json({ error: 'Extraction failed' }, { status: 500 })
  }

  if (parsed.items.length === 0) {
    return NextResponse.json({ data: [], count: 0 })
  }

  const rows = parsed.items.map(item => {
    const owner = item.owner_index !== null ? participants[item.owner_index] : undefined
    const flagged = item.duplicate_of_index !== null ? existing[item.duplicate_of_index] : undefined
    // Backstop for the re-run case, where wording is identical
    const duplicate = flagged || findExactDuplicate(item.title, existing)

    return {
      meeting_id,
      source,
      source_ref,
      extracted_by: userId,
      target: item.target,
      title: item.title,
      owner_id: owner?.user_id ?? null,
      due_date: item.due_date || null,
      evidence: item.evidence || '',
      confidence: item.confidence,
      duplicate_of_kind: duplicate?.kind ?? null,
      duplicate_of_id: duplicate?.id ?? null,
      status: 'pending' as const,
    }
  })

  const { data, error } = await supabase.from('extracted_items').insert(rows).select()
  if (error) {
    const message =
      error.code === 'PGRST205'
        ? 'Extracted items table not found — run supabase-transcripts.sql in the Supabase SQL editor.'
        : error.message
    return NextResponse.json({ error: message }, { status: 500 })
  }

  return NextResponse.json({ data, count: data?.length ?? 0 })
}
