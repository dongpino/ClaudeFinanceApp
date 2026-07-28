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
 *          (2026-07-28 전수 대조 — 2026·2027 16건 전건 일치. 연준 페이지는 "each meeting
 *           date is tentative until confirmed"라고 명시하나, 우리 배열은 tentative를
 *           쓰지 않는다 — 연준 공표분은 사실상 확정으로 취급한다.)
 *  - CPI:  https://www.bls.gov/schedule/news_release/cpi.htm  ⚠️ 봇 차단(403)으로 직접 대조 불가
 *          교차 확인 ①: https://www.usinflationcalculator.com/inflation/consumer-price-index-release-schedule/
 *          교차 확인 ②: FRED release dates API(release_id=10) — BLS 미러
 *          (2026-07-28 전수 대조 — 2026년 12건이 refMonth까지 두 경로 모두 일치.)
 *          발표 시각은 미 동부시각(ET) 08:30 고정.
 *  - MSCI: https://www.msci.com/eqb/pressreleases/archive/ir_dates.pdf (Next Eight IR Dates)
 *          개별 리뷰 보도자료(businesswire/MSCI media room)로 항목별 교차 확인
 *          (2026-07-28 전수 대조 — **연 4회 체계로 정정**하며 2026-02 소급 추가,
 *           2027 4건 신설. 상세는 MSCI_REVIEWS_2026 주석 참조.)
 *  - 금통위: 한국은행 "2026년 금융통화위원회 정기회의 개최 및 의사록 공개 예정일정"
 *          (2025-10-30 공표). 개별 일자는 통화정책방향 보도자료로 교차 확인.
 *          (2026-07-28 확인 — 통방 8회. 2027분 미공표.)
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
  // 2026-07-28 전수 기계 대조: federalreserve.gov 공표 일정과 2026·2027 16건 전건 일치.
  fomc:     '2026-07-28',
  // 2026-07-28 전수 대조: 2026년 12건이 refMonth까지 전건 일치(usinflationcalculator
  // + FRED release dates 두 경로 독립 확인). 2027분은 확인 실패 — 배열 주석 참조.
  cpi:      '2026-07-28',
  // 2026-07-28: 연 4회 체계로 정정하며 2026-02 소급 추가 + 2027 4건 신설.
  msci:     '2026-07-28',
  // 한국은행 2026년 정기회의 일정(2025-10-30 공표) 기준. 2027분 미공표.
  bok:      '2026-07-28',
  // 2026-07-28: 네이버 IR / 삼성 global IR / Finnhub와 재대조해 오류 3건 정정(위 출처 주석).
  earnings: '2026-07-28',
  // 만기일 보정용 휴장일 표(MARKET_HOLIDAYS) — 다른 하드코딩 배열과 같은 규율을 적용한다.
  holidays: '2026-07-28',
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

// 2027년 CPI — ⚠️ **확인 실패**(2026-07-28). "미공표"로 단정하지 않는다.
//   · bls.gov가 봇 차단(Access Denied 403) — 원출처 직접 대조 불가
//   · FRED release dates API(release_id=10, include_release_dates_with_no_data=true)로
//     우회 조회 → 2026분 12건은 우리 배열과 전건 일치했으나 2027분은 **0건**
//   · 교차확인 출처(usinflationcalculator)도 2026-12-10까지만 게재
//   즉 "BLS가 아직 안 올렸다"와 "미러들이 아직 못 받아왔다"를 구분하지 못한 상태다.
// TODO(2026-10-01 재시도): 위 세 경로를 다시 확인해 공표됐으면 채우고 VERIFIED_AT.cpi를
//   함께 갱신할 것. 미채움 상태에서도 병합 구조상 동작에 문제는 없고, 2026-11-10경
//   CPI 소진 경고가 뜬다.
export const CPI_RELEASES_2027 = [];

/** 소비부가 참조하는 병합 CPI 일정(날짜 오름차순) */
export const CPI_RELEASES = [...CPI_RELEASES_2026, ...CPI_RELEASES_2027];

