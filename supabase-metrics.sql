/*
 * Migration 13 — accountability metrics.
 *
 * Three things, in dependency order:
 *
 *  1. commitment_events, an append-only record of the changes that decide whether
 *     a task was delivered on time. Due dates became editable, so
 *     `completed_at <= due_date` on its own would call a task punctual even if the
 *     deadline had been moved three times to stay ahead of it. A metric that
 *     rewards moving goalposts is worse than no metric.
 *
 *  2. A guard so only the person who assigned a task can move its date. Being
 *     handed work does not come with the authority to rewrite when it is wanted.
 *
 *  3. team_ids(), the set of people whose numbers you are entitled to see: you,
 *     everyone below you in the reporting line, and everyone at all if you are an
 *     admin. Authority flows down, so a department head inherits their reports'
 *     reports without anything being granted twice.
 */

-- ── 1. the event log ────────────────────────────────────────────────────────────

create table if not exists public.commitment_events (
  id uuid primary key default gen_random_uuid(),
  commitment_id uuid not null references public.weekly_commitments(id) on delete cascade,
  -- Null when the change came from a server route or the nightly run rather than
  -- from a person, which is worth being able to tell apart.
  actor_id uuid references public.profiles(id) on delete set null,
  event text not null check (event in ('due_date_changed', 'reassigned')),
  from_value text,
  to_value text,
  created_at timestamptz not null default now()
);

create index if not exists commitment_events_commitment_idx
  on public.commitment_events(commitment_id, created_at desc);

comment on table public.commitment_events is
  'Append-only record of due date and owner changes. Written only by trigger; no insert policy exists, so it cannot be forged.';

alter table public.commitment_events enable row level security;

/*
 * Readable exactly when the commitment itself is. The subquery runs as the
 * calling user, so weekly_commitments RLS decides — participation, department
 * sharing and oversight all come along without being restated here, and cannot
 * drift apart from it later.
 */
drop policy if exists "Events follow the task" on public.commitment_events;
create policy "Events follow the task" on public.commitment_events for select
  using (
    exists (select 1 from public.weekly_commitments c where c.id = commitment_id)
  );

-- Deliberately no insert, update or delete policy. The trigger below is SECURITY
-- DEFINER and writes these rows; nobody else can add, alter or remove one.

-- ── 2. only the assigner may move a date ───────────────────────────────────────

create or replace function public.guard_due_date_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.due_date is not distinct from old.due_date then
    return new;
  end if;

  -- auth.uid() is null for the service role: the nightly run and the server
  -- routes are not people and are not being policed here.
  if auth.uid() is null then
    return new;
  end if;

  -- The admin exemption is deliberate. Without it a task created by someone who
  -- has left the company could never have its date corrected by anyone.
  if auth.uid() = old.creator_id or public.is_admin() then
    return new;
  end if;

  raise exception
    'Only the person who assigned this task can change its due date'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists guard_due_date on public.weekly_commitments;
create trigger guard_due_date
  before update on public.weekly_commitments
  for each row execute function public.guard_due_date_change();

-- ── 3. record what changed ─────────────────────────────────────────────────────

create or replace function public.record_commitment_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.due_date is distinct from old.due_date then
    insert into public.commitment_events (commitment_id, actor_id, event, from_value, to_value)
    values (new.id, auth.uid(), 'due_date_changed',
            old.due_date::text, new.due_date::text);
  end if;

  if new.assignee_id is distinct from old.assignee_id then
    insert into public.commitment_events (commitment_id, actor_id, event, from_value, to_value)
    values (new.id, auth.uid(), 'reassigned',
            old.assignee_id::text, new.assignee_id::text);
  end if;

  return null;
end;
$$;

drop trigger if exists record_commitment_change on public.weekly_commitments;
create trigger record_commitment_change
  after update on public.weekly_commitments
  for each row execute function public.record_commitment_change();

-- ── 4. whose numbers may I see ─────────────────────────────────────────────────

/*
 * You, everyone beneath you in the reporting line, and everyone if you are an
 * admin.
 *
 * The depth cap is the same cycle guard manages() uses: manager_id is a plain
 * self-reference, and a loop would otherwise recurse until the statement was
 * killed. Ten levels is far deeper than any real reporting line here.
 */
create or replace function public.team_ids()
returns setof uuid language sql security definer set search_path = public stable as $$
  with recursive team as (
    select p.id, 1 as depth
    from public.profiles p
    where auth.uid() is not null and p.id = auth.uid()
    union all
    select p.id, t.depth + 1
    from public.profiles p
    join team t on p.manager_id = t.id
    where t.depth < 10
  )
  select id from team
  union
  select p.id from public.profiles p where public.is_admin();
$$;

grant execute on function public.team_ids() to authenticated;
