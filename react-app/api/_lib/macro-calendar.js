/**
 * api/_lib/macro-calendar.js — "시장 캘린더" 이벤트 소스 (FOMC/CPI/선물옵션 만기/MSCI 리밸런싱/실적)
 *
 * 이벤트는 두 갈래로 나뉜다:
 *  ① 하드코딩 상수(FOMC/CPI/MSCI/실적) — 연도가 바뀌면 배열을 갱신해야 함, 출처 주석 참고.
 *  ② 규칙 기반 계산(선물옵션 동시만기일) — 연도 하드코딩 없이 매년 자동 계산됨.
 *
 * 연도 병합 구조: 카테고리별로 연도 배열(..._2026 / ..._2027)을 따로 두되, 소비하는
 * 쪽(getNextFomcMeeting·getNextCpiRelease·getUpcomingEvents·getEventsForMonth·
 * getScheduleDepletion)은 병합 상수
 * (FOMC_MEETINGS / CPI_RELEASES / MSCI_REVIEWS / EARNINGS_EVENTS)만 참조한다. 다음
 * 연도분을 추가할 때 배열 하나를 만들고 병합 라인에 끼워 넣으면 끝이며, 소비부는
 * 손댈 필요가 없다(연말 연도 경계에서 조용히 null을 반환하던 문제의 구조적 해소).
 * ⚠️ 병합 배열은 날짜 오름차순을 유지해야 한다 — getNextFomcMeeting/getNextCpiRelease가
 * find()로 "첫 미래 항목"을 집는다.
 *
 * 신빙성 표기 두 가지:
 *  · VERIFIED_AT — 카테고리별 "원출처 최종 확인일". API 응답과 캘린더 탭에 노출한다.
 *  · tentative   — 원출처가 아직 확정 공표하지 않아 과거 패턴으로 추정한 날짜. UI에
 *                  "(예정)"으로 구분 표시하고, 확정되면 날짜 갱신 + 플래그 제거한다.
 *
 * 출처:
 *  - FOMC: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *          (2026-07-27 확인 — 2027년 8회 공표분 반영, 2026년분 원문 재대조 일치)
 *  - CPI:  https://www.bls.gov/schedule/news_release/cpi.htm
 *          교차 확인: https://www.usinflationcalculator.com/inflation/consumer-price-index-release-schedule/
 *          (2026-07-27 확인) — 발표 시각은 미 동부시각(ET) 08:30 고정.
 *  - MSCI: https://www.msci.com/indexes/index-resources/index-announcements
 *          https://www.msci.com/eqb/pressreleases/archive/ir_dates.pdf
 *          (2026-07-27 확인 — 8월/11월 예정일 원문 일치, 단 MSCI가 변경 가능성 공식 고지)
 *  - 실적: 삼성전자 IR(news.samsung.com/global/ir), 애플 뉴스룸/8-K, NVIDIA 8-K/IR
 *          (2026-07-27 확인 — 3Q 일정은 각 사가 통상 3~4주 전에야 공표해 미확정,
 *           과거 패턴 기반 추정치를 tentative:true로 선반영)
 *          (2026-07-28 재대조 — 오류 3건 정정. 실측 출처를 명기한다:
 *            · 삼성 2Q26 확정실적 7/23 → 7/30
 *              네이버 IR https://m.stock.naver.com/api/stock/005930/integration
 *                        irScheduleInfo.irScheduleDate = "2026-07-30" (D-2 실측)
 *              + 삼성 global IR https://www.samsung.com/global/ir/ "2Q26 Earnings
 *                Conference Call" + 웹 검색 "7월 30일 10:00" — 3중 일치
 *            · 애플 FY26 4Q  10/29 → 10/28   Finnhub /calendar/earnings (hour=amc)
 *            · 엔비디아 FY27 3Q 11/18 → 11/17 Finnhub /calendar/earnings (hour=amc)
 *           같은 대조에서 확정 항목(애플 7/30·엔비디아 8/26)은 Finnhub와 정확히
 *           일치 → 기준(ET 표기)은 맞고 추정 규칙만 하루 밀려 있었음이 확인됐다.)
 *
 * ET→KST 변환은 해당 날짜의 실제 서머타임(DST) 여부를 Intl 타임존 데이터로 판정하므로
 * DST 규칙을 직접 하드코딩하지 않고, 매년 값만 넣으면 계속 정확하게 동작한다.
 */