/**
 * MSCI 정기 인덱스 리뷰 — **연 4회(2·5·8·11월)**. announce: 발표일, effective: 시행일.
 *
 * ⚠️ 2026-07-28 정정: 예전 주석이 "(5·8·11월)"이라 2월 리뷰가 통째로 빠져 있었다.
 *    2023-02부터 4회 전부 동일한 QCIR(분기 인덱스 리뷰) 체계이며, 과거의
 *    Quarterly(2·8월)/Semi-Annual(5·11월) 구분은 폐지됐다 — 2월 누락 재발 방지용 기록.
 *    MSCI가 "Next Eight Index Review Dates"(=2년치 8회)를 한 번에 공표하는 것도
 *    연 4회 체계의 방증이다.
 *
 * ⚠️ effective 값의 규약이 배열 안에서 섞여 있다(2026-07-28 발견, 미정정).
 *    MSCI는 "changes as of the close of X" 와 "Effective date Y"(=X의 다음 영업일)를
 *    함께 공표하는데, 아래 2026-05는 close 날짜(5/29 금)를, 2026-08·11은 effective
 *    날짜(9/1 화, 12/1 화)를 담고 있다. 어느 쪽으로 통일할지는 판단이 필요해 이번엔
 *    건드리지 않았다 — 통일 시 2026-05는 2026-06-01로 바뀐다.
 *
 * TODO(규약): region:'KR'의 의미가 정의돼 있지 않다 — "발표 주체 국가"인지 "영향받는
 *   시장"인지. MSCI는 글로벌 지수사업자(발표는 CET 23:00)라 두 해석이 갈린다.
 *   FOMC/CPI의 'US'도 같은 모호성을 갖는다(그쪽은 둘이 일치해 드러나지 않을 뿐).
 *   규약을 정한 뒤 일괄 정리할 것.
 */
export const MSCI_REVIEWS_2026 = [
  // 2026-07-28 소급 추가: 발표 2/10 (businesswire/MSCI 보도자료), "all changes as of the
  // close of February 27, 2026, Effective date March 02, 2026" → effective는 3/2 채택.
  { announce: '2026-02-10', effective: '2026-03-02', label: '2월' },
  { announce: '2026-05-12', effective: '2026-05-29', label: '5월' },
  { announce: '2026-08-12', effective: '2026-09-01', label: '8월' },
  { announce: '2026-11-11', effective: '2026-12-01', label: '11월' },
];

// MSCI press release 2026-05-12 (ir_dates.pdf) 원문 확인, verifiedAt 2026-07-28
export const MSCI_REVIEWS_2027 = [
  { announce: '2027-02-09', effective: '2027-03-01', label: '2월' },
  { announce: '2027-05-10', effective: '2027-05-28', label: '5월' },
  { announce: '2027-08-12', effective: '2027-09-01', label: '8월' },
  { announce: '2027-11-11', effective: '2027-12-01', label: '11월' },
];

const MSCI_REVIEWS = [...MSCI_REVIEWS_2026, ...MSCI_REVIEWS_2027];

/**
 * 한국은행 금융통화위원회 — 통화정책방향 결정회의(통방)만. **연 8회**.
 * 금융안정회의(3·6·9·12월, 연 4회)는 금리 결정이 없어 제외한다.
 *
 * 발표 시각은 회의 당일 오전(통상 10:00 전후)이고 그 자체가 KST라 time 필드가 불필요하다
 * — FOMC/CPI처럼 ET→KST 환산으로 날짜가 어긋나는 문제가 없다.
 *
 * 출처: 한국은행 "2026년 금융통화위원회 정기회의 개최 및 의사록 공개 예정일정"
 *       (2025-10-30 공표). 개별 일자는 한국은행 통화정책방향 보도자료로 교차 확인
 *       (예: "통화정책방향(2026.4.10)", "통화정책방향(2026.7.16)").
 *       (2026-07-28 확인 — 4/10만 금요일이라 원출처로 따로 재확인했다. 나머지는 목요일.)
 */
export const BOK_MEETINGS_2026 = [
  { date: '2026-01-15' }, { date: '2026-02-26' }, { date: '2026-04-10' }, { date: '2026-05-28' },
  { date: '2026-07-16' }, { date: '2026-08-27' }, { date: '2026-10-22' }, { date: '2026-11-26' },
];

// 2027년 금통위 — ⚠️ 미공표(2026-07-28 확인). 한국은행은 통상 전년 10월경 다음 해
// 일정을 공표한다(2026년분은 2025-10-30 공표).
// TODO(2026-11-01 재확인): 공표되면 채우고 VERIFIED_AT.bok을 함께 갱신할 것.
export const BOK_MEETINGS_2027 = [];

