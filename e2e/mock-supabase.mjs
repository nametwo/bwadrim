// E2E용 가짜 Supabase (REST·Auth만). 진짜 Supabase 없이 /join·/room·/api/*가 돌아가게 한다.
// Next 서버(서버 컴포넌트·서버 액션·라우트 핸들러)가 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:<포트>로 부른다.
// Realtime(WebSocket·REST 보내기)은 여기서 하지 않는다 — 브라우저 쪽에서 Playwright가 가로챈다 (e2e/realtime-mock.ts).
//
//   POST /auth/v1/token                로그인 — 계정이 없어 늘 400(맞지 않아요). faults.failAuth면 503(장애, AUTH-03)
//   POST /auth/v1/logout               로그아웃 — scope를 기억한다 (GET /__last-logout, AUTH-06)
//   GET  /auth/v1/user                 Bearer 토큰이 FIXTURE.accessToken이면 사용자, 아니면 401
//   GET  /auth/v1/admin/users/:id      (서비스 키) 사용자 — 고객 화면의 기사님 이름
//   GET  /rest/v1/rooms?code=eq.X      (eq·neq·in·gte·is 필터, select=…, count=exact·HEAD 지원) Accept가 vnd.pgrst.object+json이면 객체 1개
//   PATCH /rest/v1/rooms?id=eq.X…      상태 갱신 (status=eq.X·neq.X, recipient_id=is.null 조건 지원). recipient_id는 있는 이름표만(FK, 없으면 409 23503)
//   POST /auth/v1/token?grant_type=pkce  카카오 로그인 돌아오기(AUTH-10). auth_code가 'e2e-kakao-code'이고 code_verifier가 있으면 사용자 세션
//   POST /rest/v1/rooms                상담 만들기 (사용자 토큰). 이번 달(한국 시간) 수가 한도에 닿으면 400 P0001 'room_limit' (ROOM-17 트리거 흉내)
//   POST /rest/v1/rpc/my_room_limit    한 달 상담 한도 (기본 30, /__faults {roomLimit}로 바꿈)
//   DELETE /auth/v1/admin/users/:id    (서비스 키) 회원 탈퇴 (AUTH-11). 같은 사용자를 다른 테스트가 같이 쓰므로 지우지 않고 기록만 (GET /__deleted-users)
//   POST /rest/v1/events               기록 (본문 객체 또는 배열) · GET은 통계·대시보드용(같은 필터, count=exact·HEAD 지원)
//   GET·POST·PATCH /rest/v1/recipients  받는 분 이름표 (ROOM-16). 사용자 토큰이면 자기 것만(RLS), 서비스 키면 전부.
//                                      eq·in·is 필터. POST는 본문 객체/배열, Prefer return=representation이면 넣은 줄을 돌려준다
//                                      (insert().select().single() = POST + return=representation + Accept 객체).
//                                      unique(engineer_id, kakao_hash) 겹치면 409 23505, label 1~30자 아니면 400 23514
//   GET  /__events  ·  GET /__rooms  ·  GET /__recipients  ·  POST /__reset[?room=ID]  ·  GET /__health   (테스트용)
//   POST /__seed {rooms?, events?, recipients?}  목록 바꾸기 (화면 카탈로그: 대시보드·통계, 받는 분 이름표). ageMin = 몇 분 전
//   POST /__patch-room {id, ...}       방 한 개 고치기 (링크를 연 뒤 세션이 닫힌 경우 등)
//   POST /__faults {failJoinToken?, failRoomUpdate?, failRoomInsert?, roomLimit?, failAuth?, failEvents?}  일부러 실패시키기 (전체 reset하면 풀린다)
//   POST /__discord/{channel}  디스코드 웹훅 흉내(OPS-09) — 서버가 보낸 {content}를 모은다 · GET /__discord 목록 · DELETE /__discord 비우기
//
// 고정 데이터는 e2e/fixtures.json과 같다 (테스트도 같은 파일을 읽는다).
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, "fixtures.json"), "utf8"));
const PORT = Number(process.env.E2E_SUPABASE_PORT ?? FIXTURE.supabasePort);

