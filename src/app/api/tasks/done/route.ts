import { NextResponse } from 'next/server'
import { verifyActionToken } from '@/lib/action-token'
import { tryServiceClient, findTaskById, completeTask } from '@/lib/complete-task'
import { escapeHtml } from '@/lib/mail'

/**
 * The "Mark done" link in a notification email.
 *
 * GET only *shows* a confirmation — it never writes. Mail clients, link
 * scanners, and corporate security proxies fetch links in emails without anyone
 * clicking, and a mutating GET would silently close tasks. The POST behind the
 * button is what acts.
 */

function page(title: string, body: string, form?: { token: string }) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f7f9;margin:0;padding:48px 16px">
  <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
    <div style="font-weight:700;letter-spacing:.08em;color:#3b2a5a;font-size:13px">DATAVATIONS</div>
    <h1 style="font-size:19px;margin:12px 0 8px;color:#1a1a1a">${escapeHtml(title)}</h1>
    <p style="color:#555;font-size:14px;line-height:1.5;margin:0">${body}</p>
    ${
      form
        ? `<form method="post" style="margin-top:24px">
             <input type="hidden" name="token" value="${escapeHtml(form.token)}">
             <button type="submit" style="background:#2b7ba8;color:#fff;border:0;padding:11px 20px;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer">Mark done</button>
           </form>`
        : ''
    }
  </div>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') || ''
  const verdict = verifyActionToken(token)
  if (!verdict.ok) return page('That link is no longer valid', escapeHtml(verdict.error))

  const service = tryServiceClient()
  if (!service.ok) return page('Not configured', escapeHtml(service.error))
  const sb = service.sb

  const task = await findTaskById(sb, verdict.payload.commitmentId)
  if (!task) return page('Task not found', 'It may have been deleted.')
  if (task.status === 'done') {
    return page('Already done', `“${escapeHtml(task.title)}” is already closed.`)
  }

  return page('Mark this task done?', `<strong>${escapeHtml(task.title)}</strong>`, { token })
}

export async function POST(req: Request) {
  let token = ''
  const contentType = req.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    token = ((await req.json().catch(() => ({}))) as { token?: string }).token || ''
  } else {
    token = ((await req.formData()).get('token') as string) || ''
  }

  const verdict = verifyActionToken(token)
  if (!verdict.ok) {
    return contentType.includes('application/json')
      ? NextResponse.json({ error: verdict.error }, { status: 400 })
      : page('That link is no longer valid', escapeHtml(verdict.error))
  }

  const service = tryServiceClient()
  if (!service.ok) return page('Not configured', escapeHtml(service.error))
  const sb = service.sb

  const task = await findTaskById(sb, verdict.payload.commitmentId)
  if (!task) return page('Task not found', 'It may have been deleted.')

  // The token proves authority over this specific task, so the assignee is the
  // actor. There is no session here to identify anyone else.
  const actorId = task.assignee_id || task.creator_id
  if (!actorId) return page("Couldn't close that", 'That task has nobody assigned to it.')

  const result = await completeTask(sb, task, actorId, 'email_link')
  if (!result.ok) return page("Couldn't close that", escapeHtml(result.error))

  if (contentType.includes('application/json')) {
    return NextResponse.json({ ok: true, alreadyDone: result.alreadyDone })
  }
  return page(
    result.alreadyDone ? 'Already done' : 'Done',
    `“${escapeHtml(task.title)}” is closed. It'll show under “Done this week” in My Week.`,
  )
}