/** 소비부가 참조하는 병합 금통위 일정(날짜 오름차순) */
export const BOK_MEETINGS = [...BOK_MEETINGS_2026, ...BOK_MEETINGS_2027];

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
 * 증시 휴장일 — **만기일 보정 전용 최소 테이블**(2026~2027).
 *
 * 왜 만드는가: getExpiryEvents는 순수 요일 규칙(한국 둘째 목요일 / 미국 셋째 금요일)이라
 * 그 날이 휴장일이면 틀린 날짜를 낸다. 실제로 2026-06-19(금)은 Juneteenth로 NYSE가
 * 전휴장했는데 앱은 그날을 "미국 쿼드러플 위칭데이"로 표시했다(2026-07-28 감사에서
 * 발견, 이미 지나가 정정 대상은 아니지만 사례로 남긴다). 남은 충돌은 2027년 2건이다.
 *
 * ⚠️ 범위를 의도적으로 좁게 잡았다 — 이건 "한국/미국 공휴일 달력"이 아니라 만기일
 *    보정에만 쓰이는 표다. 다른 용도로 재사용하기 전에 완전성을 다시 따져야 한다.
 *    특히 미국 조기폐장(half-day)은 **거래일이므로 일부러 넣지 않았다** — 만기일
 *    보정에 영향이 없고, 넣으면 거래일을 휴장으로 오판한다.
 *    (참고: 2026 조기폐장은 11/27 추수감사절 다음날·12/24 크리스마스 이브, 각 13:00 ET)
 *
 * ⚠️ 커버리지 밖(2028~) 연도는 보정이 조용히 사라진다 — 그래서 getScheduleDepletion의
 *    'holidays' 카테고리로 편입해 표가 소진되기 전에 경고가 뜨게 했다. 다른 하드코딩
 *    배열과 같은 관리 규율(VERIFIED_AT + 출처 주석 + 소진 경고)을 그대로 적용한다.
 *
 * 출처(2026-07-28 확인):
 *  - 한국: 관공서의 공휴일에 관한 규정 + KRX 휴장(근로자의날·연말 폐장일 포함).
 *          요일/대체공휴일 규칙은 전 항목 프로그램으로 검산함(대체공휴일 적용 대상에
 *          현충일이 빠지는 것까지 확인). 2027 부처님오신날(음력 4/8)은 양력 환산이
 *          필요해 별도 교차 확인: time.is 2027 한국 달력 + 웹 검색 모두 5/13(목).
 *  - 미국: NYSE Group 2025~2027 Holiday and Early Closings Calendar.
 *          2026-06-19 Juneteenth 전휴장은 Fidelity/Kiplinger로 교차 확인.
 *
 * 2026 추석 대체공휴일 — **해당 없음으로 확정**(2026-07-28). 설·추석 연휴 대체공휴일은
 * 일요일 겹침 시에만 발생한다(관공서의 공휴일에 관한 규정). 2026년 추석 연휴는
 * 9/24~9/26이고 겹치는 요일이 토요일(9/26)이라 대체가 발생하지 않는다
 * (일요일 9/27은 연휴 밖). 따라서 9/28은 휴장일이 아니며 표에 넣지 않는다.
 *
 * 임시공휴일 — 2026-07-28 기준 신규 지정 없음. 현재 표의 유일한 임시공휴일성 항목은
 * 2026-06-03 지방선거다. ⚠️ 임시공휴일은 수시 지정이라 depletion이 감지할 수 없다
 * (표가 소진된 게 아니라 "채워야 할 항목이 새로 생긴" 것이므로 커버리지 수평선이
 * 움직이지 않는다). 검증층(로드맵 ③) 시간 타당성에서 다룰 것.
 */
export const MARKET_HOLIDAYS_KR_2026 = {
  '2026-01-01': '신정',        '2026-02-16': '설날 연휴',   '2026-02-17': '설날',
  '2026-02-18': '설날 연휴',   '2026-03-01': '삼일절',      '2026-03-02': '삼일절 대체공휴일',
  '2026-05-01': '근로자의날',  '2026-05-05': '어린이날',    '2026-05-24': '부처님오신날',
  '2026-05-25': '부처님오신날 대체공휴일',                  '2026-06-03': '지방선거',
  '2026-06-06': '현충일',      '2026-08-15': '광복절',      '2026-08-17': '광복절 대체공휴일',
  '2026-09-24': '추석 연휴',   '2026-09-25': '추석',        '2026-09-26': '추석 연휴',
  '2026-10-03': '개천절',      '2026-10-05': '개천절 대체공휴일',
  '2026-10-09': '한글날',      '2026-12-25': '성탄절',      '2026-12-31': '증시 폐장일',
};

