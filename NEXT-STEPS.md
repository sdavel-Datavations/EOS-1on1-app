# eos-1on1-app — handoff

An EOS-style weekly 1-on-1 app: agendas, tasks, accountability metrics, and a cadence
that notices when a week gets skipped.

- **Live:** https://eos-1on1-app.vercel.app
- **Stack:** Next 16.3.1 · React 19 · Supabase (Postgres + RLS + Auth) · Tailwind v4 · Playwright
- **Notifications:** Slack DM + email (Resend). No AI/LLM dependency anywhere.

## State as of 2026-08-19

- **14 migrations, all applied.** 332 tests pass, in 3.6 minutes. `npm run build` is clean; `npm run lint`
  is not, and never has been — see the last item under Known gaps.
- **Everything is pushed.** Nothing local.
- **One real account:** sam@datavations.com — `access_level` admin, department Marketing,
  Slack linked. Nobody else has been invited.
- **The database is empty of content:** 0 tasks, 0 meetings, 0 schedules, 0 Rocks, 0 issues.
  Every feature below is built and tested; almost none has been used in earnest.

## What is proven, and what is not

| Path | Status |
|---|---|
| Email notifications | **Working.** 4 successful sends. Two bugs fixed to get there: a doubled `@` in `NOTIFY_FROM_EMAIL`, then an unverified Resend domain. |
| Slack DM + **Mark done button** | **Working.** Confirmed `closed via slack_button`. |
| Slack **reply “done”** | **Working**, as of 2026-08-19. It had never fired once, and the cause was Slack-side: App Home → Show Tabs → Messages Tab. The toggle only shows the tab; the **checkbox under it** — *Allow users to send Slash commands and messages* — is the permission to type, and it stays clear when you flip the toggle. |
| Nightly cron | **Never observed.** 0 heartbeat rows. One should appear the first weekday after a deploy, at 13:00 UTC. Watch the Delivery panel on `/metrics`. |
| Assigner confirmation DM | **Never fired.** Needs a creator and assignee who are different people, both on Slack. |
| **Close notice to the assigner** | **Never fired**, same reason. Unit-tested, but no close has yet had a different assigner and closer. |
| Metrics dashboard | **Proven** against seeded data with a manager and a report; figures checked by hand. |
| Cadence / skipped weeks | **Proven** against seeded data. |
| Anything multi-person | **Only ever run with synthetic test accounts.** |

## Next steps, in order

1. **Invite Ashley** at `/team` — email, department Marketing, manager Sam. Signup is
   invite-only. This converts a dozen built-but-never-run features into working or broken,
   including both assigner DMs, which cannot fire until two real people are involved.
2. **Set a schedule** for her on `/team`, then hold the first real 1-on-1 — with her email in
   Direct Report, or the cadence panel counts it missed (see below).
3. **Add a Q3 Rock** for her; confirm it appears in the *next* meeting without being copied.
4. **Watch `/metrics` → Delivery** for the first cron heartbeat.

## Env vars in Vercel

