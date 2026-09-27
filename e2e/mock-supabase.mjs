// E2E용 가짜 Supabase (REST·Auth만). 진짜 Supabase 없이 /join·/room·/api/*가 돌아가게 한다.
// Next 서버(서버 컴포넌트·서버 액션·라우트 핸들러)가 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:<포트>로 부른다.
// Realtime(WebSocket)은 여기서 하지 않는다 — 브라우저 쪽에서 Playwright routeWebSocket으로 가로챈다 (e2e/realtime-mock.ts).
//
//   GET  /auth/v1/user                 Bearer 토큰이 FIXTURE.accessToken이면 사용자, 아니면 401
//   GET  /rest/v1/rooms?code=eq.X      (id=eq.X, select=… 지원) Accept가 vnd.pgrst.object+json이면 객체 1개
//   PATCH /rest/v1/rooms?id=eq.X…      상태 갱신 (status=eq.X 조건 지원)
//   POST /rest/v1/events               기록 (본문 객체 또는 배열)
//   GET  /__events  ·  POST /__reset  ·  GET /__health   (테스트용)
//
// 고정 데이터는 e2e/fixtures.json과 같다 (테스트도 같은 파일을 읽는다).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, "fixtures.json"), "utf8"));
const PORT = Number(process.env.E2E_SUPABASE_PORT ?? FIXTURE.supabasePort);

let rooms = [];
let events = [];

function reset() {
  const now = Date.now();
  rooms = FIXTURE.rooms.map((r) => ({
    engineer_id: FIXTURE.user.id,
    customer_name: null,
    customer_phone: null,
    resolved_remotely: null,
    ended_at: null,
    ...r,
    created_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + (r.expired ? -1 : 1) * 24 * 3600_000).toISOString(),
  }));
  events = [];
}
reset();

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

/** PostgREST 필터 (eq만) */
function filterRows(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (["select", "limit", "order", "offset"].includes(k)) continue;
    const m = /^eq\.(.*)$/.exec(v);
    if (!m) continue;
    out = out.filter((r) => String(r[k]) === m[1]);
  }
  return out;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (p === "/__health") return send(res, 200, { ok: true });
    if (p === "/__events") return send(res, 200, events);
    if (p === "/__rooms") return send(res, 200, rooms);
    if (p === "/__reset" && req.method === "POST") {
      reset();
      return send(res, 200, { ok: true });
    }

    if (p === "/auth/v1/user" && req.method === "GET") {
      if (!authed(req)) return send(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      return send(res, 200, FIXTURE.user);
    }

    if (p === "/rest/v1/rooms") {
      // RLS 흉내: 사용자 토큰이면 자기 방만, 서비스 키면 전부
      const service = (req.headers.apikey ?? "") === FIXTURE.serviceKey;
      const visible = service ? rooms : authed(req) ? rooms.filter((r) => r.engineer_id === FIXTURE.user.id) : [];
      const matched = filterRows(visible, url.searchParams);
      const select = url.searchParams.get("select");
      const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
      if (req.method === "GET") {
        const rows = matched.map((r) => project(r, select));
        if (single) {
          if (rows.length !== 1) {
            return send(res, 406, { code: "PGRST116", details: `The result contains ${rows.length} rows`, message: "JSON object requested, multiple (or no) rows returned" });
          }
          return send(res, 200, rows[0]);
        }
        return send(res, 200, rows);
      }
      if (req.method === "PATCH") {
        const patch = (await readBody(req)) ?? {};
        for (const r of matched) Object.assign(r, patch);
        const rows = matched.map((r) => project(r, select));
        if ((req.headers.prefer ?? "").includes("return=representation")) {
          if (single) return rows.length === 1 ? send(res, 200, rows[0]) : send(res, 406, { code: "PGRST116", message: "no rows" });
          return send(res, 200, rows);
        }
        return send(res, 204);
      }
    }

    if (p === "/rest/v1/events" && req.method === "POST") {
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : body ? [body] : [];
      for (const e of list) events.push({ ...e, at: Date.now() });
      return send(res, 201);
    }

    send(res, 404, { message: `mock: ${req.method} ${p}` });
  } catch (e) {
    send(res, 500, { message: String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-supabase] http://127.0.0.1:${PORT}`);
});
