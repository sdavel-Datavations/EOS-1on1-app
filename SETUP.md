# EOS 1-on-1 Agenda App — Setup Guide

## 1. Supabase Setup

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and open your project
2. Navigate to **SQL Editor** and run these, in order:
   - `supabase-schema.sql` — core tables, RLS policies, and the new-user trigger
   - `supabase-commitments.sql` — the `weekly_commitments` table used by the Weekly
     Commitments panel. Until this runs, that panel shows a "table not found" notice.
   - `supabase-participants.sql` — the `meeting_participants` table, plus the policies
     that grant meeting access by membership rather than by manager/report only.
     Until this runs, a meeting shows just its manager and report, and anyone added
     as a third participant cannot open it. Safe to re-run.
   - `supabase-transcripts.sql` — the `extracted_items` review queue behind
     "Import Next Steps". Depends on the access function created by
     `supabase-participants.sql`, so run it after. Safe to re-run.
   - `supabase-delete-meetings.sql` — lets the organiser delete a meeting, and
     repairs the `todos.carried_from_id` foreign key so the cascade doesn't fail
     on meetings whose to-dos were carried forward. Until this runs, the delete
     button reports that nothing was deleted. Safe to re-run.
   - `supabase-weekly-tracker.sql` — adds `completed_at` and widens the
     commitments policy to cover tasks that belong to no meeting, which is what
     the "My Week" panel adds mid-week. Until this runs, that panel can show
     commitments from meetings but cannot save a standalone task. Safe to re-run.
   - `supabase-notifications.sql` — where each task's Slack message lives (so a
     threaded "done" reply can be matched back to it), the cached Slack user id,
     and `notification_log`. Until this runs, `/api/notify` fails. Safe to re-run.
3. Go to **Authentication > Providers** and make sure **Email** is enabled
4. Go to **Settings > API** and copy:
   - **Project URL** (e.g. `https://abcdef.supabase.co`)
   - **anon/public key** (the long `eyJ...` key)

## 2. Local Setup

```bash
# Clone or copy this project, then:
cd eos-1on1-app
cp .env.local.example .env.local
```

Edit `.env.local` — see `.env.local.example` for every variable and what it's for.
At minimum:
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

No third-party AI key is needed. Next steps come from the action-item list your
notetaker already produced — see "Import Next Steps" below.

```bash
npm install
npm run dev
```

Open `http://localhost:3000` — sign up with your email, then have Ashley sign up too.

## 3. Deploy to Vercel

```bash
# From the project root:
npx vercel
```

Or connect the GitHub repo in the Vercel dashboard. Set the same two environment variables in Vercel's project settings:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## 4. Slack + Email Notifications

Optional. Skip and the app works, minus the reminders.

### Slack app

1. api.slack.com/apps > **Create New App** > **From scratch**
2. **OAuth & Permissions** > Bot Token Scopes, add exactly these four:
   `chat:write`, `im:write`, `users:read`, `users:read.email`
3. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`)
   into `SLACK_BOT_TOKEN`
4. **Basic Information** > App Credentials > copy the **Signing Secret** into
   `SLACK_SIGNING_SECRET`
5. **Event Subscriptions** > on. Request URL:
   `https://YOUR-DOMAIN/api/slack/events`
   Slack sends a one-time `url_verification` challenge; the route answers it, but
   only after checking the signature — so the signing secret must be set first or
   verification fails. Then under **Subscribe to bot events** add `message.im`.
6. **Interactivity & Shortcuts** > on. Request URL:
   `https://YOUR-DOMAIN/api/slack/interactive`

Every inbound Slack request is HMAC-verified against the signing secret, with a
five-minute replay window. These endpoints act with the service role and have no
session behind them, so that signature is the whole of their access control — if
the secret is missing they reject everything, which is the correct direction to
fail.

### Email (Resend)

1. resend.com > verify your sending domain
2. **API Keys** > create one > `RESEND_API_KEY`
3. `NOTIFY_FROM_EMAIL` — an address on the verified domain
4. `ACTION_TOKEN_SECRET` — signs the "Mark done" links, which carry their own
   authority because an inbox has no session:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
   Rotating it invalidates every link already sent.

The emailed link opens a confirmation page and takes a second click. That is
deliberate: mail clients and security scanners fetch links without anyone
clicking them, so a link that completed a task on `GET` would close tasks by
itself.

