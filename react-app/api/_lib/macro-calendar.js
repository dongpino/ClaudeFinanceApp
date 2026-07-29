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
 * ── 출처 기록 규약(2026-07-29 도입, 필수) ─────────────────────────────
 * 근거 기록 오류가 MSCI·금통위 두 번 재발해(요약본을 "원문 확인"으로 표기) 형식을 고정한다.
 * 모든 항목은 아래 세 가지를 갖춰 적는다. 셋을 못 채우면 그건 확인이 아니다.
 *   [등급]  아래 5단계 어휘 중 하나(2026-07-29 확정)
 *   요청    실제로 던진 URL과 응답 상태 — **실패도 그대로 남긴다**(403/504/파싱실패 포함)
 *   발췌    원문에서 뽑은 문자열. 사람이 같은 URL을 열어 눈으로 대조할 수 있는 최소 단위
 *
 * ── 확인 등급 어휘 ────────────────────────────────────────────────────
 *   자체실측  우리가 수집한 데이터로 값을 검증했다(거래일 캔들 유무 등)
 *   원문      발표 주체의 문서·조문·API에서 직접 추출했다(연준·BLS·MSCI·한국은행·법제처·
 *             우주항공청·NYSE·해당 기업 IR). "누가 발표하는 값인가"의 그 주체여야 한다.
 *   교차확인  발표 주체가 아닌 제3자, 독립 2경로 이상이 일치한다.
 *   벤더확인  단일 데이터 벤더 한 곳(Finnhub·네이버 등). 도달성은 좋지만 권위가 없고
 *             반증할 두 번째 경로가 없다 — '원문'과 절대 섞어 적지 않는다.
 *   관행추정  **매년 개별 공고로 정해지는 값**을 과거 관행에서 추정했다. 관행이 일관되고
 *             과거 사례가 실측되더라도 해당 연도 공고 전까지는 확정이 아니다.
 *             MSCI close와 같은 구조다(규칙은 뻔한데 원문이 나오기 전엔 확정 불가).
 *             반드시 확정 TODO(공고 예상 시점)를 함께 적는다.
 *   미확인    후보값. 규칙 도출·추정·검색 요약만 있는 상태.
 *
 * ⚠️ [원문] 등급에는 **문서 발행일을 필수로 기록한다.** 원문에도 asOf가 있다 — 발행 이후
 *    제도가 바뀌면 원문이라도 낡는다. 발행일 이후 개정 여부 확인이 [원문] 성립 조건이다.
 *    실제 사례: 2026년 월력요항(2025-06-30 발표)은 제헌절·노동절 개정(2026-04) **이전**
 *    문서라 그 표에는 제헌절이 없다. 그것만 보고 "원문에 없으니 휴장일이 아니다"라고
 *    읽으면 정확히 거꾸로 간다.
 *
 * ⚠️ **위 어휘는 서열이 아니라 축이다. 자체실측은 원문보다 상위 등급이 아니라 "과거 항목
 *    전용 검증 수단"이다.** 미래 항목은 원문 등급이 유일한 방어선이며 자체실측으로
 *    대체될 수 없다.
 *      과거 항목 = 자체실측 + 원문  /  미래 항목 = 원문
 *    근거(2026-07-29 휴장일 감사): 누락 4건 중 자체실측이 잡은 것은 이미 지나간
 *    2026-07-17 **1건뿐**이고, 나머지 3건(2027-05-03·07-17·07-19)은 전부 조문이 잡았다.
 *    실측 데이터가 아무리 깨끗해도 아직 오지 않은 날에 대해서는 침묵한다.
 * ⚠️ 열람했다는 사실과 출처의 권위도 다른 축이다. 벤더 API가 HTTP 200을 줬다는 것은
 *    '읽었다'는 뜻이지 '발표 주체가 그렇게 말했다'는 뜻이 아니다(등급 어휘 분리의 이유).
 *
 * ⚠️ 모델이 이미 알고 있던 값을 조회 결과가 반증하지 않는 것은 확인이 아니다.
 *    확인은 원문에서 그 값을 추출했을 때만 성립한다. (CLAUDE.md에도 명시)
 * ⚠️ 열람하지 못한 문서는 출처로 적지 않는다. 접근을 시도했다 실패한 사실은 "요청" 줄에
 *    상태코드로 남기되, 그 문서를 근거인 것처럼 나열하지 않는다.
 * 아래 기록은 2026-07-28~29 실제 세션 로그를 되짚어 재작성한 것이며, 값 자체는 재대조하지
 * 않았다(등급만 사실에 맞게 조정). 등급이 낮은 항목은 값이 틀렸다는 뜻이 아니라 **근거가
 * 그 값을 지지할 만큼 강하지 않다**는 뜻이다.
 *
 * 출처:
 *  - FOMC  [원문]
 *      요청 https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *           (2026-07-28, HTTP 200)
 *      발췌 2026 "January 27-28 (no SEP)" … "December 8-9* (SEP)"
 *           2027 "January 26-27 (no SEP)" … "December 7-8* (SEP)"  → 16건 전건 일치
 *           "each meeting date is tentative until confirmed"
 *      비고 연준 문구는 tentative지만 우리 배열은 tentative 플래그를 쓰지 않는다
 *           (연준 공표분은 사실상 확정으로 취급).
 *
 *  - CPI 2026  [교차확인 — 발표 주체(BLS) 원문은 403 차단, 독립 2경로가 12건 전건 일치]
 *      요청 ① https://www.bls.gov/schedule/news_release/cpi.htm
 *              (2026-07-28, **HTTP 403 Access Denied** — 봇 차단, 원문 대조 불가)
 *           ② https://www.usinflationcalculator.com/inflation/consumer-price-index-release-schedule/
 *              (2026-07-28, HTTP 200)
 *           ③ https://api.stlouisfed.org/fred/release/dates?release_id=10
 *              &include_release_dates_with_no_data=true&realtime_start=2026-01-01
 *              &realtime_end=2027-12-31  (2026-07-28, HTTP 200 — BLS 미러)
 *      발췌 ② "December 2025 | January 13, 2026 | 8:30 AM"(refMonth·시각 포함 표)
 *           ③ "2026: 12건 → 2026-01-13, 2026-02-13, … 2026-12-10"
 *      비고 발표 시각 08:30 ET는 ②의 Time 컬럼에서 온 값이다.
 *
 *  - CPI 2027  [미확인 — 확인 실패이지 "미공표" 단정 아님]  상세는 CPI_RELEASES_2027 주석.
 *      요청 위 ①403 / ②2026-12-10까지만 게재 / ③ HTTP 200이나 "2027: 0건"
 *
 *  - MSCI 2026-08·11 + 2027 4건  [원문]
 *      요청 https://app2.msci.com/eqb/pressreleases/archive/ir_dates.csv
 *           (2026-07-28, HTTP 200, 12508 bytes. www.msci.com 동일 경로도 같은 응답)
 *           ※ 같은 문서의 .pdf 판(www.msci.com/…/ir_dates.pdf)은 WebFetch가 스트림을
 *             파싱하지 못해 실패 → csv 경로로 우회한 것이다.
 *      발췌 "Quarter|Event|Announcement Date|Effective Date"
 *           "Aug, 2026|""Index Review""|08-12-2026|09-01-2026"
 *           "Nov, 2026|""Index Review""|11-11-2026|12-01-2026"
 *           "Feb, 2027|…|02-09-2027|03-01-2027"  "May, 2027|…|05-10-2027|05-28-2027"
 *           "Aug, 2027|…|08-12-2027|09-01-2027"  "Nov, 2027|…|11-11-2027|12-01-2027"
 *      비고 CSV 수록 범위는 Aug 2026 ~ Feb 2028 — **2026-02·2026-05는 이 문서에 없다**.
 *
 *  - MSCI 2026-05 announce/close  [원문]
 *      요청 https://app2.msci.com/webapp/index_ann/DocGet?pub_key=bN889ud22q4%3D&lang=en&format=html
 *           (2026-07-28, HTTP 200)
 *      발췌 "Announcement Date: May 12, 2026 (after 11:00 p.m. CEST)"
 *           "Effective Date: Close of May 29, 2026"
 *
 *  - MSCI 2026-05 effective(2026-06-01)  [미확인 — 도출값]
 *      위 원문은 "Close of May 29"까지만 적는다. 06-01은 ir_dates.csv의 Effective 규약
 *      (close 익영업일)에서 **도출**한 값이며 원문 발췌가 아니다. 값은 그대로 두되 등급만 낮춘다.
 *
 *  - MSCI 2026-02 전체(announce 2/10, close 2/27, effective 3/2)  [미확인 — 제3자 요약]
 *      요청 https://www.businesswire.com/news/home/20260203687223/en/… (2026-07-28, **read ECONNRESET**)
 *      근거 웹 검색 결과 요약 + 제3자 기사(venturasecurities / marketscreener / intellectia).
 *      ⚠️ 종전 주석은 "businesswire 20260210452023"을 인용 출처로 달아 뒀으나 그 문서는
 *         열람하지 못했다 — 출처에서 내리고 등급을 낮춘다(값은 미수정).
 *
 *  - 금통위 2026  [원문]
 *      요청 https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755
 *           (2026-07-29, HTTP 200 — 서버 렌더링 HTML의 "회의일자" 컬럼 직접 추출)
 *      발췌 "01월 15일(목)" "02월 26일(목)" "04월 10일(금)" "05월 28일(목)"
 *           "07월 16일(목)" "08월 27일(목)" "10월 22일(목)" "11월 26일(목)"  → 8건
 *      비고 2026-07-28 시도는 같은 URL이 **HTTP 504**로 실패했고, 그날 배열은 검색 요약본
 *           근거였다(보도자료 본문은 일정을 담지 않고 HWP/PDF 첨부에만 있어 미열람).
 *           2026-07-29에 원문으로 다시 대조해 8건 전건 일치를 확인했다.
 *
 *  - 금통위 2027  [원문 — 미공표]  상세는 BOK_MEETINGS_2027 주석.
 *
 *  - 실적 삼성 2Q26 확정(2026-07-30)  [원문]  ← 발표 주체 문서를 직접 읽었다
 *      요청 https://www.samsung.com/global/ir/ (2026-07-28, HTTP 200)                      ← 원문
 *           https://m.stock.naver.com/api/stock/005930/integration (2026-07-28, HTTP 200)   ← 벤더
 *      발췌 samsung.com 페이지 내 "2Q26 Earnings Conference Call"
 *           irScheduleInfo = {"title":"2026년 2분기 경영실적 발표","irScheduleDate":"2026-07-30"}
 *      비고 종전 값 7/23이 확정 표기(tentative 없음)로 틀려 있던 항목이다. 발표 주체 문서와
 *           벤더가 같은 날짜를 주므로 [원문]이 성립한다(벤더는 보강 경로일 뿐 근거의 본체가 아님).
 *
 *  - 실적 애플 10/28 · 엔비디아 11/17  [벤더확인 — Finnhub 단일]
 *      요청 https://finnhub.io/api/v1/calendar/earnings?from=2026-07-01&to=2026-12-31&symbol=…
 *           (2026-07-28, HTTP 200)
 *      발췌 {"symbol":"AAPL","date":"2026-10-28","hour":"amc","quarter":4,"year":2026}
 *      ⚠️ 2026-07-29 등급 정정: 종전 [원문확인]은 **틀린 등급**이었다. Finnhub는 발표 주체가
 *         아니라 데이터 벤더이고, HTTP 200은 "우리가 읽었다"는 사실일 뿐 "애플이 그렇게
 *         공표했다"가 아니다. 발표 주체(IR)는 아래대로 403이라 반증할 두 번째 경로가 없다 —
 *         그 상태를 등급 어휘로 드러낸다.
 *      비고 같은 대조에서 확정 항목(애플 7/30·엔비디아 8/26)은 정확히 일치 → 기준(ET 표기)은
 *           맞고 요일 규칙 추정치만 하루씩 밀려 있었음이 확인됐다.
 *
 *  - 실적 애플/엔비디아 IR 원문  [미확인 — 접근 실패]
 *      요청 https://investor.apple.com/investor-relations/default.aspx (2026-07-28, HTTP 403, Cloudflare)
 *           https://investor.nvidia.com/events-and-presentations/events/default.aspx (동일 403)
 *      ⚠️ 종전 주석의 출처 표기 "애플 뉴스룸/8-K, NVIDIA 8-K/IR"은 열람하지 못한 문서다 —
 *         출처에서 내린다. 현재 US 실적일의 실제 근거는 위 Finnhub 한 경로뿐이다.
 *
 *  - 실적 tentative 잔여분(삼성 3Q26 10/08·10/29)  [미확인 — 후보값]
 *      근거 과거 패턴/요일 규칙 추정. Finnhub는 KR 종목을 커버하지 않고, 네이버 IR은
 *      "다음 1건"만 노출해 미래 분기를 확인할 수 없다. 회사 공표 시 갱신 대상.
 *
 * ET→KST 변환은 해당 날짜의 실제 서머타임(DST) 여부를 Intl 타임존 데이터로 판정하므로
 * DST 규칙을 직접 하드코딩하지 않고, 매년 값만 넣으면 계속 정확하게 동작한다.
 */

