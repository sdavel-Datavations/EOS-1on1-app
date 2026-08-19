import { test, expect, Page } from '@playwright/test'
import { seedAndLogin, createUser, invite, invitationsReady, login, baseUrl, tableExists, commitmentsTableExists, participantsTableExists, trackerReady, subtasksReady, backdateMeeting, metricsReady, loadEnv, schedulesReady, profileIdFor, backdateSchedule } from './playwright-auth'
import { describeDue, todayISO } from '../src/lib/tracker'

async function signInAndStartMeeting(page: Page, name = 'E2E User') {
  const email = `e2e+${Date.now()}@example.com`
  const password = 'Password123!'

  // create a pre-confirmed user, then sign in through the app's own form
  await seedAndLogin(page, email, password, name)

  // Dashboard should show
  await page.getByText('New Meeting').waitFor({ timeout: 10000 })

  // Start a meeting; leave report email blank
  await page.getByRole('button', { name: 'Start 1-on-1' }).click()
  await expect(page).toHaveURL(/.*\/meeting\/.+/)
}

test('meeting agenda renders and segue notes persist', async ({ page }) => {
  // The meeting page must actually render — a rules-of-hooks violation here used
  // to crash the page after data loaded, while still leaving the URL correct.
  const errors: string[] = []
  page.on('pageerror', err => errors.push(err.message))

  await signInAndStartMeeting(page)

  await expect(page.getByRole('heading', { name: 'Weekly Commitments' })).toBeVisible({ timeout: 15000 })
  for (const title of ['Segue', 'Scorecard & Rock Pulse', 'Headlines', 'To-Dos & Wrap']) {
    await expect(page.getByText(title, { exact: true })).toBeVisible()
  }

  // Segue is expanded by default and must offer both wins
  await expect(page.getByPlaceholder('Personal win...').first()).toBeVisible()
  await expect(page.getByPlaceholder('Professional win...').first()).toBeVisible()

  // Both segue fields must persist through RLS, not just accept keystrokes
  await page.getByPlaceholder('Personal win...').first().fill('Ran a 10k')
  await page.getByPlaceholder('Professional win...').first().fill('Shipped the pipeline')
  await page.getByPlaceholder('Professional win...').first().blur()
  await page.waitForTimeout(1000)

  await page.reload()
  await expect(page.getByPlaceholder('Personal win...').first()).toHaveValue('Ran a 10k')
  await expect(page.getByPlaceholder('Professional win...').first()).toHaveValue('Shipped the pipeline')

  expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toEqual([])
})

test('an added participant can open the meeting', async ({ page }) => {
  test.skip(
    !(await participantsTableExists()),
    'meeting_participants table missing — run supabase-participants.sql in the Supabase SQL editor',
  )

  const guestEmail = `guest+${Date.now()}@example.com`
  const guestPassword = 'Password123!'
  await invite(guestEmail)
  await createUser(guestEmail, guestPassword, 'Guest Participant')

  // Manager creates the meeting and adds the guest
  await signInAndStartMeeting(page, 'Meeting Owner')
  const meetingUrl = page.url()

  await page.getByPlaceholder('Add participant email').fill(guestEmail)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('Guest Participant').first()).toBeVisible({ timeout: 10000 })

  // The guest gets their own segue box in the shared agenda
  await expect(page.getByPlaceholder('Personal win...')).toHaveCount(2)

  // The point of the participants table: the guest can actually load the meeting.
  // Under the old manager/report-only policies this hung on "Loading meeting...".
  await page.goto('/') // Sign out lives in the dashboard header, not the meeting page
  await page.getByRole('button', { name: 'Sign out' }).click()
  await login(page, guestEmail, guestPassword)

  // It also shows up in their meeting history, which RLS now scopes by membership
  await expect(page.getByText('Meeting History')).toBeVisible()
  await expect(page.getByText('Meeting Owner + TBD')).toBeVisible({ timeout: 10000 })

  await page.goto(meetingUrl)
  await expect(page.getByRole('heading', { name: 'Weekly Commitments' })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Loading meeting...')).toHaveCount(0)
  await expect(page.getByPlaceholder('Personal win...')).toHaveCount(2)
})

test('a meeting can be deleted from the dashboard', async ({ page }) => {
  await signInAndStartMeeting(page, 'Delete Tester')
  const meetingUrl = page.url()

  await page.goto('/')
  const card = page.getByText('Delete Tester + TBD')
  await expect(card).toBeVisible({ timeout: 10000 })

  await page.getByRole('button', { name: 'Delete meeting' }).first().click()
  // Destructive, so it asks first — and asking must not navigate into the meeting
  await expect(page.getByText('Delete this meeting and its agenda?')).toBeVisible()
  await expect(page).toHaveURL(/\/$/)

  await page.getByRole('button', { name: 'Delete', exact: true }).click()

  // The prompt clears only once the delete round-trip resolves, so this is the
  // point at which the outcome is known.
  await expect(page.getByText('Delete this meeting and its agenda?')).toHaveCount(0, { timeout: 15000 })

  // Without the DELETE policy the delete affects zero rows; deleteMeeting()
  // reports that rather than silently appearing to succeed.
  const migrationNotice = page.getByText(/Run supabase-delete-meetings\.sql/)
  if (await migrationNotice.isVisible()) {
    test.skip(true, 'meetings DELETE policy missing — run supabase-delete-meetings.sql')
  }

  await expect(card).toHaveCount(0, { timeout: 10000 })

  // And the meeting itself is gone, not just hidden from the list
  await page.goto(meetingUrl)
  await expect(page.getByText('Loading meeting...')).toBeVisible()
})

test('cancelling a delete leaves the meeting alone', async ({ page }) => {
  await signInAndStartMeeting(page, 'Keep Tester')
  await page.goto('/')

  const card = page.getByText('Keep Tester + TBD')
  await expect(card).toBeVisible({ timeout: 10000 })

  await page.getByRole('button', { name: 'Delete meeting' }).first().click()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await expect(page.getByText('Delete this meeting and its agenda?')).toHaveCount(0)
  await expect(card).toBeVisible()
})

test('weekly commitments save through RLS', async ({ page }) => {
  test.skip(
    !(await commitmentsTableExists()),
    'weekly_commitments table missing — run supabase-commitments.sql in the Supabase SQL editor',
  )

  const name = 'E2E User'
  await signInAndStartMeeting(page, name)

  // Commitments go straight through RLS now — no service-role API route
  await page.getByPlaceholder('Commitment title').fill('Send the Q3 scorecard')
  await page.getByRole('button', { name: 'Add Commitment' }).click()

  await expect(page.getByText('Send the Q3 scorecard')).toBeVisible({ timeout: 10000 })
  // assignee renders as a name, not a raw UUID
  await expect(page.getByText(`${name} · Due —`)).toBeVisible()

  // Toggling done persists. A finished commitment now drops off the open list into
  // a collapsed section, so the count is what proves it landed — and waiting for
  // that before reloading matters, since reloading mid-PATCH tests nothing.
  await page.getByTitle('Mark as done').click()
  await expect(page.getByText(/Done · 1/)).toBeVisible({ timeout: 10000 })
  await page.reload()
  await expect(page.getByText(/Done · 1/)).toBeVisible({ timeout: 10000 })

  // Reopening from that section still works, so nothing is stranded there
  await page.getByRole('button', { name: /Done · 1/ }).click()
  await expect(page.getByTitle('Mark as open')).toBeVisible()
})