### Scheduling

`vercel.json` runs `/api/notify` at 13:00 UTC on weekdays. Set `CRON_SECRET` in
Vercel and it sends that automatically as `Authorization: Bearer …`; the `GET`
handler accepts nothing else, so opening the URL in a browser can't fire a round
of notifications. `POST` additionally accepts a signed-in user, for a manual
send.

One message is sent per task rather than a digest, because a threaded "done"
reply has to be unambiguous about which task it closes.

### Closing a task from Slack

Reply `done` in the task's thread, or press **Mark done**. The parser is
deliberately strict — questions, negations ("not done"), hedges ("almost done"),
and future tense ("I'll get it done") are all ignored, and anything over six
words is treated as discussion. The button is the unambiguous path. Every
completion records who closed it and how, in `weekly_commitments.completed_via`
and `notification_log`.

## 5. Supabase Auth — Redirect URLs

In Supabase Dashboard > Authentication > URL Configuration, add your Vercel URL to **Redirect URLs**:
```
https://your-app.vercel.app/**
```

## How It Works

**Dashboard (/)** — Sign in, create new meetings, search past discussions, see meeting history.

**My Week (on the dashboard)** — The day-to-day tracker. Every commitment assigned
to you or by you, across all meetings, grouped Overdue / Due today / Due this week /
Later / No due date. Add a task that came up mid-week and it lives here with no
meeting attached. Ticking one off records when, so "Done this week" is a real list.

**Import Next Steps (on the meeting page)** — Paste the action-item list Granola,
Gemini, or Otter already produced at the end of the meeting, one per line. No AI
key and no per-token billing: the notetaker's AI already did that work, and
reading its output is a formatting problem.

It handles bullets, numbers, and markdown checkboxes; skips the notetaker's own
headings ("Action Items:", "Next Steps"); treats a ticked box as already done;
and collapses items repeated between a summary and a list. Owners are read from
`Sam: …`, `[Sam] …`, `Sam — …`, or a trailing `(Sam)`, and matched only against
real meeting participants — an unrecognised name stays unassigned rather than
being guessed at. Due dates are read from ISO dates, `Aug 21`, `today`,
`tomorrow`, and weekday names; vague ones like "by EOW" are deliberately left
alone, because a wrong date on someone's task is worse than none.

Every item lands in a review queue and reaches the agenda only when you accept
it. Each row shows the line it was parsed from, flags anything already on the
agenda as a possible duplicate, and marks items where no owner could be read.

**Meeting page (/meeting/[id])** — The 5-section EOS agenda:
1. **Segue** — Both users prep personal + professional wins independently
2. **Scorecard & Rock Pulse** — On/off track toggles (measurable names carry forward)
3. **Headlines** — Both users write their own headlines, see each other's
4. **IDS Issues** — Priority cycling (H/M/L), descriptions + resolutions
5. **To-Dos & Wrap** — Incomplete to-dos auto-carry from last meeting. Meeting rating 1-10.

**Key behaviors:**
- Creating a new meeting auto-carries forward incomplete to-dos and scorecard item names from the previous meeting
- Both manager and direct report can prep their sections before the meeting
- Section timers track time vs. allotted and turn red when over
- Master timer tracks total meeting duration (goes red at 30 min)
- Search bar searches across all past issues and to-dos

## Project Structure

```
src/
├── app/
│   ├── globals.css          # Tailwind + Datavations brand tokens
│   ├── layout.tsx           # Root layout
│   ├── page.tsx             # Dashboard: auth, new meeting, history, search
│   └── meeting/[id]/
│       └── page.tsx         # Meeting detail: all 5 sections + timers
└── lib/
    ├── supabase.ts          # Supabase browser client
    ├── types.ts             # TypeScript types + section config
    └── hooks.ts             # Auth, data hooks, CRUD helpers, search
```

## Things You Might Want to Add

- **Real-time sync** — Subscribe to Supabase realtime channels so both users see edits live during the meeting
- **Email invites** — Send Ashley a link when you create a meeting
- **PDF export** — Generate a summary of each completed meeting
- **Quarterly Conversation template** — A separate meeting type with People Analyzer, GWC check, and Rock retrospective
- **Recurring meeting creation** — Auto-create next week's meeting when you complete this one
