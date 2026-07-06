/**
 * api/_lib/macro-calendar.js — 2026년 FOMC 회의 일정 + CPI 발표 일정 (하드코딩 상수)
 *
 * 출처:
 *  - FOMC: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (2026-07-06 확인)
 *  - CPI:  https://www.bls.gov/schedule/news_release/cpi.htm
 *          교차 확인: https://www.usinflationcalculator.com/inflation/consumer-price-index-release-schedule/
 *          (2026-07-06 확인) — 발표 시각은 미 동부시각(ET) 08:30 고정.
 *
 * 연도가 바뀌면 이 두 배열만 갱신하면 된다. ET→KST 변환은 해당 날짜의 실제
 * 서머타임(DST) 여부를 Intl 타임존 데이터로 판정하므로 DST 규칙을 직접
 * 하드코딩하지 않고, 매년 값만 넣으면 계속 정확하게 동작한다.
 */

export const FOMC_MEETINGS_2026 = [
  { start: '2026-01-27', end: '2026-01-28' },
  { start: '2026-03-17', end: '2026-03-18' },
  { start: '2026-04-28', end: '2026-04-29' },
  { start: '2026-06-16', end: '2026-06-17' },
  { start: '2026-07-28', end: '2026-07-29' },
  { start: '2026-09-15', end: '2026-09-16' },
  { start: '2026-10-27', end: '2026-10-28' },
  { start: '2026-12-08', end: '2026-12-09' },
];

// date: 발표일(미 동부 캘린더 날짜), refMonth: 해당 발표가 다루는 기준월
export const CPI_RELEASES_2026 = [
  { date: '2026-01-13', refMonth: '2025-12' },
  { date: '2026-02-13', refMonth: '2026-01' },
  { date: '2026-03-11', refMonth: '2026-02' },
  { date: '2026-04-10', refMonth: '2026-03' },
  { date: '2026-05-12', refMonth: '2026-04' },
  { date: '2026-06-10', refMonth: '2026-05' },
  { date: '2026-07-14', refMonth: '2026-06' },
  { date: '2026-08-12', refMonth: '2026-07' },
  { date: '2026-09-11', refMonth: '2026-08' },
  { date: '2026-10-14', refMonth: '2026-09' },
  { date: '2026-11-10', refMonth: '2026-10' },
  { date: '2026-12-10', refMonth: '2026-11' },
];

const CPI_RELEASE_HOUR_ET = 8;
const CPI_RELEASE_MIN_ET  = 30;

// ── 날짜 유틸 ────────────────────────────────────────────────

function todayKST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function daysBetween(fromDateStr, toDateStr) {
  const a = new Date(`${fromDateStr}T00:00:00Z`);
  const b = new Date(`${toDateStr}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// 'YYYY-MM-DD' + 미 동부시각(ET) hour:min → 실제 UTC Date.
// 그 날짜의 서머타임 여부는 Intl 타임존 데이터로 판정 — DST 규칙을 직접
// 계산하지 않아 연도가 바뀌어도(오탈자 없이) 안전하다.
function nyWallTimeToUTC(dateStr, hour, minute) {
  const probe = new Date(`${dateStr}T12:00:00Z`); // 자정 근처 DST 경계 회피용 정오 프로브
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset',
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const m = offsetName.match(/GMT([+-]\d+)/);
  const offsetH = m ? parseInt(m[1], 10) : -5;
  const sign = offsetH >= 0 ? '+' : '-';
  const abs  = String(Math.abs(offsetH)).padStart(2, '0');
  return new Date(
    `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${sign}${abs}:00`
  );
}

function formatKSTHM(date) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

// ── 공개 함수 ────────────────────────────────────────────────

/** 다음(또는 진행 중인) FOMC 회의 — KST 기준 오늘 날짜로 D-day 계산 */
export function getNextFomcMeeting() {
  const today = todayKST();
  const next = FOMC_MEETINGS_2026.find(m => daysBetween(today, m.end) >= 0);
  if (!next) return null;
  return { ...next, dDay: daysBetween(today, next.start) };
}

/** 다음 CPI 발표 — KST 기준 오늘 날짜로 D-day + 발표 시각(KST) 계산 */
export function getNextCpiRelease() {
  const today = todayKST();
  const next = CPI_RELEASES_2026.find(r => daysBetween(today, r.date) >= 0);
  if (!next) return null;
  const utc = nyWallTimeToUTC(next.date, CPI_RELEASE_HOUR_ET, CPI_RELEASE_MIN_ET);
  return {
    ...next,
    dDay: daysBetween(today, next.date),
    kstTime: formatKSTHM(utc),
  };
}