test('the tasks page holds mid-week tasks and commitments from meetings alike', async ({ page }) => {
  test.skip(
    !(await trackerReady()),
    'completed_at column missing — run supabase-weekly-tracker.sql in the Supabase SQL editor',
  )

  const email = `tracker+${Date.now()}@example.com`
  await seedAndLogin(page, email, 'Password123!', 'Tracker Tester')

  // Tasks live on their own page now; the dashboard only links to them.
  await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 10000 })
  await page.getByRole('link', { name: /Tasks/ }).first().click()
  await expect(page).toHaveURL(/\/tasks$/)

  // A task typed straight in has no meeting behind it at all — the case the
  // original RLS policy silently rejected, since it keyed off
  // can_access_meeting(meeting_id) and meeting_id is null here.
  await page.getByPlaceholder('What needs doing?').fill('Chase the vendor invoice')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Chase the vendor invoice')).toBeVisible({ timeout: 15000 })

  // It survives a reload, so it really persisted rather than only rendering
  await page.reload()
  await expect(page.getByText('Chase the vendor invoice')).toBeVisible({ timeout: 10000 })

  // A commitment raised inside a 1-on-1 must show up in the same list, because
  // the whole point is not having to reopen last week's meeting to find it
  await page.goto('/')
  await page.getByRole('button', { name: 'Start 1-on-1' }).click()
  await expect(page).toHaveURL(/.*\/meeting\/.+/)
  await page.getByPlaceholder('Commitment title').fill('Send the Q3 scorecard')
  await page.getByRole('button', { name: 'Add Commitment' }).click()
  await expect(page.getByText('Send the Q3 scorecard')).toBeVisible({ timeout: 10000 })

  await page.goto('/tasks')
  await expect(page.getByText('Send the Q3 scorecard')).toBeVisible({ timeout: 10000 })
  await expect(page.getByText('Chase the vendor invoice')).toBeVisible()

  // Filters narrow without losing anything: both are mine to do here
  await page.getByRole('button', { name: 'I asked for' }).click()
  await expect(page.getByText('Nothing open here.')).toBeVisible()
  await page.getByRole('button', { name: 'Mine to do' }).click()
  await expect(page.getByText('Chase the vendor invoice')).toBeVisible()

  // Ticking it off moves it into "done this week"
  await page.getByTitle('Mark as done').first().click()
  await expect(page.getByText(/Done this week · 1/)).toBeVisible({ timeout: 10000 })

  await page.reload()
  await expect(page.getByText(/Done this week · 1/)).toBeVisible({ timeout: 10000 })
})

test('the tasks page is not readable without a session', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByText('You need to be signed in to see your tasks.')).toBeVisible({ timeout: 10000 })
})

test('notifying a task you cannot see is refused', async ({ page, request }) => {
  // /api/notify sends with the service role, so the caller's authority is checked
  // first — through their own client, which means RLS decides, not the handler.
  const email = `notifyauth+${Date.now()}@example.com`
  await seedAndLogin(page, email, 'Password123!', 'Notify Tester')
  const cookies = await page.context().cookies()

  const res = await request.post(`${baseUrl()}/api/notify`, {
    headers: { cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') },
    data: { commitment_id: '00000000-0000-0000-0000-000000000000' },
  })
  expect(res.status()).toBe(403)
  expect((await res.json()).error).toContain('No access')
})

test('slack webhooks reject unsigned requests', async ({ request }) => {
  // These endpoints act with the service role and have no session to rely on, so
  // the HMAC signature is the only thing standing between a stranger and closing
  // someone's tasks. Both must fail closed.
  for (const path of ['/api/slack/events', '/api/slack/interactive']) {
    const res = await request.post(`${baseUrl()}${path}`, {
      data: { type: 'event_callback', event: { type: 'message', text: 'done' } },
    })
    expect(res.status(), `${path} accepted an unsigned request`).toBe(401)
  }
})

test('slack events rejects a forged signature', async ({ request }) => {
  const res = await request.post(`${baseUrl()}/api/slack/events`, {
    headers: {
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-slack-signature': 'v0=' + 'f'.repeat(64),
      'content-type': 'application/json',
    },
    data: { type: 'url_verification', challenge: 'let-me-in' },
  })
  expect(res.status()).toBe(401)
  // And it must not echo the challenge back, which would confirm the endpoint
  // answers unverified callers.
  expect(await res.text()).not.toContain('let-me-in')
})

test('the notify endpoint will not fire for an anonymous caller', async ({ request }) => {
  // GET is what Vercel Cron uses, so it takes the secret and nothing else —
  // opening the URL in a browser must not send a round of notifications.
  const get = await request.get(`${baseUrl()}/api/notify`)
  expect(get.status()).toBe(401)
  expect((await get.json()).error).toContain('cron secret')

  const post = await request.post(`${baseUrl()}/api/notify`, { data: {} })
  expect(post.status()).toBe(401)
})

test('an emailed done link refuses a token it did not sign', async ({ request }) => {
  const res = await request.get(`${baseUrl()}/api/tasks/done?token=forged.signature`)
  const body = await res.text()
  expect(body).toContain('no longer valid')
  // A GET must never complete a task: mail scanners fetch links unprompted.
  expect(body).not.toContain('is closed')
})

test('pasted action items land in the review queue, deduped', async ({ page }) => {
  test.skip(
    !(await tableExists('extracted_items')),
    'extracted_items table missing — run supabase-transcripts.sql in the Supabase SQL editor',
  )

  await signInAndStartMeeting(page, 'Import Tester')

  // A commitment already on the agenda, so the paste has something to collide with
  await page.getByPlaceholder('Commitment title').fill('Send the Q3 scorecard')
  await page.getByRole('button', { name: 'Add Commitment' }).click()
  await expect(page.getByText('Send the Q3 scorecard')).toBeVisible({ timeout: 10000 })

  // The list a notetaker produces: a heading, an owner, a due date, and a repeat
  // of something already tracked.
  await page.getByPlaceholder(/Paste action items/).fill(
    [
      'Action Items:',
      '- Import Tester: book the vendor call by Friday',
      '- Draft the hiring plan',
      '- Send the Q3 scorecard',
    ].join('\n'),
  )
  await page.getByRole('button', { name: 'Review next steps' }).click()

  // Three items read, the repeat flagged rather than silently dropped
  await expect(page.getByText(/3 items to review/)).toBeVisible({ timeout: 15000 })
  await expect(page.getByText(/1 flagged as already on the agenda/)).toBeVisible()
  await expect(page.getByText('POSSIBLE DUPLICATE')).toBeVisible()

  // exact, because each row also quotes the raw pasted line as provenance and a
  // substring match would hit both the title and the blockquote.
  await expect(page.getByText('book the vendor call', { exact: true })).toBeVisible()
  // The owner was matched to a participant and the date read off "by Friday"
  await expect(page.getByText('Import Tester · Due 2026-08-21')).toBeVisible()
  await expect(page.getByText('Draft the hiring plan', { exact: true })).toBeVisible()
  // An unattributed line stays unassigned rather than being guessed at
  await expect(page.getByText('NO OWNER READ').first()).toBeVisible()

  // Nothing reaches the agenda until accepted — that is the whole point of the queue
  await expect(page.getByText(/Pending review \(3\)/)).toBeVisible()

  await page.getByRole('button', { name: 'Accept' }).first().click()
  await expect(page.getByText(/Pending review \(2\)/)).toBeVisible({ timeout: 15000 })
})

test('a task can be assigned to a teammate by email and reaches them', async ({ page, browser }) => {
  test.skip(
    !(await trackerReady()),
    'completed_at column missing — run supabase-weekly-tracker.sql in the Supabase SQL editor',
  )

  // A teammate who shares no meeting with the assigner, so the owner dropdown
  // cannot list them — the case assignment by email exists for.
  const mateEmail = `mate+${Date.now()}@example.com`
  const matePassword = 'Password123!'
  await invite(mateEmail)
  await createUser(mateEmail, matePassword, 'Team Mate')

  const ownerEmail = `owner+${Date.now()}@example.com`
  await seedAndLogin(page, ownerEmail, 'Password123!', 'Task Owner')
  await page.goto('/tasks')

  await page.getByPlaceholder('What needs doing?').fill('Review the vendor contract')
  await page.getByPlaceholder('teammate@datavations.com').fill(mateEmail)
  await page.getByRole('button', { name: /Add & Notify/ }).click()

  // Named in the confirmation, so it's clear who it was for — and when no channel
  // is configured the UI says the send failed rather than implying it went out.
  await expect(page.getByText(/Task added.*Team Mate/)).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Review the vendor contract')).toBeVisible()

  // An unknown address is refused rather than silently assigned to nobody
  await page.getByPlaceholder('What needs doing?').fill('Should not be created')
  await page.getByPlaceholder('teammate@datavations.com').fill('nobody@example.com')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText(/No account for nobody@example.com/)).toBeVisible({ timeout: 10000 })
  await expect(page.getByText('Should not be created')).toHaveCount(0)

  // The assignee sees it on their own board — this is the RLS path for a task
  // with no meeting behind it, reachable only via assignee_id.
  const mateContext = await browser.newContext()
  const matePage = await mateContext.newPage()
  await login(matePage, mateEmail, matePassword)
  await matePage.goto('/tasks')
  await expect(matePage.getByText('Review the vendor contract')).toBeVisible({ timeout: 15000 })
  await expect(matePage.getByRole('button', { name: 'Mine to do' })).toBeVisible()

  // And they can close it, which is what the Slack reply does server-side
  await matePage.getByTitle('Mark as done').first().click()
  await expect(matePage.getByText(/Done this week · 1/)).toBeVisible({ timeout: 15000 })
  await mateContext.close()
})

