/**
 * api/_lib/macro-calendar.js — "시장 캘린더" 이벤트 소스 (FOMC/CPI/선물옵션 만기/MSCI 리밸런싱/실적)
 *
 * 이벤트는 두 갈래로 나뉜다:
 *  ① 하드코딩 상수(FOMC/CPI/MSCI/실적) — 연도가 바뀌면 배열을 갱신해야 함, 출처 주석 참고.
 *  ② 규칙 기반 계산(선물옵션 동시만기일) — 연도 하드코딩 없이 매년 자동 계산됨.
 *
 * 출처:
 *  - FOMC: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (2026-07-06 확인)
 *  - CPI:  https://www.bls.gov/schedule/news_release/cpi.htm
 *          교차 확인: https://www.usinflationcalculator.com/inflation/consumer-price-index-release-schedule/
 *          (2026-07-06 확인) — 발표 시각은 미 동부시각(ET) 08:30 고정.
 *  - MSCI: https://www.msci.com/indexes/index-resources/index-announcements
 *          (2026-07-06 확인, 8월/11월은 MSCI가 사전 공지한 예정일 — 변경 가능성 있음 공식 고지)
 *  - 실적: 삼성전자 IR(news.samsung.com/global/ir), 애플 뉴스룸(9to5mac.com 2026-07-02 보도),
 *          NVIDIA 8-K/IR(tipranks.com) — (2026-07-06 확인, ⚠️ 다음 분기 일정 확정되면 갱신 필요)
 *
 * ET→KST 변환은 해당 날짜의 실제 서머타임(DST) 여부를 Intl 타임존 데이터로 판정하므로
 * DST 규칙을 직접 하드코딩하지 않고, 매년 값만 넣으면 계속 정확하게 동작한다.
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

// MSCI 정기 인덱스 리뷰(5·8·11월) — announce: 발표일, effective: 시행일(리밸런싱 반영일)
const MSCI_REVIEWS_2026 = [
  { announce: '2026-05-12', effective: '2026-05-29', label: '5월' },
  { announce: '2026-08-12', effective: '2026-09-01', label: '8월' },
  { announce: '2026-11-11', effective: '2026-12-01', label: '11월' },
];

// 실적 발표 — 2026-07-06 기준 알려진 근접 일정만. 다음 분기분은 확정되는 대로 추가할 것.
export const EARNINGS_EVENTS_2026 = [
  { date: '2026-07-07', title: '삼성전자 2Q26 잠정실적(가이던스) 발표', category: 'earnings', region: 'KR' },
  { date: '2026-07-23', title: '삼성전자 2Q26 확정실적(컨퍼런스콜)',   category: 'earnings', region: 'KR' },
  { date: '2026-07-30', title: '애플 FY26 3분기 실적 발표',            category: 'earnings', region: 'US' },
  { date: '2026-08-26', title: '엔비디아 FY27 2분기 실적 발표',        category: 'earnings', region: 'US' },
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

function toDateStr(date) {
  return date.toISOString().slice(0, 10);
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

// n번째 요일 계산(UTC 캘린더 날짜 기준, 시간대 무관 — 만기일은 날짜만 의미가 있음).
// weekday: 0=일 ... 4=목 5=금 6=토. n: 1=첫째, 2=둘째, 3=셋째 ...
function nthWeekdayOfMonth(year, monthIndex0, weekday, n) {
  const first = new Date(Date.UTC(year, monthIndex0, 1));
  const firstWeekday = first.getUTCDay();
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + (n - 1) * 7;
  return new Date(Date.UTC(year, monthIndex0, day));
}

const QUARTER_MONTHS_0 = [2, 5, 8, 11]; // 0-indexed: 3·6·9·12월

/**
 * 규칙 기반 선물옵션 동시만기일 계산 — 연도 하드코딩 없음.
 *  한국: 매월 둘째 목요일(분기월엔 "네 마녀의 날", 그 외엔 월간 옵션만기)
 *  미국: 3·6·9·12월 셋째 금요일(쿼드러플 위칭)만 해당 — 미국은 매월이 아님.
 * @param {number} year
 */
