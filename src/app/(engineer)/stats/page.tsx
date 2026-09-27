import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ChevronLeftIcon } from "@/components/ui/icons";
import {
  computeMetrics,
  type MetricEvent,
  type MetricRoom,
  type Ratio,
} from "@/lib/metrics";

export const metadata: Metadata = {
  title: "통계 — 봐드림",
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

  const cards: { title: string; value: string; detail: string; note?: string }[] = [
    {
      title: "원격 해결률",
      value: percent(m.resolvedRemotely),
      detail: `답한 ${m.resolvedRemotely.of}건 중 ${m.resolvedRemotely.hit}건 출장 없이 해결`,
      note: "연결 없이 닫았거나 답하지 않은 상담은 빼고 셉니다",
    },
    {
      title: "링크 → 카메라 허용",
      value: percent(m.linkToCamera),
      detail: `링크를 연 ${m.linkToCamera.of}건 중 ${m.linkToCamera.hit}건`,
    },
    {
      title: "연결 실패율 (추정)",
      value: percent(m.connectFailure),
      detail: `카메라를 켠 ${m.connectFailure.of}건 중 ${m.connectFailure.hit}건 연결 기록 없음`,
      note: "연결 준비를 안 눌렀거나 고객이 기다리다 나간 경우도 포함돼 실제보다 높게 나옵니다",
    },
    {
      title: "TURN 중계 비율",
      value: percent(m.relay),
      detail: `연결된 ${m.relay.of}건 중 ${m.relay.hit}건 중계 서버 경유`,
      note: "비용 계산 근거. 5G끼리 등 직접 연결이 안 될 때 중계합니다",
    },
    {
      title: "상담당 평균 시간",
      value: m.avgDurationSec === null ? "—" : minutes(m.avgDurationSec),
      detail: `답한 ${m.durationCount}건 기준`,
      note: "통화 시간이 아니라 상담을 만든 때부터 잽니다",
    },
    {
      title: "도구 사용",
      value: `포인터 ${percent(m.pointerUsed)} · 멈춤 ${percent(m.freezeUsed)}`,
      detail: `연결된 ${m.pointerUsed.of}건 기준`,
    },
  ];

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 pt-[max(8px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      <header className="flex min-h-14 items-center">
        <Link
          href="/dashboard"
          className="-ml-2 flex h-touch items-center gap-0.5 rounded-xl pr-3 pl-1 text-body-m text-text-secondary active:bg-bg-muted"
        >
          <ChevronLeftIcon className="size-6" />
          상담 목록
        </Link>
      </header>

      <div className="flex flex-col gap-1">
        <h1 className="text-title-l">통계</h1>
        <p className="text-body-m text-text-secondary">
          {period.days ? `최근 ${period.days}일` : "전체 기간"}에 만든 상담 {m.sessions}건
        </p>
      </div>

      {/* 기간 고르기. 선택 상태는 중립색(파랑은 '지금 누를 것'에만) */}
      <nav aria-label="기간" className="grid grid-cols-3 gap-1 rounded-2xl bg-bg-muted p-1">
        {PERIODS.map((p) => (
          <Link
            key={p.key}
            href={`/stats?period=${p.key}`}
            aria-current={p.key === period.key ? "page" : undefined}
            className={`flex h-11 items-center justify-center rounded-xl text-label-m ${
              p.key === period.key
                ? "bg-bg-page text-text-primary shadow-card"
                : "text-text-secondary"
            }`}
          >
            {p.label}
          </Link>
        ))}
      </nav>

      {m.sessions === 0 ? (
        <p className="rounded-2xl bg-bg-subtle py-12 text-center text-body-m text-text-secondary">
          이 기간에 만든 상담이 없어요.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {cards.map((c, i) => (
            <li
              key={c.title}
              className={`rounded-2xl p-4 ${i === 0 ? "bg-success-tint" : "bg-bg-subtle"}`}
            >
              <p className="text-label-m text-text-secondary">{c.title}</p>
              <p className={`mt-1 text-display-l ${i === 0 ? "text-text-success" : "text-text-primary"}`}>
                {c.value}
              </p>
              <p className="mt-1 text-body-m text-text-secondary">{c.detail}</p>
              {c.note && <p className="mt-1 text-body-s text-text-tertiary">{c.note}</p>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
