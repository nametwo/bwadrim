// 핵심 지표 계산 (DATA-02, DATA-06). 이벤트 개수가 아니라 세션 단위로 센다.
// 입력은 엔지니어 자신의 세션·이벤트(RLS가 걸러 준다).

export interface MetricRoom {
  id: string;
  resolved_remotely: boolean | null;
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
  resolvedRemotely: Ratio; // 답한 세션 중 '네'
  linkToCamera: Ratio; // 링크 연 세션 중 카메라 허용
  connectFailure: Ratio; // 카메라 허용한 세션 중 연결 기록이 없는 세션 (추정치)
  relay: Ratio; // 연결된 세션 중 TURN 경유
  pointerUsed: Ratio; // 연결된 세션 중 레이저 포인터 사용
  freezeUsed: Ratio; // 연결된 세션 중 화면 멈춤 사용
  avgDurationSec: number | null; // 답한 세션의 세션 시간 평균(만든 때부터)
  durationCount: number;
}

export function computeMetrics(
  rooms: MetricRoom[],
  events: MetricEvent[],
): Metrics {
  const ids = new Set(rooms.map((r) => r.id));
  // 이벤트 이름별로, 그 이벤트가 한 번이라도 있는 세션
  const withEvent = new Map<string, Set<string>>();
  const durations: number[] = [];
  for (const e of events) {
    if (!ids.has(e.room_id)) continue;
    let set = withEvent.get(e.name);
    if (!set) withEvent.set(e.name, (set = new Set()));
    set.add(e.room_id);
    if (e.name === "ended") {
      const d = e.props?.duration_sec;
      // 연결 없이 닫은 세션(resolved_remotely null)은 빼야 평균이 부풀지 않는다
      if (typeof d === "number" && e.props?.resolved_remotely != null) {
        durations.push(d);
      }
    }
  }
  const has = (name: string) => withEvent.get(name) ?? new Set<string>();
  const both = (a: Set<string>, b: Set<string>) =>
    [...a].filter((id) => b.has(id)).length;

  const answered = rooms.filter((r) => r.resolved_remotely !== null);
  const opened = has("link_opened");
  const granted = has("camera_granted");
  const connected = has("connected");

  return {
    sessions: rooms.length,
    resolvedRemotely: {
      hit: answered.filter((r) => r.resolved_remotely === true).length,
      of: answered.length,
    },
    linkToCamera: { hit: both(opened, granted), of: opened.size },
    connectFailure: {
      hit: [...granted].filter((id) => !connected.has(id)).length,
      of: granted.size,
    },
    relay: { hit: both(connected, has("relay_used")), of: connected.size },
    pointerUsed: { hit: both(connected, has("pointer_used")), of: connected.size },
    freezeUsed: { hit: both(connected, has("freeze_used")), of: connected.size },
    avgDurationSec: durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null,
    durationCount: durations.length,
  };
}