export function getExpiryEvents(year) {
  const events = [];
  for (let month = 0; month < 12; month++) {
    const isQuarterly = QUARTER_MONTHS_0.includes(month);
    events.push({
      date: toDateStr(nthWeekdayOfMonth(year, month, 4, 2)), // 목요일=4, 둘째주
      title: isQuarterly ? '한국 선물옵션 동시만기일(네 마녀의 날)' : '한국 옵션만기일',
      category: 'expiry', region: 'KR',
    });
    if (isQuarterly) {
      events.push({
        date: toDateStr(nthWeekdayOfMonth(year, month, 5, 3)), // 금요일=5, 셋째주
        title: '미국 쿼드러플 위칭데이',
        category: 'expiry', region: 'US',
      });
    }
  }
  return events;
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

/**
 * 시장 캘린더 통합 이벤트 — FOMC/CPI/선물옵션 만기/MSCI 리밸런싱/실적을
 * 하나의 타입으로 합쳐 앞으로 `days`일 이내 것만 D-day와 함께 반환(날짜순 정렬).
 * 타입: { date, endDate?, title, category: 'fomc'|'cpi'|'expiry'|'msci'|'earnings',
 *         region: 'US'|'KR', time?, dDay }
 * @param {number} days 조회 범위(기본 30일)
 */
export function getUpcomingEvents(days = 30) {
  const today = todayKST();
  const events = [];

  // FOMC — 2일짜리 회의라 "진행 중"(오늘이 첫날은 지났지만 둘째 날 이전) 케이스를
  // end 기준으로 포함시키고, dDay는 회의 시작일 기준으로 계산(진행 중이면 음수 → UI가 "진행중" 표시)
  for (const m of FOMC_MEETINGS_2026) {
    if (daysBetween(today, m.end) < 0) continue;
    const dDay = daysBetween(today, m.start);
    if (dDay > days) continue;
    events.push({ date: m.start, endDate: m.end, title: 'FOMC 회의', category: 'fomc', region: 'US', dDay });
  }

  // CPI
  for (const r of CPI_RELEASES_2026) {
    const dDay = daysBetween(today, r.date);
    if (dDay < 0 || dDay > days) continue;
    const utc = nyWallTimeToUTC(r.date, CPI_RELEASE_HOUR_ET, CPI_RELEASE_MIN_ET);
    events.push({ date: r.date, title: '미국 CPI 발표', category: 'cpi', region: 'US', time: formatKSTHM(utc), dDay });
  }

  // 선물옵션 만기 — 조회 범위가 연말/연초를 걸칠 수 있어 올해+내년 둘 다 계산
  const y = Number(today.slice(0, 4));
  for (const expiry of [...getExpiryEvents(y), ...getExpiryEvents(y + 1)]) {
    const dDay = daysBetween(today, expiry.date);
    if (dDay < 0 || dDay > days) continue;
    events.push({ ...expiry, dDay });
  }

  // MSCI 리뷰 — 발표일/시행일을 각각 별개 이벤트로
  for (const rev of MSCI_REVIEWS_2026) {
    const announceDDay = daysBetween(today, rev.announce);
    if (announceDDay >= 0 && announceDDay <= days) {
      events.push({ date: rev.announce, title: `MSCI ${rev.label} 리뷰 발표`, category: 'msci', region: 'KR', dDay: announceDDay });
    }
    const effectiveDDay = daysBetween(today, rev.effective);
    if (effectiveDDay >= 0 && effectiveDDay <= days) {
      events.push({ date: rev.effective, title: `MSCI ${rev.label} 리뷰 시행`, category: 'msci', region: 'KR', dDay: effectiveDDay });
    }
  }

  // 실적
  for (const e of EARNINGS_EVENTS_2026) {
    const dDay = daysBetween(today, e.date);
    if (dDay < 0 || dDay > days) continue;
    events.push({ ...e, dDay });
  }

  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