/**
 * 카테고리별 원출처 최종 확인일(YYYY-MM-DD, KST). 배열을 갱신하거나 원문을 재대조했을
 * 때 함께 올린다 — 이 값이 오래됐다는 것 자체가 "일정이 바뀌었어도 모른다"는 신호다.
 * (일정 변경 감지 수단이 없는 현 구조에서 사용자에게 줄 수 있는 최소한의 신빙성 근거)
 */
// ⚠️ 이 날짜는 "그날 대조했다"는 뜻일 뿐 정확성을 보증하지 않는다(삼성 2Q26 전례: 확인일
//    도장이 찍힌 뒤에도 틀린 값이 남아 있었다). 각 카테고리의 **확인 등급**은 위 출처 기록에
//    있으며, 아래 주석에 요약만 병기한다 — 날짜만 보고 신뢰도를 읽지 말 것.
export const VERIFIED_AT = {
  // [원문] federalreserve.gov 원문과 2026·2027 16건 전건 일치.
  fomc:     '2026-07-28',
  // [교차확인] 2026년 12건이 refMonth까지 독립 2경로 일치(BLS 원문은 403 차단이라 [원문] 불가).
  // 2027분은 [미확인](확인 실패) — 배열 주석 참조.
  cpi:      '2026-07-28',
  // [혼합] 2026-08·11 + 2027 4건은 ir_dates.csv [원문], 2026-05 announce/close도
  // MSCI DocGet [원문]. 단 2026-05 effective는 도출값, 2026-02 3필드는 제3자 요약
  // [미확인] — 항목별 등급이 다르므로 이 한 날짜로 뭉뚱그려 읽지 말 것.
  msci:     '2026-07-28',
  // [원문] 2026-07-29 한국은행 회의 목록 원문에서 8건 직접 추출(2026-07-28분은
  // 504 실패 후 검색 요약본 근거였음 — 정정 이력은 출처 기록 참조). 2027분 미공표 확인.
  bok:      '2026-07-29',
  // [혼합] 삼성 2Q26은 [원문](samsung.com IR + 네이버 보강). 애플·엔비디아는
  // [벤더확인](Finnhub 단일 — 2026-07-29 등급 정정, 종전 [원문확인]은 오기).
  // 삼성 3Q26 tentative 2건은 [미확인](요일 규칙 후보값).
  earnings: '2026-07-28',
  // [자체실측 + 원문] 2026-07-29 승격. 2026 거래일 140일을 우리 수집 데이터 3소스로
  // 전건 대조(오탑재 0, 누락 1건 발견 → 추가) + 법제처 조문/우주항공청 월력요항/NYSE 원문.
  // 예외 1건: 2027 부처님오신날 5/13만 [교차확인] — 표 주석 참조.
  holidays: '2026-07-29',
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

// 2027년 CPI — ⚠️ [미확인 — **확인 실패**](2026-07-28). "미공표"로 단정하지 않는다.
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
 * ── 시행 규약(2026-07-28 통일) ─────────────────────────────────
 * **시행 이벤트 = close 날짜(공표 원문 직접 값). effective는 익영업일이며 저장하지 않음.**
 * 혼재 사고 2026-07-28 기록 — 통일 전에는 2026-05가 close 날짜(5/29)를, 2026-08·11이
 * effective 날짜(9/1·12/1)를 담아 같은 배열 안에서 두 규약이 섞여 있었다.
 *
 * close를 택한 이유: 리밸런싱 수급이 close 당일 **종가**에 발생하고, 한국 언론도
 * "X일 장마감 기준 적용"으로 표기한다. effective(익영업일)는 지수에 반영되는 시점일 뿐
 * 거래가 일어나는 날이 아니다.
 *
 * ⚠️ close 날짜는 **역산하지 않는다**. close는 각 리뷰 결과 보도자료에서만 공표된다
 *    (일정표 ir_dates.csv에는 announce/effective만 존재) — 미래 close는 원리적 미확보.
 *    확보 시 close 이벤트로 승격하고 effective 이벤트를 대체한다. 승격 절차는 실적
 *    감시기 설계에 편입 예정(2026-07-28).
 *
 * 시행 이벤트 생성 규칙 — 전 리뷰가 시행 이벤트를 하나씩 갖되 근거가 다르다:
 *    · close 확보분  → close 날짜, "리밸런싱 반영(종가)"
 *    · close 미확보분 → effective 날짜, "지수 반영" + 매매 시점이 전 영업일 종가임을 병기
 *    두 라벨을 구분하는 이유: 같은 "MSCI 리뷰 반영"이라도 전자는 수급이 실제로 터지는
 *    날이고 후자는 지수 구성이 갈리는 날이라, 하나로 뭉뚱그리면 하루 오해가 생긴다.
 *    effective를 close인 척 쓰지 않으므로 역산 금지 규칙과 충돌하지 않는다.
 *
 * TODO(규약): region:'KR'의 의미가 정의돼 있지 않다 — "발표 주체 국가"인지 "영향받는
 *   시장"인지. MSCI는 글로벌 지수사업자(발표는 CET 23:00)라 두 해석이 갈린다.
 *   FOMC/CPI의 'US'도 같은 모호성을 갖는다(그쪽은 둘이 일치해 드러나지 않을 뿐).
 *   규약을 정한 뒤 일괄 정리할 것.
 */
// 필드 3종의 의미(어느 것도 close↔effective 사이를 역산해 채우지 않는다):
//   announce  : ir_dates.csv 원문(2026-05-12 공표분) 및 개별 사전공지
//   close     : 각 리뷰 **결과** 보도자료의 "as of the close of X" 문구
//   effective : ir_dates.csv의 Effective Date 컬럼(또는 결과 보도자료의 "Effective date")
// ⚠️ 2026-07-29 정정: 종전 이 자리에 "전부 공표 원문 값"이라고 적혀 있었으나 사실이 아니다.
//    항목별 확인 등급이 갈린다 — 아래 각 항목 주석과 파일 상단 출처 기록 참조.
//    (2026-02 3필드 = 제3자 요약, 2026-05 effective = 도출값)
export const MSCI_REVIEWS_2026 = [
  // ⚠️ [미확인 — 제3자 요약] 3필드 전부. businesswire 원문은 read ECONNRESET으로 못 읽었고,
  //   근거는 검색 요약 + 제3자 기사(venturasecurities/marketscreener/intellectia)다.
  //   종전 주석이 인용 출처로 달아 뒀던 "businesswire 20260210452023"은 열람하지 못한
  //   문서라 내렸다(2026-07-29 정정). 값은 건드리지 않았다 — 재확인 대상.
  //   ir_dates.csv는 Aug 2026부터 실려 있어 이 리뷰를 담지 않는다.
  { announce: '2026-02-10', close: '2026-02-27', effective: '2026-03-02', label: '2월' },
  // announce/close [원문] MSCI DocGet(app2.msci.com, HTTP 200):
  //   "Announcement Date: May 12, 2026 (after 11:00 p.m. CEST)"
  //   "Effective Date: Close of May 29, 2026"
  // ⚠️ effective(06-01)는 [미확인 — 도출값]: 위 원문은 "Close of May 29"까지만 적는다.
  //   06-01은 ir_dates.csv의 Effective 규약(close 익영업일)에서 도출했다. 값은 유지.
  { announce: '2026-05-12', close: '2026-05-29', effective: '2026-06-01', label: '5월' },
  // announce/effective [원문] ir_dates.csv: "Aug, 2026|""Index Review""|08-12-2026|09-01-2026"
  // TODO(close 날짜 원문 미확인): 미래 리뷰라 결과 보도자료가 아직 없다. 발표일(8/12)
  //   이후 "as of the close of X"를 확인해 close로 승격할 것. effective는 ir_dates.csv
  //   원문값이며 close 자리에 옮겨 적지 말 것(그건 역산이다).
  { announce: '2026-08-12', effective: '2026-09-01', label: '8월' },
  // announce/effective [원문] ir_dates.csv: "Nov, 2026|""Index Review""|11-11-2026|12-01-2026"
  // TODO(close 날짜 원문 미확인): 위와 동일.
  { announce: '2026-11-11', effective: '2026-12-01', label: '11월' },
];

// [원문] announce/effective 4건 모두 ir_dates.csv(2026-05-12 공표분, HTTP 200)의
// 컬럼값 그대로다 — 발췌: "Feb, 2027|…|02-09-2027|03-01-2027" "May, 2027|…|05-10-2027|05-28-2027"
// "Aug, 2027|…|08-12-2027|09-01-2027" "Nov, 2027|…|11-11-2027|12-01-2027".
// close는 4건 모두 미래 리뷰라 원문이 존재하지 않는다(TODO).
// ⚠️ 2027-05만 effective가 월초가 아니라 05-28이다 — MSCI 원문이 그러하므로 그대로 둔다
//    (다른 분기는 03-01 / 09-01 / 12-01). 오탈자로 보고 "고치지" 말 것.
export const MSCI_REVIEWS_2027 = [
  { announce: '2027-02-09', effective: '2027-03-01', label: '2월' },  // TODO(close 원문 미확인)
  { announce: '2027-05-10', effective: '2027-05-28', label: '5월' },  // TODO(close 원문 미확인)
  { announce: '2027-08-12', effective: '2027-09-01', label: '8월' },  // TODO(close 원문 미확인)
  { announce: '2027-11-11', effective: '2027-12-01', label: '11월' }, // TODO(close 원문 미확인)
];

const MSCI_REVIEWS = [...MSCI_REVIEWS_2026, ...MSCI_REVIEWS_2027];

/**
 * 한국은행 금융통화위원회 — 통화정책방향 결정회의(통방)만. **연 8회**.
 * 금융안정회의(3·6·9·12월, 연 4회)는 금리 결정이 없어 제외한다.
 *
 * 발표 시각은 회의 당일 오전(통상 10:00 전후)이고 그 자체가 KST라 time 필드가 불필요하다
 * — FOMC/CPI처럼 ET→KST 환산으로 날짜가 어긋나는 문제가 없다.
 *
 * 출처 [원문]
 *   요청 https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755
 *        (2026-07-29 원문 목록 전건 대조, HTTP 200, "회의일자" 컬럼 직접 추출)
 *   발췌 "01월 15일(목)" "02월 26일(목)" "04월 10일(금)" "05월 28일(목)"
 *        "07월 16일(목)" "08월 27일(목)" "10월 22일(목)" "11월 26일(목)"
 *   비고 4/10만 금요일이고 나머지는 목요일 — 원문도 그렇게 적혀 있다(오탈자 아님).
 *
 * ⚠️ 정정 이력(2026-07-29): 종전 주석은 이 배열의 출처를 한국은행 보도자료
 *    "2026년 금융통화위원회 정기회의 개최 및 의사록 공개 예정일정"(2025-10-30 공표)으로
 *    적고 "4/10은 원출처로 따로 재확인했다"고 밝혔으나, 둘 다 사실과 달랐다.
 *    · 그 보도자료 **본문에는 일정이 없다**(HWP/PDF 첨부에만 수록, 첨부는 미열람) —
 *      열람하지 않은 문서라 출처에서 내렸다.
 *    · 회의 목록 원문은 2026-07-28에 HTTP 504로 실패했고, 그날의 8건은 검색 결과
 *      요약문과 언론 기사(월 단위 + 첫 회의일)에서 온 값이었다.
 *    값 자체는 2026-07-29 원문 대조에서 8건 전건 일치했다 — 값이 아니라 근거 기록이 틀렸다.
 */
export const BOK_MEETINGS_2026 = [
  { date: '2026-01-15' }, { date: '2026-02-26' }, { date: '2026-04-10' }, { date: '2026-05-28' },
  { date: '2026-07-16' }, { date: '2026-08-27' }, { date: '2026-10-22' }, { date: '2026-11-26' },
];

// 2027년 금통위 — ⚠️ **미공표**. [원문]
//   요청 위와 같은 URL + &pYear=2027 (2026-07-29, HTTP 200)
//   발췌 <h3>2027년</h3> + selected="selected" 2027 — 그런데 **목록 0건**
//   판독 2026 목록은 아직 열리지 않은 회의(10/22·11/26)도 그대로 표시한다. 즉 이 표는
//        "개최분"이 아니라 "공표된 예정분"을 싣는다 → 빈 표 = 미개최가 아니라 **미공표**.
//   비고 한국은행은 통상 전년 10월경 다음 해 일정을 공표한다(2026년분은 2025-10-30 공표).
//   ⚠️ 2026-07-28판 주석은 같은 결론을 적으면서 근거가 "검색 결과에 2027 링크가 없었다"뿐이었다
//      (확인 시도 0건). 결론은 같아도 그건 확인이 아니다 — 그래서 위 요청/발췌로 대체했다.
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

// 2027년 실적 — ⚠️ **의도적으로 비워 둔다**(2026-07-29 판단). Finnhub는 2027 날짜를 준다
//   (AAPL 2027-01-27, NVDA 2027-02-23 amc — 2026-07-29 조회). 그런데 이 값은 **기업 공표가
//   아니라 벤더 추정값**이다. tentative:true는 이 파일에서 "회사가 아직 공식 공표하지 않아
//   과거 패턴으로 추정한 날짜"를 뜻하는데, 벤더 추정을 여기에 넣으면 그 의미가 희석된다
//   ("기업이 잠정 공표함"과 "벤더가 찍어 줌"이 한 배지로 뭉개진다 — 상태판에서 stale 배지를
//   다른 뜻으로 재사용하길 거부한 것과 같은 이유다).
//   비워 두면 getScheduleDepletion이 커버리지 소진을 경고하므로 조용히 묻히지도 않는다.
//   기업 공표(IR 공지/8-K)가 확인되면 그때 채운다.
export const EARNINGS_EVENTS_2027 = [];

/** 소비부가 참조하는 병합 실적 일정(날짜 오름차순) */
export const EARNINGS_EVENTS = [...EARNINGS_EVENTS_2026, ...EARNINGS_EVENTS_2027];

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
 * 출처 — 2026-07-29 **[미확인] → [자체실측 + 원문]으로 승격**(근거 3종을 모두 확보).
 *
 *  - 한국  [자체실측 + 원문]
 *    ① [자체실측] 우리가 이미 쓰는 수집 경로의 일봉으로 2026 거래일을 전건 대조했다.
 *         구간 2026-01-02 ~ 2026-07-29(거래일 140일), 소스 3종 전부 일치 —
 *         Naver 지수 KOSPI·KOSDAQ (m.stock.naver.com/api/index/{code}/price),
 *         Daum 개별종목 (finance.daum.net/api/charts/A005930/days)
 *       결과: 표에 있던 11건은 전부 실측 휴장과 일치, **오탑재 0건**,
 *             누락 1건(2026-07-17) 발견 → 이번에 추가. 3소스 모두 7/16·7/20은 거래, 7/17만 없음.
 *       ⚠️ 실측은 과거분만 가능하다 — 2026-08 이후와 2027 전체는 아래 ②③에만 의존한다.
 *    ② [원문] 국가법령정보센터 「관공서의 공휴일에 관한 규정」
 *         [시행 2026. 5. 11.] [대통령령 제36290호, 2026. 4. 30., 일부개정]
 *         https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=285779&chrClsCd=010202&efYd=20260511
 *         (2026-07-29, HTTP 200. 최초 URL(/법령/관공서의공휴일에관한규정)은 1294B 프레임
 *          셸이라 조문이 안 나온다 — iframe이 부르는 위 lsInfoR.do가 본문이다.)
 *       발췌 제2조(공휴일) "2. 「국경일에 관한 법률」에 따른 국경일" / "6. 노동절(5월 1일)"
 *            제3조(대체공휴일) ① "제2조 제2호부터 제10호까지의 공휴일이 …
 *              1. 제2조 제2호, 제5호부터 제7호까지 또는 제10호의 공휴일이 토요일이나
 *                 일요일과 겹치는 경우
 *              2. 제2조 제4호 또는 제9호의 공휴일이 일요일과 겹치는 경우"
 *       → 제헌절은 국경일(제2호)이므로 **대체공휴일 적용 대상이고 토요일 겹침도 포함**된다.
 *         현충일(제8호)은 제3조제1항 어느 호에도 없으므로 대체 대상이 아니다.
 *       제·개정이유(https://www.law.go.kr/LSW/lsRvsDocInfoR.do?lsiSeq=285779, HTTP 200):
 *            "제헌절을 공휴일로 지정 … 노동절을 공휴일로 지정 … 「공휴일에 관한 법률」이
 *             개정(법률 제21338호, 2026. 2. 10. 공포, 5. 11. 시행 및 법률 제21543호,
 *             2026. 4. 9. 공포, 5. 1. 시행)됨에 따라 … 제헌절 및 노동절이 토요일이나
 *             일요일 또는 다른 공휴일과 겹치는 경우에는 … 첫 번째 비공휴일을 대체공휴일로
 *             지정하려는 것임"
 *    ②-1 [원문] 우주항공청 「2026년 월력요항」 발표 — **발행일 2025-06-30**
 *         https://www.kasa.go.kr/bbs/BBSMSTR_000000000010/view.do?nttId=B000000001860Pe2zT3
 *         (2026-07-29 조회, HTTP 200)
 *       발췌 "토요일과 겹치는 공휴일 4일(현충일(6.6), 광복절(8.15), 추석연휴 마지막 날(9.26),
 *              개천절(10.3))"
 *            "8월 15~17일(광복절, 일요일 및 광복절 대체공휴일, 3일), 9월 24~27일(추석연휴 및
 *              일요일, 4일), 10월 3~5일(개천절, 일요일 및 개천절 대체공휴일, 3일),
 *              10월 9~11일(한글날 및 토·일요일, 3일), 12월 25~27일(기독탄신일 및 토·일요일, 3일)"
 *       → 2026 하반기 공휴일 전건이 표와 일치(누락·오탑재 0).
 *       ⚠️ **발행일 함정**: 이 문서는 2025-06-30 발표라 제헌절·노동절 개정(2026-04-30) **이전**
 *          이다. 그래서 "2026 공휴일 70일"이고 **제헌절이 실려 있지 않다**. 우리 제헌절 근거는
 *          조문 + 자체실측 + 아래 2027년 월력요항의 소급 서술이지 이 문서가 아니다.
 *          (2027년 월력요항: "노동절·제헌절의 공휴일 지정('26.4.)으로 2026년 월력요항 대비
 *           공휴일이 2일 증가")  [원문] 등급이라도 발행일 이후 개정 여부를 봐야 하는 실례다.
 *    ③ [원문] 우주항공청 「2027년 월력요항」 발표 — **발행일 2026-06-29** (천문법상 달력 기준)
 *         https://www.kasa.go.kr/prog/plcyBrf/brief/kor/sub01_01_04/view.do?plcyBrfNo=431
 *         (2026-07-29, HTTP 200. 등록일 2026-06-29)
 *       발췌 "올해부터 관공서의 공휴일로 지정된 노동절·제헌절"
 *            "토요일과 겹치는 공휴일 5일(설 연휴 첫날(2.6.), 노동절(5.1.), 제헌절(7.17.),
 *              한글날(10.9.), 기독탄신일(12.25.))"
 *            "5월 1~3일(노동절, 일요일 및 노동절 대체공휴일, 3일) …
 *             7월 17~19일(제헌절, 일요일 및 제헌절 대체공휴일, 3일)"
 *            "설날(2.7), 현충일(6.6), 광복절(8.15), 개천절(10.3)이 일요일과 겹쳐 실질적인
 *              총 공휴일은 72일"  ← 현충일에 대체가 없다는 방증(있으면 줄지 않는다)
 *       ⚠️ 붙임 「2027년 월력요항」 HWPX 원문은 미확보 — FileDown.do 직접 호출이 세션
 *          없이는 에러페이지를 준다. HWPX는 ZIP(OWPML)이라 받기만 하면 파싱 가능하다.
 *          TODO: 확보되면 음력 기반 항목(부처님오신날·설날·추석)을 [원문]으로 승격할 것.
 *
 *  - 2027 부처님오신날 5/13  [교차확인]  ← 이 표에서 유일하게 원문 미확보 항목
 *      주근거 ① 국제뉴스(2026-05-24)
 *           https://www.gukjenews.com/news/articleView.html?idxno=3591025
 *           2027 부처님오신날 = 음력 4월 8일 → 양력 5월 13일 목요일, 평일이라 대체공휴일 없음
 *      주근거 ② 나무위키 "부처님오신날" — 음력 4월 8일의 양력 대응 연도 목록에서
 *           2027년이 "5월 13일" 그룹에 편입돼 있음
 *      ⚠️ 취득 경로 명시(규약상 필수): 위 두 건은 **Claude 대화 세션 검색으로 취득**
 *         (2026-07-29)한 것이고 **Claude Code가 직접 fetch한 결과가 아니다**. 즉 이 파일의
 *         다른 항목들과 달리 "요청 URL + 응답 상태"를 우리가 기록하지 못했다.
 *      참고근거 https://publicholidays.co.kr/ko/2027-dates/ (2026-07-29, HTTP 200, 직접 취득)
 *           발췌 "5월 13일|목요일|부처님 오신 날"
 *         ⚠️ 주근거에서 내렸다 — 같은 표가 조문에 반하는 항목을 싣는다. 2027-06-07을
 *            "현충일 휴일"로 넣었는데(현충일=제2조제8호, 제3조제1항 어느 호에도 없어
 *            대체 대상이 아니다) 제헌절 대체(7/19)는 빠뜨렸다. 5/13을 지지하기는 하나
 *            이 출처 자체의 정확도가 낮다는 사실을 근거와 함께 남긴다.
 *      ⚠️ 직접 fetch로 확보하려던 다른 제3자는 전부 실패했다 — timeanddate.com 403,
 *         dallyeok.com 403, ko.wikipedia(부처님 오신 날) 2027 미수록.
 *      TODO(원문 승격): 월력요항 붙임 HWPX(위 ③)를 확보하면 곧바로 [원문]으로 올릴 것.
 *
 *  - 연말 폐장일(2026-12-31·2027-12-31)  [관행추정]
 *      ⚠️ 성격: 공휴일이 아니라 **거래소가 매년 12월 개별 공고로 지정**하는 휴장일이다.
 *         그래서 조문에도 월력요항에도 KASI에도 없다. 관행은 일관되나 **해당 연도 공고
 *         전까지 확정이 아니다** — MSCI close와 같은 구조(규칙은 뻔한데 원문이 나오기 전엔
 *         확정 불가)라 같은 등급 어휘를 쓴다.
 *      근거 ① [자체실측] 2025-12-31(수)은 평일인데 KOSPI 캔들이 없다. 마지막 거래일은
 *              2025-12-30(화), 재개는 2026-01-02(금).
 *              scripts/fixtures/kr-trading-days.json에 그 구간을 담아 회귀로 고정했다.
 *           ② [교차확인 — 사용자 제공] 한경BUSINESS·비즈니스포스트(2025-12-18): KRX가 31일을
 *              연말 휴장일로 지정, 30일이 최종 매매거래일. ⚠️ 이 두 건은 사용자가 제시한
 *              것이며 Claude Code가 직접 fetch하지 않았다(요청 URL·상태 미기록).
 *      ⚠️ KRX 원문은 **5경로 전부 실패**(2026-07-29):
 *           open.krx.co.kr/…/MKD01100305.jsp        HTTP 200이나 JS 렌더 — 날짜 0건
 *           GenerateOTP.jspx → MKD99000001.jspx     HTTP 404 (구 엔드포인트 폐지)
 *           data.krx.co.kr/…/MDCHARD002.cmd         HTTP 200이나 "로그인 또는 회원가입이 필요합니다"
 *           law.krx.co.kr(법규검색)                  프레임셋 804B + JS 렌더, 조문 미도달
 *           regulation.krx.co.kr/…/RGL04010102.jsp  HTTP 200이나 본문 JS 렌더(게다가 금시장 페이지)
 *      TODO(2026-12-01 확정): 그해 KRX 공고가 나오면 값을 재확인하고 등급을 올릴 것.
 *         2027-12-31도 같은 성격이라 2027-12-01에 다시 본다.
 *
 *  - 미국  [원문]
 *      요청 https://www.nyse.com/trade/hours-calendars (2026-07-29, HTTP 200)
 *           ※ 페이지 자체에 발행일 표기가 없다 — 조회일만 기록한다(2026·2027·2028 3개년 게재).
 *           ※ 종전 주석이 적던 /markets/hours-calendars는 **302**다 — 리다이렉트를 따라야 한다.
 *      발췌 "All NYSE markets observe U.S. holidays as listed below for 2026, 2027, and 2028."
 *           2026 "New Year's Day Thursday, January 1 … Independence Day Friday, July 3
 *                 (Independence Day observed) … Christmas Day Friday, December 25"
 *           2027 "Friday, January 1 … Juneteenth … Friday, June 18 (observed) …
 *                 Christmas Day … Friday, December 24 (Christmas Day observed)"
 *      결과 2026·2027 **20건 전건이 표와 일치**(수정 없음).
 *      조기폐장 주석: NYSE 원문 "close early at 1:00 p.m. … on Friday, November 27, 2026,
 *           Friday, November 26, 2027" — 거래일이므로 표에 넣지 않는다는 기존 규율 그대로.
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
// 라벨 '근로자의날' → '노동절' 확정(2026-07-29). 법률 제21543호(2026-04-09 공포,
// 2026-05-01 시행)로 **법정공휴일 '노동절'**이 됐고 규정 제2조제6호가 "노동절(5월 1일)"이다.
// 소급 케이스는 존재하지 않는다 — 표의 두 항목(2026-05-01·2027-05-01)이 모두 시행일
// 이후이고, 2026-05-01은 정확히 시행일 당일이라 그날부터 노동절이다.
// (근로자의날은 원래 관공서 공휴일이 아니라 「근로자의 날 제정에 관한 법률」상 유급휴일이고
//  KRX가 별도로 휴장하던 날이다. 이제는 공휴일이라 대체공휴일 규정까지 적용된다 —
//  2027-05-03이 그 결과다.)
export const MARKET_HOLIDAYS_KR_2026 = {
  '2026-01-01': '신정',        '2026-02-16': '설날 연휴',   '2026-02-17': '설날',
  '2026-02-18': '설날 연휴',   '2026-03-01': '삼일절',      '2026-03-02': '삼일절 대체공휴일',
  '2026-05-01': '노동절',  '2026-05-05': '어린이날',    '2026-05-24': '부처님오신날',
  '2026-05-25': '부처님오신날 대체공휴일',                  '2026-06-03': '지방선거',
  '2026-06-06': '현충일',
  // 2026-07-29 추가(누락분). 규정 제2조제2호(국경일) + 「국경일에 관한 법률」상 제헌절.
  // 대통령령 제36290호(2026-04-30 공포, 제2호 개정규정 2026-05-11 시행)로 공휴일 복귀.
  // [자체실측] 2026-07-17 캔들 없음 — Naver KOSPI/KOSDAQ, Daum 005930 3소스 전부(7/16·7/20은 거래).
  '2026-07-17': '제헌절',
  '2026-08-15': '광복절',      '2026-08-17': '광복절 대체공휴일',
  '2026-09-24': '추석 연휴',   '2026-09-25': '추석',        '2026-09-26': '추석 연휴',
  '2026-10-03': '개천절',      '2026-10-05': '개천절 대체공휴일',
  '2026-10-09': '한글날',      '2026-12-25': '성탄절',
  // [관행추정] 공휴일이 아니라 KRX가 매년 12월 개별 공고로 지정하는 휴장일이다.
  // 조문·월력요항에 없다 — 근거는 자체실측(2025-12-31 평일 휴장)과 언론. 상단 출처 기록 참조.
  // TODO(2026-12-01): 그해 KRX 공고로 확정할 것.
  '2026-12-31': '증시 폐장일',
};

