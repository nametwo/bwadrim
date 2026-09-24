-- 봐드림 스키마
-- Supabase SQL Editor에서 실행 (여러 번 실행해도 안전)

create extension if not exists "pgcrypto";

-- 방(세션). 엔지니어만 생성. 고객은 join_token 링크로 접근.
create table if not exists rooms (
  id          uuid primary key default gen_random_uuid(),
  code        text unique,                          -- 폐기(ROOM-02). 예전 세션의 6자리 코드. 새 세션은 비어 있음
  engineer_id uuid not null references auth.users(id) on delete cascade,
  customer_name  text,                              -- 쓰지 않음: 고객 연락처는 저장하지 않는다(NFR-07)
  customer_phone text,                              -- 쓰지 않음(NFR-07)
  status      text not null default 'waiting'       -- waiting | active | ended
              check (status in ('waiting','active','ended')),
  resolved_remotely boolean,                        -- 종료 시 엔지니어가 체크. 핵심 지표
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  ended_at    timestamptz
);

create index if not exists rooms_engineer_idx on rooms(engineer_id, created_at desc);

-- 예전 DB에서는 code가 필수였다. 이제 새 세션은 code 없이 만든다 (ROOM-02 폐기)
alter table rooms alter column code drop not null;

-- 고객 링크(/join/{join_token})용 추측 불가능한 값 (32자리 16진수, 약 122비트, ROOM-12).
-- 기존 행에도 각각 새 값이 채워진다
alter table rooms add column if not exists join_token text not null unique
  default replace(gen_random_uuid()::text, '-', '');

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

-- 예전 6자리 코드 생성 헬퍼 (ROOM-02 폐기로 삭제)
drop function if exists gen_room_code();

-- ─── 통화 시그널링 채널 권한 (Supabase Realtime 비공개 채널, BUG-09) ───
-- 방마다 일방통행 채널 두 개:
--   room:{id}:e  엔지니어 → 고객. 보내기는 로그인한 방 주인만 → 엔지니어 사칭 차단
--   room:{id}:c  고객 → 엔지니어. 링크를 연 사람 누구나 (고객은 로그인 없음)
-- 듣기는 두 채널 모두 열린 방(종료·만료 전)이면 누구나. 종료·만료된 방은 새로 들어올 수 없다.
-- 적용 후 대시보드 Realtime 설정에서 공개 채널 허용(Allow public access)을 끌 것.
-- 켜 두면 비공개 설정을 뺀 채널은 이 규칙을 거치지 않는다.

-- API로 노출되지 않는 스키마 (public 함수는 누구나 RPC로 부를 수 있다)
create schema if not exists private;
grant usage on schema private to anon, authenticated;

-- 토픽이 'room:{uuid}:{lane}' 형식이고 방이 열려 있으면 방 주인 id, 아니면 null.
-- 정책을 평가하는 쪽(anon)은 rooms를 못 읽으므로 security definer로 읽는다
create or replace function private.open_room_owner(topic text, lane text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  m text[];
  owner uuid;
begin
  m := regexp_match(topic, '^room:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([ec])$');
  if m is null or m[2] <> lane then
    return null;
  end if;
  select r.engineer_id into owner
    from public.rooms r
   where r.id = m[1]::uuid
     and r.status <> 'ended'
     and r.expires_at > now();
  return owner;
end;
$$;

grant execute on function private.open_room_owner(text, text) to anon, authenticated;

drop policy if exists "bwadrim lanes: listen" on realtime.messages;
create policy "bwadrim lanes: listen" on realtime.messages
  for select to anon, authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and (
      private.open_room_owner(realtime.topic(), 'e') is not null
      or private.open_room_owner(realtime.topic(), 'c') is not null
    )
  );

drop policy if exists "bwadrim customer lane: send" on realtime.messages;
create policy "bwadrim customer lane: send" on realtime.messages
  for insert to anon, authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and private.open_room_owner(realtime.topic(), 'c') is not null
  );

drop policy if exists "bwadrim engineer lane: send" on realtime.messages;
create policy "bwadrim engineer lane: send" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and private.open_room_owner(realtime.topic(), 'e') = (select auth.uid())
  );
