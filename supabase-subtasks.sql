-- EOS 1-on-1 — main tasks with subtasks
-- Run in the Supabase SQL Editor AFTER supabase-departments.sql. Safe to re-run.
--
-- A piece of work like "Build out HIRI Pulse Member edition" is not one task, it's
-- a container for several. parent_id makes that relationship explicit rather than
-- leaving it implied by naming.

alter table public.weekly_commitments
  add column if not exists parent_id uuid references public.weekly_commitments(id) on delete cascade;

create index if not exists weekly_commitments_parent_idx
  on public.weekly_commitments(parent_id)
  where parent_id is not null;

/*
 * One level only, enforced rather than merely intended.
 *
 * Arbitrary nesting reads well in a schema and badly everywhere else: the UI needs
 * a recursive renderer, progress counts need a recursive walk, and a cycle makes
 * both non-terminating. One level covers "main task with subtasks", which is the
 * thing being asked for.
 *
 * The meeting check keeps visibility coherent. Access rules differ sharply between
 * a standalone task and one raised in a 1-on-1, so a subtask must sit on the same
 * side of that line as its parent — otherwise a subtask under a private 1-on-1
 * commitment could be departmentally visible, which is exactly backwards.
 */
create or replace function public.enforce_task_depth()
returns trigger language plpgsql set search_path = public as $$
declare
  parent record;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'A task cannot be its own parent';
  end if;

  select parent_id, meeting_id into parent
  from public.weekly_commitments where id = new.parent_id;

  if not found then
    raise exception 'That parent task does not exist';
  end if;

  if parent.parent_id is not null then
    raise exception 'Subtasks go one level deep — that task is already a subtask';
  end if;

  if coalesce(parent.meeting_id::text, '') <> coalesce(new.meeting_id::text, '') then
    raise exception 'A subtask must belong to the same meeting as its parent';
  end if;

  return new;
end $$;

drop trigger if exists enforce_task_depth_before_write on public.weekly_commitments;
create trigger enforce_task_depth_before_write
  before insert or update of parent_id on public.weekly_commitments
  for each row execute function public.enforce_task_depth();

-- ── Visibility ──
/*
 * A subtask is visible to anyone who can see its parent.
 *
 * Without this, "3 of 5 done" lies: a subtask handed to someone in another
 * department is invisible to the person who owns the main task, so the count
 * silently drops rows the reader cannot see. Mirrors the parent's own rules rather
 * than inventing new ones.
 *
 * SECURITY DEFINER so the policy can read the parent row without re-entering this
 * same policy. Safe from recursion because the trigger above guarantees a parent
 * has no parent of its own, so the lookup is exactly one hop.
 */
create or replace function public.can_access_parent_task(p_parent uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select auth.uid() is not null and exists (
    select 1 from public.weekly_commitments p
    where p.id = p_parent
      and (
        p.assignee_id = auth.uid()
        or p.creator_id = auth.uid()
        or public.is_admin()
        or public.manages(p.assignee_id)
        or public.manages(p.creator_id)
        or (p.meeting_id is not null and public.can_access_meeting(p.meeting_id))
        or (
          p.meeting_id is null
          and p.visible_to_department
          and nullif(btrim(lower(p.department)), '') = public.my_department()
        )
      )
  );
$$;

drop policy if exists "Subtasks inherit parent visibility" on public.weekly_commitments;
create policy "Subtasks inherit parent visibility" on public.weekly_commitments for select
  using (parent_id is not null and public.can_access_parent_task(parent_id));

-- A subtask inherits its parent's department, so departmental views stay whole
-- even when the person creating the subtask sits elsewhere.
create or replace function public.stamp_task_department()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.department is null and new.parent_id is not null then
    select p.department into new.department
    from public.weekly_commitments p where p.id = new.parent_id;
  end if;

  if new.department is null then
    select p.department into new.department
    from public.profiles p
    where p.id = coalesce(new.creator_id, new.assignee_id);
  end if;

  return new;
end $$;