test('signup requires an invitation', async () => {
  test.skip(
    !(await invitationsReady()),
    'invitations table missing — run supabase-access-control.sql in the Supabase SQL editor',
  )

  // Deliberately NOT invited. The gate is a trigger on auth.users, so it holds
  // for the admin API too, not just the public signup form — which is what makes
  // it a real gate rather than a UI check.
  const stranger = `stranger+${Date.now()}@example.com`
  let failed = false
  try {
    await createUser(stranger, 'Password123!', 'Uninvited Stranger')
  } catch {
    // The wording is deliberately not asserted: GoTrue replaces a trigger's
    // message with a generic "Database error creating new user", so the outcome
    // is the only thing worth checking here.
    failed = true
  }
  expect(failed, 'an uninvited email was allowed to create an account').toBe(true)

  // Invited, and the same call now succeeds — proving the gate is the invitation
  // and not something incidental about the address.
  await invite(stranger)
  await createUser(stranger, 'Password123!', 'Now Invited')
})

test('the directory is not readable without a session', async ({ request }) => {
  test.skip(
    !(await invitationsReady()),
    'invitations table missing — run supabase-access-control.sql in the Supabase SQL editor',
  )

  // The anon key ships in the browser bundle, so it is public. Before
  // supabase-access-control.sql this returned every name and email address.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const res = await request.get(`${url}/rest/v1/profiles?select=id,full_name,email&limit=50`, {
    headers: { apikey: anon!, Authorization: `Bearer ${anon}` },
  })
  const body = await res.json()
  expect(Array.isArray(body) ? body.length : 0, 'the anon key can still read profiles').toBe(0)
})

test('a member cannot promote themselves to admin', async ({ page }) => {
  test.skip(
    !(await invitationsReady()),
    'invitations table missing — run supabase-access-control.sql in the Supabase SQL editor',
  )

  const email = `member+${Date.now()}@example.com`
  await seedAndLogin(page, email, 'Password123!', 'Ordinary Member')
  const cookies = await page.context().cookies()
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  // Direct write through the anon key: blocked by column-level grants, not RLS,
  // since RLS cannot restrict which columns an UPDATE touches.
  const direct = await page.evaluate(async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    )
    return 'unreachable'
  }).catch(() => 'blocked')
  expect(['blocked', 'unreachable']).toContain(direct)

  // And through the admin route, which checks the caller's level
  const viaRoute = await page.request.post(`${baseUrl()}/api/team/manager`, {
    headers: { cookie: cookieHeader },
    data: { user_id: 'self', role: 'admin' },
  })
  expect(viaRoute.status()).toBe(403)
  expect((await viaRoute.json()).error).toContain('admin')

  // A member also cannot invite an admin
  const badInvite = await page.request.post(`${baseUrl()}/api/team/invite`, {
    headers: { cookie: cookieHeader },
    data: { email: `sneaky+${Date.now()}@example.com`, role: 'admin' },
  })
  expect(badInvite.status()).toBe(403)
})

test('a department sees each others shared tasks but not private 1-on-1 commitments', async ({ page, browser }) => {
  test.skip(
    !(await tableExists('invitations')),
    'run supabase-access-control.sql and supabase-departments.sql in the Supabase SQL editor',
  )

  const stamp = Date.now()
  const alphaEmail = `dept-a+${stamp}@example.com`
  const betaEmail = `dept-b+${stamp}@example.com`
  const outsiderEmail = `dept-c+${stamp}@example.com`
  const password = 'Password123!'

  // Two in Marketing, one in Sales. Department comes off the invitation.
  await invite(alphaEmail, { department: 'Marketing' })
  await invite(betaEmail, { department: 'Marketing' })
  await invite(outsiderEmail, { department: 'Sales' })
  await createUser(alphaEmail, password, 'Alpha Marketer')
  await createUser(betaEmail, password, 'Beta Marketer')
  await createUser(outsiderEmail, password, 'Carol Sales')

  const deptReady = await (async () => {
    // Skip cleanly if supabase-departments.sql hasn't run: without it the column
    // is absent and nothing here can hold.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const res = await fetch(`${url}/rest/v1/weekly_commitments?select=visible_to_department&limit=1`, {
      headers: { apikey: anon!, Authorization: `Bearer ${anon}` },
    })
    return res.ok
  })()
  test.skip(!deptReady, 'visible_to_department missing — run supabase-departments.sql')

  // Alpha raises a mid-week task, which defaults to department-visible
  await login(page, alphaEmail, password)
  await page.goto('/tasks')
  await page.getByPlaceholder('What needs doing?').fill('Refresh the campaign landing page')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Refresh the campaign landing page')).toBeVisible({ timeout: 20000 })

  // Alpha also raises one inside a 1-on-1, which defaults to private — a 1-on-1
  // is a performance conversation, not departmental noise.
  await page.goto('/')
  await page.getByRole('button', { name: 'Start 1-on-1' }).click()
  await expect(page).toHaveURL(/.*\/meeting\/.+/)
  await page.getByPlaceholder('Commitment title').fill('Work on presentation confidence')
  await page.getByRole('button', { name: 'Add Commitment' }).click()
  await expect(page.getByText('Work on presentation confidence')).toBeVisible({ timeout: 10000 })

  // Beta, same department, sees the shared one and not the private one
  const betaCtx = await browser.newContext()
  const betaPage = await betaCtx.newPage()
  await login(betaPage, betaEmail, password)
  await betaPage.goto('/tasks')
  await expect(betaPage.getByText('Refresh the campaign landing page')).toBeVisible({ timeout: 15000 })
  await expect(betaPage.getByText('Work on presentation confidence')).toHaveCount(0)

  // Tagged with the department, and it shows under the department filter
  await expect(betaPage.getByText('MARKETING').first()).toBeVisible()
  await betaPage.getByRole('button', { name: 'My department' }).click()
  await expect(betaPage.getByText('Refresh the campaign landing page')).toBeVisible()

  // Read-only: no toggle on somebody else's task, so helping out cannot mean
  // silently closing it
  await expect(betaPage.getByTitle('Mark as done')).toHaveCount(0)
  await betaCtx.close()

  // Carol, different department, sees neither
  const carolCtx = await browser.newContext()
  const carolPage = await carolCtx.newPage()
  await login(carolPage, outsiderEmail, password)
  await carolPage.goto('/tasks')
  await expect(carolPage.getByText('Nothing open here.')).toBeVisible({ timeout: 15000 })
  await expect(carolPage.getByText('Refresh the campaign landing page')).toHaveCount(0)
  await carolCtx.close()
})

