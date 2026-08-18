# eos-1on1-app — where things stand

Live: https://eos-1on1-app.vercel.app
Next 16.3.1 · React 19 · Supabase · Tailwind v4

## State

- All 12 migrations applied. All commits pushed and deployed.
- 173 tests pass; `npm run build` clean.
- Owner account: sam@datavations.com — `access_level` admin, department Marketing, Slack linked.
- Database is essentially empty: 1 profile, 0 meetings, 1 task. **Ashley has not been invited.**

## Env vars in Vercel

Set: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ACTION_TOKEN_SECRET`, `CRON_SECRET`,
`RESEND_API_KEY`, `NOTIFY_FROM_EMAIL`.

Not set: `NEXT_PUBLIC_APP_URL` (optional — falls back to `VERCEL_PROJECT_PRODUCTION_URL`).

There is no Anthropic key and no LLM dependency.

## Unverified paths

1. **Slack "reply done" has never been proven end to end.** Slack App Home → Show Tabs →
   Messages Tab is OFF, so the DM reads "Sending messages to this app has been turned off"
   and `done` cannot be typed. Turn it on, tick *Allow users to send Slash commands and
   messages from the messages tab*, then reply `done` and confirm
   `weekly_commitments.completed_via = 'slack_reply'` with the right `completed_by`.
2. **The Slack "Mark done" button works** — confirmed `[slack/complete/ok] closed via
   slack_button` — but the message-redraw fix deployed *after* that click. Press it again on
   the old message; it now self-heals.
3. **Email had a doubled `@`** in `NOTIFY_FROM_EMAIL`
   (`noreply@@marketing.task.datavations.com`), which is why nothing had ever sent. Fixed in
   Vercel on 2026-08-18 and redeployed; the first successful send is still unconfirmed.
   Found in `notification_log`, which named the offending value outright — Resend's own
   message is a generic `Invalid from field` that names nothing, so the typo was invisible
   both on screen and in the logs.
   To confirm: create a task with Email ticked, then look for a
   `channel=email status=sent` row in `notification_log`. If it fails there, the next
   suspect is the sending domain not being verified in Resend.
   Note `RESEND_API_KEY` and `NOTIFY_FROM_EMAIL` are **not** in `.env.local`, so email never
   sends on localhost regardless — test this on the deployed app.
4. **No meetings exist**, so the agenda, Rocks, and Import Next Steps have never run against
   real data.

## Next steps, in order

1. Slack Messages Tab on → prove the reply path.
2. Invite Ashley at `/team` — her email, manager Sam, department Marketing. Signup is
   invite-only; she cannot register without this.
3. Create the first real meeting, her email in Direct Report.
4. Add a Q3 Rock for her in Scorecard & Rock Pulse; confirm it shows in the *next* meeting too,
   without having been copied.
5. Verify the email path per (3) above.

## Conventions to keep

- **Probe the live database before trusting a schema file.** `profiles.role` already existed
  with values the new check constraint would have rejected, which would have aborted an entire
  migration. That was caught by probing, not by reading.
- **Every migration-dependent test is skip-gated** on a column probe (`trackerReady`,
  `subtasksReady`, `invitationsReady`, `tableExists`) so the suite is green both before and
  after a migration. Do the same for new columns.
- **Global teardown deletes every `@example.com` account and its data** after each run
  (`tests/global-teardown.ts`). Never widen that pattern — example.com is IANA-reserved,
  which is the whole reason it is a safe boundary. `SKIP_TEST_CLEANUP=1` keeps data while
  debugging.
- **RLS decides visibility; never re-filter the same rule in the query.** A duplicate
  client-side filter silently hid departmental and oversight tasks — the policy was correct
  and the app simply never asked.
- **Oversight (manager / admin / department) is read-only**, via separate `FOR SELECT`
  policies. Don't widen the `FOR ALL` participation policies to grant it.
- **Never let a missing env var throw.** `tryServiceClient()` exists because an unhandled
  throw returned a 500 with an empty body and cost an hour to diagnose.
- **Dates are compared as `YYYY-MM-DD` strings, never parsed into `Date`.** Parsing shifts by
  the UTC offset and breaks due dates and quarter boundaries west of Greenwich.
- **`notification_log` is the first place to look** when a notification silently fails.
- `rm -rf .next` while `next dev` is running kills the dev server; Playwright then fails with
  `fetch failed`. Restart with `npm run dev`.

## Architecture notes

- `weekly_commitments` holds **both** mid-week tasks (`meeting_id` null) and 1-on-1
  commitments. Departmental sharing and subtasks apply to standalone tasks only — 1-on-1
  commitments can be performance material.
- **Open Work** lives inside **To-Dos & Wrap** (section 5), which is the EOS to-do review —
  so it is on that section's 5-minute clock and collapsed until the section is opened. It
  reads every still-open task belonging to the people in that meeting — mid-week tasks and unfinished commitments from earlier 1-on-1s —
  and deliberately excludes that meeting's own commitments, which have their own section.
  Read, never copied: a copy would fork the task, so closing one side would leave the other
  open. `src/lib/open-work.ts` holds the pure logic; `useOpenWork` does the query.
- Rocks live in `rocks`, keyed by (owner_id, quarter), and are **read** by every agenda in
  that quarter rather than copied into it. `rock_checkins` holds the weekly pulse, unique per
  (rock, meeting).
- Subtasks are one level deep, enforced by a trigger, and **assignable to anyone in the owner
  dropdown** (people you share a meeting with). A piece kept for whoever owns the main task is
  silent; a piece handed to someone else is notified, so one handover is one DM rather than
  five. It inherits the parent's due date.
- **An orphaned subtask must never disappear.** Hand someone one piece of a task whose parent
  RLS does not show them, and that row is neither top level nor drawn by a parent — it renders
  nowhere, which is work assigned to someone that they can never see. `isTopLevel()` in
  `src/lib/open-work.ts` is the single rule, used by both the task board and the agenda panel.
- Slack message state is redrawn from the row by `syncSlackMessage()`; all four close paths
  (app, email link, Slack reply, Slack button) go through it.
- No AI/LLM dependency. "Import Next Steps" parses the action-item list Granola or Gemini
  already produced — `src/lib/parse-action-items.ts`.

## Migration order

`supabase-schema.sql` → `commitments` → `participants` → `transcripts` → `delete-meetings` →
`weekly-tracker` → `notifications` → `access-control` → `departments` → `subtasks` → `rocks`

Run in that order; each depends on the ones before it. All are applied in production.
