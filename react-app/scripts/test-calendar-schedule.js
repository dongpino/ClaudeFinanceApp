/**
 * scripts/test-calendar-schedule.js — 시장 캘린더 일정층 검증(순수 계산, 외부 호출 없음).
 *
 * 검증 대상:
 *  1. 소진 경고 해소  — 실적 3Q 선반영 후 오늘(2026-07-27) 기준 depletion이 빈다
 *  2. tentative 전파  — 추정 일정이 upcoming/월 그리드까지 플래그를 달고 내려간다
 *  3. 연도 병합 구조  — 2026→2027 경계에서 getNextFomcMeeting이 null로 끊기지 않는다
 *  4. CPI 미공표 갭   — 2027 미공표 상태를 "조용한 null"이 아니라 경고로 드러낸다
 *  5. calendar 유사 행 — 상태판에 나갈 행의 status/note
 *
 * "오늘"은 전부 고정 날짜로 목킹한다(실제 시계에 의존하면 시간이 지나며 스스로 깨진다).
 * 실행: node scripts/test-calendar-schedule.js
 */
import {
  getScheduleDepletion, getNextFomcMeeting, getNextCpiRelease,
  getUpcomingEvents, getEventsForMonth,
  FOMC_MEETINGS, CPI_RELEASES, EARNINGS_EVENTS, VERIFIED_AT,
} from '../api/_lib/macro-calendar.js';
import { buildCalendarSource } from '../api/health.js';

// ── "오늘" 목킹 ───────────────────────────────────────────────
// macro-calendar의 todayKST()는 Intl.format(new Date())라, 인자 없는 new Date()와
// Date.now()만 고정하면 된다(문자열 인자 생성자는 실제 동작 유지 — daysBetween이 씀).
const RealDate = Date;
function withToday(dateStr, fn) {
  const fixedMs = RealDate.parse(`${dateStr}T04:00:00Z`); // KST 13:00 — 자정 경계 회피
  class MockDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  }
  globalThis.Date = MockDate;
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', msg); } }

// ── 1. 소진 경고 해소(오늘 기준) ────────────────────────────────
{
  const dep = withToday('2026-07-27', () => getScheduleDepletion());
  assert(dep.length === 0, `1: 2026-07-27 depletion 비어야 함 (실제: ${JSON.stringify(dep)})`);

  // 반증 — 3Q 선반영 전이었다면 실적이 걸렸어야 한다(임계 30일, 구 마지막값 8/26).
  const before = withToday('2026-07-27', () => getScheduleDepletion(120));
  const earnings = before.find(d => d.category === 'earnings');
  assert(earnings?.lastDate === '2026-11-17', `1: 실적 마지막 일정이 11/17이어야 함 (실제: ${earnings?.lastDate})`);
}

// ── 2. tentative 전파 ──────────────────────────────────────────
{
  const up = withToday('2026-07-27', () => getUpcomingEvents(120));
  // 날짜만으로 찾으면 안 된다 — 2026-10-08은 한국 옵션만기일(둘째 목요일)과 겹친다.
  const earningsOn = d => up.find(e => e.date === d && e.category === 'earnings');
  // 2026-07-28 정정으로 7/30에 실적이 2건(삼성 확정 + 애플)이 됐다 — 날짜만으로 find하면
  // 앞선 삼성이 잡혀 "애플을 봤다"는 착각이 생긴다. 제목으로 특정한다.
  const earningsBy = (d, kw) => up.find(e => e.date === d && e.category === 'earnings' && e.title.includes(kw));
  const apple3Q = earningsBy('2026-07-30', '애플');
  const samsung3Q = earningsOn('2026-10-08');
  const nvidia3Q = earningsOn('2026-11-17');
  assert(!apple3Q?.tentative, '2: 확정 일정(7/30 애플)은 tentative 없음');
  assert(samsung3Q?.tentative === true, '2: 추정 일정(10/8 삼성 잠정)은 tentative:true');
  assert(nvidia3Q?.tentative === true, '2: 추정 일정(11/17 엔비디아)은 tentative:true');

  // 2026-07-28 정정 3건을 회귀로 못박는다 — 셋 다 "확인일 도장이 찍혀 있는데도 틀렸던"
  // 값이라, 다음에 누가 요일 규칙으로 되돌려 놓으면 여기서 걸려야 한다.
  const samsung2Q = earningsBy('2026-07-30', '삼성전자 2Q26 확정실적');
  assert(samsung2Q, '2: 삼성 2Q26 확정실적은 7/30 (7/23 아님 — 네이버 IR/삼성 IR/웹 3중 일치)');
  assert(!samsung2Q?.tentative, '2: 삼성 2Q26 확정실적은 확정 표기');
  assert(!up.some(e => e.date === '2026-07-23' && e.category === 'earnings'), '2: 7/23에 실적 없음');
  assert(earningsBy('2026-10-28', '애플')?.tentative === true, '2: 애플 4Q는 10/28이며 tentative 유지');
  assert(!up.some(e => e.date === '2026-10-29' && e.title.includes('애플')), '2: 애플이 10/29에 남아있지 않음');
  assert(earningsBy('2026-11-17', '엔비디아')?.tentative === true, '2: 엔비디아 3Q는 11/17이며 tentative 유지');

  const oct = getEventsForMonth(2026, 10);
  assert(oct.filter(e => e.tentative).length === 3, `2: 10월 그리드에 추정 3건 (실제: ${oct.filter(e => e.tentative).length})`);
  assert(oct.every(e => e.category !== 'earnings' || e.tentative), '2: 10월 실적은 전부 추정');

  // 확정 일정에는 플래그가 없어야 UI가 "(예정)"을 잘못 붙이지 않는다.
  const jul = getEventsForMonth(2026, 7);
  assert(jul.filter(e => e.category === 'earnings').every(e => !e.tentative), '2: 7월 실적은 전부 확정');
}