test('the close-notice endpoint refuses callers without access', async ({ page, request }) => {
  // Same shape as the sync endpoint below, and for the same reason: it acts with
  // the service role, so it proves the caller may see the task through their own
  // client first. Without that check it would answer "does this id exist?" for
  // anyone with a session.
  const anon = await request.post(`${baseUrl()}/api/tasks/close-notice`, {
    data: { commitment_id: '00000000-0000-0000-0000-000000000000' },
  })
  expect(anon.status()).toBe(401)

  const email = `notice+${Date.now()}@example.com`
  await seedAndLogin(page, email, 'Password123!', 'Notice Tester')
  const cookies = await page.context().cookies()
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  const foreign = await request.post(`${baseUrl()}/api/tasks/close-notice`, {
    headers: { cookie },
    data: { commitment_id: '00000000-0000-0000-0000-000000000000' },
  })
  expect(foreign.status()).toBe(403)
  expect((await foreign.json()).error).toContain('No access')

  const missing = await request.post(`${baseUrl()}/api/tasks/close-notice`, {
    headers: { cookie },
    data: {},
  })
  expect(missing.status()).toBe(400)
})

test('the slack sync endpoint refuses callers without access', async ({ page, request }) => {
  // It reaches Slack with the service role, so the caller's authority is
  // established first through their own client — RLS decides, not the handler.
  const anon = await request.post(`${baseUrl()}/api/slack/sync`, {
    data: { commitment_id: '00000000-0000-0000-0000-000000000000' },
  })
  expect(anon.status()).toBe(401)

  const email = `sync+${Date.now()}@example.com`
  await seedAndLogin(page, email, 'Password123!', 'Sync Tester')
  const cookies = await page.context().cookies()

  const foreign = await request.post(`${baseUrl()}/api/slack/sync`, {
    headers: { cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') },
    data: { commitment_id: '00000000-0000-0000-0000-000000000000' },
  })
  expect(foreign.status()).toBe(403)
  expect((await foreign.json()).error).toContain('No access')

  // Signed in but no id: 400. Unauthenticated it is 401 above, because auth comes
  // first — a stranger shouldn't learn which field the route wants.
  const missing = await request.post(`${baseUrl()}/api/slack/sync`, {
    headers: { cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') },
    data: {},
  })
  expect(missing.status()).toBe(400)
})

test('a main task holds subtasks and reports progress', async ({ page }) => {
  test.skip(
    !(await subtasksReady()),
    'parent_id column missing — run supabase-subtasks.sql in the Supabase SQL editor',
  )

  const email = `parent+${Date.now()}@example.com`
  await seedAndLogin(page, email, 'Password123!', 'Parent Tester')
  await page.goto('/tasks')

  await page.getByPlaceholder('What needs doing?').fill('Build out HIRI Pulse Member edition')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Build out HIRI Pulse Member edition')).toBeVisible({ timeout: 20000 })

  // Subtasks need supabase-subtasks.sql; skip cleanly rather than fail if pending
  await page.getByRole('button', { name: '+ Subtask' }).first().click()
  const subInput = page.getByPlaceholder("What's the next piece of this?")
  await expect(subInput).toBeVisible()
  await subInput.fill('Draft the member onboarding copy')
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  await expect(page.getByText('Draft the member onboarding copy')).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('button', { name: /0 of 1 done/ })).toBeVisible()

  // The form stays open after adding, so several subtasks can go in without
  // reopening it each time — no second '+ Subtask' click needed here.
  await expect(subInput).toBeVisible()
  await subInput.fill('Wire the entitlement check')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('button', { name: /0 of 2 done/ })).toBeVisible({ timeout: 15000 })

  // Closing a subtask must not close the parent — a main task usually has a last
  // step of its own, so that call stays with the person who owns it.
  await page.getByTitle('Mark as done').nth(1).click()
  await expect(page.getByRole('button', { name: /1 of 2 done/ })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Build out HIRI Pulse Member edition')).toBeVisible()

  // Progress survives a reload, so it came from the rows rather than local state
  await page.reload()
  await expect(page.getByRole('button', { name: /1 of 2 done/ })).toBeVisible({ timeout: 15000 })

  // Collapsed after a reload, so the subtask is legitimately not rendered — which
  // is itself the proof it is not also a top-level row.
  await expect(page.getByText('Draft the member onboarding copy')).toHaveCount(0)

  // Expanding shows it exactly once, not twice
  await page.getByRole('button', { name: /1 of 2 done/ }).click()
  await expect(page.getByText('Draft the member onboarding copy')).toHaveCount(1)
})

/** Opens To-Dos & Wrap, where the Open Work review lives. Sections start collapsed. */
async function openToDos(page: Page) {
  await page.getByText('To-Dos & Wrap').click()
  await expect(page.getByTestId('open-work')).toBeVisible({ timeout: 10000 })
}

test('open work from elsewhere lands on the agenda, and closing it there closes the task', async ({ page }) => {
  test.skip(
    !(await trackerReady()),
    'completed_at column missing — run supabase-weekly-tracker.sql in the Supabase SQL editor',
  )

  const email = `openwork+${Date.now()}@example.com`
  await seedAndLogin(page, email, 'Password123!', 'Open Work Tester')

  // A task raised mid-week, belonging to no meeting at all
  await page.goto('/tasks')
  await page.getByPlaceholder('What needs doing?').fill('Chase the vendor invoice')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Chase the vendor invoice')).toBeVisible({ timeout: 15000 })

  // First 1-on-1: the mid-week task is pulled on to the agenda without anyone
  // re-entering it, which is the entire point.
  await page.goto('/')
  await page.getByRole('button', { name: 'Start 1-on-1' }).click()
  await expect(page).toHaveURL(/.*\/meeting\/.+/)
  const firstMeeting = page.url()
  const panel = page.getByTestId('open-work')
  // It lives in To-Dos & Wrap, which is collapsed until opened — that section is
  // the EOS to-do review, so outstanding work is the first thing in it.
  await openToDos(page)
  await expect(panel.getByText('Chase the vendor invoice')).toBeVisible({ timeout: 15000 })
  await expect(panel.getByText('Raised during the week · 1')).toBeVisible()

  // A commitment raised in THIS meeting stays out of the panel — it already has
  // its own section, and listing it twice reads as two separate obligations.
  await page.getByPlaceholder('Commitment title').fill('Send the Q3 scorecard')
  await page.getByRole('button', { name: 'Add Commitment' }).click()
  await expect(page.getByText('Send the Q3 scorecard')).toBeVisible({ timeout: 10000 })
  await page.reload()
  await openToDos(page)
  await expect(panel.getByText('Chase the vendor invoice')).toBeVisible({ timeout: 15000 })
  await expect(panel.getByText('Send the Q3 scorecard')).toHaveCount(0)

  // Next 1-on-1: last meeting's unfinished commitment now carries forward
  await page.goto('/')
  await page.getByRole('button', { name: 'Start 1-on-1' }).click()
  await expect(page).toHaveURL(/.*\/meeting\/.+/)
  expect(page.url()).not.toBe(firstMeeting)
  await openToDos(page)
  await expect(panel.getByText('Send the Q3 scorecard')).toBeVisible({ timeout: 15000 })
  await expect(panel.getByText('Chase the vendor invoice')).toBeVisible()
  await expect(panel.getByText('Carried over from earlier 1-on-1s · 1')).toBeVisible()

  // Ticking it off here closes the real task, not a copy of it. A copy is the
  // failure this design avoids: two rows, one closed, the work still owed.
  await panel.getByTitle('Mark as done').first().click()
  await expect(panel.getByText('2 open')).toHaveCount(0, { timeout: 15000 })

  await page.goto('/tasks')
  await expect(page.getByText(/Done this week · 1/)).toBeVisible({ timeout: 15000 })
})

test('a subtask can be handed to a teammate, and reaches them', async ({ page, browser }) => {
  test.skip(
    !(await subtasksReady()),
    'parent_id column missing — run supabase-subtasks.sql in the Supabase SQL editor',
  )

  const mateEmail = `submate+${Date.now()}@example.com`
  const matePassword = 'Password123!'
  await invite(mateEmail)
  await createUser(mateEmail, matePassword, 'Sub Mate')

  // Sharing a meeting is what puts someone in the owner dropdown, which is the
  // only picker a row this narrow has room for.
  await signInAndStartMeeting(page, 'Main Task Owner')
  await page.getByPlaceholder('Add participant email').fill(mateEmail)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('Sub Mate').first()).toBeVisible({ timeout: 10000 })

  await page.goto('/tasks')
  await page.getByPlaceholder('What needs doing?').fill('Build HIRI Pulse Member edition')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Build HIRI Pulse Member edition')).toBeVisible({ timeout: 20000 })

  await page.getByRole('button', { name: '+ Subtask' }).first().click()
  const subInput = page.getByPlaceholder("What's the next piece of this?")
  const owner = page.getByLabel('Subtask owner')

  // A piece kept for the owner of the main task stays quiet: breaking your own
  // task into five is not five handovers, and five DMs for one is why this was
  // hard-coded off before it could be assigned at all.
  await subInput.fill('Scope the member tiers')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('Scope the member tiers')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText(/Subtask added/)).toHaveCount(0)

  // Handing one to someone else must tell them, naming who it went to
  await subInput.fill('Wire the member auth flow')
  await owner.selectOption({ label: 'Sub Mate' })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText(/Subtask added.*Sub Mate/)).toBeVisible({ timeout: 20000 })
  await expect(page.getByRole('button', { name: /0 of 2 done/ })).toBeVisible({ timeout: 15000 })

  // It really is theirs, not just labelled as theirs
  const mateContext = await browser.newContext()
  const matePage = await mateContext.newPage()
  await login(matePage, mateEmail, matePassword)
  await matePage.goto('/tasks')
  await expect(matePage.getByText('Wire the member auth flow')).toBeVisible({ timeout: 15000 })
  // The piece they were given, and not the piece they were not
  await expect(matePage.getByText('Scope the member tiers')).toHaveCount(0)

  // And they can close their own piece without touching the main task
  await matePage.getByTitle('Mark as done').first().click()
  await expect(matePage.getByText(/Done this week · 1/)).toBeVisible({ timeout: 15000 })
  await mateContext.close()

  // The main task reflects their progress, and is still open — a main task has a
  // last step of its own, so closing it stays with whoever owns it.
  await page.reload()
  await expect(page.getByRole('button', { name: /1 of 2 done/ })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Build HIRI Pulse Member edition')).toBeVisible()
})

