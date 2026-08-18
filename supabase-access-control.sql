-- EOS 1-on-1 — access control: invitations, manager hierarchy, admin tier
-- Run in the Supabase SQL Editor AFTER supabase-notifications.sql. Safe to re-run.
--
-- Fixes a live leak and adds the access model:
--
-- 1. public.profiles was readable with the ANON key and no session at all. That
--    key ships in the browser bundle, so every name and email address was
--    effectively public. Now a session is required, and you see only people you
--    actually work with.
-- 2. profiles UPDATE was `using (auth.uid() = id)` with no column restriction,
--    so adding a role column would have let anyone make themselves an admin.
--    Table-level UPDATE is revoked and only full_name is grantable back.
-- 3. Signup was open to anyone with the URL. Now an invitation is required.
-- 4. Oversight is read-only and separate from participation: a manager or admin
--    can SEE a report's meetings and tasks but cannot edit them.

-- ── Roles and the reporting line ──
-- NOT named `role`: public.profiles.role already exists as ('manager','report'),
-- the old meeting-seat field superseded by meeting_participants.role, and every
-- existing row holds 'report'. Reusing it would mean a check constraint that
-- fails against live data and aborts this whole migration. It is left alone.
alter table public.profiles
  add column if not exists access_level text not null default 'member',
  add column if not exists manager_id uuid references public.profiles(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_access_level_check') then
    alter table public.profiles
      add constraint profiles_access_level_check
      check (access_level in ('member', 'manager', 'admin'));
  end if;
  -- A self-managing row would make the hierarchy walk below meaningless.
  if not exists (select 1 from pg_constraint where conname = 'profiles_manager_not_self') then
    alter table public.profiles
      add constraint profiles_manager_not_self check (manager_id is null or manager_id <> id);
  end if;
end $$;

create index if not exists profiles_manager_idx on public.profiles(manager_id);

-- ── No self-promotion ──
-- RLS cannot restrict columns, so this is done with column-level grants: revoke
-- UPDATE on the table, then grant it back only where it is harmless. Without
-- this, "Users can update own profile" would let anyone set role = 'admin'.
revoke update on public.profiles from authenticated, anon;
grant update (full_name) on public.profiles to authenticated;
-- access_level and manager_id are changed only through /api/team, which runs with the
-- service role after checking the caller is an admin. service_role is unaffected
-- by the revoke above.

-- ── Who am I, and who do I manage ──
create or replace function public.is_admin()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and access_level = 'admin'
  );
$$;

/*
 * True when the caller is anywhere above p_target in the reporting line, so a
 * skip-level manager inherits access without anything being granted twice.
 *
 * The depth cap is a cycle guard: manager_id is a plain self-reference, and a
 * loop (A manages B manages A) would otherwise recurse until the statement was
 * killed. The not-self constraint above stops the trivial case; this stops the
 * rest.
 */
create or replace function public.manages(p_target uuid)
returns boolean language sql security definer set search_path = public stable as $$
  with recursive chain as (
    select p.id, p.manager_id, 1 as depth
    from public.profiles p
    where p.id = p_target
    union all
    select p.id, p.manager_id, c.depth + 1
    from public.profiles p
    join chain c on p.id = c.manager_id
    where c.depth < 10
  )
  select auth.uid() is not null
     and exists (select 1 from chain where chain.manager_id = auth.uid());
$$;

-- ── Profiles: who you may see ──
-- Yourself, anyone you manage at any depth, anyone you share a meeting with,
-- anyone on the other side of a task, and everything if you are an admin.
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
  );
$$;

drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Users can view all profiles" on public.profiles;
drop policy if exists "Users can view permitted profiles" on public.profiles;
create policy "Users can view permitted profiles" on public.profiles for select
  using (public.can_view_profile(id));

/*
 * Exact-email lookup, for assigning a task or adding a participant.
 *
 * These flows need to reach someone who shares no meeting with you yet, which
 * the policy above deliberately hides. SECURITY DEFINER answers one exact
 * address at a time and returns no list, so the directory stays closed to
 * enumeration. A session is still required.
 */
create or replace function public.find_profile_by_email(p_email text)
returns table (id uuid, full_name text)
language sql security definer set search_path = public stable as $$
  select p.id, p.full_name
  from public.profiles p
  where auth.uid() is not null
    and lower(p.email) = lower(trim(p_email))
  limit 1;
$$;

revoke all on function public.find_profile_by_email(text) from anon;
grant execute on function public.find_profile_by_email(text) to authenticated;

-- ── Invitations ──
create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  manager_id uuid references public.profiles(id) on delete set null,
  access_level text not null default 'member'
    check (access_level in ('member', 'manager', 'admin')),
  invited_by uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz default now()
);