/**
 * 카테고리별 원출처 최종 확인일(YYYY-MM-DD, KST). 배열을 갱신하거나 원문을 재대조했을
 * 때 함께 올린다 — 이 값이 오래됐다는 것 자체가 "일정이 바뀌었어도 모른다"는 신호다.
 * (일정 변경 감지 수단이 없는 현 구조에서 사용자에게 줄 수 있는 최소한의 신빙성 근거)
 */
export const VERIFIED_AT = {
  fomc:     '2026-07-27',
  cpi:      '2026-07-27',
  msci:     '2026-07-27',
  // 2026-07-28: 네이버 IR / 삼성 global IR / Finnhub와 재대조해 오류 3건 정정(위 출처 주석).
  earnings: '2026-07-28',
};

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

// 2027년 FOMC — federalreserve.gov 공표분(2026-07-27 확인). 연준은 2년치를 미리 공표한다.
// SEP(경제전망요약) 동반 회의: 3월·6월·9월·12월.
export const FOMC_MEETINGS_2027 = [
  { start: '2027-01-26', end: '2027-01-27' },
  { start: '2027-03-16', end: '2027-03-17' },
  { start: '2027-04-27', end: '2027-04-28' },
  { start: '2027-06-08', end: '2027-06-09' },
  { start: '2027-07-27', end: '2027-07-28' },
  { start: '2027-09-14', end: '2027-09-15' },
  { start: '2027-10-26', end: '2027-10-27' },
  { start: '2027-12-07', end: '2027-12-08' },
];

/** 소비부가 참조하는 병합 FOMC 일정(날짜 오름차순) */
export const FOMC_MEETINGS = [...FOMC_MEETINGS_2026, ...FOMC_MEETINGS_2027];

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

// 2027년 CPI — ⚠️ 미공표(2026-07-27 확인). BLS는 통상 전년 가을에 다음 해 공표 일정을
// 올리며(bls.gov/schedule/news_release/cpi.htm), 현재 마지막 공표분은 2026-12-10이다.
// TODO(2026-10-01 재확인): 공표되면 아래 배열을 채우고 VERIFIED_AT.cpi를 함께 갱신할 것.
//   미채움 상태에서도 병합 구조상 동작에 문제는 없고, 2026-11-10경 CPI 소진 경고가 뜬다.
export const CPI_RELEASES_2027 = [];

/** 소비부가 참조하는 병합 CPI 일정(날짜 오름차순) */
export const CPI_RELEASES = [...CPI_RELEASES_2026, ...CPI_RELEASES_2027];

// MSCI 정기 인덱스 리뷰(5·8·11월) — announce: 발표일, effective: 시행일(리밸런싱 반영일)
const MSCI_REVIEWS_2026 = [
  { announce: '2026-05-12', effective: '2026-05-29', label: '5월' },
  { announce: '2026-08-12', effective: '2026-09-01', label: '8월' },
  { announce: '2026-11-11', effective: '2026-12-01', label: '11월' },
];

// TODO(2026-10-01 재확인): 2027년 리뷰 일정(MSCI ir_dates.pdf) 확정 시 MSCI_REVIEWS_2027 추가.
const MSCI_REVIEWS = [...MSCI_REVIEWS_2026];