// ── 3. 2026→2027 경계(연도 병합 구조) ───────────────────────────
{
  // 병합 전에는 2026-12-09(마지막 회의) 이후 null이 떨어져 매크로 카드가 조용히 비었다.
  const next = withToday('2026-12-15', () => getNextFomcMeeting());
  assert(next !== null, '3: 12/9 이후에도 다음 FOMC가 있어야 함(2027 병합)');
  assert(next?.start === '2027-01-26', `3: 다음 FOMC는 2027-01-26 (실제: ${next?.start})`);
  assert(next?.dDay === 42, `3: dDay=42 (실제: ${next?.dDay})`);

  // 연말 마지막 회의 진행 중에는 그 회의가 잡혀야 한다(end 기준 포함 규칙 유지).
  const during = withToday('2026-12-09', () => getNextFomcMeeting());
  assert(during?.start === '2026-12-08', `3: 12/9엔 진행 중인 12/8 회의 (실제: ${during?.start})`);

  // 월 그리드도 2027년을 알아야 한다.
  const jan27 = getEventsForMonth(2027, 1);
  assert(jan27.some(e => e.category === 'fomc' && e.date === '2027-01-26'), '3: 2027-01 그리드에 FOMC');

  // 조회 범위가 연말을 걸쳐도 2027 이벤트가 섞여 들어온다.
  const across = withToday('2026-12-20', () => getUpcomingEvents(60));
  assert(across.some(e => e.date === '2027-01-26'), '3: 연말 조회에 2027-01 FOMC 포함');

  // 병합 배열 오름차순(getNext*의 find 전제).
  const asc = arr => arr.every((v, i) => i === 0 || arr[i - 1] <= v);
  assert(asc(FOMC_MEETINGS.map(m => m.start)), '3: FOMC_MEETINGS 오름차순');
  assert(asc(CPI_RELEASES.map(r => r.date)), '3: CPI_RELEASES 오름차순');
  assert(asc(EARNINGS_EVENTS.map(e => e.date)), '3: EARNINGS_EVENTS 오름차순');
  assert(FOMC_MEETINGS.length === 16, `3: FOMC 2026+2027 = 16건 (실제: ${FOMC_MEETINGS.length})`);
}

// ── 4. CPI 2027 미공표 갭이 경고로 드러나는가 ────────────────────
{
  // BLS 미공표라 2026-12-10 이후 null이 되는 건 현재로선 정상 — 대신 그 전에
  // 소진 경고가 반드시 먼저 떠야 "조용한 실패"가 아니다.
  const gone = withToday('2026-12-15', () => getNextCpiRelease());
  assert(gone === null, '4: 2027 미공표 상태에선 12/10 이후 다음 CPI가 없음');

  const dep = withToday('2026-11-15', () => getScheduleDepletion());
  assert(dep.some(d => d.category === 'cpi'), '4: 11/15엔 CPI 소진 경고가 떠 있어야 함');
  assert(dep.every((d, i) => i === 0 || dep[i - 1].daysLeft <= d.daysLeft), '4: depletion은 급한 순 정렬');
  assert(dep[0].category === 'earnings', `4: 가장 급한 건 실적(11/17) (실제: ${dep[0].category})`);
  // 2027 병합의 효과 — 예전 구조라면 FOMC(2026-12-09)도 함께 소진 경고에 올랐다.
  assert(!dep.some(d => d.category === 'fomc'), '4: FOMC는 2027 병합으로 소진 대상 아님');
  assert(dep.length === 3, `4: 실적·MSCI·CPI 3건 (실제: ${dep.map(d => d.category).join(',')})`);
}

// ── 5. 상태판 calendar 유사 행 ──────────────────────────────────
{
  const okRow = withToday('2026-07-27', () => buildCalendarSource());
  assert(okRow.source === 'calendar' && okRow.kind === 'derived', '5: source/kind 식별자');
  assert(okRow.status === 'ok', `5: 소진 없으면 ok (실제: ${okRow.status})`);
  assert(/확인$/.test(okRow.note), `5: 평시 note는 확인일 (실제: "${okRow.note}")`);
  assert(okRow.lastSuccessAt === null && okRow.consecutiveFailures === 0, '5: 수집 필드는 중립값');

  const warnRow = withToday('2026-11-15', () => buildCalendarSource());
  assert(warnRow.status === 'warn', `5: 소진 임박이면 warn (실제: ${warnRow.status})`);
  assert(warnRow.note.startsWith('실적 11/17 이후 없음'), `5: note에 가장 급한 소진 (실제: "${warnRow.note}")`);
  assert(warnRow.note.includes('외 2'), `5: 나머지는 "외 N"으로 축약 (실제: "${warnRow.note}")`);
  assert(warnRow.depletion.length === 3, `5: depletion 원본 동봉 (실제: ${warnRow.depletion.length})`);
}

// ── 6. verifiedAt 계약 ─────────────────────────────────────────
{
  const keys = ['fomc', 'cpi', 'msci', 'earnings'];
  assert(keys.every(k => /^\d{4}-\d{2}-\d{2}$/.test(VERIFIED_AT[k] ?? '')), '6: 4개 카테고리 모두 YYYY-MM-DD');
}

console.log(`\n${fail === 0 ? '✓ 전체 통과' : '✗ 실패 있음'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
