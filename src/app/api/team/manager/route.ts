import { NextResponse } from 'next/server'
import { requireCaller } from '@/lib/require-admin'
import { logNotification } from '@/lib/complete-task'

/** Sets or clears someone's manager, and optionally their role. Admins only. */
export async function POST(req: Request) {
  const result = await requireCaller()
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  const { caller } = result

  if (!caller.isAdmin) {
    return NextResponse.json({ error: 'Only an admin can change reporting lines' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    user_id?: string
    manager_id?: string | null
    role?: string
  }

  if (!body.user_id) {
    return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
  }
  if (body.manager_id && body.manager_id === body.user_id) {
    return NextResponse.json({ error: 'Someone cannot report to themselves' }, { status: 400 })
  }
  if (body.role && !['member', 'manager', 'admin'].includes(body.role)) {
    return NextResponse.json({ error: 'role must be member, manager or admin' }, { status: 400 })
  }

  // A cycle would make the hierarchy walk unresolvable, and the depth cap in
  // manages() would silently stop finding people rather than erroring.
  if (body.manager_id) {
    const { data: chainClear } = await caller.admin.rpc('would_create_cycle', {
      p_user: body.user_id,
      p_manager: body.manager_id,
    })
    if (chainClear === true) {
      return NextResponse.json(
        { error: 'That would create a loop in the reporting line' },
        { status: 400 },
      )
    }
  }

  const fields: Record<string, unknown> = { manager_id: body.manager_id ?? null }
  if (body.role) fields.access_level = body.role

  const { data, error } = await caller.admin
    .from('profiles')
    .update(fields)
    .eq('id', body.user_id)
    .select('id, full_name, access_level, manager_id')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'No such person' }, { status: 404 })

  await logNotification(caller.admin, {
    user_id: caller.id,
    channel: 'app',
    event: 'notify',
    status: 'ok',
    detail: `set ${body.user_id} manager=${body.manager_id ?? 'none'}${body.role ? ` role=${body.role}` : ''}`,
  })

  return NextResponse.json({ data })
}
