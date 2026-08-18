import type { SupabaseClient } from '@supabase/supabase-js'

const RETURNING = 'id, email, access_level, manager_id, accepted_at'

/**
 * Creates or updates an invitation.
 *
 * Deliberately not an upsert with ON CONFLICT: the unique index is on
 * lower(email), an expression index, and Postgres only matches ON CONFLICT
 * against a constraint on the exact column. Insert-then-update-on-conflict works
 * against the expression index and stays correct under a concurrent double
 * invite, which the index rejects rather than duplicating.
 */
export async function upsertInvitation(
  sb: SupabaseClient,
  row: {
    email: string
    access_level: string
    manager_id: string | null
    invited_by?: string | null
  },
) {
  const email = row.email.trim().toLowerCase()
  const insert = await sb
    .from('invitations')
    .insert({ ...row, email })
    .select(RETURNING)
    .maybeSingle()

  if (!insert.error) return insert

  // 23505 = unique_violation: already invited, so update instead.
  if (insert.error.code === '23505') {
    const fields: Record<string, unknown> = {
      access_level: row.access_level,
      manager_id: row.manager_id,
    }
    if (row.invited_by !== undefined) fields.invited_by = row.invited_by
    // ilike with no wildcards is case-insensitive equality, which matches the
    // index and also catches rows the backfill inserted with original casing.
    return sb.from('invitations').update(fields).ilike('email', email).select(RETURNING).maybeSingle()
  }

  return insert
}
