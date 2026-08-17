# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e.spec.ts >> signup -> create meeting
- Location: tests/e2e.spec.ts:4:5

# Error details

```
TimeoutError: locator.waitFor: Timeout 10000ms exceeded.
Call log:
  - waiting for getByText('New Meeting') to be visible

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e3]:
    - generic [ref=e4]: "Supabase URL (runtime): https://gcostwqdmjtsxoiopafh.supabase.co"
    - generic [ref=e5]:
      - heading "DATAVATIONS" [level=1] [ref=e6]
      - paragraph [ref=e7]: Weekly 1-on-1 Agenda
    - generic [ref=e9]:
      - textbox "Email" [ref=e10]
      - textbox "Password" [ref=e11]
      - button "Sign In" [ref=e12]
    - paragraph [ref=e13]:
      - text: No account?
      - button "Sign up" [ref=e14]
  - alert [ref=e15]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test'
  2  | import { seedAndLogin } from './playwright-auth'
  3  | 
  4  | test('signup -> create meeting', async ({ page, baseURL }) => {
  5  |   const name = 'E2E User'
  6  |   const email = `e2e+${Date.now()}@example.com`
  7  |   const password = 'Password123!'
  8  | 
  9  |   // create user and set session directly to avoid email flows
  10 |   await seedAndLogin(page, email, password, name)
  11 | 
  12 |   // Now visit the app (session is preloaded)
  13 |   await page.goto('/')
  14 | 
  15 |   // Dashboard should show
> 16 |   await page.getByText('New Meeting').waitFor({ timeout: 10000 })
     |                                       ^ TimeoutError: locator.waitFor: Timeout 10000ms exceeded.
  17 | 
  18 |   // Start a meeting; leave report email blank
  19 |   await page.getByRole('button', { name: 'Start 1-on-1' }).click()
  20 | 
  21 |   // Expect to be redirected to a meeting page
  22 |   await expect(page).toHaveURL(/.*\/meeting\/.+/)
  23 | })
  24 | 
```