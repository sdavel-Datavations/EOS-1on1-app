/*
 * Migration 14 — 1-on-1 schedules, and noticing a week that got skipped.
 *
 * Every meeting so far has been created by hand on the day, which means a week
 * nobody held leaves no trace at all. For a tool whose whole premise is a weekly
 * rhythm, the missed week is the most important thing it could tell you, and it
 * was the one thing it could not.
 *
 * Deliberately NOT auto-creating meetings. A row created by a scheduler would look
 * exactly like a meeting that happened, so the schedule would erase the very gaps
 * it exists to reveal. A meeting row means somebody opened one; absence means
 * nobody did.
 */

create table if not exists public.meeting_schedules (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.profiles(id) on delete cascade,
  -- Not nullable, unlike meetings.report_id: a solo agenda is a real thing, but a
  -- recurring 1-on-1 with nobody is not, and matching it to meetings would be
  -- guesswork.
  report_id uuid not null references public.profiles(id) on delete cascade,
  cadence text not null default 'weekly' check (cadence in ('weekly', 'fortnightly')),
  -- 0 = Sunday, matching JavaScript's getUTCDay(), so the app needs no conversion.
  weekday smallint not null default 3 check (weekday between 0 and 6),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One schedule per pair. Two would make "was this week held" ambiguous.
  unique (manager_id, report_id)
);

create index if not exists meeting_schedules_manager_idx on public.meeting_schedules(manager_id);
create index if not exists meeting_schedules_report_idx on public.meeting_schedules(report_id);

comment on table public.meeting_schedules is
  'Recurring 1-on-1s. Never creates meetings; absence of a meeting in an expected week is what makes a skipped week visible.';

alter table public.meeting_schedules enable row level security;

/*
 * Both people in the pair can see it — a report should know when their own 1-on-1
 * is meant to be — plus anyone above them in the line, and admins.
 */
drop policy if exists "Pair and oversight can view schedules" on public.meeting_schedules;
create policy "Pair and oversight can view schedules" on public.meeting_schedules for select
  using (
    auth.uid() = manager_id
    or auth.uid() = report_id
    or public.is_admin()
    or public.manages(manager_id)
    or public.manages(report_id)
  );

/*
 * Only the manager side, or an admin, may create or change one. Being someone's
 * report does not come with the authority to reschedule your own review — the same
 * reasoning as due dates belonging to whoever assigned the work.
 */
drop policy if exists "Managers can write schedules" on public.meeting_schedules;
create policy "Managers can write schedules" on public.meeting_schedules for all
  using (auth.uid() = manager_id or public.is_admin() or public.manages(report_id))
  with check (auth.uid() = manager_id or public.is_admin() or public.manages(report_id));

create or replace function public.touch_meeting_schedule()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_meeting_schedule on public.meeting_schedules;
create trigger touch_meeting_schedule
  before update on public.meeting_schedules
  for each row execute function public.touch_meeting_schedule();
