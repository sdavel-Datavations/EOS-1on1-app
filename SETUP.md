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
     "Next Steps from Transcript". Depends on the access function created by
     `supabase-participants.sql`, so run it after. Safe to re-run.
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

`ANTHROPIC_API_KEY` is additionally required for "Next Steps from Transcript".
It is read server-side only — transcript content is sent to the Anthropic API for
extraction, and this app stores only the items you accept, never the transcript.

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

## 4. Supabase Auth — Redirect URLs

In Supabase Dashboard > Authentication > URL Configuration, add your Vercel URL to **Redirect URLs**:
```
https://your-app.vercel.app/**
```

## How It Works

**Dashboard (/)** — Sign in, create new meetings, search past discussions, see meeting history.

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
