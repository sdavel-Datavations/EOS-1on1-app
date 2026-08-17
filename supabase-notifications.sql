-- EOS 1-on-1 — Slack + email notifications, and closing a task by replying "done"
-- Run in the Supabase SQL Editor AFTER supabase-weekly-tracker.sql. Safe to re-run.

-- Where a task's Slack message lives, so a threaded reply can be traced back to
-- the task it answers. slack_ts is Slack's message id within a channel.
alter table public.weekly_commitments
  add column if not exists slack_channel text,
  add column if not exists slack_ts text,
  add column if not exists notified_at timestamptz,
  add column if not exists completed_by uuid references public.profiles(id),
  add column if not exists completed_via text;

-- Free text rather than a check constraint: a new surface shouldn't need a
-- migration before it can record how a task was closed.
comment on column public.weekly_commitments.completed_via is
  'app | slack_reply | slack_button | email_link — how the task was closed.';

-- A thread reply arrives with only a channel + thread_ts, so this is the lookup.
create index if not exists weekly_commitments_slack_ts_idx
  on public.weekly_commitments(slack_channel, slack_ts);
create index if not exists weekly_commitments_notify_idx
  on public.weekly_commitments(status, notified_at);

-- Slack identifies people by their own user id, not by email. Cached here after
-- the first users.lookupByEmail so every send isn't two API calls.
alter table public.profiles
  add column if not exists slack_user_id text;

create unique index if not exists profiles_slack_user_id_idx
  on public.profiles(slack_user_id)
  where slack_user_id is not null;

-- ── Audit trail ──
-- Every send attempt, and every task closed from outside the app, lands here.
-- Notifications are sent by a service-role job with no user session, so without
-- this there is no record of what was sent to whom, or of who closed a task via
-- Slack rather than in the UI.
create table if not exists public.notification_log (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid references public.weekly_commitments(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,
  channel text not null,
  event text not null,
  status text not null,
  detail text default '',
  created_at timestamptz default now()
);

comment on table public.notification_log is
  'Append-only record of notification sends and out-of-app task completions.';
comment on column public.notification_log.channel is 'slack | email | app';
comment on column public.notification_log.event is 'notify | complete | error';
comment on column public.notification_log.status is 'sent | failed | skipped | ok';

create index if not exists notification_log_commitment_idx
  on public.notification_log(commitment_id, created_at desc);
create index if not exists notification_log_user_idx
  on public.notification_log(user_id, created_at desc);

alter table public.notification_log enable row level security;

-- Readable by the person it concerns; no insert/update/delete policy at all, so
-- only the service-role job can write it and nobody can rewrite history through
-- the anon key. Service role bypasses RLS by design.
drop policy if exists "Subject can read own notifications" on public.notification_log;
create policy "Subject can read own notifications" on public.notification_log for select
  using (user_id = auth.uid());