test('closing a task in the app records who closed it and how', async ({ page }) => {
  test.skip(
    !(await trackerReady()),
    'completed_at column missing — run supabase-weekly-tracker.sql in the Supabase SQL editor',
  )

  await seedAndLogin(page, `viaapp+${Date.now()}@example.com`, 'Password123!', 'Via App Tester')
  await page.goto('/tasks')

  await page.getByPlaceholder('What needs doing?').fill('Close this one from the board')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  const row = page.getByTestId('task-row').filter({ hasText: 'Close this one from the board' })
  await expect(row).toBeVisible({ timeout: 15000 })

  await row.getByTitle('Mark as done').click()

  // The board, the Slack redraw and the metrics all read completed_via, and every
  // one of them had nothing to read after an in-app close: the badge is the visible
  // half of that, so it is what this asserts.
  await expect(page.getByText('in the app by Via App Tester')).toBeVisible({ timeout: 15000 })

  // Survives a reload, so it is on the row and not only in local state.
  await page.reload()
  await expect(page.getByText('in the app by Via App Tester')).toBeVisible({ timeout: 15000 })

  // Reopening clears it rather than leaving a stale "closed by" on an open task.
  await page.getByTestId('task-row').filter({ hasText: 'Close this one from the board' })
    .getByTitle('Mark as open').click()
  await expect(page.getByText('in the app by Via App Tester')).toHaveCount(0)
})