Set: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ACTION_TOKEN_SECRET`, `CRON_SECRET`,
`RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` (`noreply@marketing.task.datavations.com`).

Not set: `NEXT_PUBLIC_APP_URL` (optional — falls back to `VERCEL_PROJECT_PRODUCTION_URL`).

`.env.local` holds **only** Supabase keys, `ACTION_TOKEN_SECRET` and `CRON_SECRET` — no Slack
or Resend credentials, so **neither Slack nor email can send from localhost.** A non-send in
dev proves nothing; test those on the deployed app.

Vercel cron: `/api/notify` at `0 13 * * 1-5` (13:00 UTC, weekdays), in `vercel.json`.

## Migration order

Run in this order; each depends on the ones before it. All 14 are applied.

`supabase-schema.sql` → `commitments` → `participants` → `transcripts` → `delete-meetings` →
`weekly-tracker` → `notifications` → `access-control` → `departments` → `subtasks` → `rocks`
→ `metrics` → `schedules`

(That is 13 names for 14 files — `supabase-schema.sql` plus 13 others.)

## How the pieces fit

**Tasks.** `weekly_commitments` holds *both* mid-week tasks (`meeting_id` null) and
commitments raised in a 1-on-1. Departmental sharing and subtasks apply to standalone tasks
only — a 1-on-1 commitment can be performance material.

- Subtasks are **one level deep** (trigger-enforced), **assignable**, and carry **their own
  due dates** (pre-filled from the parent, then independent — work runs in stages).
- **Notes** live in `description` and travel into the Slack DM and the email. Context that
  stays in the app is context the assignee never reads.
- **Due dates are the assigner's to change** — enforced by a trigger, since RLS cannot
  restrict which columns an UPDATE touches. Admins are exempt so a task created by someone
  who has left can still be corrected. Delegating a task onward stays open to whoever holds it.
- **Reassignment** goes through `/api/tasks/reassign`, never a direct column write: the old
  owner's Slack DM has to be retired first, because its Mark done button closes by task id
  rather than by who pressed it.
- **All four ways of closing a task record `completed_by` and `completed_via`.** The board's
  checkbox recorded neither for a long time, and three features were quietly reading them: the
  badge on the task row, the name in the Slack redraw's "Closed by … in the app", and the
  closure-channel breakdown in `/metrics`, which said *unrecorded*. The column is free text on
  purpose — a new surface should not need a migration to say how it closed something — so the
  cost of forgetting is silence rather than an error. Reopening clears both.
- **The assigner hears once when a task is closed** — a quiet DM, no button, skipped when
  you close your own task, which is most of them. `closeNoticeDecision()` holds the rules and
  `punctualityLabel()` reuses `punctualityOf()` from the metrics, so a DM cannot disagree with
  the dashboard about whether something was late. Deduped on a `notification_log` row, so
  reopening and re-closing does not repeat it. The three out-of-app surfaces send it from
  `completeTask`; the board's checkbox is a plain RLS update with no service role in the path,
  so it calls `/api/tasks/close-notice` separately rather than move that write server-side.
- **An orphaned subtask must never disappear.** Hand someone one piece of a task whose parent
  RLS hides, and that row is neither top-level nor drawn by a parent. `isTopLevel()` in
  `src/lib/open-work.ts` is the single rule, used by the task board and the agenda alike.

**Agenda.** Five timed EOS sections. **Open Work** sits inside To-Dos & Wrap — that section
*is* the EOS to-do review — and reads every still-open task belonging to the people in the
meeting, excluding that meeting's own commitments. Read, never copied.

**Rocks** live in `rocks` keyed by (owner_id, quarter) and are **read** by every agenda that
quarter rather than copied. `rock_checkins` holds the weekly pulse.

**Issues** carry forward until resolved, and can now *be* resolved — `resolved` was a column
with nothing setting it, so carrying them forward without that would have made every issue
immortal.

**Metrics** (`/metrics`). Scope comes from `team_ids()`, **not** from reading `profiles`:
`can_view_profile` also grants anyone you share a meeting with, and a peer's numbers are not a
manager's business. Recursive, so a department head inherits their reports' reports.

- **On time** = `completed_at::date <= due_date`. Undated work is neither on time nor late and
  sits outside the figure — counting it as punctual would flatter everyone.
- **The rate is blank below four judged tasks.** One late out of three reads as 33% and swings
  to 0% next week.
- **`commitment_events`** records due-date and owner changes, so the metric cannot be gamed by
  moving a deadline. Deadline moves show next to the rate.
- Comparison is against the **equal-length** window ending the day before. Only closed work is
  compared — open/overdue/oldest describe today, not a period. A delta is suppressed when
  either window is below the minimum.
- Flow counts **handovers only**.
- `is_admin()` is **global**, not per-department. A second department needing its own admin
  would need a department dimension on `access_level`.

**Cadence** (`meeting_schedules`). A schedule says when a 1-on-1 was *expected*; a meeting row
says one *happened*. The gap is the feature.

- **Nothing auto-creates meetings.** A scheduler's row would be indistinguishable from a
  meeting somebody held, erasing the very gaps this reveals.
- **Held is matched by week**, not by exact date — a Wednesday moved to Thursday is the same
  1-on-1.
- **A solo agenda does not count.** Matching is on the (manager, report) pair, so *Start
  1-on-1* with Direct Report blank will read as a missed week.
- **Weeks before the schedule existed are not misses** (clamped to `created_at`), and **today
  is never missed yet**.
- Only the **manager side** (or an admin) can set or change one.
- Google Calendar sync was considered and **not** built: OAuth refresh tokens with calendar
  scope held server-side, and it still would not say whether the 1-on-1 *happened*. A sensible
  addition on top later, not instead.

**Delivery** (`/delivery`, admin-only tab). Every scheduled run writes a heartbeat to
`notification_log` — including quiet runs and ones that fail for want of a channel — because a
run that sends nothing used to write nothing, making "never fired" and "fired quietly"
identical. A *manual* send deliberately writes none. The page reads
`/api/notifications/recent`: service role behind an admin check, since the table's RLS only
exposes rows about yourself.

- **A failure is answered by a later success on the same channel**, and only unanswered ones
  are counted. The panel used to call every failed row a failure for all time, so two config
  mistakes from one afternoon sat on screen permanently after email started working — which is
  the fastest way to teach someone to ignore a monitoring panel.
- **Health is asked for directly, not inferred from a window of recent rows.** A channel's last
  success can sit well outside any such window once the log has volume, which would read as
  "email is broken" rather than "email was broken yesterday".
- **"Never used" is distinct from "healthy".** A channel that has sent nothing has proved
  nothing — the same reason the cron looked fine for a fortnight while never having run.
- It sat on `/metrics` only because that was the only admin-gated page. Nothing about delivery
  is a measure of anyone's work, and `/metrics` is now only about people.

**The header is one component** (`src/components/AppNav.tsx`). It was copy-pasted into four
pages, so reordering the tabs was the same edit four times with nothing to stop the copies
drifting. A test walks every page asserting the nav and a heading render, because nothing else
did — and a mistake in a shared header takes down every page at once.

## Conventions to keep

- **Probe the live database before trusting a schema file.** `profiles.role` already existed
  with values a new check constraint would have rejected, which would have aborted an entire
  migration.
- **Every migration-dependent test is skip-gated** on a probe (`trackerReady`, `subtasksReady`,
  `metricsReady`, `schedulesReady`, `tableExists`) so the suite is green before and after.
- **RLS decides visibility; never re-filter the same rule in the query.** A duplicate
  client-side filter silently hid departmental and oversight tasks.
- **Oversight is read-only**, via separate `FOR SELECT` policies. Don't widen `FOR ALL`.
- **Never let a missing env var throw.** `tryServiceClient()` exists because an unhandled throw
  returned a 500 with an empty body.
- **Detect an RLS refusal.** A blocked UPDATE or DELETE affects no rows and reports no error —
  indistinguishable from success. Always `.select()` back and check.
- **Dates are compared as `YYYY-MM-DD` strings, never parsed into `Date`.** `new
  Date('2026-08-20')` is UTC midnight, which is the 19th west of Greenwich. This has caused
  real bugs twice: overdue styling, and meetings filed a day late by `toISOString()`.
- **`notification_log` is the first place to look** when a notification silently fails.
- `rm -rf .next` under a running `next dev` kills the dev server; Playwright then fails with
  `fetch failed`.

## Testing traps worth remembering

- **A hook after an early return takes the whole page down.** `useSchedules` below
  `if (!user) return` crashed `/team` entirely — and the suite stayed green, because no test
  asserted that page renders for a signed-in user. Hooks go above every early return.
- **A green suite is not proof a page renders.** Assert on real content, not only on API
  responses and error strings.
- **`.first()` on a board with more than one item attaches work to the wrong parent**, and
  every assertion still passes. Scope to `data-testid="task-group"` / `task-row`.
- **Success notices quote the title back**, so `getByText('<title>')` matches the notice rather
  than the row. Assert on rows when checking something is gone.
- **`getByLabel` substring-matches case-insensitively**, and Next's dev overlay is labelled
  "Open Next.js Dev Tools" — so `getByLabel('To')` matches it. Use `{ exact: true }`.
- **Never run two suites at once.** `globalTeardown` deletes *every* `@example.com` account,
  not only the ones its own run created — so a second run wipes the first run's accounts
  mid-test. Sessions die, pages bounce to the sign-in card, and you get a dozen unrelated
  failures clustered in whichever run was still going. It cost an afternoon: 14 failures, a
  2.2-hour wall-clock, and two wrong diagnoses (auth rate limiting, then a corrupted dev
  server) before the cause turned out to be a second run I had started myself to investigate
  the first. Alone, the same suite is 3.6 minutes and green.
- **Never pipe Playwright through `tail` or `grep` without keeping `$?`.** The exit code you
  see is the last command in the pipe, so a run with 14 failures reports "exited with code 0"
  and a truncated tail can hide the failure list entirely. Two runs were misread as clean this
  way. Redirect to a file and echo the code:
  `npx playwright test --reporter=list > out.txt 2>&1; echo "EXIT: $?"`.
- **Killing a run skips `globalTeardown`**, leaving `@example.com` accounts in the live
  database. Run it by hand:
  `npx tsx -e "import t from './tests/global-teardown'; (t as any)()"`.
- The suite occasionally fails a batch on Supabase slowness — logins time out and `Sign out`
  never appears. Re-run before believing it.

## The one operational risk

**The test suite runs against the production Supabase project.** That is how 8 test accounts
were once left in the live database, and how misleading cron heartbeats were nearly left in
the log. The teardown is narrow and `example.com` is IANA-reserved, but **a second Supabase
project for tests is the actual fix** — worth doing before anyone else's data is in there.

This is also why CI runs only part of the suite. Of 304 tests, **270 are pure functions** —
no browser, no network, no credentials, 1.9s — and those are what GitHub Actions runs on every
push. The remaining 34 live in `tests/e2e.spec.ts`, which signs real accounts in and out of
the live project; putting the service-role key in GitHub to run them would mean writing to
production on every push. Run those locally before pushing. A second Supabase project would
let CI run everything.

## Known gaps, not yet built

- **Three overlapping task concepts on one agenda:** `todos`, Weekly Commitments, Open Work.
  Recommendation: retire the `todos` section — commitments notify, close from Slack, appear on
  `/tasks` and feed the metrics; `todos` do none of that, and the table has 0 rows. Not done
  because it deletes a visible feature.
- **No meeting-prep digest.** Considered and deferred: the agenda's content (headlines,
  scorecard, segue) is all manually typed and currently empty, so a digest would mostly
  announce blanks.
- **No recurring meeting creation** — deliberately, see Cadence above.
- **No first-run empty states.** A new user's first login is a blank dashboard.
- **No per-task audit UI.** `commitment_events` records due-date and owner changes but nothing
  displays the history.
- **19 lint errors, none of them new work.** `npm run lint` has never been clean, so a
  non-zero exit is not a signal that something just broke — read the list, don't count it:
  - 12 × `react-hooks/set-state-in-effect` — the pattern every data hook in the codebase uses.
  - 5 × `no-explicit-any`, 1 × `react/no-unescaped-entities` — cosmetic.
  - 1 × React Compiler *"Cannot call impure function during render"* on `Date.now()` at
    `src/app/meeting/[id]/page.tsx:128`. **Checked: a false positive.** It sits in
    `startMeeting`, which is reached only from `onClick` — the rule can't prove that. Don't
    "fix" it by suppressing the rule; the rule is right about everywhere else.