/**
 * 실적 발표. tentative:true = 회사가 아직 공식 공표하지 않아 과거 패턴으로 추정한 날짜.
 *   · 삼성 잠정실적: 분기 종료 다음 달 초순(10/8은 목요일, 2024·2025년 패턴)
 *   · 삼성 확정실적: 같은 달 말 컨퍼런스콜(10/29 목)
 *   · 애플 FY 4분기: 10월 마지막 주 목요일
 *   · 엔비디아 FY 3분기: 11월 셋째 주 수요일
 * 각 사는 통상 3~4주 전에 날짜를 공표하므로, 확정되는 대로 date를 갱신하고 tentative를
 * 제거한다(UI의 "(예정)" 배지가 자동으로 사라진다).
 * shortLabel: 캘린더 그리드 셀 칩용 5자 내외 축약(item 1 규칙)
 *
 * ⚠️ 추정 규칙의 +1일 오차 전례(2026-07-28 발견) — "마지막 주 목요일"/"셋째 주 수요일"
 *    같은 요일 규칙은 실제와 하루씩 어긋난 적이 있다. 소스 조사 중 Finnhub와 대조하니
 *    애플 3Q26을 10/29로, 엔비디아를 11/18로 잡아 뒀는데 실제는 각각 10/28·11/17이었다
 *    (둘 다 수요일 — 규칙이 통째로 하루씩 밀려 있었다). 같은 대조에서 확정 항목 2건
 *    (애플 7/30, 엔비디아 8/26)은 정확히 일치해, 기준(ET 표기)이 맞고 추정치만 틀렸음이
 *    확인됐다. 요일 규칙으로 새 tentative를 채울 때는 반드시 외부 소스와 한 번 대조할 것.
 *
 * ⚠️ 확정 표기(tentative 없음)라고 안전한 게 아니다 — 삼성 2Q26 확정실적을 7/23으로
 *    적어 뒀으나 실제는 7/30이었다(2026-07-28 발견). VERIFIED_AT.earnings가 7/27로
 *    갱신된 뒤에도 틀린 값이 남아 있었다. 확인일 도장은 "그날 대조했다"는 뜻일 뿐
 *    정확성을 보증하지 못한다 — 실적일 감시기(읽기 전용 불일치 알림) 도입 예정.
 */
export const EARNINGS_EVENTS_2026 = [
  { date: '2026-07-07', title: '삼성전자 2Q26 잠정실적(가이던스) 발표', shortLabel: '삼성 잠정실적', category: 'earnings', region: 'KR' },
  // 2026-07-28 정정: 7/23 → 7/30. 3중 일치(네이버 IR irScheduleDate=2026-07-30 /
  // 삼성 global IR "2Q26 Earnings Conference Call" / 웹 검색 "7월 30일 10시").
  { date: '2026-07-30', title: '삼성전자 2Q26 확정실적(컨퍼런스콜)',   shortLabel: '삼성 확정실적', category: 'earnings', region: 'KR' },
  { date: '2026-07-30', title: '애플 FY26 3분기 실적 발표',            shortLabel: '애플 실적',   category: 'earnings', region: 'US' },
  { date: '2026-08-26', title: '엔비디아 FY27 2분기 실적 발표',        shortLabel: '엔비디아 실적', category: 'earnings', region: 'US' },
  { date: '2026-10-08', title: '삼성전자 3Q26 잠정실적(가이던스) 발표', shortLabel: '삼성 잠정실적', category: 'earnings', region: 'KR', tentative: true },
  // 2026-07-28 정정: 10/29 → 10/28 (Finnhub calendar/earnings, hour=amc).
  // tentative 유지 — 애플 공식 IR 공지 전까지는 여전히 추정이다.
  // ⚠️ 정정으로 삼성(10/29)보다 앞서게 돼 배열 순서도 함께 바꿨다(오름차순 불변조건).
  { date: '2026-10-28', title: '애플 FY26 4분기 실적 발표',            shortLabel: '애플 실적',   category: 'earnings', region: 'US', tentative: true },
  { date: '2026-10-29', title: '삼성전자 3Q26 확정실적(컨퍼런스콜)',   shortLabel: '삼성 확정실적', category: 'earnings', region: 'KR', tentative: true },
  // 2026-07-28 정정: 11/18 → 11/17 (Finnhub calendar/earnings, hour=amc). tentative 유지.
  { date: '2026-11-17', title: '엔비디아 FY27 3분기 실적 발표',        shortLabel: '엔비디아 실적', category: 'earnings', region: 'US', tentative: true },
];

