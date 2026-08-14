-- EOS 1-on-1 Agenda App — Supabase Schema
-- Run this in the Supabase SQL Editor

-- Profiles (linked to Supabase Auth)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  role text check (role in ('manager', 'report')) default 'report',
  created_at timestamptz default now()
);

-- Meetings
create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  meeting_date date not null default current_date,
  manager_id uuid references public.profiles(id),
  report_id uuid references public.profiles(id),
  status text check (status in ('prep', 'active', 'completed')) default 'prep',
  rating int check (rating between 1 and 10),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Segue notes (one per person per meeting)
create table public.segue_notes (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references public.meetings(id) on delete cascade,
  user_id uuid references public.profiles(id),
  personal_win text default '',
  professional_win text default '',
  created_at timestamptz default now()
);

-- Scorecard items (measurables + rocks)
create table public.scorecard_items (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references public.meetings(id) on delete cascade,
  item_type text check (item_type in ('measurable', 'rock')) not null,
  name text not null default '',
  on_track boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- Headlines
create table public.headlines (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references public.meetings(id) on delete cascade,
  user_id uuid references public.profiles(id),
  content text default '',
  created_at timestamptz default now()
);

-- Issues (IDS)
create table public.issues (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references public.meetings(id) on delete cascade,
  description text not null default '',
  priority text check (priority in ('H', 'M', 'L')) default 'H',
  resolution text default '',
  resolved boolean default false,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- To-dos
create table public.todos (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references public.meetings(id) on delete cascade,
  text text not null default '',
  owner text default '',
  done boolean default false,
  carried_from_id uuid references public.todos(id),
  is_new boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- Section timers (track time spent per section)
create table public.section_timers (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references public.meetings(id) on delete cascade,
  section_key text not null, -- 'segue', 'scorecard', 'headlines', 'ids', 'todos'
  elapsed_seconds int default 0,
  completed boolean default false
);

-- Enable RLS
alter table public.profiles enable row level security;
alter table public.meetings enable row level security;
alter table public.segue_notes enable row level security;
alter table public.scorecard_items enable row level security;
alter table public.headlines enable row level security;
alter table public.issues enable row level security;
alter table public.todos enable row level security;
alter table public.section_timers enable row level security;

-- RLS Policies: users can see meetings they're part of
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Users can view all profiles" on public.profiles for select using (true);
create policy "Users can insert own profile" on public.profiles for insert with check (auth.uid() = id);

create policy "Meeting participants can view" on public.meetings for select
  using (auth.uid() = manager_id or auth.uid() = report_id);
create policy "Meeting participants can insert" on public.meetings for insert
  with check (auth.uid() = manager_id or auth.uid() = report_id);
create policy "Meeting participants can update" on public.meetings for update
  using (auth.uid() = manager_id or auth.uid() = report_id);

-- Child table policies (inherit from meeting access)
create policy "Access via meeting" on public.segue_notes for all
  using (meeting_id in (select id from public.meetings where manager_id = auth.uid() or report_id = auth.uid()));
create policy "Access via meeting" on public.scorecard_items for all
  using (meeting_id in (select id from public.meetings where manager_id = auth.uid() or report_id = auth.uid()));
create policy "Access via meeting" on public.headlines for all
  using (meeting_id in (select id from public.meetings where manager_id = auth.uid() or report_id = auth.uid()));
create policy "Access via meeting" on public.issues for all
  using (meeting_id in (select id from public.meetings where manager_id = auth.uid() or report_id = auth.uid()));
create policy "Access via meeting" on public.todos for all
  using (meeting_id in (select id from public.meetings where manager_id = auth.uid() or report_id = auth.uid()));
create policy "Access via meeting" on public.section_timers for all
  using (meeting_id in (select id from public.meetings where manager_id = auth.uid() or report_id = auth.uid()));

-- Function to auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger meetings_updated_at before update on public.meetings
  for each row execute function update_updated_at();

-- Handle new user signup: auto-create profile
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)), new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
