-- 봐드림 스키마
-- Supabase SQL Editor에서 실행 (여러 번 실행해도 안전)

create extension if not exists "pgcrypto";

-- 방(세션). 엔지니어만 생성. 고객은 code로 접근.
create table if not exists rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,                 -- 초대 URL용 짧은 코드
  engineer_id uuid not null references auth.users(id) on delete cascade,
  customer_name  text,
  customer_phone text,
  status      text not null default 'waiting'       -- waiting | active | ended
              check (status in ('waiting','active','ended')),
  resolved_remotely boolean,                        -- 종료 시 엔지니어가 체크. 핵심 지표
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  ended_at    timestamptz
);

create index if not exists rooms_engineer_idx on rooms(engineer_id, created_at desc);

-- 지표 이벤트. 나중에 과금/최적화 근거.
create table if not exists events (
  id         bigint generated always as identity primary key,
  room_id    uuid references rooms(id) on delete cascade,
  actor      text not null check (actor in ('engineer','customer','system')),
  name       text not null,       -- room_created, link_opened, camera_granted, connected, relay_used, ended, ...
  props      jsonb default '{}',  -- user agent, ice candidate type, duration 등
  created_at timestamptz not null default now()
);

create index if not exists events_room_idx on events(room_id, created_at);
create index if not exists events_name_idx on events(name, created_at);

-- RLS
alter table rooms  enable row level security;
alter table events enable row level security;

-- 엔지니어: 자기 방만
drop policy if exists "engineer manages own rooms" on rooms;
create policy "engineer manages own rooms" on rooms
  for all using (auth.uid() = engineer_id) with check (auth.uid() = engineer_id);

-- 고객(anon): 방 정보는 서버 API(service role)를 통해서만 읽는다. 직접 select 없음.
-- 이벤트 insert는 서버 API를 통해서만.
drop policy if exists "engineer reads own events" on events;
create policy "engineer reads own events" on events
  for select using (
    exists (select 1 from rooms r where r.id = events.room_id and r.engineer_id = auth.uid())
  );

-- 코드 생성 헬퍼 (혼동 쉬운 문자 제외, 6자리)
create or replace function gen_room_code() returns text language sql as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', (random()*30)::int + 1, 1), '')
  from generate_series(1, 6);
$$;