/** 소비부가 참조하는 병합 실적 일정(날짜 오름차순) */
export const EARNINGS_EVENTS = [...EARNINGS_EVENTS_2026];

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

// 'YYYY-MM-DD' + 미 동부시각(ET) hour:min → { utc: Date, uncertain: boolean }.
// 그 날짜의 서머타임 여부는 Intl 타임존 데이터(shortOffset)로 판정 — DST 규칙을
// 직접 계산하지 않아 연도가 바뀌어도(오탈자 없이) 안전하다.
//
// 폴백 견고성: 런타임 ICU가 shortOffset을 지원하지 않거나(구형 환경) 예상 밖의
// 문자열("EDT" 등)을 주면 오프셋 파싱이 실패할 수 있다. 그때는 EST(-5)로 폴백하되
// uncertain=true를 함께 반환한다 — 여름(EDT, -4)에 이 폴백이 조용히 걸리면 1시간
// 틀린 시각이 표시되므로, 호출측이 "경" 불확실 표기를 붙이고(formatKSTHM) 서버
// 로그로도 남겨 감지할 수 있게 하기 위함이다.
function nyWallTimeToUTC(dateStr, hour, minute) {
  const probe = new Date(`${dateStr}T12:00:00Z`); // 자정 근처 DST 경계 회피용 정오 프로브
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset',
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value;
  const m = offsetName?.match(/GMT([+-]\d+)/);
  const uncertain = !m; // GMT 오프셋을 못 읽음 → EST(-5) 폴백, 불확실
  if (uncertain) {
    // Vercel 함수 로그에 남겨 폴백 발동을 사후 감지 가능하게(프로덕션 로그 grep).
    console.warn(`[macro-calendar] ET→KST 오프셋 파싱 실패, EST(-5) 폴백: date=${dateStr} raw="${offsetName ?? 'none'}"`);
  }
  const offsetH = m ? parseInt(m[1], 10) : -5;
  const sign = offsetH >= 0 ? '+' : '-';
  const abs  = String(Math.abs(offsetH)).padStart(2, '0');
  const utc = new Date(
    `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${sign}${abs}:00`
  );
  return { utc, uncertain };
}

// uncertain=true면 오프셋 판정이 폴백된 것이라 "경"을 붙여 불확실성을 표면에 노출한다.
function formatKSTHM(date, uncertain = false) {
  const hm = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  return uncertain ? `${hm}경` : hm;
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
      shortLabel: isQuarterly ? '동시만기' : '옵션만기',
      category: 'expiry', region: 'KR',
    });
    if (isQuarterly) {
      events.push({
        date: toDateStr(nthWeekdayOfMonth(year, month, 5, 3)), // 금요일=5, 셋째주
        title: '미국 쿼드러플 위칭데이',
        shortLabel: '위칭데이',
        category: 'expiry', region: 'US',
      });
    }
  }
  return events;
}

/**
 * 하드코딩 일정 배열의 "소진 임박" 경고 — 각 배열의 실제 마지막 이벤트 날짜를
 * 런타임에 읽어 계산한다. 경고 코드에 날짜를 중복 기재하지 않으므로, 배열에
 * 미래 일정을 추가하면(예: FOMC_MEETINGS_2027 병합) 별도 조치 없이 경고가
 * 자동으로 해제된다.
 *
 * 판정: 각 배열의 가장 늦은 이벤트 날짜가 오늘로부터 withinDays일 이내(또는
 * 이미 과거)면 소진 임박으로 본다. 규칙 계산인 선물옵션 만기(getExpiryEvents)는
 * 연도 하드코딩이 없어 소진 개념 자체가 없으므로 대상에서 제외한다.
 *
 * @param {number} withinDays 임박 판정 임계(기본 30일)
 * @returns {Array<{category: string, lastDate: string, daysLeft: number}>}
 *          daysLeft 오름차순(가장 급한 것 먼저). 임박 항목이 없으면 빈 배열.
 */
