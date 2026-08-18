import { test, expect, Page } from '@playwright/test'
import { seedAndLogin, createUser, invite, invitationsReady, login, baseUrl, tableExists, commitmentsTableExists, participantsTableExists, trackerReady } from './playwright-auth'

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

  // Toggling done persists. Wait for the toggle to land before reloading —
  // reloading mid-PATCH aborts the request and tests nothing.
  await page.getByTitle('Mark as done').click()
  await expect(page.getByTitle('Mark as open')).toBeVisible({ timeout: 10000 })
  await page.reload()
  await expect(page.getByTitle('Mark as open')).toBeVisible({ timeout: 10000 })
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
