-- EOS 1-on-1 — deleting meetings
-- Run this in the Supabase SQL Editor AFTER supabase-schema.sql.
-- Independent of the other migrations; order among them doesn't matter.
-- Safe to re-run.

-- ── Who may delete ──
-- Only the organiser (manager). A report or an added participant can edit the
-- shared agenda but must not be able to destroy the record of the meeting.
-- Without this policy a delete silently affects zero rows: RLS has no DELETE
-- policy to permit it, and PostgREST reports success either way.
drop policy if exists "Meeting managers can delete" on public.meetings;
create policy "Meeting managers can delete" on public.meetings for delete
  using (manager_id = auth.uid());

-- ── Make the cascade actually work ──
-- Every child table references meetings with ON DELETE CASCADE, so its rows go
-- with the meeting. (Cascades are system-initiated and bypass RLS, so the child
-- tables need no DELETE policies of their own.)
--
-- One exception breaks it: todos.carried_from_id points at the *previous*
-- meeting's todo and was created with no ON DELETE action, i.e. NO ACTION. So
-- deleting an older meeting whose to-dos were carried forward fails with a
-- foreign-key violation — exactly the meetings you'd most want to clean up.
-- SET NULL keeps the newer to-do and just forgets where it came from.
alter table public.todos drop constraint if exists todos_carried_from_id_fkey;
alter table public.todos
  add constraint todos_carried_from_id_fkey
  foreign key (carried_from_id) references public.todos(id) on delete set null;