export function getScheduleDepletion(withinDays = 30) {
  const today = todayKST();
  // FOMC는 회의 종료일(end), MSCI는 두 이벤트 중 나중인 시행일(effective)이
  // 실질적인 마지막 날짜다. 나머지는 단일 date.
  // 병합 상수 기준 — 다음 연도 배열을 추가하면 경고가 자동으로 풀린다.
  // 실적의 tentative(추정) 항목도 포함해 계산한다: 경고의 목적이 "앞이 비었다"를
  // 알리는 것이므로, 추정치라도 채워져 있으면 소진은 아니다(추정 여부는 UI의
  // "(예정)" 배지가 따로 알린다).
  const sources = [
    { category: 'fomc',     dates: FOMC_MEETINGS.map(m => m.end) },
    { category: 'cpi',      dates: CPI_RELEASES.map(r => r.date) },
    { category: 'msci',     dates: MSCI_REVIEWS.map(r => r.effective) },
    { category: 'earnings', dates: EARNINGS_EVENTS.map(e => e.date) },
  ];

  const depletion = [];
  for (const { category, dates } of sources) {
    if (dates.length === 0) continue;
    const lastDate = dates.reduce((a, b) => (a > b ? a : b)); // 배열 정렬 여부와 무관하게 최댓값
    const daysLeft = daysBetween(today, lastDate);
    if (daysLeft <= withinDays) depletion.push({ category, lastDate, daysLeft });
  }

  return depletion.sort((a, b) => a.daysLeft - b.daysLeft);
}

// FOMC 회의 하나를 통합 이벤트 형태로 (getUpcomingEvents/getEventsForMonth 공용)
function fomcEvent(meeting) {
  return { date: meeting.start, endDate: meeting.end, title: 'FOMC 회의', shortLabel: 'FOMC', category: 'fomc', region: 'US' };
}

// CPI 발표 하나를 통합 이벤트 형태로 (getUpcomingEvents/getEventsForMonth 공용)
function cpiEvent(release) {
  const { utc, uncertain } = nyWallTimeToUTC(release.date, CPI_RELEASE_HOUR_ET, CPI_RELEASE_MIN_ET);
  return { date: release.date, title: '미국 CPI 발표', shortLabel: 'CPI', category: 'cpi', region: 'US', time: formatKSTHM(utc, uncertain) };
}

// MSCI 리뷰 하나(발표+시행)를 통합 이벤트 2개로 (getUpcomingEvents/getEventsForMonth 공용)
function msciEventsFor(rev) {
  return [
    { date: rev.announce,  title: `MSCI ${rev.label} 리뷰 발표`, shortLabel: 'MSCI', category: 'msci', region: 'KR' },
    { date: rev.effective, title: `MSCI ${rev.label} 리뷰 시행`, shortLabel: 'MSCI', category: 'msci', region: 'KR' },
  ];
}

// ── 공개 함수 ────────────────────────────────────────────────

/** 다음(또는 진행 중인) FOMC 회의 — KST 기준 오늘 날짜로 D-day 계산 */
export function getNextFomcMeeting() {
  const today = todayKST();
  const next = FOMC_MEETINGS.find(m => daysBetween(today, m.end) >= 0);
  if (!next) return null;
  return { ...next, dDay: daysBetween(today, next.start) };
}

/** 다음 CPI 발표 — KST 기준 오늘 날짜로 D-day + 발표 시각(KST) 계산 */
export function getNextCpiRelease() {
  const today = todayKST();
  const next = CPI_RELEASES.find(r => daysBetween(today, r.date) >= 0);
  if (!next) return null;
  const { utc, uncertain } = nyWallTimeToUTC(next.date, CPI_RELEASE_HOUR_ET, CPI_RELEASE_MIN_ET);
  return {
    ...next,
    dDay: daysBetween(today, next.date),
    kstTime: formatKSTHM(utc, uncertain),
  };
}