let rooms = [];
let events = [];
let recipients = [];
let faults = {};
let deletedUsers = [];
/** 마지막 로그아웃 요청 {scope, at} — 이 기기만(local)인지 본다 (AUTH-06) */
let lastLogout = null;
/** 디스코드 웹훅으로 온 글 [{channel, content, at}] (OPS-09) */
let discord = [];

function freshRoom(r, now) {
  return {
    engineer_id: FIXTURE.user.id,
    customer_name: null,
    customer_phone: null,
    resolved_remotely: null,
    ended_at: null,
    // 카톡 1:1 방 해시와 받는 분 이름표 (ROOM-15·16). 카카오 웹훅이 채운다
    kakao_hash: null,
    recipient_id: null,
    ...r,
    created_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + (r.expired ? -1 : 1) * 24 * 3600_000).toISOString(),
  };
}

// roomId를 주면 그 방과 그 방의 기록만 되돌린다 — 동시에 도는 다른 테스트의 방을 건드리지 않게.
// 받는 분 이름표는 방이 아니라 엔지니어 것이라 전체 reset 때만 비운다 (한 테스트만 지우려면 /__seed {recipients: []})
function reset(roomId) {
  const now = Date.now();
  if (roomId) {
    const r = FIXTURE.rooms.find((x) => x.id === roomId);
    if (r) rooms = rooms.map((x) => (x.id === roomId ? freshRoom(r, now) : x));
    events = events.filter((e) => e.room_id !== roomId);
    return;
  }
  rooms = FIXTURE.rooms.map((r) => freshRoom(r, now));
  events = [];
  recipients = [];
  faults = {};
  deletedUsers = [];
  lastLogout = null;
  discord = [];
}
reset();

/** 화면 카탈로그용 방: ageMin분 전에 만든 방. expired면 만든 지 24시간이 지난 방, tookMin이면 만든 뒤 그만큼 지나 끝난 방 */
function seededRoom({ ageMin, expired, tookMin, ...r }, now) {
  const created = now - (ageMin ?? (expired ? 25 * 60 : 1)) * 60_000;
  return {
    ...freshRoom(r, now),
    created_at: new Date(created).toISOString(),
    expires_at: new Date(expired ? now - 3600_000 : created + 24 * 3600_000).toISOString(),
    ended_at: tookMin == null ? null : new Date(created + tookMin * 60_000).toISOString(),
  };
}

/** 받는 분 이름표 한 줄 (supabase/schema.sql recipients). id·시각은 DB 기본값처럼 채운다. lastSentMin = 몇 분 전에 마지막으로 보냄 */
function recipientRow({ lastSentMin, ...r }, now = Date.now()) {
  const at = new Date(now).toISOString();
  return {
    id: crypto.randomUUID(),
    engineer_id: FIXTURE.user.id,
    kakao_hash: null,
    last_sent_at: lastSentMin == null ? at : new Date(now - lastSentMin * 60_000).toISOString(),
    created_at: at,
    ...r,
  };
}

/**
 * recipients 제약 흉내: label not null·1~30자(check), unique(engineer_id, kakao_hash).
 * Postgres처럼 kakao_hash가 null인 줄끼리는 겹쳐도 된다. 어기면 PostgREST 오류 응답 [status, body], 괜찮으면 null
 */
function recipientViolation(row, others) {
  if (typeof row.label !== "string") {
    return [400, { code: "23502", details: null, hint: null, message: 'null value in column "label" of relation "recipients" violates not-null constraint' }];
  }
  const n = Array.from(row.label).length;
  if (n < 1 || n > 30) {
    return [400, { code: "23514", details: null, hint: null, message: 'new row for relation "recipients" violates check constraint "recipients_label_check"' }];
  }
  if (row.kakao_hash != null && others.some((o) => o.engineer_id === row.engineer_id && o.kakao_hash === row.kakao_hash)) {
    return [
      409,
      {
        code: "23505",
        details: `Key (engineer_id, kakao_hash)=(${row.engineer_id}, ${row.kakao_hash}) already exists.`,
        hint: null,
        message: 'duplicate key value violates unique constraint "recipients_engineer_id_kakao_hash_key"',
      },
    ];
  }
  return null;
}

