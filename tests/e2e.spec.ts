import { test, expect } from '@playwright/test'
import { seedAndLogin } from './playwright-auth'

test('signup -> create meeting', async ({ page, baseURL }) => {
  const name = 'E2E User'
  const email = `e2e+${Date.now()}@example.com`
  const password = 'Password123!'

  // create user and set session directly to avoid email flows
  await seedAndLogin(page, email, password, name)

  // Now visit the app (session is preloaded)
  await page.goto('/')

  // Dashboard should show
  await page.getByText('New Meeting').waitFor({ timeout: 10000 })

  // Start a meeting; leave report email blank
  await page.getByRole('button', { name: 'Start 1-on-1' }).click()

  // Expect to be redirected to a meeting page
  await expect(page).toHaveURL(/.*\/meeting\/.+/)
})
