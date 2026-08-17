import { test, expect, Page } from '@playwright/test'
import { seedAndLogin, commitmentsTableExists } from './playwright-auth'

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
