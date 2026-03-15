-- RAG Work Tracker — Supabase Schema
-- Paste this entire file into Supabase → SQL Editor → Run

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- PROFILES (extends Supabase auth.users)
create table if not exists public.profiles (
  id uuid references auth.users(id) on delete cascade primary key,
  email text,
  display_name text,
  plan text default 'free',
  ai_queries_today int default 0,
  ai_queries_date date default current_date,
  created_at timestamptz default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- PROJECTS
create table if not exists public.projects (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  name text not null,
  description text default '',
  created_at timestamptz default now()
);

-- TASKS
create table if not exists public.tasks (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  title text not null,
  project text default '',
  status text default 'todo' check (status in ('todo','inprogress','done','blocked')),
  priority text default 'medium' check (priority in ('high','medium','low')),
  due_date date,
  description text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- TIMELINE EVENTS
create table if not exists public.timeline (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  type text not null,
  text text not null,
  task_id uuid,
  extra jsonb default '{}',
  created_at timestamptz default now()
);

-- Row Level Security — users can only see their own data
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.timeline enable row level security;

-- Profiles policies
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

-- Projects policies
create policy "Users can manage own projects" on public.projects for all using (auth.uid() = user_id);

-- Tasks policies
create policy "Users can manage own tasks" on public.tasks for all using (auth.uid() = user_id);

-- Timeline policies
create policy "Users can manage own timeline" on public.timeline for all using (auth.uid() = user_id);

-- Indexes for performance
create index if not exists tasks_user_id_idx on public.tasks(user_id);
create index if not exists tasks_status_idx on public.tasks(status);
create index if not exists timeline_user_id_idx on public.timeline(user_id);
create index if not exists timeline_created_idx on public.timeline(created_at desc);
create index if not exists projects_user_id_idx on public.projects(user_id);

-- Free tier limits view (helper)
create or replace view public.user_limits as
select
  p.id,
  p.plan,
  p.ai_queries_today,
  p.ai_queries_date,
  count(distinct pr.id) as project_count,
  count(distinct t.id) as task_count
from public.profiles p
left join public.projects pr on pr.user_id = p.id
left join public.tasks t on t.user_id = p.id
group by p.id, p.plan, p.ai_queries_today, p.ai_queries_date;