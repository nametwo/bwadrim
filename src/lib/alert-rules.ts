import { createAdminClient } from "./supabase/admin";
import { notify, roomLink } from "./alerts";

// 어떤 기록이 어느 채널로 가는지 (OPS-06). 규칙을 바꾸면 요구사항 OPS-06 표도 같이 고칠 것.
//   응급(alert): 모든 상담이 영향받는 설정 오류, 실패가 몰림
//   평소(info): 실패 한 건 한 건 — 채널 알림은 꺼 두고 필요할 때 훑어본다
// 로컬·Preview 기록(env ≠ production)은 알리지 않는다.

type Props = Record<string, unknown>;

// TURN 발급이 설정 문제로 막힘 — 키가 없거나 Cloudflare가 키를 거부. 모든 상담이 STUN만으로 간다
function isTurnConfigError(p: Props) {
  return p.reason === "env_missing" || [401, 403, 404].includes(Number(p.status));
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

// 최근 windowMin분 동안 운영 기록이 몇 개인지 (distinctRooms면 상담 수, keep으로 더 거른다)
async function recentCount(
  name: string,
  windowMin: number,
  distinctRooms = false,
  keep: (p: Props) => boolean = () => true,
): Promise<number> {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString();
  const { data, error } = await createAdminClient()
    .from("events")
    .select("room_id, props")
    .eq("name", name)
    .eq("props->>env", "production")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error || !data) return 0;
  const rows = data.filter((r) => keep((r.props as Props | null) ?? {}));
  return distinctRooms ? new Set(rows.map((r) => r.room_id)).size : rows.length;
}

// 폰에서 온 글자는 디스코드 마크다운·링크로 해석되지 않게 막는다 (알림 채널을 꾸며 낸 글로 속이지 못하게)
export function escapeMd(s: string): string {
  return s.replace(/[\\*_~`|>\[\]()#-]/g, "\\$&").replace(/:\/\//g, ":\u200b//").replace(/@/g, "@\u200b");
}

function str(v: unknown) {
  return v === undefined || v === null || v === "" ? "—" : escapeMd(String(v));
}

export async function alertOnEvent(roomId: string | null, actor: string, name: string, p: Props) {
  if (p.env !== "production" && process.env.ALERTS_ENABLED !== "1") return;
  try {
    if (name === "turn_fallback") {
      const config = isTurnConfigError(p);
      await notify(config ? "alert" : "info", {
        title: config ? "TURN 설정 오류: 모든 상담이 중계 없이 연결돼요" : "TURN 없이 연결을 시작했어요",
        lines: [
          `원인: ${str(p.reason)}${p.status ? ` (HTTP ${p.status})` : ""}`,
          `누구: ${str(p.who)} · 상담: ${roomLink(roomId)}`,
          config ? "Cloudflare TURN 키(OPS-01)를 확인해 주세요. 모바일망끼리는 연결이 실패해요." : "",
        ].filter(Boolean),
        key: config ? "turn-config" : `turn-${str(p.reason)}`,
        cooldownSec: config ? 1800 : 600,
      });
      if (!config && (await recentCount("turn_fallback", 30)) >= 3) {
        await notify("alert", {
          title: "TURN 발급 실패가 30분에 3번 이상 났어요",
          lines: [`마지막 원인: ${str(p.reason)}${p.status ? ` (HTTP ${p.status})` : ""}`, "Cloudflare 상태를 확인해 주세요."],
          key: "turn-burst",
          cooldownSec: 3600,
        });
      }
      return;
    }

    if (name === "call_failed") {
      // 끝난 상담에 들어온 경우(room_gone)는 네트워크 실패가 아니다 — 평소 채널에만
      await notify("info", {
        title: `연결 실패 · ${str(p.stage)}`,
        fields: [
          { name: "상담", value: roomLink(roomId) },
          { name: "누구", value: actor },
          { name: "원인", value: str(p.reason) },
          { name: "TURN", value: p.turn === false ? `없음 (${str(p.turn_err)})` : "있음" },
          { name: "통화 중이었나", value: p.after_connected ? "예" : "아니오" },
          ...(p.err ? [{ name: "오류", value: str(p.err), inline: false }] : []),
        ],
        key: `failed-${roomId}-${str(p.stage)}-${actor}`,
        cooldownSec: 300,
      });
      if (p.stage !== "room_gone" && (await recentCount("call_failed", 60, true, (q) => q.stage !== "room_gone")) >= 3) {
        await notify("alert", {
          title: "1시간 안에 상담 3건 이상 연결이 실패했어요",
          lines: [`마지막: ${str(p.stage)} · ${str(p.reason)} · ${roomLink(roomId)}`, "평소 채널에서 실패 내역을 확인해 주세요."],
          key: "failed-burst",
          cooldownSec: 3600,
        });
      }
      return;
    }

    if (name === "client_error") {
      const sig = `${str(p.kind)}:${str(p.name)}:${str(p.msg).slice(0, 80)}`;
      await notify("info", {
        title: `화면 오류 · ${str(p.kind)}`,
        fields: [
          { name: "상담", value: roomLink(roomId) },
          { name: "누구", value: actor },
          { name: "오류", value: `${str(p.name)}: ${str(p.msg)}`, inline: false },
          ...(p.src ? [{ name: "위치", value: str(p.src), inline: false }] : []),
          ...(p.phase ? [{ name: "화면 단계", value: str(p.phase) }] : []),
        ],
        key: `cerr-${sig}`,
        cooldownSec: 3600,
      });
      if ((await recentCount("client_error", 10)) >= 10) {
        await notify("alert", {
          title: "화면 오류가 10분에 10번 이상 났어요",
          lines: [`마지막: ${sig}`, "최근 배포를 확인해 주세요."],
          key: "cerr-burst",
          cooldownSec: 3600,
        });
      }
    }
  } catch (e) {
    console.error("[alerts] 규칙 처리 실패:", e);
  }
}
