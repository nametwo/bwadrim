// 핵심 지표 계산 (DATA-02, DATA-06). 이벤트 개수가 아니라 세션 단위로 센다.
// 입력은 엔지니어 자신의 세션·이벤트(RLS가 걸러 준다).

export interface MetricRoom {
  id: string;
  // 예전 '출장 없이 해결?' 답(이제 쓰지 않는 칸). 예전 상담이 연결됐었는지 가리는 데만 쓴다(endedConnected)
  resolved_remotely?: boolean | null;
}

export interface MetricEvent {
  room_id: string;
  name: string;
  props: Record<string, unknown> | null;
}

export interface Ratio {
  hit: number; // 분자(세션 수)
  of: number; // 분모(세션 수)
}

export interface Metrics {
  sessions: number;
  linkToCamera: Ratio; // 링크 연 세션 중 카메라 허용
  connectFailure: Ratio; // 카메라 허용한 세션 중 고객 폰이 연결 실패를 알려 왔고 끝내 연결되지 않은 세션 (connect_failed, 2026-10-23부터)
  notConnected: number; // 카메라 허용했지만 연결도 실패 기록도 없는 세션 (연결 준비를 안 눌렀거나 기다리다 나감. 2026-10-23 전의 실패도 여기 들어간다)
  relay: Ratio; // 연결된 세션 중 TURN 경유
  pointerUsed: Ratio; // 연결된 세션 중 레이저 포인터 사용
  freezeUsed: Ratio; // 연결된 세션 중 화면 멈춤 사용
  avgDurationSec: number | null; // 연결됐다 끝난 세션의 세션 시간 평균(만든 때부터)
  durationCount: number;
}

/**
 * 끝난 상담이 고객과 연결된 적 있었는지. 표시(대시보드 칩·끝난 상담 화면)와 평균 시간이 같은 판정을 쓴다.
 * - `ended` 이벤트의 `props.connected === true` (지금 기록)
 * - 예전 기록: `props.resolved_remotely`가 true/false (해결 여부를 답했다 = 연결됐었다. null은 연결 없이 닫음)
 * - 예전 기록: `rooms.resolved_remotely`가 true/false (두 번째 인자. 이벤트 기록이 빠졌어도 방에 답이 남아 있으면)
 * `rooms.resolved_remotely`는 이제 쓰지 않는 칸이라 새 상담은 늘 null이다.
 */
export function endedConnected(
  props: Record<string, unknown> | null | undefined,
  roomResolvedRemotely?: boolean | null,
): boolean {
  if (typeof roomResolvedRemotely === "boolean") return true;
  if (!props) return false;
  return props.connected === true || typeof props.resolved_remotely === "boolean";
}

export function computeMetrics(
  rooms: MetricRoom[],
  events: MetricEvent[],
): Metrics {
  const ids = new Set(rooms.map((r) => r.id));
  const roomAnswer = new Map(rooms.map((r) => [r.id, r.resolved_remotely]));
  // 이벤트 이름별로, 그 이벤트가 한 번이라도 있는 세션
  const withEvent = new Map<string, Set<string>>();
  // 세션마다 시간 하나. 연결 없이 닫은 세션은 빼야 평균이 부풀지 않는다
  const durations = new Map<string, number>();
  // 연결하던 중 실패한 세션. 통화 중 끊김(stage: 'call')은 연결 실패가 아니다
  const failedToConnect = new Set<string>();
  for (const e of events) {
    if (!ids.has(e.room_id)) continue;
    if (e.name === "connect_failed" && e.props?.stage !== "call") failedToConnect.add(e.room_id);
    let set = withEvent.get(e.name);
    if (!set) withEvent.set(e.name, (set = new Set()));
    set.add(e.room_id);
    if (e.name === "ended" && !durations.has(e.room_id)) {
      const d = e.props?.duration_sec;
      if (typeof d === "number" && endedConnected(e.props, roomAnswer.get(e.room_id))) {
        durations.set(e.room_id, d);
      }
    }
  }
  const has = (name: string) => withEvent.get(name) ?? new Set<string>();
  const both = (a: Set<string>, b: Set<string>) =>
    [...a].filter((id) => b.has(id)).length;

  const opened = has("link_opened");
  const granted = has("camera_granted");
  const connected = has("connected");
  const times = [...durations.values()];

  return {
    sessions: rooms.length,
    linkToCamera: { hit: both(opened, granted), of: opened.size },
    connectFailure: {
      hit: [...granted].filter((id) => failedToConnect.has(id) && !connected.has(id)).length,
      of: granted.size,
    },
    notConnected: [...granted].filter((id) => !connected.has(id) && !failedToConnect.has(id)).length,
    relay: { hit: both(connected, has("relay_used")), of: connected.size },
    pointerUsed: { hit: both(connected, has("pointer_used")), of: connected.size },
    freezeUsed: { hit: both(connected, has("freeze_used")), of: connected.size },
    avgDurationSec: times.length
      ? times.reduce((a, b) => a + b, 0) / times.length
      : null,
    durationCount: times.length,
  };
}
