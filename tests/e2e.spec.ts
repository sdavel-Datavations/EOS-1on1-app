import { test, expect, Page } from '@playwright/test'
import { seedAndLogin, createUser, login, baseUrl, commitmentsTableExists, participantsTableExists } from './playwright-auth'

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
  await createUser(guestEmail, guestPassword, 'Guest Participant')

  // Manager creates the meeting and adds the guest
  await signInAndStartMeeting(page, 'Meeting Owner')
  const meetingUrl = page.url()

  await page.getByPlaceholder('Add participant email').fill(guestEmail)
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('Guest Participant').first()).toBeVisible({ timeout: 10000 })

  // The guest gets their own segue box in the shared agenda
  await expect(page.getByPlaceholder('Personal win...')).toHaveCount(2)

  // The point of the participants table: the guest can actually load the meeting.
  // Under the old manager/report-only policies this hung on "Loading meeting...".
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

test('extraction endpoint rejects unauthenticated callers', async ({ request }) => {
  // The whole point of the server-auth foundation: a route handler that holds an
  // API key must know who is calling. No session cookie => no extraction.
  const res = await request.post(`${baseUrl()}/api/extract`, {
    data: { meeting_id: '00000000-0000-0000-0000-000000000000', transcript: 'Sam: I will send the numbers.' },
  })
  expect(res.status()).toBe(401)
  expect((await res.json()).error).toContain('Not signed in')
})

test('extraction endpoint validates its input', async ({ request }) => {
  const res = await request.post(`${baseUrl()}/api/extract`, { data: { transcript: 'x' } })
  expect(res.status()).toBe(400)
  expect((await res.json()).error).toContain('required')
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

  // Toggling done persists
  await page.getByTitle('Mark as done').click()
  await page.reload()
  await expect(page.getByTitle('Mark as open')).toBeVisible({ timeout: 10000 })
})