-- Case-insensitive, because email is matched that way at signup. Note this is an
-- EXPRESSION index: `ON CONFLICT (email)` will not match it, so the invite routes
-- insert and fall back to an update on unique violation rather than upserting.
create unique index if not exists invitations_email_idx on public.invitations(lower(email));

alter table public.invitations enable row level security;

drop policy if exists "Admins and managers can read invitations" on public.invitations;
create policy "Admins and managers can read invitations" on public.invitations for select
  using (public.is_admin() or invited_by = auth.uid() or manager_id = auth.uid());

-- Writes go through /api/team with the service role, so no insert/update/delete
-- policy is defined here: the anon key cannot mint itself an invitation.

-- ── Signup requires an invitation ──
create or replace function public.enforce_invitation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.invitations where lower(email) = lower(new.email)
  ) then
    raise exception 'That email has not been invited to this workspace.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists enforce_invitation_before_signup on auth.users;
create trigger enforce_invitation_before_signup
  before insert on auth.users
  for each row execute function public.enforce_invitation();

-- Carry the invitation's manager and role onto the new profile.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  inv public.invitations;
begin
  select * into inv from public.invitations
  where lower(email) = lower(new.email) limit 1;

  insert into public.profiles (id, full_name, email, manager_id, access_level)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email,
    inv.manager_id,
    coalesce(inv.access_level, 'member')
  )
  on conflict (id) do nothing;

  update public.invitations
    set accepted_at = now()
    where lower(email) = lower(new.email) and accepted_at is null;

  return new;
end $$;

-- Existing accounts predate the gate. Record an accepted invitation for each so
-- the table reflects reality and nobody is locked out of a re-signup.
insert into public.invitations (email, access_level, accepted_at)
select p.email, coalesce(p.access_level, 'member'), coalesce(p.created_at, now())
from public.profiles p
where p.email is not null
on conflict (lower(email)) do nothing;

-- ── Oversight: read-only, and separate from participation ──
-- can_access_meeting() stays participation-only because the child tables use it
-- for FOR ALL, which covers writes. Oversight is added as its own SELECT policy
-- so a manager or admin can read a report's agenda without being able to edit it.
create or replace function public.can_oversee_meeting(p_meeting_id uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select public.is_admin() or exists (
    select 1 from public.meeting_participants mp
    where mp.meeting_id = p_meeting_id and public.manages(mp.user_id)
  );
$$;

drop policy if exists "Oversight can view meetings" on public.meetings;
create policy "Oversight can view meetings" on public.meetings for select
  using (
    public.is_admin()
    or public.manages(manager_id)
    or public.manages(report_id)
    or public.can_oversee_meeting(id)
  );

do $$
declare t text;
begin
  foreach t in array array[
    'segue_notes', 'scorecard_items', 'headlines', 'issues', 'todos',
    'section_timers', 'meeting_participants', 'extracted_items'
  ] loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      execute format('drop policy if exists "Oversight can view" on public.%I', t);
      execute format(
        'create policy "Oversight can view" on public.%I for select
           using (public.can_oversee_meeting(meeting_id))', t);
    end if;
  end loop;
end $$;

-- Tasks: participants keep read/write via the existing policy; oversight reads.
drop policy if exists "Oversight can view tasks" on public.weekly_commitments;
create policy "Oversight can view tasks" on public.weekly_commitments for select
  using (
    public.is_admin()
    or public.manages(assignee_id)
    or public.manages(creator_id)
    or (meeting_id is not null and public.can_oversee_meeting(meeting_id))
  );

drop policy if exists "Admins can read notifications" on public.notification_log;
create policy "Admins can read notifications" on public.notification_log for select
  using (public.is_admin() or public.manages(user_id));

-- ── Seed the first admin ──
-- EDIT THIS EMAIL if the owner should be someone else. Nothing else in the file
-- names a person; further admins are granted through /api/team.
update public.profiles set access_level = 'admin'
  where lower(email) = lower('sam@datavations.com');

-- ── Cycle guard for reporting-line edits ──
-- manages() caps its walk at ten levels, so a loop would not hang but WOULD make
-- it quietly stop finding people. /api/team/manager calls this before writing.
create or replace function public.would_create_cycle(p_user uuid, p_manager uuid)
returns boolean language sql security definer set search_path = public stable as $$
  with recursive chain as (
    select p.id, p.manager_id, 1 as depth
    from public.profiles p where p.id = p_manager
    union all
    select p.id, p.manager_id, c.depth + 1
    from public.profiles p
    join chain c on p.id = c.manager_id
    where c.depth < 50
  )
  -- Pointing p_user at p_manager loops if p_user is already above p_manager.
  select p_user = p_manager or exists (select 1 from chain where chain.id = p_user);
$$;

revoke all on function public.would_create_cycle(uuid, uuid) from anon, authenticated;
