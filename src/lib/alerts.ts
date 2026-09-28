import { createAdminClient } from "./supabase/admin";
import { redactText } from "./redact";

// 운영 알림 (OPS-06). 디스코드 웹훅 두 개 — 서버 전용(웹훅 주소는 비밀값).
//   info  (DISCORD_WEBHOOK_INFO)  평소 알림: 연결 실패 한 건, TURN 없이 진행, 화면 오류, 하루 요약. 채널 알림은 꺼 둔다
//   alert (DISCORD_WEBHOOK_ALERT) 응급 알림: 설정이 깨져 모든 상담이 영향받거나 실패가 몰릴 때
// 운영 배포(VERCEL_ENV=production)에서만 보낸다. 로컬·Preview는 콘솔에만 (ALERTS_ENABLED=1이면 어디서든 보냄).
// 같은 알림은 key마다 cooldown 동안 한 번만 — 서버리스는 인스턴스가 여럿이라 DB(claim_alert)로 막는다.

export type AlertLevel = "info" | "alert";

export interface AlertMessage {
  title: string;
  lines?: string[];
  fields?: { name: string; value: string; inline?: boolean }[];
  // 같은 key는 cooldownSec 안에 다시 보내지 않는다. 없으면 매번 보낸다
  key?: string;
  cooldownSec?: number;
}

const COLORS: Record<AlertLevel, number> = { info: 0x3b82f6, alert: 0xef4444 };

export function appEnv(): string {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
}

export function appVersion(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
}

function enabled() {
  return appEnv() === "production" || process.env.ALERTS_ENABLED === "1";
}

function webhookUrl(level: AlertLevel) {
  const raw = level === "alert" ? process.env.DISCORD_WEBHOOK_ALERT : process.env.DISCORD_WEBHOOK_INFO;
  return raw?.trim() || null;
}

// 운영 주소. 알림에서 상담 화면으로 바로 가게 (방 주인만 열린다)
export function siteUrl(): string | null {
  const host = process.env.NEXT_PUBLIC_SITE_URL?.trim() || process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!host) return null;
  return host.startsWith("http") ? host.replace(/\/$/, "") : `https://${host}`;
}

export function roomLink(roomId: string | null | undefined): string {
  if (!roomId) return "상담 없음";
  const base = siteUrl();
  return base ? `[${roomId.slice(0, 8)}](${base}/room/${roomId})` : roomId.slice(0, 8);
}

// DB가 안 될 때를 위한 인스턴스 안 쿨다운 (claim_alert를 못 부르면 이것만으로 막는다)
const localSent = new Map<string, number>();

async function claim(key: string, cooldownSec: number): Promise<boolean> {
  const now = Date.now();
  const last = localSent.get(key);
  if (last !== undefined && now - last < cooldownSec * 1000) return false;
  localSent.set(key, now);
  try {
    const { data, error } = await createAdminClient().rpc("claim_alert", {
      p_key: key,
      p_cooldown_sec: cooldownSec,
    });
    if (error) throw error;
    return data === true;
  } catch (e) {
    // 함수가 아직 없거나(OPS-04 전) DB 장애 — 알림은 보내되 인스턴스 쿨다운만 적용
    console.warn("[alerts] claim_alert 실패, 인스턴스 쿨다운만 적용:", e);
    return true;
  }
}

function clip(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// 디스코드 embed 한도(제목 256, 본문 4096, 필드 25개·값 1024) 안으로 맞춘다
export function discordPayload(level: AlertLevel, msg: AlertMessage) {
  const env = appEnv();
  const prefix = env === "production" ? "" : `[${env}] `;
  return {
    username: level === "alert" ? "봐드림 응급" : "봐드림",
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: clip(prefix + redactText(msg.title, 250), 256),
        description: msg.lines?.length ? clip(msg.lines.map((l) => redactText(l, 1000)).join("\n"), 4000) : undefined,
        color: COLORS[level],
        fields: msg.fields?.slice(0, 25).map((f) => ({
          name: clip(redactText(f.name, 250), 256),
          value: clip(redactText(f.value, 1000) || "—", 1024),
          inline: f.inline ?? true,
        })),
        footer: { text: `v ${appVersion()}` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// 알림 보내기. 실패해도 던지지 않는다 — 알림 때문에 기능이 멈추면 안 된다
export async function notify(level: AlertLevel, msg: AlertMessage): Promise<void> {
  try {
    if (!enabled()) {
      console.info(`[alerts:${level}] ${msg.title}`, msg.lines ?? "");
      return;
    }
    const url = webhookUrl(level);
    if (!url) {
      console.warn(`[alerts] ${level} 웹훅 주소가 없어 보내지 않음: ${msg.title}`);
      return;
    }
    if (msg.key && !(await claim(`${level}:${msg.key}`, msg.cooldownSec ?? 600))) return;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordPayload(level, msg)),
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(`[alerts] 디스코드 ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  } catch (e) {
    console.error("[alerts] 보내기 실패:", e);
  }
}