export const MARKET_HOLIDAYS_KR_2027 = {
  '2027-01-01': '신정',        '2027-02-06': '설날 연휴',   '2027-02-07': '설날',
  '2027-02-08': '설날 연휴',   '2027-02-09': '설날 대체공휴일',
  '2027-03-01': '삼일절',      '2027-05-01': '근로자의날',  '2027-05-05': '어린이날',
  '2027-05-13': '부처님오신날',
  '2027-06-06': '현충일',      '2027-08-15': '광복절',      '2027-08-16': '광복절 대체공휴일',
  '2027-09-14': '추석 연휴',   '2027-09-15': '추석',        '2027-09-16': '추석 연휴',
  '2027-10-03': '개천절',      '2027-10-04': '개천절 대체공휴일',
  '2027-10-09': '한글날',      '2027-10-11': '한글날 대체공휴일',
  '2027-12-25': '성탄절',      '2027-12-27': '성탄절 대체공휴일', '2027-12-31': '증시 폐장일',
};

export const MARKET_HOLIDAYS_US_2026 = {
  '2026-01-01': "New Year's Day",       '2026-01-19': 'MLK Day',
  '2026-02-16': "Presidents' Day",      '2026-04-03': 'Good Friday',
  '2026-05-25': 'Memorial Day',         '2026-06-19': 'Juneteenth',
  '2026-07-03': 'Independence Day(관측)', '2026-09-07': 'Labor Day',
  '2026-11-26': 'Thanksgiving',         '2026-12-25': 'Christmas',
};

export const MARKET_HOLIDAYS_US_2027 = {
  '2027-01-01': "New Year's Day",       '2027-01-18': 'MLK Day',
  '2027-02-15': "Presidents' Day",      '2027-03-26': 'Good Friday',
  '2027-05-31': 'Memorial Day',         '2027-06-18': 'Juneteenth(관측)',
  '2027-07-05': 'Independence Day(관측)', '2027-09-06': 'Labor Day',
  '2027-11-25': 'Thanksgiving',         '2027-12-24': 'Christmas(관측)',
};

/** 지역별 병합 휴장일 — 연도 배열 추가 시 여기만 끼워 넣으면 된다(다른 상수와 동일 규율) */
export const MARKET_HOLIDAYS = {
  KR: { ...MARKET_HOLIDAYS_KR_2026, ...MARKET_HOLIDAYS_KR_2027 },
  US: { ...MARKET_HOLIDAYS_US_2026, ...MARKET_HOLIDAYS_US_2027 },
};

/**
 * 만기일이 휴장일/주말이면 직전 거래일로 앞당긴다(한국·미국 공통 관행).
 * 요일 규칙이 낳는 날짜는 항상 평일이라 주말 검사는 보수적 방어다.
 * 커버리지 밖 연도는 휴일이 조회되지 않아 자연히 무보정 — 기존 동작과 동일하다.
 * @returns {{ date: string, adjustedFrom?: string, adjustedReason?: string }}
 */
/**
 * 휴장일 표의 커버리지 수평선 — KR/US 중 **먼저 끝나는 쪽**의 마지막 날짜.
 * 한쪽만 갱신하고 다른 쪽을 잊는 상황에서 짧은 쪽이 경고를 내야 하기 때문이다.
 * (getScheduleDepletion에서 export하지 않고 내부 사용 — 테스트는 결과로 검증한다)
 */
function holidayCoverageEnd() {
  const ends = ['KR', 'US'].map(r =>
    Object.keys(MARKET_HOLIDAYS[r] ?? {}).reduce((a, b) => (a > b ? a : b), ''));
  return ends.filter(Boolean).reduce((a, b) => (a < b ? a : b), '9999-12-31');
}

