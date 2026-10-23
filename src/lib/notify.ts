import { after } from "next/server";

// 디스코드 알림 (OPS-09). 채널 두 개 — 응급(urgent)은 지금 봐야 하는 것, 일반(general)은 상담이 흘러가는 모든 단계.
// 웹훅 주소는 환경 변수로만 받는다(코드·문서에 적지 말 것). 비어 있으면 아무것도 보내지 않는다.
// 보내기는 응답을 돌려준 뒤(after)에 한다 — 고객·엔지니어 화면이 디스코드를 기다리지 않게. 실패해도 기능을 막지 않는다.
// 서버 전용: 서버 액션·라우트 핸들러·서버 컴포넌트에서만 부른다

export type NotifyChannel = "urgent" | "general";

const TIMEOUT_MS = 4000;
// 응급은 같은 일(key)을 이 시간 안에 두 번 보내지 않는다. 함수 인스턴스마다 따로 세므로 Vercel에서는 드물게 겹칠 수 있다
const URGENT_DEDUPE_MS = 10 * 60_000;
const recentUrgent = new Map<string, number>();

function webhookUrl(channel: NotifyChannel): string | null {
  const raw = (channel === "urgent" ? process.env.DISCORD_WEBHOOK_URGENT : process.env.DISCORD_WEBHOOK_GENERAL)?.trim();
  return raw && /^https?:\/\//.test(raw) ? raw : null;
}

/** 웹훅이 하나라도 설정돼 있는지. 없으면 상담 정보를 찾는 수고도 하지 않는다 */
export function notifyEnabled(): boolean {
  return webhookUrl("urgent") !== null || webhookUrl("general") !== null;
}

/** 디스코드로 한 줄 보낸다. 실패해도 던지지 않는다. 웹훅이 없거나 실패하면 false */
export async function sendDiscord(channel: NotifyChannel, content: string): Promise<boolean> {
  const url = webhookUrl(channel);
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 디스코드 한 메시지는 2000자까지. 멘션은 풀지 않는다(기록에 @everyone 같은 글자가 섞여도 알림이 울리지 않게)
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[notify] 디스코드 ${channel} 응답 ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[notify] 디스코드 ${channel} 보내기 실패:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** 응답을 보낸 뒤에 돌린다(after). 요청 밖(단위 테스트 등)이면 바로 돌린다 */
export function schedule(fn: () => Promise<unknown>): void {
  try {
    after(fn);
  } catch {
    void fn().catch(() => {});
  }
}

/** 같은 응급(key)을 10분 안에 또 보낼지. 보내기로 했으면 그 시각을 기억한다 */
export function shouldSendUrgent(key: string, now = Date.now()): boolean {
  const last = recentUrgent.get(key);
  if (last !== undefined && now - last < URGENT_DEDUPE_MS) return false;
  recentUrgent.set(key, now);
  if (recentUrgent.size > 200) {
    for (const [k, t] of recentUrgent) if (now - t >= URGENT_DEDUPE_MS) recentUrgent.delete(k);
  }
  return true;
}

/** 일반 채널로 한 줄 (응답 뒤에) */
export function notifyGeneral(content: string): void {
  if (!webhookUrl("general")) return;
  schedule(() => sendDiscord("general", content));
}

/** 응급 채널로 한 줄 (응답 뒤에). 같은 key는 10분에 한 번 */
export function notifyUrgent(key: string, content: string): void {
  if (!webhookUrl("urgent")) return;
  if (!shouldSendUrgent(key)) return;
  schedule(() => sendDiscord("urgent", content));
}

/** 테스트용: 응급 중복 기억을 지운다 */
export function resetNotifyForTests(): void {
  recentUrgent.clear();
}