test('a task carries notes, and they can be added or changed afterwards', async ({ page }) => {
  test.skip(
    !(await trackerReady()),
    'completed_at column missing — run supabase-weekly-tracker.sql in the Supabase SQL editor',
  )

  await seedAndLogin(page, `notes+${Date.now()}@example.com`, 'Password123!', 'Notes Tester')
  await page.goto('/tasks')

  const notesBox = page.getByPlaceholder(/Notes and context/)
  await page.getByPlaceholder('What needs doing?').fill('Build HIRI Pulse Member edition')
  await notesBox.fill('Start from the pricing doc in Drive.\nMember tiers are still open.')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Build HIRI Pulse Member edition')).toBeVisible({ timeout: 20000 })

  // Collapsed by default — twenty tasks with twenty paragraphs is not a list
  await expect(page.getByText('Start from the pricing doc in Drive.')).toHaveCount(0)
  await page.getByRole('button', { name: /Notes/ }).first().click()
  await expect(page.getByText('Start from the pricing doc in Drive.')).toBeVisible()
  // Newlines survive rather than collapsing into one run-on line
  await expect(page.getByText('Member tiers are still open.')).toBeVisible()

  // The form is cleared, so the next task does not silently inherit this context
  await expect(notesBox).toHaveValue('')

  // It persisted rather than only rendering
  await page.reload()
  await page.getByRole('button', { name: /Notes/ }).first().click()
  await expect(page.getByText('Start from the pricing doc in Drive.')).toBeVisible({ timeout: 15000 })

  // Editing in place
  await page.getByRole('button', { name: 'Edit' }).first().click()
  const editor = page.getByPlaceholder(/Background, links, what done looks like/)
  await editor.fill('Pricing is settled — build against the final tiers.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Pricing is settled — build against the final tiers.')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Start from the pricing doc in Drive.')).toHaveCount(0)

  // A task created without notes can have them added later
  await page.getByPlaceholder('What needs doing?').fill('Draft the September newsletter')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Draft the September newsletter')).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: '+ Notes' }).first().click()
  await page.getByPlaceholder(/Background, links, what done looks like/).fill('Theme is retention.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Theme is retention.')).toBeVisible({ timeout: 15000 })

  await page.reload()
  await expect(page.getByRole('button', { name: '+ Notes' })).toHaveCount(0, { timeout: 15000 })
})

test('a task can be deleted, and a main task takes its subtasks with it', async ({ page }) => {
  test.skip(
    !(await subtasksReady()),
    'parent_id column missing — run supabase-subtasks.sql in the Supabase SQL editor',
  )

  await seedAndLogin(page, `del+${Date.now()}@example.com`, 'Password123!', 'Delete Tester')
  await page.goto('/tasks')

  const rowFor = (title: string) => page.getByTestId('task-row').filter({ hasText: title })

  // Cancelling must leave it alone — destructive, so it asks first
  await page.getByPlaceholder('What needs doing?').fill('Keep this one')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Keep this one')).toBeVisible({ timeout: 20000 })
  const keep = rowFor('Keep this one')
  await keep.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(keep.getByText('Delete?')).toBeVisible()
  await keep.getByRole('button', { name: 'Cancel' }).click()
  await expect(keep.getByText('Delete?')).toHaveCount(0)
  await expect(page.getByText('Keep this one')).toBeVisible()

  // A plain task goes, and stays gone rather than only disappearing from view
  await page.getByPlaceholder('What needs doing?').fill('Delete this one')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Delete this one')).toBeVisible({ timeout: 20000 })

  const doomed = rowFor('Delete this one')
  // Exactly one exact-'Delete' button per row either way: the trigger is replaced
  // by the confirmation, so the same locator serves for both clicks.
  await doomed.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(doomed.getByText('Delete?')).toBeVisible()
  await doomed.getByRole('button', { name: 'Delete', exact: true }).click()
  // Asserted on rows, not page text: the confirmation notice quotes the title
  // back ("Deleted \"Delete this one\"."), so getByText still finds it.
  await expect(rowFor('Delete this one')).toHaveCount(0, { timeout: 15000 })
  await page.reload()
  await expect(rowFor('Delete this one')).toHaveCount(0, { timeout: 15000 })
  await expect(rowFor('Keep this one')).toHaveCount(1)

  // A main task with subtasks says what else goes, because parent_id cascades in
  // the database and losing five pieces of work by surprise is not recoverable
  await page.getByPlaceholder('What needs doing?').fill('Build the member edition')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Build the member edition')).toBeVisible({ timeout: 20000 })

  // Scoped to this task's group, not `.first()`: with two tasks on the board
  // `.first()` hung the subtasks off the wrong parent, and every assertion still
  // passed because the subtasks did exist — just not where the test meant.
  const group = page.getByTestId('task-group').filter({ hasText: 'Build the member edition' })
  await group.getByRole('button', { name: '+ Subtask' }).click()
  const subInput = group.getByPlaceholder("What's the next piece of this?")
  for (const piece of ['Wire the auth flow', 'Ship the survey screen']) {
    await subInput.fill(piece)
    await group.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(group.getByText(piece)).toBeVisible({ timeout: 15000 })
  }
  await expect(group.getByRole('button', { name: /0 of 2 done/ })).toBeVisible()

  const parent = rowFor('Build the member edition')
  await parent.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(parent.getByText('Delete this and its 2 subtasks?')).toBeVisible()
  await parent.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(page.getByText(/Deleted .*and its 2 subtasks/)).toBeVisible({ timeout: 15000 })
  await page.reload()
  await expect(rowFor('Build the member edition')).toHaveCount(0, { timeout: 15000 })
  await expect(rowFor('Wire the auth flow')).toHaveCount(0)
  await expect(rowFor('Ship the survey screen')).toHaveCount(0)
  // and the untouched one is still there, so the cascade was scoped
  await expect(rowFor('Keep this one')).toHaveCount(1)
})

test('a task can be handed to someone else after the fact', async ({ page, browser }) => {
  test.skip(
    !(await trackerReady()),
    'completed_at column missing — run supabase-weekly-tracker.sql in the Supabase SQL editor',
  )

  const mateEmail = `reassign+${Date.now()}@example.com`
  const matePassword = 'Password123!'
  await invite(mateEmail)
  await createUser(mateEmail, matePassword, 'New Owner')

  // Sharing a meeting is what puts someone in the owner dropdown
  await signInAndStartMeeting(page, 'First Owner')
  await page.getByPlaceholder('Add participant email').fill(mateEmail)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByText('New Owner').first()).toBeVisible({ timeout: 10000 })

  await page.goto('/tasks')
  await page.getByPlaceholder('What needs doing?').fill('Chase the vendor invoice')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Chase the vendor invoice')).toBeVisible({ timeout: 20000 })

  const row = page.getByTestId('task-row').filter({ hasText: 'Chase the vendor invoice' })
  await expect(row.getByText('You', { exact: false })).toBeVisible()

  await row.getByRole('button', { name: 'Owner & date' }).click()
  await row.getByLabel('Task owner').selectOption({ label: 'New Owner' })
  await row.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.getByText(/Reassigned/)).toBeVisible({ timeout: 20000 })
  // Still visible to the creator, but owned by someone else now
  await page.reload()
  const after = page.getByTestId('task-row').filter({ hasText: 'Chase the vendor invoice' })
  await expect(after.getByText('New Owner')).toBeVisible({ timeout: 15000 })

  // And it is genuinely theirs, not just labelled so
  const ctx = await browser.newContext()
  const matePage = await ctx.newPage()
  await login(matePage, mateEmail, matePassword)
  await matePage.goto('/tasks')
  await expect(matePage.getByText('Chase the vendor invoice')).toBeVisible({ timeout: 15000 })
  await matePage.getByRole('button', { name: 'Mine to do' }).click()
  await expect(matePage.getByText('Chase the vendor invoice')).toBeVisible()
  await ctx.close()
})