function adjustToPrevTradingDay(dateUtc, region) {
  const original = toDateStr(dateUtc);
  const holidays = MARKET_HOLIDAYS[region] ?? {};
  const d = new Date(dateUtc.getTime());
  // 최장 연휴(추석/설 3일 + 주말)를 넘겨도 남는 여유. 10일을 다 써도 못 찾으면
  // 표가 이상한 것이므로 보정을 포기하고 원래 날짜를 낸다(조용한 무한루프 금지).
  for (let i = 0; i < 10; i++) {
    const s = toDateStr(d);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays[s]) {
      return s === original ? { date: s } : { date: s, adjustedFrom: original, adjustedReason: holidays[original] ?? '휴장' };
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return { date: original };
}

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
    // 휴장일이면 직전 거래일로 앞당긴다. 보정이 일어난 경우에만 adjustedFrom/
    // adjustedReason이 붙으므로, 기존 소비부는 date만 읽어 그대로 동작한다.
    const kr = adjustToPrevTradingDay(nthWeekdayOfMonth(year, month, 4, 2), 'KR'); // 목요일=4, 둘째주
    events.push({
      ...kr,
      title: isQuarterly ? '한국 선물옵션 동시만기일(네 마녀의 날)' : '한국 옵션만기일',
      shortLabel: isQuarterly ? '동시만기' : '옵션만기',
      category: 'expiry', region: 'KR',
    });
    if (isQuarterly) {
      const us = adjustToPrevTradingDay(nthWeekdayOfMonth(year, month, 5, 3), 'US'); // 금요일=5, 셋째주
      events.push({
        ...us,
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
 * 이미 과거)면 소진 임박으로 본다. 선물옵션 만기(getExpiryEvents) 자체는 규칙 계산이라
 * 연도 하드코딩이 없어 소진 개념이 없지만, 그 **휴장일 보정 표**(MARKET_HOLIDAYS)는
 * 수동 테이블이므로 'holidays'로 편입했다(2026-07-28).
 * 편입 이유: 표가 소진되면 보정이 조용히 사라지는데, 그 결과가 다른 카테고리보다
 * 위험하다 — FOMC 배열이 비면 캘린더가 비어 눈에 띄지만, 휴장일 표가 비면 만기일이
 * "그럴듯하지만 틀린 날짜"로 계속 표시돼 알아챌 방법이 없다.
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
    { category: 'bok',      dates: BOK_MEETINGS.map(m => m.date) },
    // 휴장일 표는 "이벤트 목록"이 아니라 "커버리지 범위"다 — 마지막 날짜가 곧 수평선.
    // 아래 reduce가 최댓값을 집으므로, KR/US 각각의 최대를 그대로 넣으면 늦게 끝나는
    // 쪽이 이겨 먼저 소진되는 쪽을 가린다. 실질 한계는 먼저 끝나는 쪽이라 min을 넣는다.
    { category: 'holidays', dates: [holidayCoverageEnd()] },
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
//
// ── 날짜 규약(2026-07-28 명문화) ────────────────────────────────
// 셀 날짜 = 현지(ET) 기준, time = KST 환산. 국제 언론 표기와의 일치를 위해 셀은 ET를
// 유지한다("1월 27~28일 FOMC"로 보도되는데 캘린더만 28~29일로 뜨면 대조가 안 된다).
// 대신 한국 사용자에게 실제로 중요한 "결과가 언제 나오나"는 time으로 명시한다 —
// 성명 발표는 종료일 14:00 ET이고 그건 KST로 **다음 날 새벽**이다(EST 04:00 / EDT 03:00).
// CPI(08:30 ET → KST 같은 날 21:30/22:30)와 달리 FOMC만 날짜가 하루 넘어가므로,
// time이 없으면 "FOMC 1/27~1/28"만 보고 1/29 새벽 결과를 놓치게 된다.
const FOMC_STATEMENT_HOUR_ET = 14;
const FOMC_STATEMENT_MIN_ET  = 0;

function fomcEvent(meeting) {
  const { utc, uncertain } = nyWallTimeToUTC(meeting.end, FOMC_STATEMENT_HOUR_ET, FOMC_STATEMENT_MIN_ET);
  return {
    date: meeting.start, endDate: meeting.end, title: 'FOMC 회의', shortLabel: 'FOMC',
    category: 'fomc', region: 'US',
    time: `결과 발표 익일 ${formatKSTHM(utc, uncertain)} KST`,
  };
}

// 금통위 회의 하나를 통합 이벤트 형태로 — 발표가 KST 오전이라 time 없음(위 FOMC 주석 참조).
function bokEvent(meeting) {
  return { date: meeting.date, title: '한국은행 금통위(통화정책방향)', shortLabel: '금통위', category: 'bok', region: 'KR' };
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

  // 금통위
  for (const m of BOK_MEETINGS) {
    const dDay = daysBetween(today, m.date);
    if (dDay < 0 || dDay > days) continue;
    events.push({ ...bokEvent(m), dDay });
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
  for (const m of BOK_MEETINGS) {
    if (m.date.startsWith(prefix)) events.push(bokEvent(m));
  }

  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
