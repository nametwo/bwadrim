import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { notify } from "@/lib/alerts";
import { errorText } from "@/lib/alert-rules";
import {
  computeDigest,
  kstDayRange,
  digestLines,
  digestNeedsAlert,
  type DigestEvent,
  type DigestReport,
  type DigestRoom,
} from "@/lib/ops-digest";

// 하루 운영 요약 (OPS-07). Vercel Cron이 매일 00:00 UTC(= 오전 9시 한국)에 부른다 — vercel.json.
// 전날(한국 시간 0시~24시)에 만든 상담을 세어 평소 채널에 보내고, 기준을 넘으면 응급 채널에도 한 줄.
// Vercel은 CRON_SECRET이 있으면 Authorization: Bearer <값>을 붙여 부른다. 없으면 아무도 못 부른다.
// 손으로 다시 보내기: curl -H "Authorization: Bearer $CRON_SECRET" "<주소>/api/cron/digest?date=2026-09-27"

export const dynamic = "force-dynamic";

const IN_CHUNK = 50;
// Supabase는 한 번에 1000줄까지만 준다 — 끝까지 나눠 받는다
const PAGE = 1000;
const MAX_PAGES = 50;

async function inChunks<T>(
  ids: string[],
  load: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    for (let p = 0; p < MAX_PAGES; p++) {
      const { data, error } = await load(chunk, p * PAGE, (p + 1) * PAGE - 1);
      if (error) throw error;
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "CRON_SECRET 미설정" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const range = kstDayRange(new URL(request.url).searchParams.get("date"));
  if (!range) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });

  try {
    const admin = createAdminClient();
    const { data: rooms, error } = await admin
      .from("rooms")
      .select("id, resolved_remotely")
      .gte("created_at", range.start.toISOString())
      .lt("created_at", range.end.toISOString())
      .order("created_at", { ascending: true })
      .limit(1000);
    if (error) throw error;
    const ids = (rooms ?? []).map((r) => r.id as string);

    const [events, reports] = await Promise.all([
      inChunks<DigestEvent>(ids, (chunk, from, to) =>
        admin
          .from("events")
          .select("room_id, actor, name, props, created_at")
          .in("room_id", chunk)
          .order("id", { ascending: true })
          .range(from, to),
      ),
      inChunks<DigestReport>(ids, (chunk, from, to) =>
        admin
          .from("call_reports")
          .select("room_id, actor, report")
          .in("room_id", chunk)
          .order("room_id", { ascending: true })
          .order("pid", { ascending: true })
          .range(from, to),
      ),
    ]);

    const digest = computeDigest((rooms ?? []) as DigestRoom[], events, reports);
    const { lines, fields } = digestLines(digest);
    await notify("info", { title: `하루 요약 · ${range.label}`, lines, fields });

    const warn = digestNeedsAlert(digest);
    if (warn.length) {
      // 같은 날짜는 하루에 한 번만 (손으로 다시 보내도 응급 채널엔 다시 안 간다)
      await notify("alert", {
        title: `${range.label} 확인이 필요해요`,
        lines: [...warn, "평소 채널의 하루 요약을 봐 주세요."],
        key: `digest-warn-${range.label}`,
        cooldownSec: 86400,
      });
    }
    return NextResponse.json({ date: range.label, digest });
  } catch (e) {
    console.error("[digest] 실패:", e);
    await notify("alert", { title: "하루 요약을 만들지 못했어요", lines: [errorText(e)], key: "digest-fail", cooldownSec: 3600 });
    return NextResponse.json({ error: "digest failed" }, { status: 500 });
  }
}
