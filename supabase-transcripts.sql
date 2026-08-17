-- EOS 1-on-1 — transcript extraction review queue
-- Run this in the Supabase SQL Editor AFTER supabase-participants.sql
-- (it depends on the can_access_meeting() function defined there).
-- Safe to re-run.
--
-- Design note: transcripts are NOT stored. Granola (or the uploaded file) is the
-- source of truth, and a 1-on-1 transcript is personnel data — compensation,
-- performance, complaints about colleagues. What persists is the extracted item
-- plus a short evidence excerpt, which is what a human needs in order to accept
-- or reject it. `source_ref` records where it came from so it can be re-fetched.

create table if not exists public.extracted_items (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,

  -- provenance
  source text not null check (source in ('upload', 'granola')) default 'upload',
  source_ref text,                       -- Granola note id, or a filename
  extracted_by uuid references public.profiles(id),

  -- the proposed item
  target text not null check (target in ('todo', 'commitment', 'issue')),
  title text not null,
  owner_id uuid references public.profiles(id),
  due_date date,
  evidence text default '',              -- short quote justifying the item
  confidence text check (confidence in ('high', 'medium', 'low')) default 'medium',

  -- dedupe against what's already on the agenda
  duplicate_of_kind text check (duplicate_of_kind in ('todo', 'commitment')),
  duplicate_of_id uuid,

  -- review state — nothing reaches the shared agenda without a human accepting it
  status text not null check (status in ('pending', 'accepted', 'rejected')) default 'pending',
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  accepted_kind text check (accepted_kind in ('todo', 'commitment', 'issue')),
  accepted_id uuid,

  created_at timestamptz default now()
);

create index if not exists extracted_items_meeting_idx on public.extracted_items(meeting_id);
create index if not exists extracted_items_status_idx on public.extracted_items(meeting_id, status);

alter table public.extracted_items enable row level security;

drop policy if exists "Access via meeting" on public.extracted_items;
create policy "Access via meeting" on public.extracted_items for all
  using (public.can_access_meeting(meeting_id));
