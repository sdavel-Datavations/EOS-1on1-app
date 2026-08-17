-- EOS 1-on-1 — real meeting participants
-- Run this in the Supabase SQL Editor AFTER supabase-schema.sql and
-- supabase-commitments.sql. Safe to re-run.
--
-- Why: access was keyed off meetings.manager_id / meetings.report_id, so a third
-- person added to a meeting could not select the meeting row at all — their page
-- hung on "Loading meeting...". Membership now lives in meeting_participants and
-- every policy keys off it.
--
-- meetings.manager_id / report_id are kept: they still record who holds which
-- seat, and act as a fallback so a meeting is never orphaned if its participant
-- rows are missing.

-- ── Membership table ──
create table if not exists public.meeting_participants (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('manager', 'report', 'participant')) default 'participant',
  created_at timestamptz default now(),
  unique (meeting_id, user_id)
);

create index if not exists meeting_participants_user_idx on public.meeting_participants(user_id);
create index if not exists meeting_participants_meeting_idx on public.meeting_participants(meeting_id);

alter table public.meeting_participants enable row level security;

-- ── Membership tests ──
-- SECURITY DEFINER so policies can read meeting_participants and meetings without
-- re-entering their own RLS, which would recurse.
create or replace function public.is_meeting_participant(p_meeting_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.meeting_participants
    where meeting_id = p_meeting_id and user_id = auth.uid()
  );
$$;

-- Fallback for meetings whose participant rows are missing, and the bootstrap
-- case: the creator must be able to insert the first participant row.
create or replace function public.is_meeting_owner(p_meeting_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.meetings
    where id = p_meeting_id
      and (manager_id = auth.uid() or report_id = auth.uid())
  );
$$;

create or replace function public.can_access_meeting(p_meeting_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_meeting_participant(p_meeting_id)
      or public.is_meeting_owner(p_meeting_id);
$$;

-- ── Backfill from the existing shape ──
-- Manager and report seats.
insert into public.meeting_participants (meeting_id, user_id, role)
select id, manager_id, 'manager' from public.meetings where manager_id is not null
on conflict (meeting_id, user_id) do nothing;

insert into public.meeting_participants (meeting_id, user_id, role)
select id, report_id, 'report' from public.meetings where report_id is not null
on conflict (meeting_id, user_id) do nothing;

-- Extra people were previously implied by placeholder segue/headline rows.
insert into public.meeting_participants (meeting_id, user_id, role)
select distinct meeting_id, user_id, 'participant'
from public.segue_notes
where meeting_id is not null and user_id is not null
on conflict (meeting_id, user_id) do nothing;

insert into public.meeting_participants (meeting_id, user_id, role)
select distinct meeting_id, user_id, 'participant'
from public.headlines
where meeting_id is not null and user_id is not null
on conflict (meeting_id, user_id) do nothing;

-- ── Policies: meeting_participants ──
drop policy if exists "Participants can view membership" on public.meeting_participants;
create policy "Participants can view membership" on public.meeting_participants for select
  using (public.can_access_meeting(meeting_id));

drop policy if exists "Participants can add membership" on public.meeting_participants;
create policy "Participants can add membership" on public.meeting_participants for insert
  with check (public.can_access_meeting(meeting_id));

drop policy if exists "Participants can remove membership" on public.meeting_participants;
create policy "Participants can remove membership" on public.meeting_participants for delete
  using (public.can_access_meeting(meeting_id));

-- ── Policies: meetings ──
-- These must NOT go through can_access_meeting(), even though every child table
-- does. That function re-queries public.meetings, and a command cannot see its
-- own uncommitted row — so on `insert ... returning` (which is what
-- .insert().select() emits) the lookup finds nothing and the SELECT policy
-- rejects the returned row with 42501, breaking meeting creation entirely.
-- Comparing the row's own columns works because RLS evaluates them against the
-- candidate row. is_meeting_participant() is safe here: it reads
-- meeting_participants, not meetings.
drop policy if exists "Meeting participants can view" on public.meetings;
create policy "Meeting participants can view" on public.meetings for select
  using (
    manager_id = auth.uid()
    or report_id = auth.uid()
    or public.is_meeting_participant(id)
  );

drop policy if exists "Meeting participants can insert" on public.meetings;
create policy "Meeting participants can insert" on public.meetings for insert
  with check (auth.uid() = manager_id or auth.uid() = report_id);

drop policy if exists "Meeting participants can update" on public.meetings;
create policy "Meeting participants can update" on public.meetings for update
  using (
    manager_id = auth.uid()
    or report_id = auth.uid()
    or public.is_meeting_participant(id)
  );

-- ── Policies: child tables ──
-- FOR ALL with no WITH CHECK reuses the USING expression for inserts.
drop policy if exists "Access via meeting" on public.segue_notes;
create policy "Access via meeting" on public.segue_notes for all
  using (public.can_access_meeting(meeting_id));

drop policy if exists "Access via meeting" on public.scorecard_items;
create policy "Access via meeting" on public.scorecard_items for all
  using (public.can_access_meeting(meeting_id));

drop policy if exists "Access via meeting" on public.headlines;
create policy "Access via meeting" on public.headlines for all
  using (public.can_access_meeting(meeting_id));

drop policy if exists "Access via meeting" on public.issues;
create policy "Access via meeting" on public.issues for all
  using (public.can_access_meeting(meeting_id));

drop policy if exists "Access via meeting" on public.todos;
create policy "Access via meeting" on public.todos for all
  using (public.can_access_meeting(meeting_id));

drop policy if exists "Access via meeting" on public.section_timers;
create policy "Access via meeting" on public.section_timers for all
  using (public.can_access_meeting(meeting_id));

-- ── Policies: weekly_commitments (from supabase-commitments.sql) ──
-- Skipped when that table isn't present yet. If you run supabase-commitments.sql
-- AFTER this file, re-run this file so commitments get participant-based access.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'weekly_commitments'
  ) then
    execute 'drop policy if exists "Commitment participants can view" on public.weekly_commitments';
    execute 'drop policy if exists "Commitment participants can insert" on public.weekly_commitments';
    execute 'drop policy if exists "Commitment participants can update" on public.weekly_commitments';
    execute 'drop policy if exists "Access via meeting" on public.weekly_commitments';
    execute 'drop policy if exists "Access via meeting or ownership" on public.weekly_commitments';
    -- Same expression supabase-weekly-tracker.sql installs, so re-running either
    -- file converges instead of leaving a stale policy that hides standalone tasks.
    execute 'create policy "Access via meeting or ownership" on public.weekly_commitments for all
      using (
        (meeting_id is not null and public.can_access_meeting(meeting_id))
        or (meeting_id is null and (assignee_id = auth.uid() or creator_id = auth.uid()))
      )';
  end if;
end $$;
