import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { StatCard } from "@/components/ui/stat-card";
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

// Supabase는 한 번에 최대 1000줄까지 준다 — 끝까지 나눠 받는다
const PAGE = 1000;
const MAX_PAGES = 50;

async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, (i + 1) * PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function percent(r: Ratio) {
  return r.of === 0 ? "—" : `${Math.round((r.hit / r.of) * 100)}%`;
}

function minutes(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}분 ${s}초` : `${s}초`;
}

// 핵심 지표 화면 (DATA-06). 내 세션만 센다(RLS)
export default async function StatsPage({ searchParams }: PageProps<"/stats">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/stats");

  const { period: raw } = await searchParams;
  const period = PERIODS.find((p) => p.key === raw) ?? PERIODS[1];
  const since = period.days ? daysAgo(period.days) : null;

  const [rooms, events] = await Promise.all([
    fetchAll<MetricRoom>((from, to) => {
      let q = supabase.from("rooms").select("id, resolved_remotely");
      if (since) q = q.gte("created_at", since);
      return q.order("created_at", { ascending: false }).range(from, to);
    }),
    // 기간 안에 만든 세션의 이벤트만 쓰므로, 기간 시작 이후 이벤트만 받아도 된다
    fetchAll<MetricEvent>((from, to) => {
      let q = supabase.from("events").select("room_id, name, props");
      if (since) q = q.gte("created_at", since);
      return q.order("id", { ascending: true }).range(from, to);
    }),
  ]);

  const m = computeMetrics(rooms, events);

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
      value: m.avgDurationSec === null ? "—" : minutes(m.avgDurationSec),
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
        </div>

        {/* 기간 고르기. 선택 상태는 중립색(파랑은 '지금 누를 것'에만) — 고른 칸이 진한 회색 */}
        <nav aria-label="기간" className="mb-3 grid grid-cols-3 gap-1 rounded-2xl bg-bg-page p-1">
          {PERIODS.map((p) => (
            <Link
              key={p.key}
              href={`/stats?period=${p.key}`}
              aria-current={p.key === period.key ? "page" : undefined}
              className={`flex h-11 items-center justify-center rounded-xl text-label-m ${
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
