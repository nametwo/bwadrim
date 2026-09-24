import type { BrowserContext, WebSocketRoute } from "@playwright/test";

// Supabase Realtime 가짜 (브라우저 WebSocket을 Playwright가 가로챔 — 서버 없음).
// 통화 시그널링(src/lib/webrtc/call.ts)이 쓰는 만큼만: phx_join · heartbeat · presence(track) · broadcast(offer/answer/ice/bye).
// 프로토콜: Phoenix vsn 2.0.0 — 텍스트는 JSON 배열 [join_ref, ref, topic, event, payload],
// 사용자 broadcast는 바이너리 (보냄: kind 3 userBroadcastPush / 받음: kind 4 userBroadcast, realtime-js serializer.js).
// 여러 페이지(엔지니어·고객, 다른 컨텍스트여도 됨)의 소켓을 이 허브 하나가 이어 준다.

interface Joined {
  joinRef: string;
  presenceKey: string | null;
  selfBroadcast: boolean;
}

interface Client {
  id: number;
  ws: WebSocketRoute;
  topics: Map<string, Joined>;
}

interface PresenceEntry {
  key: string;
  meta: Record<string, unknown>;
}

const dec = new TextDecoder();

export class RealtimeHub {
  private seq = 0;
  private readonly clients = new Set<Client>();
  /** topic → client → presence */
  private readonly presence = new Map<string, Map<Client, PresenceEntry>>();
  /** 전달한 broadcast (디버깅·검증용) */
  readonly broadcasts: { topic: string; event: string; from: number }[] = [];

