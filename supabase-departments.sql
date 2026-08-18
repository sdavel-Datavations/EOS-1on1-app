-- EOS 1-on-1 — departments
-- Run in the Supabase SQL Editor AFTER supabase-access-control.sql. Safe to re-run.
--
-- Departmental transparency: anyone in Marketing can see Marketing's tasks, so
-- they can pick up slack without being told. Read-only — seeing a colleague's
-- task is useful; silently closing or editing it is not, so that stays with the
-- assignee, the creator, and the reporting line.

alter table public.profiles
  add column if not exists department text;

create index if not exists profiles_department_idx
  on public.profiles(lower(department)) where department is not null;

/*
 * A task carries its own department rather than deriving it from the assignee's
 * current one. Someone moving team should not retroactively expose or hide work
 * that was done under the old one, and a task handed across departments keeps
 * the context it was raised in.
 *
 * visible_to_department is nullable so the trigger below can tell "not specified"
 * from "explicitly set", which a NOT NULL DEFAULT could not.
 */
alter table public.weekly_commitments
  add column if not exists department text,
  add column if not exists visible_to_department boolean;

create index if not exists weekly_commitments_department_idx
  on public.weekly_commitments(lower(department), status)
  where department is not null;

/*
 * Fills in the department from the assignee, and picks a default for sharing.
 *
 * Mid-week tasks default to visible: that is the case the feature exists for.
 * Commitments raised INSIDE a 1-on-1 default to private, because a 1-on-1 is a
 * performance conversation — "have that difficult conversation with a client" or
 * anything tied to someone's review should not land in front of their whole
 * department by default. Either default can be overridden per task.
 */
create or replace function public.set_commitment_department()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.department is null and new.assignee_id is not null then
    select p.department into new.department
    from public.profiles p where p.id = new.assignee_id;
  end if;

  if new.visible_to_department is null then
    new.visible_to_department := (new.meeting_id is null);
  end if;

  return new;
end $$;

drop trigger if exists set_commitment_department_trigger on public.weekly_commitments;
create trigger set_commitment_department_trigger
  before insert on public.weekly_commitments
  for each row execute function public.set_commitment_department();

-- Existing rows predate both columns. Same rule as the trigger, applied once.
update public.weekly_commitments c
  set department = p.department
  from public.profiles p
  where c.assignee_id = p.id and c.department is null and p.department is not null;

update public.weekly_commitments
  set visible_to_department = (meeting_id is null)
  where visible_to_department is null;

-- ── Who is in my department ──
create or replace function public.shares_department(p_department text)
returns boolean language sql security definer set search_path = public stable as $$
  select p_department is not null
     and trim(p_department) <> ''
     and exists (
       select 1 from public.profiles
       where id = auth.uid()
         and department is not null
         and lower(trim(department)) = lower(trim(p_department))
     );
$$;

-- SELECT only. Oversight and departmental visibility are both read-only; writes
-- stay with the people actually responsible for the task.
drop policy if exists "Department can view shared tasks" on public.weekly_commitments;
create policy "Department can view shared tasks" on public.weekly_commitments for select
  using (
    coalesce(visible_to_department, false)
    and public.shares_department(department)
  );

-- Seeing a colleague's task is only useful if you can see whose it is.
create or replace function public.can_view_profile(p_target uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select auth.uid() is not null and (
    p_target = auth.uid()
    or public.is_admin()
    or public.manages(p_target)
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
    -- Same department, so a shared task shows a name rather than "Someone else".
    or exists (
      select 1 from public.profiles me, public.profiles them
      where me.id = auth.uid() and them.id = p_target
        and me.department is not null and them.department is not null
        and lower(trim(me.department)) = lower(trim(them.department))
    )
  );
$$;

-- Carried onto the profile at signup, like manager and access level.
alter table public.invitations
  add column if not exists department text;

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

-- department is set by an admin through /api/team, never by the person
-- themselves, so it is deliberately absent from the column grant below.
revoke update on public.profiles from authenticated, anon;
grant update (full_name) on public.profiles to authenticated;