/**
 * 시장 캘린더 통합 이벤트 — FOMC/CPI/선물옵션 만기/MSCI 리밸런싱/실적을
 * 하나의 타입으로 합쳐 앞으로 `days`일 이내 것만 D-day와 함께 반환(날짜순 정렬).
 * 타입: { date, endDate?, title, shortLabel, category: 'fomc'|'cpi'|'expiry'|'msci'|'earnings',
 *         region: 'US'|'KR', time?, dDay }
 * @param {number} days 조회 범위(기본 30일)
 */
export function getUpcomingEvents(days = 30) {
  const today = todayKST();
  const events = [];

  // FOMC — 2일짜리 회의라 "진행 중"(오늘이 첫날은 지났지만 둘째 날 이전) 케이스를
  // end 기준으로 포함시키고, dDay는 회의 시작일 기준으로 계산(진행 중이면 음수 → UI가 "진행중" 표시)
  for (const m of FOMC_MEETINGS) {
    if (daysBetween(today, m.end) < 0) continue;
    const dDay = daysBetween(today, m.start);
    if (dDay > days) continue;
    events.push({ ...fomcEvent(m), dDay });
  }

  // CPI
  for (const r of CPI_RELEASES) {
    const dDay = daysBetween(today, r.date);
    if (dDay < 0 || dDay > days) continue;
    events.push({ ...cpiEvent(r), dDay });
  }

  // 선물옵션 만기 — 조회 범위가 연말/연초를 걸칠 수 있어 올해+내년 둘 다 계산
  const y = Number(today.slice(0, 4));
  for (const expiry of [...getExpiryEvents(y), ...getExpiryEvents(y + 1)]) {
    const dDay = daysBetween(today, expiry.date);
    if (dDay < 0 || dDay > days) continue;
    events.push({ ...expiry, dDay });
  }

  // MSCI 리뷰 — 발표일/시행일을 각각 별개 이벤트로
  for (const rev of MSCI_REVIEWS) {
    for (const ev of msciEventsFor(rev)) {
      const dDay = daysBetween(today, ev.date);
      if (dDay < 0 || dDay > days) continue;
      events.push({ ...ev, dDay });
    }
  }

  // 실적
  for (const e of EARNINGS_EVENTS) {
    const dDay = daysBetween(today, e.date);
    if (dDay < 0 || dDay > days) continue;
    events.push({ ...e, dDay });
  }

  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 특정 연·월(캘린더 탭 월 그리드용)에 속하는 이벤트 전부 — 과거·미래 무관하게
 * 그 달에 날짜가 걸치는 것만 반환(dDay 없음, D-day는 getUpcomingEvents 전용).
 * FOMC처럼 endDate가 있는 이벤트는 시작·종료 중 하나라도 해당 월에 걸리면 포함.
 * @param {number} year
 * @param {number} month 1~12 (사람이 읽는 월, 0-indexed 아님)
 */
export function getEventsForMonth(year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const events = [];

  for (const m of FOMC_MEETINGS) {
    if (m.start.startsWith(prefix) || m.end.startsWith(prefix)) events.push(fomcEvent(m));
  }
  for (const r of CPI_RELEASES) {
    if (r.date.startsWith(prefix)) events.push(cpiEvent(r));
  }
  for (const expiry of getExpiryEvents(year)) {
    if (expiry.date.startsWith(prefix)) events.push(expiry);
  }
  for (const rev of MSCI_REVIEWS) {
    for (const ev of msciEventsFor(rev)) {
      if (ev.date.startsWith(prefix)) events.push(ev);
    }
  }
  for (const e of EARNINGS_EVENTS) {
    if (e.date.startsWith(prefix)) events.push(e);
  }

  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
