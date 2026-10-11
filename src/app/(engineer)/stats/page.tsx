import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { StatCard } from "@/components/ui/stat-card";
import { formatAvgDuration } from "@/lib/format";
import {
  computeMetrics,
  type MetricEvent,
  type MetricRoom,
  type Ratio,
} from "@/lib/metrics";

export const metadata: Metadata = {
  title: "통계 | 봐드림",
};

const PERIODS = [
  { key: "7", label: "7일", days: 7 },
  { key: "30", label: "30일", days: 30 },
  { key: "all", label: "전체", days: null },
] as const;

// Supabase는 한 번에 최대 1000줄까지 준다 — 나눠 받는다. MAX_PAGES쪽까지 다 차면 거기서 멈추고 잘렸다고 알린다
const PAGE = 1000;
const MAX_PAGES = 50;
// 이벤트는 내 방 id로 좁혀 받는다. 주소가 너무 길어지지 않게 100개씩, 한 번에 4묶음까지
const ROOM_CHUNK = 100;
const PARALLEL = 4;
// 지표(metrics.ts)에 쓰는 이벤트만 받는다 — room_created·kakao_sent·도구 기록 등은 세지 않는다
const METRIC_EVENTS = ["link_opened", "camera_granted", "connected", "relay_used", "pointer_used", "freeze_used", "ended"];

