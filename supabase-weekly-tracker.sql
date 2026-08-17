-- EOS 1-on-1 — weekly tracker
-- Run this in the Supabase SQL Editor AFTER supabase-commitments.sql and
-- supabase-participants.sql. Safe to re-run.
--
-- Two changes:
--
-- 1. Standalone tasks. weekly_commitments.meeting_id was already nullable, but
--    supabase-participants.sql repointed the policy at
--    can_access_meeting(meeting_id), which returns false when meeting_id is
--    null — so a task added mid-week, outside any meeting, was both impossible
--    to insert and invisible if it existed. Ownership now covers that case.
--
-- 2. completed_at, so the tracker can show what got finished this week rather
--    than only what is still open.

alter table public.weekly_commitments
  add column if not exists completed_at timestamptz;

-- The tracker's main query is "everything assigned to me, by due date".
create index if not exists weekly_commitments_assignee_idx
  on public.weekly_commitments(assignee_id, status);
create index if not exists weekly_commitments_creator_idx
  on public.weekly_commitments(creator_id, status);
create index if not exists weekly_commitments_due_idx
  on public.weekly_commitments(due_date);

-- Anything already done predates the column. Attribute it to creation time so
-- it doesn't read as "never completed".
update public.weekly_commitments
  set completed_at = created_at
  where status = 'done' and completed_at is null;

-- ── Policy ──
-- Replaces every earlier name for this policy so re-running any of the three
-- migration files converges on the same single policy.
drop policy if exists "Commitment participants can view" on public.weekly_commitments;
drop policy if exists "Commitment participants can insert" on public.weekly_commitments;
drop policy if exists "Commitment participants can update" on public.weekly_commitments;
drop policy if exists "Access via meeting" on public.weekly_commitments;
drop policy if exists "Access via meeting or ownership" on public.weekly_commitments;

-- FOR ALL with no WITH CHECK reuses the USING expression for inserts.
-- A meeting-bound task is reachable by anyone in that meeting; a standalone one
-- only by the person it's for and the person who wrote it.
create policy "Access via meeting or ownership" on public.weekly_commitments for all
  using (
    (meeting_id is not null and public.can_access_meeting(meeting_id))
    or (meeting_id is null and (assignee_id = auth.uid() or creator_id = auth.uid()))
  );
