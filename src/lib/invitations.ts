import type { SupabaseClient } from '@supabase/supabase-js'

const RETURNING = 'id, email, access_level, manager_id, department, accepted_at'
const FALLBACK_RETURNING = 'id, email, access_level, manager_id, accepted_at'

/** supabase-departments.sql hasn't run yet: PostgREST reports an unknown column. */
function isMissingDepartment(error: { code?: string; message: string }) {
  return error.code === 'PGRST204' || /department/i.test(error.message)
}

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
    department?: string | null
    invited_by?: string | null
  },
) {
  const email = row.email.trim().toLowerCase()
  let insert = await sb
    .from('invitations')
    .insert({ ...row, email })
    .select(RETURNING)
    .maybeSingle()

  // Without this, an unapplied departments migration blocks signup entirely
  // rather than merely losing the department — the invitation is the signup gate.
  if (insert.error && isMissingDepartment(insert.error)) {
    const { department: _ignored, ...rest } = row
    insert = await sb
      .from('invitations')
      .insert({ ...rest, email })
      .select(FALLBACK_RETURNING)
      .maybeSingle()
  }

  if (!insert.error) return insert

  // 23505 = unique_violation: already invited, so update instead.
  if (insert.error.code === '23505') {
    const fields: Record<string, unknown> = {
      access_level: row.access_level,
      manager_id: row.manager_id,
    }
    if (row.department !== undefined) fields.department = row.department
    if (row.department !== undefined) fields.department = row.department
    if (row.invited_by !== undefined) fields.invited_by = row.invited_by
    // ilike with no wildcards is case-insensitive equality, which matches the
    // index and also catches rows the backfill inserted with original casing.
    const update = await sb
      .from('invitations')
      .update(fields)
      .ilike('email', email)
      .select(RETURNING)
      .maybeSingle()

    if (update.error && isMissingDepartment(update.error)) {
      delete fields.department
      return sb
        .from('invitations')
        .update(fields)
        .ilike('email', email)
        .select(FALLBACK_RETURNING)
        .maybeSingle()
    }
    return update
  }

  return insert
}