async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, (i + 1) * PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) rows.push(r);
    if (!data || data.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function percent(r: Ratio) {
  return r.of === 0 ? "—" : `${Math.round((r.hit / r.of) * 100)}%`;
}

// 핵심 지표 화면 (DATA-06). 내 세션만 센다(RLS)
export default async function StatsPage({ searchParams }: PageProps<"/stats">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { period: raw } = await searchParams;
  const picked = PERIODS.find((p) => p.key === raw);
  // 로그인 뒤 고른 기간 그대로 돌아오게 (AUTH-04)
  if (!user) redirect(`/login?next=${encodeURIComponent(picked ? `/stats?period=${picked.key}` : "/stats")}`);

  const period = picked ?? PERIODS[1];
  const since = period.days ? daysAgo(period.days) : null;

  // 기간 안에 만든 상담을 먼저 받고, 그 상담들의 이벤트만 받는다 (이벤트가 언제 남았는지는 보지 않는다)
  const rooms = await fetchAll<MetricRoom>((from, to) => {
    let q = supabase.from("rooms").select("id, resolved_remotely");
    if (since) q = q.gte("created_at", since);
    return q.order("created_at", { ascending: false }).range(from, to);
  });
  const ids = rooms.rows.map((r) => r.id);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += ROOM_CHUNK) chunks.push(ids.slice(i, i + ROOM_CHUNK));
  const parts: { rows: MetricEvent[]; truncated: boolean }[] = [];
  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const got = await Promise.all(
      chunks.slice(i, i + PARALLEL).map((chunk) =>
        fetchAll<MetricEvent>((from, to) =>
          supabase
            .from("events")
            .select("room_id, name, props")
            .in("room_id", chunk)
            .in("name", METRIC_EVENTS)
            .order("id", { ascending: true })
            .range(from, to),
        ),
      ),
    );
    parts.push(...got);
  }
  const events = parts.flatMap((p) => p.rows);
  // 어느 쪽이든 끝까지 못 받았으면 숫자가 일부만 센 것이라고 밝힌다
  const truncated = rooms.truncated || parts.some((p) => p.truncated);

  const m = computeMetrics(rooms.rows, events);

  // 2×2 네 칸 (숫자 + 'N건 중 M건')
  const cards: { title: string; value: string; detail: string }[] = [
    {
      title: "카메라 허용",
      value: percent(m.linkToCamera),
      detail: `링크를 연 ${m.linkToCamera.of}건 중 ${m.linkToCamera.hit}건`,
    },
    {
      title: "연결 실패율(추정)",
      value: percent(m.connectFailure),
      detail: `카메라를 켠 ${m.connectFailure.of}건 중 ${m.connectFailure.hit}건`,
    },
    {
      title: "TURN 중계",
      value: percent(m.relay),
      detail: `연결된 ${m.relay.of}건 중 ${m.relay.hit}건`,
    },
    {
      title: "상담당 평균",
      value: m.avgDurationSec === null ? "—" : formatAvgDuration(m.avgDurationSec),
      detail: `연결된 뒤 끝낸 ${m.durationCount}건 기준`,
    },
  ];

  // 숫자를 읽을 때 주의할 점 — 카드마다 붙이면 글이 많아져 맨 아래에 모아 접어 둔다
  const notes: [string, string][] = [
    ["카메라 허용", "링크를 연 상담 가운데 고객님이 카메라를 켠 비율이에요."],
    ["연결 실패율", "연결 준비를 안 눌렀거나 고객님이 기다리다 나간 경우까지 들어가서 실제보다 높게 나와요."],
    ["TURN 중계", "비용을 따질 때 보는 숫자예요. 5G끼리처럼 바로 연결이 안 되면 중계 서버를 거쳐요."],
    ["상담당 평균", "고객님과 연결됐던 상담만 셌어요. 통화 시간이 아니라 상담을 만든 때부터 쟀어요."],
  ];

  return (
    <div className="flex min-h-dvh flex-col bg-bg-muted">
      <main className="mx-auto flex w-full max-w-md flex-col px-5 pt-[max(8px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
        <header className="flex min-h-14 items-center">
          <Link
            href="/dashboard"
            className="-ml-2 flex h-touch items-center gap-0.5 rounded-xl pr-3 pl-1 text-label-m text-text-secondary active:bg-border"
          >
            <ChevronLeftIcon className="size-6" />
            상담 목록
          </Link>
        </header>

        <div className="flex flex-col gap-1 pt-3 pb-5">
          <h1 className="text-title-l">통계</h1>
          <p className="text-body-m text-text-secondary">
            {period.days ? `최근 ${period.days}일` : "전체 기간"} · 상담 {m.sessions}건
          </p>
          {truncated && (
            <p data-testid="stats-truncated" className="text-body-s text-text-secondary">
              기록이 많아 일부만 셌어요
            </p>
          )}
        </div>

        {/* 기간 고르기. 선택 상태는 중립색(파랑은 '지금 누를 것'에만) — 고른 칸이 진한 회색 */}
        <nav aria-label="기간" className="mb-3 grid grid-cols-3 gap-1 rounded-2xl bg-bg-page p-1">
          {PERIODS.map((p) => (
            <Link
              key={p.key}
              href={`/stats?period=${p.key}`}
              aria-current={p.key === period.key ? "page" : undefined}
              className={`flex h-touch items-center justify-center rounded-xl text-label-m ${
                p.key === period.key ? "bg-text-primary text-on-primary" : "text-text-secondary active:bg-bg-muted"
              }`}
            >
              {p.label}
            </Link>
          ))}
        </nav>

        {m.sessions === 0 ? (
          <p className="rounded-3xl bg-bg-page py-12 text-center text-body-m text-text-secondary">
            이 기간에 만든 상담이 없어요.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <ul data-testid="stats-cards" className="grid grid-cols-2 gap-3">
              {cards.map((c) => (
                <li key={c.title} className="contents">
                  <StatCard label={c.title} value={c.value} sub={c.detail} />
                </li>
              ))}
            </ul>

            <section className="rounded-3xl bg-bg-page p-5">
              <h2 className="text-label-m text-text-secondary">도구 사용</h2>
              <div className="mt-3 grid grid-cols-2">
                <p className="flex flex-col">
                  <span className="text-body-s text-text-secondary">레이저 포인터</span>
                  <span className="text-title-m">{percent(m.pointerUsed)}</span>
                </p>
                <p className="flex flex-col">
                  <span className="text-body-s text-text-secondary">화면 멈춤</span>
                  <span className="text-title-m">{percent(m.freezeUsed)}</span>
                </p>
              </div>
              <p className="mt-2 text-body-s text-text-secondary">연결된 {m.pointerUsed.of}건 기준</p>
            </section>

            <details className="group rounded-3xl bg-bg-page px-5">
              <summary className="flex min-h-button-l cursor-pointer list-none items-center justify-between text-label-m text-text-secondary">
                이렇게 셌어요
                <ChevronLeftIcon className="size-5 -rotate-90 text-icon-secondary transition-transform group-open:rotate-90" />
              </summary>
              <dl className="flex flex-col gap-3 pb-5">
                {notes.map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-label-m text-text-primary">{k}</dt>
                    <dd className="text-body-s text-text-secondary">{v}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </div>
        )}
      </main>
    </div>
  );
}