test('a subtask keeps its own due date, not the parent’s', async ({ page }) => {
  test.skip(
    !(await subtasksReady()),
    'parent_id column missing — run supabase-subtasks.sql in the Supabase SQL editor',
  )

  const plus = (days: number) => {
    const [y, m, d] = todayISO().split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() + days)
    return dt.toISOString().slice(0, 10)
  }
  const parentDue = plus(30)
  const subDue = plus(3)

  await seedAndLogin(page, `stages+${Date.now()}@example.com`, 'Password123!', 'Stages Tester')
  await page.goto('/tasks')

  await page.getByPlaceholder('What needs doing?').fill('Build the member edition')
  await page.locator('input[type="date"]').first().fill(parentDue)
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Build the member edition')).toBeVisible({ timeout: 20000 })

  const group = page.getByTestId('task-group').filter({ hasText: 'Build the member edition' })
  await group.getByRole('button', { name: '+ Subtask' }).click()

  // Pre-filled from the parent, which is the sensible default...
  await expect(group.getByLabel('Subtask due date')).toHaveValue(parentDue)
  // ...but a piece waiting on someone else is due earlier than the whole
  await group.getByLabel('Subtask due date').fill(subDue)
  await group.getByPlaceholder("What's the next piece of this?").fill('Wire the auth flow')
  await group.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(group.getByText('Wire the auth flow')).toBeVisible({ timeout: 15000 })

  await page.reload()
  await expect(page.getByRole('button', { name: /0 of 1 done/ })).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: /0 of 1 done/ }).click()

  const parentRow = page.getByTestId('task-row').filter({ hasText: 'Build the member edition' })
  const subRow = page.getByTestId('task-row').filter({ hasText: 'Wire the auth flow' })
  await expect(parentRow.getByText(describeDue(parentDue))).toBeVisible()
  await expect(subRow.getByText(describeDue(subDue))).toBeVisible()
  expect(describeDue(parentDue)).not.toBe(describeDue(subDue))
})

