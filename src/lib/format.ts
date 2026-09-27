// 화면에 보이는 시각·시간 글자. 항상 한국 시간(Asia/Seoul)으로 (BUG-06).
// Intl의 한국어 형식은 서버 ICU에 따라 'PM 05:00'처럼 섞여 나올 수 있어 숫자만 받아 직접 조합한다.

const KST = "Asia/Seoul";
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

interface KstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: KST,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function kstParts(date: Date): KstParts {
  const p: Record<string, string> = {};
  for (const { type, value } of partsFormat.formatToParts(date)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: WEEKDAY_EN.indexOf(p.weekday),
  };
}

/** '오후 5:03' */
export function formatKstTime(date: Date): string {
  const { hour, minute } = kstParts(date);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour < 12 ? "오전" : "오후"} ${h12}:${String(minute).padStart(2, "0")}`;
}

// 한국 날짜만 비교하려고 UTC 자정 기준의 일 번호로 바꾼다
function dayNumber(p: KstParts) {
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000);
}

/** '오늘' · '어제' · '9월 25일 (목)' · (해가 다르면) '2025년 12월 30일 (화)' */
export function formatKstDay(date: Date, now: Date = new Date()): string {
  const p = kstParts(date);
  const n = kstParts(now);
  const diff = dayNumber(n) - dayNumber(p);
  if (diff === 0) return "오늘";
  if (diff === 1) return "어제";
  const md = `${p.month}월 ${p.day}일 (${WEEKDAY[p.weekday]})`;
  return p.year === n.year ? md : `${p.year}년 ${md}`;
}

/** '오늘 오후 5:03' */
export function formatKstDateTime(date: Date, now: Date = new Date()): string {
  return `${formatKstDay(date, now)} ${formatKstTime(date)}`;
}

/** 걸린 시간: '40초' · '12분' · '1시간 5분' */
export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) return `${sec}초`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}분`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

/** 통화 시계: '3:07' · '1:02:09' */
export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** 이 달 1일 0시(한국 시간)의 ISO 문자열 — '이번 달' 집계용 */
export function kstMonthStartIso(now: Date = new Date()): string {
  const { year, month } = kstParts(now);
  // 한국은 UTC+9, 서머타임 없음
  return new Date(Date.UTC(year, month - 1, 1, -9)).toISOString();
}
