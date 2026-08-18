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
3. **Email is unproven.** `NOTIFY_FROM_EMAIL` was failing with Resend's `Invalid from field`.
   A normalizer (trim, strip quotes, add missing angle brackets) is deployed, so it may
   already work. Verify:
   `curl -X GET https://eos-1on1-app.vercel.app/api/notify -H "Authorization: Bearer $CRON_SECRET"`
   — returns per-channel results. `CRON_SECRET` is in `.env.local`.
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
- **Open Work** at the top of each agenda reads every still-open task belonging to the
  people in that meeting — mid-week tasks and unfinished commitments from earlier 1-on-1s —
  and deliberately excludes that meeting's own commitments, which have their own section.
  Read, never copied: a copy would fork the task, so closing one side would leave the other
  open. `src/lib/open-work.ts` holds the pure logic; `useOpenWork` does the query.
- Rocks live in `rocks`, keyed by (owner_id, quarter), and are **read** by every agenda in
  that quarter rather than copied into it. `rock_checkins` holds the weekly pulse, unique per
  (rock, meeting).
- Subtasks are one level deep, enforced by a trigger.
- Slack message state is redrawn from the row by `syncSlackMessage()`; all four close paths
  (app, email link, Slack reply, Slack button) go through it.
- No AI/LLM dependency. "Import Next Steps" parses the action-item list Granola or Gemini
  already produced — `src/lib/parse-action-items.ts`.

## Migration order

`supabase-schema.sql` → `commitments` → `participants` → `transcripts` → `delete-meetings` →
`weekly-tracker` → `notifications` → `access-control` → `departments` → `subtasks` → `rocks`

Run in that order; each depends on the ones before it. All are applied in production.
