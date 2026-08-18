-- EOS 1-on-1 — departmental task visibility
-- Run in the Supabase SQL Editor AFTER supabase-access-control.sql. Safe to re-run.
--
-- Everyone in a department can see that department's tasks, so someone with spare
-- capacity can pick up work they aren't assigned to.
--
-- Scoped deliberately to STANDALONE tasks (meeting_id is null) — the ones raised
-- mid-week. Commitments made inside a 1-on-1 stay between the participants and
-- the reporting line: this table holds both, and a 1-on-1 commitment can be
-- performance or development material, which is not the same thing as "help out
-- with the campaign launch". The policy at the bottom is the one place to widen
-- that if a whole department should see those too.

alter table public.profiles
  add column if not exists department text;

alter table public.invitations
  add column if not exists department text;

-- Compared case-insensitively, so 'Marketing' and 'marketing' are one department.
create index if not exists profiles_department_idx on public.profiles(lower(department));

/*
 * The task's own department, stamped at creation, plus an opt-out.
 *
 * Stored rather than derived from the assignee's current profile for two reasons:
 * a task keeps the department it was raised in even if someone later moves teams,
 * and the policy becomes one comparison instead of a join across two profiles.
 */
alter table public.weekly_commitments
  add column if not exists department text,
  add column if not exists visible_to_department boolean not null default true;

create index if not exists weekly_commitments_department_idx
  on public.weekly_commitments(lower(department))
  where meeting_id is null;

-- ── Stamp the department on the way in ──
-- A trigger, not application code: the client shouldn't have to know the
-- creator's department to file a task, and this way nothing can forget to set it.
create or replace function public.stamp_task_department()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.department is null then
    select p.department into new.department
    from public.profiles p
    where p.id = coalesce(new.creator_id, new.assignee_id);
  end if;
  return new;
end $$;

drop trigger if exists stamp_task_department_before_insert on public.weekly_commitments;
create trigger stamp_task_department_before_insert
  before insert on public.weekly_commitments
  for each row execute function public.stamp_task_department();

-- Existing standalone tasks predate the column.
update public.weekly_commitments c
  set department = p.department
  from public.profiles p
  where c.department is null
    and c.meeting_id is null
    and p.id = coalesce(c.creator_id, c.assignee_id)
    and p.department is not null;

-- ── Department tests ──
-- SECURITY DEFINER so policies can read profiles without re-entering their own
-- RLS. Null department is never a match: otherwise everyone without one would
-- silently share a department with everyone else who has none.
create or replace function public.my_department()
returns text language sql security definer set search_path = public stable as $$
  select nullif(btrim(lower(p.department)), '')
  from public.profiles p
  where p.id = auth.uid();
$$;

create or replace function public.shares_department(p_target uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select auth.uid() is not null
     and p_target is not null
     and public.my_department() is not null
     and public.my_department() = (
       select nullif(btrim(lower(p.department)), '')
       from public.profiles p where p.id = p_target
     );
$$;

-- Departmental colleagues need to resolve each other's names for the task list.
create or replace function public.can_view_profile(p_target uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select auth.uid() is not null and (
    p_target = auth.uid()
    or public.is_admin()
    or public.manages(p_target)
    or public.shares_department(p_target)
    or exists (
      select 1
      from public.meeting_participants a
      join public.meeting_participants b on a.meeting_id = b.meeting_id
      where a.user_id = auth.uid() and b.user_id = p_target
    )
    or exists (
      select 1 from public.weekly_commitments c
      where (c.assignee_id = auth.uid() and c.creator_id = p_target)
         or (c.creator_id = auth.uid() and c.assignee_id = p_target)
    )
  );
$$;

-- Carry the invitation's department onto the new profile, alongside manager and
-- access level.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  inv public.invitations;
begin
  select * into inv from public.invitations
  where lower(email) = lower(new.email) limit 1;

  insert into public.profiles (id, full_name, email, manager_id, access_level, department)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    inv.manager_id,
    coalesce(inv.access_level, 'member'),
    inv.department
  )
  on conflict (id) do nothing;

  update public.invitations
    set accepted_at = now()
    where lower(email) = lower(new.email) and accepted_at is null;

  return new;
end $$;

-- ── The policy ──
-- Read-only, and a separate SELECT policy rather than a widening of the existing
-- FOR ALL: a colleague helping out should see the task, not silently edit or close
-- someone else's. Taking it on stays a deliberate handover by the owner.
drop policy if exists "Department can view shared tasks" on public.weekly_commitments;
create policy "Department can view shared tasks" on public.weekly_commitments for select
  using (
    meeting_id is null
    and visible_to_department
    and department is not null
    and nullif(btrim(lower(department)), '') = public.my_department()
  );
