import { NextResponse } from 'next/server'
import { requireCaller } from '@/lib/require-admin'
import { logNotification } from '@/lib/complete-task'
import { upsertInvitation } from '@/lib/invitations'

/**
 * Invites someone, optionally under a manager.
 *
 * Signup is gated on a row in public.invitations, and that table has no insert
 * policy — so this route is the only way one is created, and it cannot be reached
 * without a session. An admin may invite anyone at any role; anyone else may
 * invite only under themselves, and only as a member, so a manager can bring on a
 * report without being able to mint another admin.
 */
export async function POST(req: Request) {
  const result = await requireCaller()
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  const { caller } = result

  const body = (await req.json().catch(() => ({}))) as {
    email?: string
    manager_id?: string | null
    role?: string
  }

  const email = (body.email || '').trim().toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 })
  }

  let role = body.role || 'member'
  let managerId = body.manager_id ?? null

  if (!caller.isAdmin) {
    // Escalation guard: without this, any member could invite an admin and then
    // sign in as them, or park someone under a manager they have no relation to.
    if (role !== 'member') {
      return NextResponse.json(
        { error: 'Only an admin can invite someone as a manager or admin' },
        { status: 403 },
      )
    }
    if (managerId && managerId !== caller.id) {
      return NextResponse.json(
        { error: 'You can only invite someone reporting to you' },
        { status: 403 },
      )
    }
    managerId = caller.id
    role = 'member'
  }

  if (!['member', 'manager', 'admin'].includes(role)) {
    return NextResponse.json({ error: 'role must be member, manager or admin' }, { status: 400 })
  }

  const { data, error } = await upsertInvitation(caller.admin, {
    email,
    manager_id: managerId,
    access_level: role,
    invited_by: caller.id,
  })

  if (error) {
    if (error.code === 'PGRST205') {
      return NextResponse.json(
        { error: 'Invitations table not found — run supabase-access-control.sql in the Supabase SQL editor.' },
        { status: 500 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Granting access is worth a record even when it goes right.
  await logNotification(caller.admin, {
    user_id: caller.id,
    channel: 'app',
    event: 'notify',
    status: 'ok',
    detail: `invited ${email} as ${role}${managerId ? ` under ${managerId}` : ''}`,
  })

  return NextResponse.json({ data })
}