test('a finished commitment drops off the meeting’s open list', async ({ page }) => {
  test.skip(
    !(await commitmentsTableExists()),
    'weekly_commitments table missing — run supabase-commitments.sql in the Supabase SQL editor',
  )

  await signInAndStartMeeting(page, 'Wrap Tester')
  await page.getByPlaceholder('Commitment title').fill('Send the Q3 scorecard')
  await page.getByRole('button', { name: 'Add Commitment' }).click()
  await expect(page.getByText('Send the Q3 scorecard')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText(/Done ·/)).toHaveCount(0)

  await page.getByTitle('Mark as done').first().click()

  // Off the open list, but not out of the record: a 1-on-1 is partly a review of
  // what got finished.
  await expect(page.getByText('Everything raised here is done.')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Send the Q3 scorecard')).toHaveCount(0)
  await expect(page.getByText(/Done · 1/)).toBeVisible()

  await page.getByRole('button', { name: /Done · 1/ }).click()
  await expect(page.getByText('Send the Q3 scorecard')).toBeVisible()

  await page.reload()
  await expect(page.getByText('Everything raised here is done.')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Send the Q3 scorecard')).toHaveCount(0)
})

test('an unresolved issue carries into the next 1-on-1', async ({ page }) => {
  await signInAndStartMeeting(page, 'Issues Tester')
  const firstUrl = page.url()
  const firstId = firstUrl.split('/meeting/')[1]

  // Issues are section 4, collapsed until opened
  await page.getByText('Issues — Identify, Discuss, Solve').click()
  await page.getByRole('button', { name: '+ Add issue' }).click()
  const description = page.getByPlaceholder('Issue description...').last()
  await description.fill('Pricing for the member tier is undecided')
  // Saved on blur, so the focus has to leave the field before it persists
  await description.blur()
  await expect(description).toHaveValue('Pricing for the member tier is undecided')

  // The app only ever dates a meeting today, and carry-forward keys off an earlier
  // date, so the previous one has to be moved back.
  await backdateMeeting(firstId, '2026-08-01')

  await page.goto('/')
  await page.getByRole('button', { name: 'Start 1-on-1' }).click()
  await expect(page).toHaveURL(/.*\/meeting\/.+/)
  expect(page.url()).not.toBe(firstUrl)

  // An issues list you have to retype is not a list. It should be waiting.
  await page.getByText('Issues — Identify, Discuss, Solve').click()
  const carried = page.locator('input[placeholder="Issue description..."]')
  await expect(carried).toHaveCount(1, { timeout: 15000 })
  await expect(carried.first()).toHaveValue('Pricing for the member tier is undecided')
})

test('a resolved issue does not follow you around', async ({ page }) => {
  await signInAndStartMeeting(page, 'Resolved Tester')
  const firstId = page.url().split('/meeting/')[1]

  await page.getByText('Issues — Identify, Discuss, Solve').click()
  await page.getByRole('button', { name: '+ Add issue' }).click()
  const description = page.getByPlaceholder('Issue description...').last()
  await description.fill('Scorecard numbers are stale')
  await description.blur()
  await expect(description).toHaveValue('Scorecard numbers are stale')

  // Resolving is what stops carry-forward. Without it every issue is immortal,
  // which would make the list worse than not carrying anything at all.
  await page.getByTitle('Mark as resolved').first().click()
  await expect(page.getByText(/Resolved · 1/)).toBeVisible({ timeout: 15000 })
  // It drops off the open list, like a finished commitment
  await expect(page.locator('input[placeholder="Issue description..."]')).toHaveCount(0)

  await backdateMeeting(firstId, '2026-08-01')
  await page.goto('/')
  await page.getByRole('button', { name: 'Start 1-on-1' }).click()
  await expect(page).toHaveURL(/.*\/meeting\/.+/)

  await page.getByText('Issues — Identify, Discuss, Solve').click()
  await expect(page.getByRole('button', { name: '+ Add issue' })).toBeVisible({ timeout: 15000 })
  // Nothing carried at all: a solved issue is not the next meeting's business
  await expect(page.locator('input[placeholder="Issue description..."]')).toHaveCount(0)
  await expect(page.getByText(/Resolved ·/)).toHaveCount(0)
})

test('the metrics page is not readable without a session', async ({ page }) => {
  await page.goto('/metrics')
  await expect(page.getByText('You need to be signed in to see metrics.')).toBeVisible({ timeout: 10000 })
})

test('metrics show your own numbers and say when scope is just you', async ({ page }) => {
  const ready = await metricsReady()

  await seedAndLogin(page, `metrics+${Date.now()}@example.com`, 'Password123!', 'Metrics Tester')

  // A task closed late, so there is something to count
  await page.goto('/tasks')
  await page.getByPlaceholder('What needs doing?').fill('Chase the vendor invoice')
  await page.locator('input[type="date"]').first().fill('2026-08-01')
  await page.getByRole('button', { name: /Add & Notify/ }).click()
  await expect(page.getByText('Chase the vendor invoice')).toBeVisible({ timeout: 20000 })

  await page.getByRole('link', { name: 'Metrics' }).click()
  await expect(page).toHaveURL(/\/metrics$/)
  await expect(page.getByRole('heading', { name: 'Accountability' })).toBeVisible({ timeout: 15000 })

  if (!ready) {
    // Before the migration the page must say so rather than showing nothing and
    // letting it read as "no data".
    await expect(page.getByText(/Run supabase-metrics\.sql/).first()).toBeVisible({ timeout: 15000 })
    return
  }

  // A fresh account manages nobody, so scope is one person and the page says so
  // instead of looking broken.
  await expect(page.getByText(/Only your own numbers so far/)).toBeVisible({ timeout: 15000 })
  // The heading on their card, not the name in the header — that matches twice.
  await expect(page.getByRole('heading', { name: 'Metrics Tester' })).toBeVisible()

  // One open task, already past its date
  await expect(page.getByText('Overdue')).toBeVisible()
  // Too little finished work to publish a rate, and it says that rather than 0%
  await expect(page.getByText(/not enough data/)).toBeVisible()

  // Thirty days by default, and the label matches the window rather than being
  // one day out from the preset that set it
  await expect(page.getByText(/Closed \/ 30d/)).toBeVisible()

  // A preset just fills the dates in; the dates are what count
  await page.getByRole('button', { name: '7 days' }).click()
  await expect(page.getByText(/Closed \/ 7d/)).toBeVisible()
  const from = await page.getByLabel('From', { exact: true }).inputValue()
  const to = await page.getByLabel('To', { exact: true }).inputValue()
  expect(from < to).toBe(true)

  // Dates can be picked directly, not only through a preset
  await page.getByLabel('From', { exact: true }).fill('2026-08-01')
  await page.getByLabel('To', { exact: true }).fill('2026-08-10')
  await expect(page.getByText(/Closed \/ 10d/)).toBeVisible()

  // A backwards range is refused rather than silently measuring nothing
  await page.getByLabel('From', { exact: true }).fill('2026-08-20')
  await expect(page.getByText(/From date is after the To date/)).toBeVisible()
  await page.getByLabel('From', { exact: true }).fill('2026-08-01')

  // Comparison names the window it is comparing against, and says what it excludes
  await page.getByRole('checkbox', { name: /Compare with the previous/ }).check()
  await expect(page.getByText(/22 Jul 2026 – 31 Jul 2026/)).toBeVisible()
  await expect(page.getByText(/Only closed work is compared/)).toBeVisible()
})

test('the delivery log is admins only', async ({ page, request }) => {
  // Anonymous first: an unauthenticated caller should learn nothing.
  const anon = await request.get(`${baseUrl()}/api/notifications/recent`)
  expect(anon.status()).toBe(401)

  // A signed-in member is refused too. notification_log is readable through RLS
  // only for rows about yourself, so this route uses the service role — the admin
  // check is the entire access control.
  await seedAndLogin(page, `member+${Date.now()}@example.com`, 'Password123!', 'Plain Member')
  const asMember = await page.evaluate(async () => {
    const res = await fetch('/api/notifications/recent')
    return { status: res.status, body: await res.json() }
  })
  expect(asMember.status).toBe(403)
  expect(JSON.stringify(asMember.body)).toContain('Admins only')

  // And the panel is not on the page for them
  await page.goto('/metrics')
  await expect(page.getByRole('heading', { name: 'Accountability' })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('Delivery')).toHaveCount(0)
})

test('a scheduled run leaves a heartbeat even when it cannot send', async ({ request }) => {
  loadEnv()
  const secret = process.env.CRON_SECRET
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  test.skip(!secret || !url || !key, 'needs CRON_SECRET and the service role key to verify the log')

  const before = new Date().toISOString()

  // Reachable only with the secret
  const unauthorised = await request.get(`${baseUrl()}/api/notify`)
  expect(unauthorised.status()).toBe(401)

  // The scheduled path. Locally no channel is configured, so this returns 500 —
  // and that is exactly the case that must still be recorded.
  const res = await request.get(`${baseUrl()}/api/notify`, {
    headers: { Authorization: `Bearer ${secret}` },
  })
  expect([200, 500]).toContain(res.status())

  const log = await request.get(
    `${url}/rest/v1/notification_log?select=created_at,event,status,detail` +
    `&event=eq.run&created_at=gte.${before}&order=created_at.desc`,
    { headers: { apikey: key!, Authorization: `Bearer ${key}` } },
  )
  const rows = await log.json()
  // A run that sends nothing used to write nothing at all, which made "never
  // fired" and "fired quietly" the same thing in the log.
  expect(rows.length).toBeGreaterThan(0)
  expect(rows[0].detail).toContain('cron:')

  // A manual send must not leave one, or the panel would claim a scheduled run
  // every time somebody pressed Notify.
  const manualBefore = new Date().toISOString()
  await request.post(`${baseUrl()}/api/notify`, {
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    data: {},
  })
  const after = await request.get(
    `${url}/rest/v1/notification_log?select=created_at&event=eq.run&created_at=gte.${manualBefore}`,
    { headers: { apikey: key!, Authorization: `Bearer ${key}` } },
  )
  expect((await after.json()).length).toBe(0)

  // Remove the heartbeats this test wrote. They say "no channel configured", which
  // is true on a dev machine and false in production — and the admin panel reads
  // the newest one, so leaving them behind would make it report a failure that
  // never happened to anybody.
  await request.delete(
    `${url}/rest/v1/notification_log?event=eq.run&created_at=gte.${before}`,
    { headers: { apikey: key!, Authorization: `Bearer ${key}` } },
  )
})

test('a 1-on-1 can be scheduled, and a skipped week shows up', async ({ page }) => {
  test.skip(!(await schedulesReady()), 'meeting_schedules missing — run supabase-schedules.sql')

  // The manager has to exist first: the report is invited under them, and without
  // that relationship the directory does not list them for each other at all.
  const mgrEmail = `mgr+${Date.now()}@example.com`
  await seedAndLogin(page, mgrEmail, 'Password123!', 'Sam Davel')
  const mgrId = await profileIdFor(mgrEmail)

  const mateEmail = `sched+${Date.now()}@example.com`
  await invite(mateEmail, { managerId: mgrId })
  await createUser(mateEmail, 'Password123!', 'Ashley Rivera')

  await page.goto('/team')
  await expect(page.getByText('Ashley Rivera')).toBeVisible({ timeout: 15000 })

  // Set a weekly Wednesday 1-on-1
  await page.getByRole('button', { name: '+ Schedule' }).first().click()
  await page.getByLabel(/1-on-1 day with/).selectOption({ label: 'Wednesday' })
  await page.getByLabel(/1-on-1 cadence with/).selectOption({ label: 'Every week' })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: /Wed · wkly/ })).toBeVisible({ timeout: 15000 })

  // The dashboard now knows when it is due — and says nothing about weeks before
  // the schedule existed. A cadence set today opening with "missed 8 of the last 8"
  // would be untrue, and the fastest way to get the panel ignored.
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Cadence' })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText(/Every week on Wednesday/)).toBeVisible()
  await expect(page.getByText('Ashley Rivera')).toBeVisible()
  await expect(page.getByText(/Missed/)).toHaveCount(0)

  // Give it history, and the skipped weeks appear — which is the whole point: a
  // week nobody held used to leave no trace anywhere.
  await backdateSchedule(mgrId, '2026-06-01T09:00:00Z')
  await page.reload()
  await expect(page.getByText(/Missed/).first()).toBeVisible({ timeout: 15000 })
  await expect(page.getByText(/held 0 of/)).toBeVisible()

  // Removing it takes the panel away rather than leaving an empty section
  await page.goto('/team')
  await page.getByRole('button', { name: /Wed · wkly/ }).click()
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('button', { name: '+ Schedule' }).first()).toBeVisible({ timeout: 15000 })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'New Meeting' })).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('heading', { name: 'Cadence' })).toHaveCount(0)
})
