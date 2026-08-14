import { test, expect } from '@playwright/test'

test('signup -> create meeting', async ({ page, baseURL }) => {
  // Use baseURL from config (DEPLOY_URL or localhost)
  await page.goto('/');

  // Switch to sign up flow
  await page.getByText('Sign up').click();

  const name = 'E2E User'
  const email = `e2e+${Date.now()}@example.com`
  const password = 'Password123!'

  await page.getByPlaceholder('Full name').fill(name)
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill(password)

  await page.getByRole('button', { name: 'Create Account' }).click()

  // After signup, dashboard should show
  await page.getByText('New Meeting').waitFor({ timeout: 10000 })

  // Start a meeting; leave report email blank
  await page.getByRole('button', { name: 'Start 1-on-1' }).click()

  // Expect to be redirected to a meeting page
  await expect(page).toHaveURL(/.*\/meeting\/.+/)
})
