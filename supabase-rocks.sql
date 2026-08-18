-- EOS 1-on-1 — quarterly Rocks that carry into every agenda
-- Run in the Supabase SQL Editor AFTER supabase-subtasks.sql. Safe to re-run.
--
-- A Rock is a 90-day priority owned by a person, not a row on one meeting's
-- agenda. Until now Rocks lived in scorecard_items and were copied forward from
-- the previous meeting, which is the wrong shape three ways: one Rock became a
-- dozen disconnected copies, editing it in one week left the others stale, and a
-- skipped week broke the chain so it vanished for the rest of the quarter.
--
-- Rocks are now stored once against their owner and quarter, and every agenda in
-- that quarter reads them. Nothing is copied, so nothing can drift.
--
-- scorecard_items is left alone: it still holds weekly measurables, and existing
-- rows are untouched.

create table if not exists public.rocks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text default '',
  -- '2026-Q3'. Text rather than a date range so the quarter a Rock belongs to is
  -- stated rather than inferred, and two Rocks in the same quarter always group.
  quarter text not null check (quarter ~ '^\d{4}-Q[1-4]$'),
  status text not null default 'on_track'
    check (status in ('on_track', 'off_track', 'done', 'dropped')),
  created_by uuid references public.profiles(id) on delete set null,
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists rocks_owner_quarter_idx on public.rocks(owner_id, quarter);
create index if not exists rocks_quarter_idx on public.rocks(quarter);

/*
 * The weekly pulse.
 *
 * EOS asks whether each Rock is on track *this week*, and the useful signal is the
 * trend across the quarter rather than a single current flag. A check-in per
 * meeting keeps that history; rocks.status stays as the Rock's overall state.
 */
create table if not exists public.rock_checkins (
  id uuid primary key default gen_random_uuid(),
  rock_id uuid not null references public.rocks(id) on delete cascade,
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  on_track boolean not null default true,
  note text default '',
  recorded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now(),
  -- One per Rock per meeting: the toggle is a state, not a log of presses.
  unique (rock_id, meeting_id)
);

create index if not exists rock_checkins_meeting_idx on public.rock_checkins(meeting_id);

-- Quarter of a date, matching src/lib/quarters.ts so the database and the app
-- never disagree about which quarter a meeting falls in.
create or replace function public.quarter_of(p_date date)
returns text language sql immutable as $$
  select to_char(p_date, 'YYYY') || '-Q' || to_char(p_date, 'Q');
$$;

alter table public.rocks enable row level security;
alter table public.rock_checkins enable row level security;

-- ── Who can see a Rock ──
-- Mirrors the rules already governing whether you can see the person: yourself,
-- anyone you manage at any depth, anyone you share a meeting with, your
-- department, and everything if you are an admin.
create or replace function public.can_view_rock(p_owner uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select public.can_view_profile(p_owner);
$$;

/*
 * Who can change one.
 *
 * Narrower than viewing on purpose. A Rock is a commitment its owner made, so a
 * departmental colleague seeing it must not be able to rewrite or quietly close
 * it; that stays with the owner, their manager, and an admin.
 */
create or replace function public.can_edit_rock(p_owner uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select auth.uid() is not null and (
    p_owner = auth.uid()
    or public.is_admin()
    or public.manages(p_owner)
  );
$$;

drop policy if exists "Rocks are visible with their owner" on public.rocks;
create policy "Rocks are visible with their owner" on public.rocks for select
  using (public.can_view_rock(owner_id));

drop policy if exists "Owner and manager can add rocks" on public.rocks;
create policy "Owner and manager can add rocks" on public.rocks for insert
  with check (public.can_edit_rock(owner_id));

drop policy if exists "Owner and manager can change rocks" on public.rocks;
create policy "Owner and manager can change rocks" on public.rocks for update
  using (public.can_edit_rock(owner_id));

drop policy if exists "Owner and manager can remove rocks" on public.rocks;
create policy "Owner and manager can remove rocks" on public.rocks for delete
  using (public.can_edit_rock(owner_id));

-- ── Check-ins ──
-- Tied to the meeting rather than to the Rock's owner: the pulse is taken during a
-- specific 1-on-1, so anyone in that meeting records it. can_access_meeting is
-- participation-only, so oversight readers cannot mark someone else's Rock.
drop policy if exists "Check-ins follow the meeting" on public.rock_checkins;
create policy "Check-ins follow the meeting" on public.rock_checkins for all
  using (public.can_access_meeting(meeting_id));

drop policy if exists "Oversight can view check-ins" on public.rock_checkins;
create policy "Oversight can view check-ins" on public.rock_checkins for select
  using (public.can_oversee_meeting(meeting_id));

-- Keep updated_at honest, since the UI reports when a Rock last changed.
create or replace function public.touch_rock()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists touch_rock_before_update on public.rocks;
create trigger touch_rock_before_update
  before update on public.rocks
  for each row execute function public.touch_rock();