function eventRow({ ageMin, ...e }, now = Date.now()) {
  const at = now - (ageMin ?? 0) * 60_000;
  return { props: {}, ...e, created_at: new Date(at).toISOString(), at };
}

/** PostgREST order (col.asc|col.desc 하나만) */
function sortRows(rows, order) {
  const m = /^(\w+)\.(asc|desc)/.exec(order ?? "");
  if (!m) return rows;
  const [, col, dir] = m;
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => (a[col] < b[col] ? -sign : a[col] > b[col] ? sign : 0));
}

function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** PostgREST 필터: eq·neq·in·gte(시각)·is(null·true·false)만. 나머지는 무시 */
function filterRows(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (["select", "limit", "order", "offset", "columns", "on_conflict"].includes(k)) continue;
    const m = /^(eq|neq|in|gte|is)\.(.*)$/.exec(v);
    if (!m) continue;
    const [, op, arg] = m;
    if (op === "is") {
      // .is("recipient_id", null) → recipient_id=is.null. 칸이 아예 없는 줄도 null로 본다
      const want = { null: null, true: true, false: false }[arg.toLowerCase()];
      if (want === undefined) continue;
      out = out.filter((r) => (want === null ? r[k] == null : r[k] === want));
    } else if (op === "eq") out = out.filter((r) => String(r[k]) === arg);
    else if (op === "neq") out = out.filter((r) => String(r[k]) !== arg);
    else if (op === "in") {
      const set = new Set(arg.replace(/^\((.*)\)$/, "$1").split(",").map((s) => s.replace(/^"(.*)"$/, "$1")));
      out = out.filter((r) => set.has(String(r[k])));
    } else {
      // 시각 칸(created_at 등)만 쓴다 — 이번 달 상담 수, 통계 기간
      const at = Date.parse(arg);
      out = out.filter((r) => Date.parse(r[k]) >= at);
    }
  }
  return out;
}

/** select(…, { count: "exact" })이면 PostgREST처럼 content-range로 개수를 알려 준다 */
function countHeader(req, n) {
  return /count=exact/.test(req.headers.prefer ?? "") ? { "content-range": n ? `0-${n - 1}/${n}` : "*/0" } : {};
}

function project(row, select) {
  if (!select || select === "*") return row;
  const o = {};
  for (const c of select.split(",").map((s) => s.trim())) o[c] = row[c];
  return o;
}

function authed(req) {
  const h = req.headers.authorization ?? "";
  return h === `Bearer ${FIXTURE.accessToken}`;
}

function isService(req) {
  return (req.headers.apikey ?? "") === FIXTURE.serviceKey;
}

/** Accept: application/vnd.pgrst.object+json (single()) — 줄이 꼭 하나여야 객체로, 아니면 406 */
function wantsObject(req) {
  return (req.headers.accept ?? "").includes("vnd.pgrst.object");
}