export const MARKET_HOLIDAYS_KR_2027 = {
  '2027-01-01': '신정',        '2027-02-06': '설날 연휴',   '2027-02-07': '설날',
  '2027-02-08': '설날 연휴',   '2027-02-09': '설날 대체공휴일',
  '2027-03-01': '삼일절',      '2027-05-01': '노동절',
  // 2026-07-29 추가(누락분). 노동절(5/1)이 토요일 → 규정 제3조제1항제1호(제2조제6호가
  // 토요일과 겹침) → 다음의 첫 번째 비공휴일. 5/2는 일요일(제1호 공휴일)이라 5/3(월).
  // 월력요항 원문: "5월 1~3일(노동절, 일요일 및 노동절 대체공휴일, 3일)"
  '2027-05-03': '노동절 대체공휴일',
  '2027-05-05': '어린이날',
  '2027-05-13': '부처님오신날',
  '2027-06-06': '현충일',
  // ⚠️ 2027-06-07(월)을 "현충일 대체공휴일"로 싣는 제3자 달력이 있으나(publicholidays.co.kr
  //    실측 확인) 조문상 **오류**다. 현충일은 규정 제2조제8호이고 제3조제1항 어느 호에도
  //    제8호가 없다 → 대체 대상 아님. 월력요항도 현충일이 일요일과 겹쳐 공휴일 수가
  //    "줄었다"고 서술한다(대체가 생겼다면 줄지 않는다). 넣지 말 것.
  // 2026-07-29 추가(누락분). 제헌절(7/17)이 토요일 → 제3조제1항제1호(제2조제2호=국경일이
  // 토요일과 겹침) → 7/18은 일요일이라 7/19(월).
  // 월력요항 원문: "7월 17~19일(제헌절, 일요일 및 제헌절 대체공휴일, 3일)"
  '2027-07-17': '제헌절',      '2027-07-19': '제헌절 대체공휴일',
  '2027-08-15': '광복절',      '2027-08-16': '광복절 대체공휴일',
  '2027-09-14': '추석 연휴',   '2027-09-15': '추석',        '2027-09-16': '추석 연휴',
  '2027-10-03': '개천절',      '2027-10-04': '개천절 대체공휴일',
  '2027-10-09': '한글날',      '2027-10-11': '한글날 대체공휴일',
  '2027-12-25': '성탄절',      '2027-12-27': '성탄절 대체공휴일',
  // [관행추정] 위 2026-12-31과 동일 성격. TODO(2027-12-01): 그해 KRX 공고로 확정.
  '2027-12-31': '증시 폐장일',
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
    // announce는 항상 있고 close는 확인된 것만 있다 — 둘 다 넣어 실제 커버리지 끝을 잡는다
    // (close만 보면 미확인분 때문에 수평선이 과도하게 짧아 오탐이 난다).
    { category: 'msci',     dates: MSCI_REVIEWS.flatMap(r => [r.announce, r.close]).filter(Boolean) },
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
  const events = [
    { date: rev.announce, title: `MSCI ${rev.label} 리뷰 발표`, shortLabel: 'MSCI', category: 'msci', region: 'KR' },
  ];
  // 시행 이벤트는 전 리뷰가 갖되 근거에 따라 날짜·라벨이 다르다(규약 주석 참조).
  // effective를 close인 척 쓰지 않는 것이 핵심 — 라벨이 다르므로 오해가 없다.
  if (rev.close) {
    events.push({
      date: rev.close, title: `MSCI ${rev.label} 리밸런싱 반영(종가)`,
      shortLabel: 'MSCI', category: 'msci', region: 'KR',
    });
  } else if (rev.effective) {
    // 설명을 title에 넣는 이유: CalendarPage의 이벤트 행은 title/region/time만 렌더하고
    // note 같은 부가 필드를 표시하지 않는다 — 별도 필드로 두면 사용자에게 안 보인다.
    events.push({
      date: rev.effective, title: `MSCI ${rev.label} 지수 반영(리밸런싱 매매는 전 영업일 종가)`,
      shortLabel: 'MSCI', category: 'msci', region: 'KR',
    });
  }
  return events;
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