  async attach(context: BrowserContext): Promise<void> {
    await context.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => this.connect(ws));
  }

  private connect(ws: WebSocketRoute) {
    const c: Client = { id: ++this.seq, ws, topics: new Map() };
    this.clients.add(c);
    ws.onMessage((m) => {
      try {
        if (typeof m === "string") this.onText(c, m);
        else this.onBinary(c, m);
      } catch (e) {
        console.warn("[realtime-mock] 메시지 처리 실패:", e);
      }
    });
    ws.onClose(() => this.disconnect(c));
  }

  private disconnect(c: Client) {
    if (!this.clients.delete(c)) return;
    for (const topic of c.topics.keys()) this.leave(c, topic);
  }

  private sendJson(c: Client, msg: unknown[]) {
    try {
      c.ws.send(JSON.stringify(msg));
    } catch {
      // 닫힌 소켓
    }
  }

  private reply(c: Client, joinRef: string | null, ref: string | null, topic: string, response: unknown = {}) {
    if (ref == null) return;
    this.sendJson(c, [joinRef, ref, topic, "phx_reply", { status: "ok", response }]);
  }

  private members(topic: string): Client[] {
    return [...this.clients].filter((x) => x.topics.has(topic));
  }

  private presenceState(topic: string) {
    const out: Record<string, { metas: Record<string, unknown>[] }> = {};
    for (const e of this.presence.get(topic)?.values() ?? []) {
      (out[e.key] ??= { metas: [] }).metas.push(e.meta);
    }
    return out;
  }

  private onText(c: Client, raw: string) {
    const [joinRef, ref, topic, event, payload] = JSON.parse(raw) as [string | null, string | null, string, string, Record<string, any>]; // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (event) {
      case "heartbeat":
        this.reply(c, null, ref, topic);
        return;
      case "phx_join": {
        const cfg = payload?.config ?? {};
        c.topics.set(topic, {
          joinRef: joinRef ?? "",
          presenceKey: cfg.presence?.key || null,
          selfBroadcast: !!cfg.broadcast?.self,
        });
        this.reply(c, joinRef, ref, topic, { postgres_changes: [] });
        this.sendJson(c, [joinRef, null, topic, "presence_state", this.presenceState(topic)]);
        return;
      }
      case "phx_leave":
        this.leave(c, topic);
        this.reply(c, joinRef, ref, topic);
        return;
      case "presence": {
        const j = c.topics.get(topic);
        this.reply(c, joinRef, ref, topic);
        if (!j) return;
        if (payload?.event === "track") {
          const key = j.presenceKey ?? `anon-${c.id}`;
          const meta = { ...(payload.payload ?? {}), phx_ref: `p${++this.seq}` };
          const map = this.presence.get(topic) ?? new Map<Client, PresenceEntry>();
          this.presence.set(topic, map);
          const prev = map.get(c);
          map.set(c, { key, meta });
          const diff = {
            joins: { [key]: { metas: [meta] } },
            leaves: prev ? { [prev.key]: { metas: [prev.meta] } } : {},
          };
          for (const m of this.members(topic)) this.sendJson(m, [m.topics.get(topic)!.joinRef, null, topic, "presence_diff", diff]);
        } else if (payload?.event === "untrack") {
          this.untrack(c, topic);
        }
        return;
      }
      case "broadcast": {
        // JSON broadcast (바이너리가 아닌 경로) — 다른 구성원에게 그대로
        this.reply(c, joinRef, ref, topic);
        for (const m of this.members(topic)) {
          if (m === c && !c.topics.get(topic)?.selfBroadcast) continue;
          this.sendJson(m, [null, null, topic, "broadcast", payload]);
        }
        return;
      }
      default:
        // access_token 등 — 받았다고만
        this.reply(c, joinRef, ref, topic);
    }
  }

  private untrack(c: Client, topic: string) {
    const map = this.presence.get(topic);
    const prev = map?.get(c);
    if (!map || !prev) return;
    map.delete(c);
    const diff = { joins: {}, leaves: { [prev.key]: { metas: [prev.meta] } } };
    for (const m of this.members(topic)) {
      if (m === c) continue;
      this.sendJson(m, [m.topics.get(topic)!.joinRef, null, topic, "presence_diff", diff]);
    }
  }

  private leave(c: Client, topic: string) {
    this.untrack(c, topic);
    c.topics.delete(topic);
  }

  /** kind 3 (userBroadcastPush) → kind 4 (userBroadcast)로 바꿔 다른 구성원에게 */
  private onBinary(c: Client, buf: Buffer) {
    const b = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (b[0] !== 3) return;
    const joinRefLen = b[1];
    const refLen = b[2];
    const topicLen = b[3];
    const eventLen = b[4];
    const metaLen = b[5];
    const encoding = b[6];
    let o = 7;
    const take = (n: number) => {
      const s = b.subarray(o, o + n);
      o += n;
      return s;
    };
    const joinRef = dec.decode(take(joinRefLen));
    const ref = dec.decode(take(refLen));
    const topicBytes = take(topicLen);
    const topic = dec.decode(topicBytes);
    const eventBytes = take(eventLen);
    const metaBytes = take(metaLen);
    const payload = b.subarray(o);
    this.broadcasts.push({ topic, event: dec.decode(eventBytes), from: c.id });
    if (ref) this.reply(c, joinRef || null, ref, topic);

    const out = new Uint8Array(5 + topicLen + eventLen + metaLen + payload.length);
    out[0] = 4;
    out[1] = topicLen;
    out[2] = eventLen;
    out[3] = metaLen;
    out[4] = encoding;
    let p = 5;
    for (const part of [topicBytes, eventBytes, metaBytes, payload]) {
      out.set(part, p);
      p += part.length;
    }
    const msg = Buffer.from(out);
    for (const m of this.members(topic)) {
      if (m === c && !c.topics.get(topic)?.selfBroadcast) continue;
      try {
        m.ws.send(msg);
      } catch {
        // 닫힌 소켓
      }
    }
  }
}

/** 한 줄 요약용 */
export function describeHub(h: RealtimeHub): string {
  const counts: Record<string, number> = {};
  for (const b of h.broadcasts) counts[b.event] = (counts[b.event] ?? 0) + 1;
  return JSON.stringify(counts);
}