function sendRows(req, res, status, rows) {
  if (wantsObject(req)) {
    if (rows.length !== 1) {
      return send(res, 406, { code: "PGRST116", details: `The result contains ${rows.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" });
    }
    return send(res, status, rows[0]);
  }
  return send(res, status, rows, countHeader(req, rows.length));
}

const RLS_DENIED = { code: "42501", details: null, hint: null, message: 'new row violates row-level security policy for table "recipients"' };

/**
 * 받는 분 이름표 (ROOM-16). RLS 흉내: 사용자 토큰이면 engineer_id가 그 사용자인 줄만 읽고 바꾸고 넣는다, 서비스 키면 전부.
 * 로그인 안 한 요청(anon)은 아무것도 못 본다
 */
async function handleRecipients(req, res, url) {
  const service = isService(req);
  const user = !service && authed(req);
  const mine = (r) => service || (user && r.engineer_id === FIXTURE.user.id);
  const select = url.searchParams.get("select");
  const representation = (req.headers.prefer ?? "").includes("return=representation");

  if (req.method === "GET" || req.method === "HEAD") {
    let rows = sortRows(filterRows(recipients.filter(mine), url.searchParams), url.searchParams.get("order"));
    const limit = Number(url.searchParams.get("limit"));
    if (limit > 0) rows = rows.slice(0, limit);
    return sendRows(req, res, 200, rows.map((r) => project(r, select)));
  }

  if (req.method === "POST") {
    if (!service && !user) return send(res, 401, { code: "42501", message: "permission denied for table recipients" });
    const body = await readBody(req);
    const list = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
    const now = Date.now();
    const added = [];
    for (const item of list) {
      const row = recipientRow(item, now);
      // with check (auth.uid() = engineer_id)
      if (!service && row.engineer_id !== FIXTURE.user.id) return send(res, 403, RLS_DENIED);
      const bad = recipientViolation(row, [...recipients, ...added]);
      if (bad) return send(res, ...bad);
      added.push(row);
    }
    recipients.push(...added);
    if (!representation) return send(res, 201);
    return sendRows(req, res, 201, added.map((r) => project(r, select)));
  }

  if (req.method === "PATCH") {
    const patch = (await readBody(req)) ?? {};
    const matched = filterRows(recipients.filter(mine), url.searchParams);
    // 먼저 모두 검사하고 바꾼다 (한 줄이라도 어기면 아무것도 안 바뀐다)
    for (const r of matched) {
      const next = { ...r, ...patch };
      if (!service && next.engineer_id !== FIXTURE.user.id) return send(res, 403, RLS_DENIED);
      const bad = recipientViolation(next, recipients.filter((o) => o !== r));
      if (bad) return send(res, ...bad);
    }
    for (const r of matched) Object.assign(r, patch);
    if (!representation) return send(res, 204);
    return sendRows(req, res, 200, matched.map((r) => project(r, select)));
  }

  return send(res, 405, { message: `mock: ${req.method} /rest/v1/recipients` });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (p === "/__health") return send(res, 200, { ok: true });
    if (p === "/__events") return send(res, 200, events);
    if (p === "/__rooms") return send(res, 200, rooms);
    if (p === "/__recipients") return send(res, 200, recipients);
    if (p === "/__last-logout") return send(res, 200, lastLogout);
    if (p.startsWith("/__discord/") && req.method === "POST") {
      const body = (await readBody(req)) ?? {};
      discord.push({ channel: p.slice("/__discord/".length), content: typeof body.content === "string" ? body.content : "", at: Date.now() });
      return send(res, 204);
    }
    if (p === "/__discord" && req.method === "GET") return send(res, 200, discord);
    if (p === "/__discord" && req.method === "DELETE") {
      discord = [];
      return send(res, 204);
    }
    if (p === "/__reset" && req.method === "POST") {
      reset(url.searchParams.get("room") ?? undefined);
      return send(res, 200, { ok: true });
    }
    if (p === "/__seed" && req.method === "POST") {
      const body = (await readBody(req)) ?? {};
      const now = Date.now();
      if (Array.isArray(body.rooms)) rooms = body.rooms.map((r) => seededRoom(r, now));
      if (Array.isArray(body.events)) events = body.events.map((e) => eventRow(e, now));
      if (Array.isArray(body.recipients)) recipients = body.recipients.map((r) => recipientRow(r, now));
      return send(res, 200, { ok: true, recipients });
    }
    if (p === "/__patch-room" && req.method === "POST") {
      const { id, ...patch } = (await readBody(req)) ?? {};
      const room = rooms.find((r) => r.id === id);
      if (!room) return send(res, 404, { message: `no room ${id}` });
      Object.assign(room, patch);
      return send(res, 200, room);
    }
    if (p === "/__faults" && req.method === "POST") {
      faults = { ...faults, ...((await readBody(req)) ?? {}) };
      return send(res, 200, faults);
    }

    // 고객 화면이 기사님 이름을 찾을 때 (서비스 키)
    const adminUser = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(p);
    if (adminUser && req.method === "GET") {
      if ((req.headers.apikey ?? "") !== FIXTURE.serviceKey) return send(res, 401, { msg: "service key required" });
      if (adminUser[1] !== FIXTURE.user.id) return send(res, 404, { msg: "User not found" });
      return send(res, 200, FIXTURE.user);
    }

    if (adminUser && req.method === "DELETE") {
      if ((req.headers.apikey ?? "") !== FIXTURE.serviceKey) return send(res, 401, { msg: "service key required" });
      deletedUsers.push(adminUser[1]);
      return send(res, 200, {});
    }
    if (p === "/__deleted-users" && req.method === "GET") return send(res, 200, deletedUsers);

    if (p === "/auth/v1/token" && req.method === "POST" && url.searchParams.get("grant_type") === "pkce") {
      const body = (await readBody(req)) ?? {};
      if (body.auth_code !== "e2e-kakao-code" || !body.code_verifier) {
        return send(res, 400, { code: 400, error_code: "flow_state_not_found", msg: "invalid flow state, no valid flow state found" });
      }
      return send(res, 200, {
        access_token: FIXTURE.accessToken,
        refresh_token: FIXTURE.refreshToken,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: FIXTURE.user,
      });
    }

    if (p === "/rest/v1/rpc/my_room_limit" && req.method === "POST") {
      if (!authed(req)) return send(res, 401, { code: "42501", message: "permission denied for function my_room_limit" });
      return send(res, 200, faults.roomLimit ?? 30);
    }

    if (p === "/rest/v1/rooms" && req.method === "POST") {
      if (!authed(req)) return send(res, 401, { code: "42501", message: "new row violates row-level security policy" });
      if (faults.failRoomInsert) return send(res, 500, { code: "XX000", message: "mock: 일부러 실패 (failRoomInsert)" });
      // 트리거 흉내: 한국 시간 이번 달 1일 0시부터 만든 내 상담 수
      const kst = new Date(Date.now() + 9 * 3600_000);
      const monthStart = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 1, -9);
      const used = rooms.filter((r) => r.engineer_id === FIXTURE.user.id && new Date(r.created_at).getTime() >= monthStart).length;
      if (used >= (faults.roomLimit ?? 30)) return send(res, 400, { code: "P0001", details: null, hint: null, message: "room_limit" });
      const body = (await readBody(req)) ?? {};
      const now = Date.now();
      const row = {
        ...freshRoom({ id: crypto.randomUUID(), status: "waiting", join_token: crypto.randomBytes(16).toString("hex"), ...body }, now),
        created_at: new Date(now).toISOString(),
      };
      rooms.push(row);
      const out = project(row, url.searchParams.get("select"));
      if ((req.headers.accept ?? "").includes("vnd.pgrst.object")) return send(res, 201, out);
      return send(res, 201, [out]);
    }

    // 로그인(서버 액션 signInWithPassword). 가짜 서버에 계정은 없다 — 늘 '맞지 않아요'.
    // failAuth면 장애 흉내: 503은 auth-js가 AuthRetryableFetchError로 돌려준다 (AUTH-03)
    if (p === "/auth/v1/token" && req.method === "POST") {
      if (faults.failAuth) return send(res, 503, { message: "mock: auth down (failAuth)" });
      return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
    }
    // 로그아웃. auth-js는 POST /logout?scope=local|global|others 로 보낸다 (AUTH-06)
    if (p === "/auth/v1/logout" && req.method === "POST") {
      lastLogout = { scope: url.searchParams.get("scope"), at: Date.now() };
      return send(res, 204);
    }
    if (p === "/auth/v1/user" && req.method === "GET") {
      if (!authed(req)) return send(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      return send(res, 200, FIXTURE.user);
    }

    if (p === "/rest/v1/rooms") {
      // RLS 흉내: 사용자 토큰이면 자기 방만, 서비스 키면 전부
      const service = (req.headers.apikey ?? "") === FIXTURE.serviceKey;
      const visible = service ? rooms : authed(req) ? rooms.filter((r) => r.engineer_id === FIXTURE.user.id) : [];
      const matched = sortRows(filterRows(visible, url.searchParams), url.searchParams.get("order"));
      const select = url.searchParams.get("select");
      const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
      if (faults.failJoinToken && url.searchParams.get("join_token") === `eq.${faults.failJoinToken}`) {
        return send(res, 500, { code: "XX000", message: "mock: 일부러 실패 (failJoinToken)" });
      }
      if (req.method === "PATCH" && faults.failRoomUpdate) {
        return send(res, 500, { code: "XX000", message: "mock: 일부러 실패 (failRoomUpdate)" });
      }
      // HEAD = select(…, { head: true }): 개수만 (본문은 node가 버린다)
      if (req.method === "GET" || req.method === "HEAD") {
        const limit = Number(url.searchParams.get("limit") ?? NaN);
        const rows = (Number.isFinite(limit) ? matched.slice(0, limit) : matched).map((r) => project(r, select));
        if (single) {
          if (rows.length !== 1) {
            return send(res, 406, { code: "PGRST116", details: `The result contains ${rows.length} rows`, message: "JSON object requested, multiple (or no) rows returned" });
          }
          return send(res, 200, rows[0]);
        }
        return send(res, 200, rows, countHeader(req, rows.length));
      }
      if (req.method === "PATCH") {
        const patch = (await readBody(req)) ?? {};
        // rooms.recipient_id references recipients(id)
        if (patch.recipient_id != null && !recipients.some((x) => x.id === patch.recipient_id)) {
          return send(res, 409, {
            code: "23503",
            details: `Key (recipient_id)=(${patch.recipient_id}) is not present in table "recipients".`,
            hint: null,
            message: 'insert or update on table "rooms" violates foreign key constraint "rooms_recipient_id_fkey"',
          });
        }
        for (const r of matched) Object.assign(r, patch);
        const rows = matched.map((r) => project(r, select));
        if ((req.headers.prefer ?? "").includes("return=representation")) {
          if (single) return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: "PGRST116", message: "no rows" });
          return send(res, 200, rows);
        }
        return send(res, 204);
      }
    }

    // 통계 화면(/stats)·대시보드·대기 화면 고객 진행 상황용 읽기. eq·neq·in·gte 필터만 적용하고 자기 방 기록을 준다 (RLS 흉내)
    // HEAD = select(…, { count: "exact", head: true }): 개수만 (TURN 발급 횟수, NET-02)
    if (p === "/rest/v1/events" && (req.method === "GET" || req.method === "HEAD")) {
      // 서비스 키면 전부(받는 분 잇기가 여러 명에게 보냈는지 볼 때, ROOM-16), 사용자 토큰이면 자기 방 것만
      const service = (req.headers.apikey ?? "") === FIXTURE.serviceKey;
      if (!service && !authed(req)) return send(res, 200, [], countHeader(req, 0));
      const mine = new Set(rooms.filter((r) => service || r.engineer_id === FIXTURE.user.id).map((r) => r.id));
      const select = url.searchParams.get("select");
      const rows = sortRows(filterRows(events.filter((e) => mine.has(e.room_id)), url.searchParams), url.searchParams.get("order"));
      return send(res, 200, rows.map((e, i) => project({ id: i + 1, ...e }, select)), countHeader(req, rows.length));
    }

    if (p === "/rest/v1/events" && req.method === "POST") {
      if (faults.failEvents) return send(res, 500, { code: "XX000", message: "mock: 일부러 실패 (failEvents)" });
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : body ? [body] : [];
      for (const e of list) events.push(eventRow(e));
      return send(res, 201);
    }

    if (p === "/rest/v1/recipients") return await handleRecipients(req, res, url);

    send(res, 404, { message: `mock: ${req.method} ${p}` });
  } catch (e) {
    send(res, 500, { message: String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-supabase] http://127.0.0.1:${PORT}`);
});
