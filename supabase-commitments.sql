-- Weekly commitments table
create table public.weekly_commitments (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references public.meetings(id) on delete cascade,
  creator_id uuid references public.profiles(id),
  assignee_id uuid references public.profiles(id),
  title text not null,
  description text default '',
  due_date date,
  status text check (status in ('open','done')) default 'open',
  notify_email boolean default true,
  notify_slack boolean default false,
  notified boolean default false,
  created_at timestamptz default now()
);

alter table public.weekly_commitments enable row level security;

create policy "Commitment participants can view" on public.weekly_commitments for select
  using (meeting_id in (select id from public.meetings where manager_id = auth.uid() or report_id = auth.uid()));

create policy "Commitment participants can insert" on public.weekly_commitments for insert
  with check (meeting_id in (select id from public.meetings where manager_id = auth.uid() or report_id = auth.uid()));

create policy "Commitment participants can update" on public.weekly_commitments for update
  using (meeting_id in (select id from public.meetings where manager_id = auth.uid() or report_id = auth.uid()));
