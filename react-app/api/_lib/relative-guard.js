/**
 * api/_lib/relative-guard.js — **검사 2a(상대 타당성 — 가격 축)**. 순수 로직, 네트워크·Redis 없음.
 *
 * 검사 1(절대 타당성)이 "값 하나만 보고 알 수 있는 것"을 담당했다면 여기는 **두 값을
 * 견줘야 알 수 있는 것**을 본다. 1단계 조사에서 범위를 크게 좁혔다:
 *   · C(교차소스 대조) — price ↔ history[-1]
 *   · 평탄성(파서 동결) — history가 여러 날 완전히 같은 값
 * 급변·뉴스 교차확인·naver-index 400은 제외했다(근거는 파일 하단 EXCLUDED 주석).
 *
 * ── 두 축을 본다: 가격 축 + change 축 ────────────────────────────────
 * 거래일 정렬을 세운 뒤 change 축을 편입했다(2026-07-30). prevClose는 **수집기가 손대기
 * 전의 원본 좌표**(originOf)로 잡고 전 거래일 종가와 대조한다 — 레벨 축과 같은 양자화
 * 허용오차를 쓰되 반올림이 두 번 겹치므로 2양자를 허용한다.
 *
 *   커버 상태 — 검사 1이 넘긴 미커버 4건 중:
 *     ① 네이버 장전 quote change=0            → **정렬로는 미커버(2026-07-31 정정).**
 *        change=0이면 price==prev_close라 same-day·prev-day 신호가 동시에 참이 되는데
 *        (축퇴) 정렬은 prev-day를 택해 잔차 0으로 통과시킨다. 그래야 확장시간 견적의
 *        정상적인 개장 전 보합이 오탐이 되지 않는다 — 대가로 "당일 캔들이 있는데 change가
 *        잘못 0"인 경우를 놓친다. TODO(검사 2b): 전용 change-zero 축으로 분리할 것.
 *     ② us10y r2 반올림 뭉갬                   → **미커버(원리적).** 오차가 정의상 1양자
 *        미만이라 값 대조로는 잡을 수 없다. observations의 internal-prevclose가 그 증상을
 *        관측하지만 임계 산정 전이라 계상하지 않는다.
 *     ③ recalcChange 검증                      → **커버.** 축을 원본 좌표로 돌리므로 재계산이
 *        만들어 낸 항등이 검사에 섞이지 않는다(originOf).
 *     ④ detectIssues 0경고인데 change 오류      → **부분 커버.** 오차가 2양자 허용을 넘을 때.
 *
 * ── 시계 게이팅을 없앤 이유, 그리고 시계로 대체하지도 않은 이유 ──────
 * 종전에는 폐장일 때만 돌렸다. "장중엔 price와 history[-1]이 어긋나는 게 정상"이라서였는데,
 * 그 어긋남은 **어느 캔들과 견주는지를 잘못 고른 결과**였다(vix 11.859%는 정확히 VIX의
 * 1일 변동폭이었다). 거래일을 맞추면 장중에도 견줄 짝이 있다 — 당일 캔들이 없으면 가격
 * 축이 성립하지 않을 뿐이고 change 축은 그대로 돈다.
 *
 * ⚠️ 그런데 8b0f452는 폐장 시계를 **거래일 시계로 바꿨을 뿐**이라 시계가 틀리면 그대로
 *    틀렸고, 실제로 틀려서 revert됐다(오탐 5건). 그래서 지금은 정렬을 **소스가 돌려준 값**
 *    에서 먼저 파생하고(alignBySignal) 시계는 그 값과 **합의할 때만** 쓴다. 두 축이 어긋난
 *    회차는 통과도 위반도 아닌 alignment-ambiguous로 남긴다 — 어제 사고는 두 축이 어긋난
 *    것을 한쪽이 조용히 이겨서 났다.
 *
 * ⚠️ **차단하지 않는다. 경보만 한다.** 이 검사는 이미 서빙된 값의 사후 검증이라 막을
 *    대상이 없다(검사 1은 캐시 진입 전이라 차단이 성립했다). 서빙 경로에 개입하지 않음은
 *    market-data.js:243에서 반환값을 쓰지 않는 것으로 코드상 보장된다.
 * ⚠️ **C 위반이 곧 price 오류라는 뜻이 아니다.** history 쪽 파서가 깨졌을 수도 있다 —
 *    어느 쪽이 틀렸는지는 이 검사로 알 수 없으므로 문구를 "양측 불일치"로 중립하게 쓴다.
 */

import { ASSET_META, isFlatExempt, isDailyCadence } from './asset-meta.js';
import { MARKET_HOLIDAYS } from './macro-calendar.js';

// ── 실행 조건: 폐장 판정 ─────────────────────────────────────────────
// 장중에는 price(실시간)와 history[-1](전일 또는 지연 종가)이 어긋나는 게 **정상**이라
// C 검사가 성립하지 않는다. 그래서 폐장일 때만 돌린다.
// ⚠️ TODO(2026-09-14): 애프터마켓(16:00~20:00 KST) 시행 시 KR 세션 종료를 20:00으로
//    옮겨야 한다. 그전에 반영하지 않으면 16~20시 사이가 '폐장'으로 잘못 잡혀 오탐이 난다.
//
// ── 세션은 두 종류다(2026-07-30 분리) ────────────────────────────────
// intraday   : 하루 안에 개장·폐장이 있다. KR·US 주식(nasdaq·dow·sp500·sox·vix·개별종목).
// continuous : **평일 연속. 주말만 폐장.** FX·금리(dxy·us10y)가 여기 속한다.
//
// ⚠️ 왜 분리하는가 — 종전에 dxy·us10y를 US(주식) 세션으로 묶은 것이 오탐의 직접 원인이었다.
//    16:00 ET에 주식이 닫혀도 FX·금리는 계속 거래되므로, 그 시간대의 price는 여전히 살아
//    있는 값이고 history[-1](전일 종가)과 벌어지는 게 **정상**이다. US 세션 기준으로는
//    그 구간이 'after-hours=폐장'이라 검사가 돌아 버렸다. 실측:
//    [저장소:9072dee8:health:validate:fields:relative@2026-07-30T00:38:40Z]
//      us10y  1.493% 위반 @2026-07-29T22:59:14.826Z (=18:59 ET, 주식 폐장·금리 거래중)
//    같은 회차에 조회한 현재 스냅샷도 1.071%로 여전히 임계를 넘는다 — 상시 오탐이었다.
const SESSION = {
  KR: { kind: 'intraday', tz: 'Asia/Seoul',       open: 9 * 60,      close: 15 * 60 + 30, holidays: 'KR' },
  US: { kind: 'intraday', tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60,      holidays: 'US' },
  // FX·금리 — 주말 폐장 창을 **일요일 재개 시각(17:00 ET)까지만**으로 좁힌다.
  //
  // ⚠️ 비대칭이 의도적이다. 금요일 17:00 ET 이후를 '개장'으로 남기면 검사 기회를 잃지만,
  //    일요일 저녁 재개 구간을 '폐장'으로 잘못 잡으면 **거래 중인 price를 금요일 캔들과
  //    대조해 오탐**이 난다. 이 검사의 목적상 오탐 한 번이 커버리지 한 칸보다 비싸다
  //    (FLAT_RUN_THRESHOLD를 7로 크게 잡은 것과 같은 판단 기준).
  // ⚠️ 미국 증시 휴장일은 폐장으로 보지 않는다. 국채는 SIFMA 권고로 쉬지만 글로벌 FX는
  //    얇게라도 거래되고, 무엇보다 "휴장일에 캔들이 안 나온 상태"에서 검사를 돌리면
  //    history[-1]이 전 거래일에 머물러 오탐이 된다. 커버리지를 포기하는 쪽을 택한다.
  FX: { kind: 'continuous', tz: 'America/New_York', reopenWeekday: 'Sun', reopenMinutes: 17 * 60 },
};

// ── 거래일(trading date) 파생 ────────────────────────────────────────
// ⚠️ **KST 날짜와 거래일은 같지 않다.** US 세션 종료 16:00 ET는 여름(EDT)에 05:00 KST
//    **다음날**이다. 그 시각의 price는 KST로는 오늘이지만 거래일은 어제다. 이 함수 없이
//    KST 날짜를 거래일로 쓰면 정확히 하루가 어긋난다.
// 검사 2b(change 축)가 history[-1]의 거래일을 price의 거래일과 맞춰야 하므로 여기서 만든다.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const shiftDate = (ymd, days) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const dowOf = ymd => DOW[new Date(`${ymd}T00:00:00Z`).getUTCDay()];

/**
 * 그 날짜가 거래일인가. holidayKey가 null이면 **주말만** 본다(continuous 세션).
 * @param {string} ymd 'YYYY-MM-DD'
 * @param {'KR'|'US'|null} holidayKey
 */
export function isTradingDay(ymd, holidayKey) {
  const d = dowOf(ymd);
  if (d === 'Sat' || d === 'Sun') return false;
  if (holidayKey && MARKET_HOLIDAYS[holidayKey]?.[ymd]) return false;
  return true;
}

/**
 * ymd 직전의 거래일. 휴장일 표가 그 연도를 덮지 않으면 평일이 그대로 거래일이 된다.
 * @returns {string|null} 10일 안에 못 찾으면 null(연휴 최장 5일이라 도달하지 않는 상한)
 */
export function prevTradingDay(ymd, holidayKey, maxBack = 10) {
  let d = ymd;
  for (let i = 0; i < maxBack; i++) {
    d = shiftDate(d, -1);
    if (isTradingDay(d, holidayKey)) return d;
  }
  return null;
}

/** ymd 직후의 거래일. continuous 세션의 17:00 롤 이후 value date를 구하는 데 쓴다. */
export function nextTradingDay(ymd, holidayKey, maxFwd = 10) {
  let d = ymd;
  for (let i = 0; i < maxFwd; i++) {
    d = shiftDate(d, 1);
    if (isTradingDay(d, holidayKey)) return d;
  }
  return null;
}

/**
 * from(제외) ~ to(포함) 사이의 거래일 수. **벽시계가 아니라 거래일로 지연을 센다.**
 *
 * ⚠️ 종전 baselineTooOld는 벽시계 3일이었다. 연휴가 끼면 정상 상태가 임계를 넘어
 *    stale-baseline 스킵으로 빠졌고 — 검사가 잡아야 할 '파서 동결'을 스킵으로 버렸다.
 *    거래일로 세면 휴장일이 애초에 계산에 들어오지 않는다.
 * @returns {number|null} to가 from보다 앞이면 음수 대신 null(정렬 이상 신호)
 */
export function tradingDaysBetween(from, to, holidayKey, cap = 40) {
  if (!from || !to) return null;
  if (from === to) return 0;
  if (to < from) return null;
  let d = from, n = 0;
  for (let i = 0; i < cap; i++) {
    d = shiftDate(d, 1);
    if (isTradingDay(d, holidayKey)) n++;
    if (d === to) return n;
    if (d > to) return n;
  }
  return null;
}

/** 세션별 휴장일 표 키 — continuous(FX)는 주말만 보므로 null. */
export function holidayKeyOf(market) {
  return SESSION[market]?.holidays ?? null;
}

// asOf 형식은 항목마다 다르다 — 두 계열이 실재한다(실측 프로덕션 lastgood):
//   시각 있음 : '2026-07-30 08:51 KST'          (CNBC 계열 — market-data.fmtKST)
//   날짜만    : '2026-07-29 (Naver 종가)'        (kr.js:52, :143 / watchlist.js:64, :88)
//               '2026-07-29 (Naver 환율)' · '(Twelve Data 종가)' · '(ECB 기준환율)'
const ASOF_TIME_RE = /\d{2}:\d{2}/;
const ASOF_DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:\D|$)/;

/**
 * asOf가 '날짜만'이면 그 날짜 문자열. 시각이 붙어 있으면 null.
 *
 * ⚠️ **날짜만 있는 asOf는 시각이 아니라 이미 확정된 거래일이다.** 소스가 일별 종가 표의
 *    날짜를 그대로 준 값이고, 그 표는 거래일에만 행을 발행한다. 시각으로 해석해 세션
 *    규칙을 적용하면 안 된다 — 자정으로 읽혀 '개장 전'이 되고 전 거래일로 밀린다.
 */
export function asOfTradingDate(v) {
  if (typeof v !== 'string' || ASOF_TIME_RE.test(v)) return null;
  return v.match(ASOF_DATE_RE)?.[1] ?? null;
}

/**
 * 아이템의 as_of 문자열/Date → Date.
 *
 * ⚠️ 날짜만 있는 문자열을 Date.parse에 그냥 넘기면 **런타임 타임존에 따라 답이 달라진다.**
 *    V8은 괄호 안을 주석으로 무시하고 'YYYY-MM-DD ...'를 로컬 자정으로 읽는다:
 *      TZ=Asia/Seoul       → 2026-07-28T15:00:00Z
 *      TZ=UTC              → 2026-07-29T00:00:00Z
 *    같은 입력이 로컬 개발기(KST)와 Vercel(UTC)에서 다른 거래일을 낸다 — 그래서 날짜만인
 *    경우는 **UTC 자정으로 고정**한다. (거래일 판정은 asOfTradingDate가 먼저 가로챈다.)
 * @returns {Date|null} 해석 불가면 null
 */
export function parseAsOf(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v !== 'string') return null;
  // 'KST'는 서머타임이 없어 +09:00 고정이 어느 계절에도 참이다(probe-store.js와 같은 근거).
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*KST$/);
  if (m) return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}+09:00`);
  const d = asOfTradingDate(v);
  if (d) return new Date(`${d}T00:00:00Z`);      // TZ 무관하게 고정
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * **그 시점에 관측된 price가 속한 거래일.** 항목의 세션(ASSET_META.market)으로 판정한다.
 *
 * basis 어휘 — 사람이 "왜 그 날짜인가"를 되짚을 수 있게 함께 돌려준다.
 *   asof-date           asOf에 시각이 없다 = 소스가 준 날짜가 곧 거래일(세션 규칙 미적용)
 *   intraday            장중. 진행 중인 그 날이 거래일
 *   after-close         폐장 후. 그 날이 거래일 (⭐ KST 날짜와 갈리는 구간)
 *   pre-open            개장 전. 전 거래일이 거래일
 *   pre-open+exthrs     개장 전이지만 **소스가 확장시간 견적이라 이미 당일로 롤됐다**
 *   non-trading-day     주말·휴장일. 전 거래일
 *   continuous-weekday  FX·금리 평일
 *   continuous-weekend  FX·금리 주말 → 직전 금요일
 *   utc-date            크립토(24시간, 세션 경계가 없어 UTC 날짜를 쓴다)
 *
 * ── ⚠️ 확장시간(exthrs) 축 — 2026-07-30 revert의 직접 원인 ──────────────
 * pre-open을 무조건 전 거래일로 보내면 **확장시간 견적을 쓰는 소스와 하루 어긋난다.**
 * CNBC bulk는 exthrs=1로 호출하므로(us-indices.js의 CNBC_QUOTE) 개장 전에도 value date가
 * 이미 당일이다. 그 구간에서 우리 시계만 전 거래일을 가리키면 history[-1](전 거래일)과
 * **날짜 라벨이 우연히 맞아** same-day로 통과 판정되고, change 축이 한 칸 더 과거인
 * history[-2]와 대조돼 체계적 오탐이 된다.
 *   [저장소:correct-marten-133336:health:validate:fields:relative@2026-07-30T08:55:26.056Z]
 *   nasdaq 1.775% / dow 2.235% / sp500 1.539% / sox 5.630% / vix 11.859% — 전부 이 경로다.
 *   detail이 '정렬 same-day, price거래일 2026-07-29, history 2026-07-29'로 남아 있다.
 * ⚠️ **이 플래그는 요청 파라미터에서 파생된다** — 소스가 무엇을 돌려줬는지가 아니라
 *    우리가 무엇을 요청했는지다. 그래서 정렬의 **1차 근거로 쓰지 않는다**(checkCross의
 *    데이터 신호가 1차이고 이건 신호가 없을 때의 폴백이다).
 *
 * @param {string} id      ASSET_META 키
 * @param {Date|string|number} at  price의 관측 시각(as_of)
 * @param {{extendedHours?: boolean}} [opts]  소스가 확장시간 견적인가(item.quoteWindow에서 파생)
 * @returns {{ date: string|null, market: string|null, basis: string }}
 */
export function tradingDateOf(id, at = new Date(), opts = {}) {
  const market = ASSET_META[id]?.market ?? null;
  // ⭐ 날짜만 있는 asOf는 소스가 확정한 거래일이다 — 세션 규칙을 적용하면 하루 밀린다.
  //    (Naver 종가/환율·Twelve Data 종가 계열 전부가 이 형식이다.)
  const direct = asOfTradingDate(at);
  if (direct) return { date: direct, market, basis: 'asof-date' };
  const when = parseAsOf(at);
  if (!when) return { date: null, market, basis: 'unparsable-asof' };
  // 크립토는 폐장이 없어 '거래일'이 세션으로 정의되지 않는다. 캔들 날짜도 UTC 기준이다.
  if (market === 'CRYPTO') return { date: when.toISOString().slice(0, 10), market, basis: 'utc-date' };
  const s = SESSION[market];
  if (!s) return { date: null, market, basis: 'unknown-market' };

  const { date, minutes } = localParts(when, s.tz);

  if (s.kind === 'continuous') {
    // ⭐ **17:00 ET 롤을 모델링한다(2026-07-30, [E] 근거).** FX·금리의 value date는 자정이
    //    아니라 뉴욕 17:00에 바뀐다. 이걸 빼면 그 이후의 price가 전날 값으로 잘못 귀속되고
    //    정확히 하루 어긋난 대조가 된다.
    //
    //    [원문 FRED DGS10 @2026-07-30 조회, https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10]
    //    발췌: "2026-07-27,4.65" "2026-07-28,4.61" (07-29 미발행 — FRED는 1영업일 지연)
    //    Naver marketIndex history를 FRED와 날짜별로 대조하면 **같은 날 일치 13/13**,
    //    1칸 지연 가설 일치 0/13 — Naver의 날짜 라벨은 정확하다.
    //    그러면 CNBC as_of='2026-07-30 08:51 KST'(=19:51 ET 07-29)의 price 4.67은 무엇인가.
    //    CNBC prev_close 4.62 = Naver 07-29 값이므로, **CNBC price는 이미 07-30 세션 값**이다
    //    (19:51 ET = 08:51 JST 07-30, 아시아 세션 진행 중). 즉 17:00 ET 롤이 실재한다.
    //
    // ⚠️ isMarketClosed와 주말 경계가 다른 것이 의도다 — 저쪽은 "지금 거래 중인가"(보수적으로
    //    금요일 저녁을 개장으로 남김), 이쪽은 "price가 어느 날의 값인가"다. 거래일 판정에서는
    //    금요일 17:00 이후 ~ 일요일 17:00을 주말로 본다.
    const dow = localParts(when, s.tz).weekday;
    const rolled = minutes >= s.reopenMinutes;
    const inWeekend =
      dow === 'Sat' ||
      (dow === 'Fri' && rolled) ||
      (dow === s.reopenWeekday && !rolled);
    if (inWeekend) {
      // 거래가 멈춘 구간 — 보유 price는 마지막 종가다. **완결된 마지막 거래일**을 쓴다.
      // 금요일 17:00 ET 직후라면 그 금요일 세션이 방금 끝난 것이므로 금요일 자신이 답이다.
      // 토요일·일요일(재개 전)은 그날이 거래일이 아니므로 직전 거래일로 물러난다.
      return isTradingDay(date, null)
        ? { date, market, basis: 'continuous-weekend' }
        : { date: prevTradingDay(date, null), market, basis: 'continuous-weekend' };
    }
    if (rolled) {
      // 새 value date가 이미 시작됐다. 다음 거래일(주말이면 건너뛴다)이 price의 거래일.
      return { date: nextTradingDay(date, null), market, basis: 'continuous-rolled' };
    }
    return isTradingDay(date, null)
      ? { date, market, basis: 'continuous-weekday' }
      : { date: prevTradingDay(date, null), market, basis: 'continuous-weekend' };
  }

  if (!isTradingDay(date, s.holidays)) {
    return { date: prevTradingDay(date, s.holidays), market, basis: 'non-trading-day' };
  }
  if (minutes < s.open) {
    // ⭐ 확장시간 견적이면 소스의 value date는 이미 당일이다(위 주석의 오탐 5건 경로).
    return opts.extendedHours
      ? { date, market, basis: 'pre-open+exthrs' }
      : { date: prevTradingDay(date, s.holidays), market, basis: 'pre-open' };
  }
  return { date, market, basis: minutes >= s.close ? 'after-close' : 'intraday' };
}

function localParts(now, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const g = t => p.find(x => x.type === t)?.value ?? '';
  return {
    date: `${g('year')}-${g('month')}-${g('day')}`,
    minutes: Number(g('hour')) * 60 + Number(g('minute')),
    weekday: g('weekday'),
  };
}

/**
 * 그 시장이 지금 닫혀 있는가.
 * @param {'KR'|'US'|'FX'|'CRYPTO'} market
 * @returns {{ closed: boolean, reason: string }}
 */
export function isMarketClosed(market, now = new Date()) {
  // 크립토는 24시간이라 폐장이 없다 — C 대상도 전부 tauto라 실제로 쓰이지 않는다.
  if (market === 'CRYPTO') return { closed: false, reason: 'always-open' };
  const s = SESSION[market];
  if (!s) return { closed: false, reason: 'unknown-market' };
  const { date, minutes, weekday } = localParts(now, s.tz);

  // ── 평일 연속 세션(FX·금리) — 주말만 폐장 ──────────────────────────
  if (s.kind === 'continuous') {
    if (weekday === 'Sat') return { closed: true, reason: 'weekend' };
    // 일요일은 재개 시각 전까지만 폐장. 그 이후는 거래 중이므로 검사하지 않는다.
    if (weekday === s.reopenWeekday && minutes < s.reopenMinutes) return { closed: true, reason: 'weekend' };
    return { closed: false, reason: 'continuous-open' };
  }

  // ── intraday 세션(주식) ────────────────────────────────────────────
  if (weekday === 'Sat' || weekday === 'Sun') return { closed: true, reason: 'weekend' };
  // 휴장일 표는 검사 1·KASI 자동대조로 관리되는 그 표를 그대로 쓴다(원본 하나).
  if (MARKET_HOLIDAYS[s.holidays]?.[date]) return { closed: true, reason: 'holiday' };
  if (minutes < s.open || minutes >= s.close) return { closed: true, reason: 'after-hours' };
  return { closed: false, reason: 'open' };
}

// ── 허용 오차: 절대값 금지, 양자화 스텝 기반 상대 오차 ───────────────
// **절대 오차로 설계하면 안 되는 이유(실측)**:
//   같은 임계 0.01을 쓰면 nasdaq(24,876)에서는 상대 4e-7이라 정상적인 교차소스 차이
//   (dxy 0.079%)조차 위반으로 잡히고, HYPR(0.92)에서는 상대 1.09%까지 눈감아 준다 —
//   같은 숫자가 자산에 따라 네 자릿수 넘게 다른 엄격도를 갖는다.
// **양자화 스텝**: 두 값이 각각 반올림되므로 최대 1스텝까지는 정상 차이다.
//   us10y가 산정 근거다 — price는 r4, history는 r2라 거친 쪽 스텝 0.01이 지배하고,
//   0.01/4.61 = 0.217%가 실측 잔차와 정확히 일치했다.
// **바닥값**: 교차소스는 종가 확정 시점이 달라 양자화만으로 설명되지 않는 차이가 남는다
//   (실측 dxy 0.079%). 그래서 바닥을 둔다 — 이 검사의 목적은 정밀도 감사가 아니라
//   "파서가 굳었는가"이고, 굳은 값은 며칠이면 퍼센트 단위로 벌어진다.
const CROSS_FLOOR_REL = 0.005;   // 0.5% — 실측 최대 잔차(us10y 0.217%)의 2배 여유
const SEMI_FLOOR_REL  = 0.002;   // 0.2% — 같은 소스라 시점 차이가 작다

/**
 * 상대 허용 오차(비율). base가 작을수록 커진다(양자화 지배).
 * @param {string} id
 * @param {number} base    잔차의 분모가 되는 값(가격 축은 price, change 축은 prevClose)
 * @param {number} [quanta=1] 반올림이 몇 번 겹쳤는가 — 아래 QUANTA 주석 참조
 */
export function crossTolerance(id, base, quanta = 1) {
  const meta = ASSET_META[id] ?? {};
  const floor = meta.cross === 'cross' ? CROSS_FLOOR_REL : SEMI_FLOOR_REL;
  const quantum = meta.quantum ?? 0.01;
  const p = Math.abs(base);
  if (!p) return floor;
  return Math.max(floor, quantum * quanta / p);
}

// ── 축별 양자 수 ─────────────────────────────────────────────────────
// 가격 축은 두 값이 각각 1번 반올림되므로 1스텝.
// change 축은 prevClose = price − change 로 만들어 **price의 반올림과 change의 반올림을
// 둘 다** 물려받으므로 2스텝이다. 1스텝으로 두면 정상 반올림이 위반이 된다 — 실측 반례:
//   [계산@2026-07-30T02:10:30Z 저장소:correct-marten-133336]
//   HYPR prevClose 0.91 vs history[-2] 0.92 → 잔차 1.099%,
//        1양자 허용 0.01/0.91 = 1.099% → 잔차 == 허용, 경계에 정확히 걸림
//        2양자 허용 2.198% → 여유 있게 통과
const QUANTA_PRICE = 1, QUANTA_PREVCLOSE = 2;

/**
 * 허용 판정 — **양자 정수 경로 OR 상대 바닥 경로**.
 *
 * ⚠️ 실수 비교(residual <= tolerance)만 쓰면 **정확히 1양자 차이일 때 부동소수점으로
 *    경계가 뒤집힌다.** 두 항이 같은 나눗셈에서 나오는데 분자만 뺄셈 오차를 안고 오기 때문:
 *    [저장소:correct-marten-133336:health:validate:fields:relative@2026-07-30T22:52:55.542Z]
 *      HYPR '양측 불일치 1.075% > 허용 1.075%' — 같은 값인데 위반으로 기록됐다.
 *    [계산@2026-07-31T02:0xZ] Math.abs(0.92 − 0.93) = 0.010000000000000009 (정확한 0.01이 아님)
 *      잔차 0.01075268817204302 > 허용 0.01075268817204301 (차 1.04e-17)
 *    저가 종목일수록 가격차가 정확히 1양자인 날이 흔해 **상시 오탐 구간**이었다.
 *
 * 두 경로를 OR로 두는 이유 — **서로 다른 오차원**이라 max로 뭉개면 안 된다:
 *   · 양자 정수 : 두 값이 각각 반올림된 데서 오는 차이. 틱 수로 세는 게 정확하다.
 *   · 상대 바닥 : 교차소스가 종가를 확정한 **시점**이 달라 남는 차이(실측 dxy 0.079%).
 *
 * @param {number} diff      expected − observed
 * @param {number} quantum   그 항목의 양자화 스텝(ASSET_META.quantum)
 * @param {number} quanta    허용 양자 수(QUANTA_PRICE | QUANTA_PREVCLOSE)
 * @param {number} denom     상대 잔차의 분모
 * @param {number} floorRel  상대 바닥(cross 0.5% / semi 0.2%)
 * @returns {{ok: boolean, ticks: number, residual: number, via: 'quanta'|'floor'|null}}
 */
export function okByTicks(diff, quantum, quanta, denom, floorRel) {
  const abs = Math.abs(diff);
  const residual = abs / Math.abs(denom || 1);
  // 반올림해 정수로 만든 뒤 비교한다 — 1.0000000000000009틱은 1틱이다.
  const ticks = quantum > 0 ? Math.round(abs / quantum) : Infinity;
  if (ticks <= quanta) return { ok: true, ticks, residual, via: 'quanta' };
  if (residual <= floorRel) return { ok: true, ticks, residual, via: 'floor' };
  return { ok: false, ticks, residual, via: null };
}

/**
 * **수집기가 손대기 전의 좌표.** 정렬 신호와 두 축이 모두 이 값을 읽는다.
 *
 * ⚠️ recalcChange는 `prev_close`만 덮는 게 아니라 **`price`도 덮는다**(us-indices.js의
 *    분기 1: price := history[-1].close, prev_close := history[-2].close). 그래서
 *    "원본 prev_close만 읽으면 된다"로는 부족하다 — 분기 1은 same-day 신호를,
 *    분기 2(prev_close := history[-1].close)는 prev-day 신호를 **각각 위조**한다.
 *    두 좌표를 모두 원본으로 되돌려야 신호가 소스의 사실을 말한다.
 *
 * ── 출처 도장(prov)이 필요한 이유 ────────────────────────────────────
 * `change_recalced` 부재는 두 가지를 뜻할 수 있다 — (a) 재계산이 안 걸렸다,
 * (b) **도장을 찍지 않던 구버전이 남긴 스냅샷이다.** lastgood은 TTL이 없어(last-good.js:9)
 * 배포 이전 스냅샷이 무기한 남고, market-data.js가 그걸 폴백으로 서빙하면 검사에도
 * 그대로 들어온다. (b)를 (a)로 읽으면 오염된 prev_close를 원본으로 믿는다.
 * 그래서 **재계산 발동 여부와 무관하게 항상** prov.v를 찍고, 없으면 신호를 포기한다.
 *
 * @returns {{price:number, prevClose:number, recalced:boolean, provenance:'stamped'|'legacy'}}
 */
export function originOf(item) {
  const rc = item?.change_recalced;
  const from = rc?.from;
  if (from) {
    return {
      price: from.price,
      // prev_close 필드를 우선하되(소스 원본), 없으면 price − change로 파생한다.
      prevClose: Number.isFinite(from.prev_close) ? from.prev_close
        : (Number.isFinite(from.price) && Number.isFinite(from.change) ? from.price - from.change : NaN),
      recalced: true, provenance: 'stamped',
    };
  }
  const derived = Number.isFinite(item?.price) && Number.isFinite(item?.change)
    ? item.price - item.change : NaN;
  return {
    price: item?.price,
    prevClose: Number.isFinite(item?.prev_close) ? item.prev_close : derived,
    recalced: false,
    provenance: item?.prov?.v ? 'stamped' : 'legacy',
  };
}

/**
 * **시계 축을 판정 근거로 쓸 수 있는가.**
 *
 * ⚠️ circular(as_of가 history[-1].date에서 파생됨)이면 `h1.date === priceDate`가 정의상
 *    참이라 시계는 **언제나 same-day**를 답한다. 그건 증거가 아니라 항등식이므로
 *    신호가 있든 없든 판정 근거가 될 수 없다.
 *    실측 반례 [저장소:correct-marten-133336:health:validate:2026-07-31@2026-07-31T04:27:59Z]:
 *      419530 [cross-price] 0.382% > 0.200% — 신호 unknown이라 순환 시계가 단독 채택돼
 *      same-day로 판정됐고, KR 장중 실시간가를 **진행 중인 캔들**과 견줘 오탐이 났다.
 *      (그 케이스는 이제 isIntradayCandle이 먼저 가로챈다 — 이 함수는 세션 밖 방어다.)
 */
function clockUsable(clock, circular) {
  return clock !== 'unknown' && !circular;
}

/**
 * **h1이 아직 확정되지 않은 '진행 중' 캔들인가.**
 *
 * 세션이 열려 있고 history[-1]의 날짜가 오늘 거래일이면, 그 캔들의 close는 종가가 아니라
 * **현재가의 스냅샷**이다. 그때 price와 h1.close의 차이는 두 엔드포인트 조회 시점 사이의
 * 정상 등락이고, 임계를 세울 근거가 없다(얼마나 움직여도 되는지 우리는 모른다).
 *
 * ⚠️ **당일 거래일은 as_of가 아니라 벽시계 now에서 구한다.** as_of에서 구하면 circular
 *    항목에서 또 항등이 된다(as_of가 곧 h1.date이므로 조건이 무조건 참이 된다).
 * ⚠️ **intraday 세션(KR·US)에만 적용한다.** 개·폐장이 하루 안에 있는 세션이라야
 *    "오늘의 진행 중 캔들"이 정의된다. 제외되는 둘 다 실측으로 걸렸다:
 *      CRYPTO — isMarketClosed가 always-open이라 조건이 영구 참이 된다.
 *      FX     — continuous라 평일 내내 open이고, 게다가 value date가 자정이 아니라
 *               17:00 ET에 바뀌므로 '오늘 ET 날짜'가 거래일과 어긋난다. 이걸 넣었더니
 *               us10y가 17:00 ET 롤 회귀(3b)에서 prev-day 대신 intraday로 잡혔다.
 * ⚠️ **stale 아이템은 제외한다.** last-good 폴백으로 서빙된 값은 price가 실시간이 아니다 —
 *    h1.date가 오늘이어도 '진행 중'이라는 전제가 성립하지 않는다.
 */
function isIntradayCandle(item, meta, h1, now) {
  const s = SESSION[meta.market];
  if (!s || s.kind !== 'intraday') return false;
  if (item.stale) return false;
  if (isMarketClosed(meta.market, now).closed) return false;
  const { date } = localParts(now, s.tz);
  if (!isTradingDay(date, holidayKeyOf(meta.market))) return false;
  return h1.date === date;
}

/**
 * **데이터 신호에 의한 정렬 판정.** 시각이 아니라 소스가 돌려준 값이 근거다.
 *
 *   원본 prev_close == history[-1].close  → prev-day (price는 다음 거래일 값)
 *   원본 price      == history[-1].close  → same-day
 *   그 외                                 → unknown
 *
 * ⚠️ **prev-day를 먼저 본다. 순서가 결과를 바꾼다.**
 *    change ≈ 0 구간에서는 price == prev_close이므로 둘 다 참이 될 수 있다(축퇴).
 *    이때 same-day를 택하면 change 축이 history[-2]와 대조돼 **어제 오탐 5건이 그대로
 *    부활한다** — 반사실 실측 [계산@2026-07-31T02:0xZ]:
 *      same-day 우선 시 nasdaq 1.775 / dow 2.235 / sp500 1.539 / sox 5.630 / vix 11.859
 *      (= fields:relative에 기록된 값과 소수 3자리까지 동일)
 *    prev-day를 택하면 change 축이 history[-1]과 대조돼 잔차 0이 된다.
 * ⚠️ 축퇴 구간에서 prev-day를 택하는 대가: "당일 캔들이 이미 있는데 change가 0으로 잘못
 *    온" 경우를 정렬로는 못 잡는다. 그건 정렬의 일이 아니라 **검사 2b의 change-zero 축**이
 *    할 일이다(미커버 4건 ①과 같은 자리). 정렬로 change 결함을 잡으려 한 것이 어제
 *    설계의 구조적 무리였다.
 *
 * @returns {{alignment:'same-day'|'prev-day'|'unknown', basis:string, degenerate:boolean}}
 */
export function alignBySignal(origin, h1, quantum) {
  if (origin.provenance === 'legacy') return { alignment: 'unknown', basis: 'no-provenance', degenerate: false };
  if (!Number.isFinite(h1?.close)) return { alignment: 'unknown', basis: 'no-history', degenerate: false };
  // 반틱 이내면 같은 값으로 본다 — 소스마다 반올림 자리수가 달라 완전 동치는 성립하지 않는다.
  const eq = v => Number.isFinite(v) && Math.abs(v - h1.close) < quantum * 0.5;
  const vEq = eq(origin.prevClose), pEq = eq(origin.price);
  if (vEq) return { alignment: 'prev-day', basis: 'prevclose==h1', degenerate: pEq };
  if (pEq) return { alignment: 'same-day', basis: 'price==h1', degenerate: false };
  return { alignment: 'unknown', basis: 'no-signal', degenerate: false };
}

/** stale-history 임계 — 거래일 갭이 이 값 이상이면 history가 굳은 것으로 본다. */
export const STALE_TRADING_DAY_GAP = 2;

/**
 * **검사 2a 교차 대조 1건 — 거래일 정렬 기반.**
 *
 * ── 왜 시계 게이팅을 없앴는가 ────────────────────────────────────────
 * 종전에는 "장중이면 price와 history[-1]이 어긋나는 게 정상"이라 폐장일 때만 돌렸다.
 * 그런데 그 어긋남은 **어느 캔들과 견주는지를 잘못 고른 결과**였다. 거래일을 맞추면
 * 장중에도 견줄 짝이 있다 — 당일 캔들이 없으면 가격 축이 성립하지 않을 뿐이고,
 * change 축(prevClose ↔ 전 거래일 종가)은 그대로 성립한다.
 * 실측 근거: vix 11.859%는 price(07-29 종가)를 07-28 캔들과 견준 값이었고,
 * 그 크기는 정확히 VIX의 1일 변동폭이었다 — 불일치가 아니라 정렬 오류였다.
 *
 * ── 정렬은 두 축의 합의로 정한다(2026-07-31 정정) ─────────────────────
 * 8b0f452는 정렬을 `history[-1].date === priceDate`라는 **날짜 라벨 대조**로만 구했다.
 * 그건 시계 게이팅(isMarketClosed)을 **다른 시계**(tradingDateOf)로 바꾼 것일 뿐 값에는
 * 손대지 않은 것이어서, 시계가 틀리면 그대로 틀렸다. 실제로 틀렸다 — CNBC를 exthrs=1로
 * 부르는데 pre-open을 전 거래일로 보내는 바람에 라벨이 **우연히 맞아** same-day로 통과
 * 판정됐고, change 축이 한 칸 더 과거와 대조돼 오탐 5건이 났다(tradingDateOf 주석 참조).
 *
 *   신호(alignBySignal) : 소스가 돌려준 **값**이 근거. 라벨·세션 모델과 무관.
 *   시계(tradingDateOf) : 날짜 라벨 + 세션 모델 + exthrs 롤이 근거.
 *   합의 → 그 분류로 검사 / 불일치 → alignment-ambiguous(미수행) / 한쪽만 → 그쪽 채택
 *
 * ── 분기 ─────────────────────────────────────────────────────────────
 *   same-day             가격 축 + change 축(history[-2] 대조)
 *   prev-day             change 축만(history[-1] 대조). 당일 캔들 부재는 정상이다
 *   stale                시계 단독 판정일 때만 도달 → **그 자체가 finding**(파서 동결 증상)
 *   ambiguous            두 축 불일치 → 스킵. 위반도 통과도 아니다
 *   unknown              신호·시계 둘 다 못 구함 → 스킵(no-provenance / no-signal / no-trading-date)
 *
 * @returns {{
 *   state:'checked'|'skipped', reason?:string, alignment?:string, alignBasis?:string,
 *   gap?:number|null, priceDate?:string|null, historyDate?:string|null,
 *   priceSource?:string|null, historySource?:string|null, provenance?:string,
 *   recalced?:boolean, signalAlignment?:string, clockAlignment?:string, degenerate?:boolean,
 *   grade?:string, axes?:Array<object>, observations?:Array<object>
 * }}
 */
export function checkCross(item, now = new Date()) {
  const meta = ASSET_META[item?.id];
  if (!meta) return { state: 'skipped', reason: 'no-meta' };
  if (meta.cross === 'tauto') return { state: 'skipped', reason: 'tauto' };
  // ⚠️ tauto와 사유를 구분해 센다. tauto는 "같은 벤더라 서로를 반증하지 못한다"이고
  //    tautological은 "같은 응답의 같은 행을 두 번 읽었다 — 잔차가 정의상 0"이다.
  if (meta.cross === 'tautological') return { state: 'skipped', reason: 'tautological' };
  if (meta.cross !== 'cross' && meta.cross !== 'semi') return { state: 'skipped', reason: 'no-grade' };

  const hist = Array.isArray(item.history) ? item.history : [];
  const h1 = hist.at(-1), h2 = hist.at(-2);
  // ⚠️ 서빙값(item.price)이 아니라 **원본 좌표**로 시작한다 — recalcChange가 price와
  //    prev_close를 둘 다 history 값으로 덮어 정렬 신호를 위조하기 때문(originOf 주석).
  const origin = originOf(item);
  // history나 price가 아예 없으면 정렬할 것이 없다 — 유일하게 남은 '기준선 없음' 스킵.
  if (!Number.isFinite(origin.price) || !Number.isFinite(h1?.close)) {
    return { state: 'skipped', reason: 'no-baseline' };
  }

  const quantum = meta.quantum ?? 0.01;
  const holidayKey = holidayKeyOf(meta.market);
  // 확장시간 여부는 소스 설정에서 파생된 item.quoteWindow가 나른다(us-indices.CNBC_QUOTE).
  const priceDate = tradingDateOf(item.id, item.as_of ?? now, {
    extendedHours: item.quoteWindow === 'extended',
  }).date;
  const pv = priceDate ? prevTradingDay(priceDate, holidayKey) : null;

  // ── 두 축을 각각 구한 뒤 합의를 요구한다 ─────────────────────────────
  // ⚠️ **어느 한쪽도 단독으로는 못 쓴다.** 라이브 실측이 둘 다 무너지는 지점을 하나씩 준다:
  //    [계산@2026-07-31T02:11:13Z 저장소:correct-marten-133336:lastgood:market:*]
  //      dxy   신호 unknown(price·prev_close 둘 다 h1과 불일치) → 시계가 구한다(roll-17ET)
  //      us10y 신호 same-day(금리가 롤을 넘어 안 움직여 price==h1이 **우연히** 성립)
  //            ↔ 시계 prev-day. 신호만 믿으면 change 축 0.858% > 0.5% 신규 오탐이었다.
  // 신호는 값을 보고 시계는 라벨·세션 모델을 본다 — **실패 모드가 겹치지 않는다.**
  // 불일치를 통과로도 위반으로도 만들지 않는 것이 이 설계의 핵심이다. 어제 사고는
  // 두 축이 어긋난 것을 한쪽이 조용히 이겨서 났다(시계가 라벨과 우연히 맞아 same-day 통과).
  // ⚠️ **as_of가 history에서 나온 항목은 시계 축이 순환 참조다.** watchlist·kr은 as_of를
  //    `${history.at(-1).date} (…)`로 만든다(watchlist.js:64,:88 / kr.js의 cur.asOf).
  //    그러면 tradingDateOf가 그 날짜를 그대로 돌려주므로 `h1.date === priceDate`가
  //    **정의상 참**이고, 시계는 언제나 same-day를 답한다 — 증거가 아니라 항등식이다.
  //    이걸 독립 축으로 세면 신호가 prev-day를 가리켜도 늘 불일치가 나서 HYPR·코스닥 3종이
  //    통째로 ambiguous로 빠진다. 순환이면 시계를 기권시키고 신호가 단독 판정한다.
  const asOfDate = asOfTradingDate(item.as_of);
  const circular = Boolean(asOfDate) && asOfDate === h1.date;
  let clock = 'unknown';
  if (priceDate) {
    if (h1.date === priceDate)   clock = 'same-day';
    else if (h1.date === pv)     clock = 'prev-day';
    else                         clock = 'stale';
  }
  const sig = alignBySignal(origin, h1, quantum);

  let alignment, alignBasis;
  const live = isIntradayCandle(item, meta, h1, now);
  if (live) {
    // ── ① 진행 중 캔들 — 축 선택보다 **먼저** 판정한다 ─────────────────
    // 이건 축 선택 규칙이 아니라 **데이터의 사실 상태**다. h1이 아직 확정되지 않은
    // 캔들이면 어느 축을 고르든 가격 축은 성립하지 않으므로, 축 선택보다 앞선다.
    alignment = 'intraday'; alignBasis = 'session-open+today-candle';
  } else if (sig.alignment !== 'unknown' && clockUsable(clock, circular)) {
    // 신호는 stale을 만들지 못하므로(값만 봄) clock==='stale'이면 항상 불일치가 된다.
    // 그때도 stale finding을 내지 않는다 — 값이 맞는데 날짜만 낡았다면 낡은 쪽이
    // history가 아니라 **우리 거래일 파생**일 수 있다(어제가 정확히 그 사고였다).
    if (sig.alignment === clock) { alignment = clock; alignBasis = `agree:${sig.basis}`; }
    else { alignment = 'ambiguous'; alignBasis = `disagree(신호 ${sig.alignment} vs 시계 ${clock})`; }
  } else if (sig.alignment !== 'unknown') {
    alignment = sig.alignment;
    alignBasis = `signal-only:${circular ? 'no-clock' : sig.basis}`;
  } else if (clockUsable(clock, circular)) {
    // 구버전 스냅샷(prov 없음)이 여기로 온다 — 신호를 포기하고 종전 동작(시계)으로 돈다.
    alignment = clock; alignBasis = `clock-only:${sig.basis}`;
  } else {
    // 신호도 없고 시계도 독립 축이 아니다 — 판정 근거가 하나도 없다.
    alignment = 'unknown';
    alignBasis = circular ? 'no-independent-axis' : `neither:${sig.basis}`;
  }

  const base = {
    state: 'checked', alignment, alignBasis, priceDate, historyDate: h1.date,
    priceSource: item.source ?? null, historySource: item.historySource ?? null,
    provenance: origin.provenance, recalced: origin.recalced,
    signalAlignment: sig.alignment, clockAlignment: clock, circularAsOf: circular,
    degenerate: sig.degenerate,
    grade: meta.cross,
    gap: priceDate ? tradingDaysBetween(h1.date, priceDate, holidayKey) : null,
  };

  // 정렬이 서지 않으면 축을 만들지 않는다. **위반도 통과도 아니고 미수행**이다.
  if (alignment === 'ambiguous') return { ...base, state: 'skipped', reason: 'alignment-ambiguous' };
  if (alignment === 'unknown') {
    return { ...base, state: 'skipped',
      reason: alignBasis === 'no-independent-axis' ? 'no-independent-axis'
        : sig.basis === 'no-provenance' ? 'no-provenance'
        : (priceDate ? 'no-signal' : 'no-trading-date') };
  }

  const axes = [], observations = [];
  /**
   * @param {boolean} [observeOnly]  true면 observations로 보낸다 — **blocked에 계상되지 않는다.**
   *   판정할 근거가 없을 뿐 값은 남겨야 하는 축에 쓴다(intraday의 가격 축).
   */
  const mkAxis = (checkKind, observed, expected, denom, quanta, observeOnly = false) => {
    const sink = observeOnly ? observations : axes;
    if (!Number.isFinite(observed) || !Number.isFinite(expected)) {
      sink.push({ checkKind, state: 'skipped', reason: 'no-baseline', observeOnly });
      return;
    }
    const floor = meta.cross === 'cross' ? CROSS_FLOOR_REL : SEMI_FLOOR_REL;
    const v = okByTicks(expected - observed, quantum, quanta, denom, floor);
    sink.push({ checkKind, state: 'checked', ok: v.ok,
      residual: v.residual, tolerance: crossTolerance(item.id, denom, quanta),
      ticks: v.ticks, via: v.via, observed, expected, quanta, observeOnly });
  };

  // ── stale — 축을 만들지 않고 finding 하나로 돌려보낸다 ───────────────
  // ⚠️ 비일별 항목은 제외한다. 월별 지표는 거래일마다 새 캔들이 생기지 않으므로 갭이
  //    정의상 벌어진다(현재 C 대상에는 없지만 향후 편입 시 상시 오탐이 되는 구간).
  if (alignment === 'stale') {
    if (!isDailyCadence(item.id)) {
      return { ...base, state: 'skipped', reason: 'non-daily-cadence' };
    }
    // history가 price보다 미래인 경우(gap===null)도 정렬 이상이다 — 함께 잡는다.
    if (base.gap == null || base.gap >= STALE_TRADING_DAY_GAP) {
      return { ...base, axes: [], observations, staleFinding: true };
    }
    // 갭이 1인데 prev-day가 아닌 경우는 논리상 없지만, 방어적으로 축 없이 통과시킨다.
    return { ...base, axes: [], observations };
  }

  // ── 가격 축 ─────────────────────────────────────────────────────────
  // same-day : h1이 확정 종가다 → **판정**한다.
  // intraday : h1이 진행 중인 캔들이라 price와의 차이가 정상 등락이다 → **관측만** 한다.
  //   실측 [저장소:correct-marten-133336:lastgood:market:419530@2026-07-31T04:27:34Z]
  //     KR 장중 13:47 KST, price 26,200 ↔ h1(2026-07-31) 26,300 → 0.382%(100틱).
  //     같은 회차 028300·080220은 0.000%였다 — 419530만 그 순간 움직여 있었다.
  //     "얼마나 움직여도 정상인가"를 판정할 모델이 없으므로 임계를 세우지 않는다.
  // prev-day : 당일 캔들이 아예 없다 → 축을 만들지 않는다.
  if (alignment === 'same-day' || alignment === 'intraday') {
    mkAxis('cross-price', origin.price, h1.close, origin.price, QUANTA_PRICE, alignment === 'intraday');
  }
  // change 축의 대조 캔들 — 당일 캔들이 있으면(same-day·intraday) history[-2],
  // prev-day면 history[-1]. intraday에서도 **전 세션 확정 종가와의 대조는 완전히 유효**하다 —
  // 진행 중인 것은 h1이지 h2가 아니다. 그래서 장중에도 change 축은 판정한다.
  const changeBaseline = (alignment === 'same-day' || alignment === 'intraday') ? h2?.close : h1.close;

  // ── change 축 — **언제나 원본 좌표로 센다** ──────────────────────────
  // 8b0f452는 recalc 발동 시에만 cross-prevclose-origin이라는 별도 축을 만들었는데,
  // 그러면 "언제 원본을 쓰는가"가 분기로 흩어져 한쪽만 고치는 실수가 난다. originOf가
  // 발동 여부와 무관하게 원본을 돌려주므로 축은 하나면 된다 — 발동 사실은 base.recalced로
  // 남겨 사람이 되짚을 수 있게 한다.
  mkAxis('cross-prevclose', origin.prevClose, changeBaseline, origin.prevClose, QUANTA_PREVCLOSE);

  // ── 관측 전용 축: internal-prevclose ────────────────────────────────
  // item.prev_close(소스가 준 필드) ↔ price − change. history가 필요 없어 24시간 성립한다.
  // ⚠️ **blocked에 계상하지 않는다.** 실측 2건이 잡히는데(HYPR 0.01 / us10y 0.001) 둘 다
  //    정상 반올림일 가능성이 높다 — unit별 정밀도 규약(percent=r4, 그 외 r2)에서 기대
  //    오차를 파생해야 임계를 정할 수 있다. TODO([E] 이후): 임계 산정 후 계상 여부 재판단.
  // ⚠️ 이 축만은 **서빙 좌표**를 본다. "소스가 준 prev_close와 price−change가 서로 맞는가"를
  //    묻는 내부 정합성 검사라 원본으로 바꾸면 질문 자체가 달라진다.
  const servedPrev = Number.isFinite(item.change) ? item.price - item.change : NaN;
  if (Number.isFinite(item.prev_close) && Number.isFinite(servedPrev)) {
    const diff = Math.abs(item.prev_close - servedPrev);
    observations.push({
      checkKind: 'internal-prevclose', observeOnly: true,
      observed: servedPrev, expected: item.prev_close, diff,
      residual: Math.abs(servedPrev) ? diff / Math.abs(servedPrev) : null,
    });
  }

  return { ...base, axes, observations };
}

// ── 평탄성(파서 동결) ────────────────────────────────────────────────
// **개별 종목은 제외한다**(meta.singleName). 저유동성 종목은 며칠 무거래가 정상이고,
// 거래정지·정리매매도 같은 모양이라 우리 데이터로는 "굳은 것"과 구분할 수단이 없다
// (1단계 조사: 거래량 필드가 홈 아이템에 없다). 지수·환율·주요 크립토만 본다.
//
// N일 산정: 지시받은 근거는 "휴장 연휴 최장 길이보다 커야 한다"였는데, **휴장일에는
// 캔들이 아예 없으므로** 연휴 길이는 이 값의 하한을 규정하지 않는다(같은 값 반복이
// 아니라 값 부재다). 실제 구속 조건은 "지수·환율이 정상적으로 며칠 연속 같은 종가를
// 낼 수 있는가"이고 그건 사실상 0~1일이다. 그래도 7로 크게 잡는다 — 이 검사는 경보이지
// 차단이 아니고, 오탐 한 번이 신뢰를 깎는 쪽이 더 비싸기 때문이다.
export const FLAT_RUN_THRESHOLD = 7;

/**
 * history 끝에서부터 연속으로 같은 close가 몇 개인지.
 * ⚠️ 캔들 부재(휴장)는 배열에 아예 없으므로 여기서 세지 않는다 — "같은 값 반복"만 센다.
 *    대신 그 구간의 날짜 범위를 함께 돌려줘 사람이 연휴와 구분할 수 있게 한다.
 */
export function checkFlatness(item) {
  const meta = ASSET_META[item?.id];
  if (!meta) return { state: 'skipped', reason: 'no-meta' };
  if (meta.singleName) return { state: 'skipped', reason: 'single-name' };
  // 갱신 주기·성격에서 파생된 면제(월별 지표·정책금리) — asset-meta.isFlatExempt가 판단한다.
  // ⚠️ baselineTooOld와 **무관하게** 여기서 먼저 빠져야 한다. 종전에는 정책금리가
  //    기준선 나이 덕에 우연히 빠지고 있었고, 그건 규칙이 아니라 사고였다.
  const ex = isFlatExempt(item.id);
  if (ex.exempt) return { state: 'skipped', reason: `flat-exempt:${ex.reason}` };
  const hist = Array.isArray(item.history) ? item.history : [];
  if (hist.length < FLAT_RUN_THRESHOLD) return { state: 'skipped', reason: 'short-history' };

  const lastClose = hist[hist.length - 1]?.close;
  if (!Number.isFinite(lastClose)) return { state: 'skipped', reason: 'no-baseline' };
  let run = 1;
  for (let i = hist.length - 2; i >= 0; i--) {
    if (hist[i]?.close !== lastClose) break;
    run++;
  }
  const from = hist[hist.length - run]?.date ?? null;
  const to = hist[hist.length - 1]?.date ?? null;
  return {
    state: 'checked', ok: run < FLAT_RUN_THRESHOLD,
    reason: 'evaluated', run, value: lastClose, from, to,
  };
}

// ── 기준선 나이 판정은 제거했다(2026-07-30) ──────────────────────────
// 종전 baselineTooOld는 **벽시계 3일**로 "기준선이 낡았다"를 판정해 stale-baseline
// 스킵으로 뺐다. 두 가지가 틀렸다:
//   ① 연휴가 끼면 정상 상태가 임계를 넘는다(추석 3일 + 주말 = 5일). 정상을 스킵으로 버렸다.
//   ② "history가 며칠째 안 갱신됨"은 **파서 동결의 직접 증상**이다 — 이 검사가 잡으려는
//      바로 그것을 스킵으로 버리고 있었다.
// 이제 checkCross가 거래일 갭으로 판정하고 STALE_TRADING_DAY_GAP 이상이면 **finding**을
// 낸다. 남은 스킵은 'no-baseline'(price/history가 아예 없음)뿐이다.

/**
 * 아이템 배열 → 검사 2a 결과 집계. **순수 함수**(호출측이 Redis에 기록한다).
 *
 * ⚠️ **집계 방식과 반환 필드 이름은 바꾸지 않았다.** checked/blocked/skipped/skipReasons/
 *    findings/fields 모두 종전 의미 그대로다 — Redis 기록 경로(persistValidation)가 이
 *    구조를 그대로 받으므로 스키마가 유지된다. 축 단위 정보는 findings에 필드로 **추가**만
 *    했고(checkKind·priceDate·historyDate·priceSource), 관측 전용 축은 별도 배열
 *    observations로 분리해 blocked에 절대 섞이지 않게 했다.
 * ── counters — 스킵이 아니어서 skipReasons에 못 넣는 것들 ──────────────
 * `skipped`를 오염시키지 않으려고 별도 맵으로 뺀다. 호출측이 `relative:{code}`로 hincrby한다.
 * ⚠️ 코드에 ':'를 쓰지 않는다 — health.sanitizeCode가 콜론을 **제거**해 키가 뭉개진다
 *    (실측: 'align:same-day' → 'alignsame-day', 'flat-exempt:policy_rate' →
 *     'flat-exemptpolicy_rate'). 콜론은 포맷 문자열에만 살아남는다(health.js:277,283).
 *
 *   align-{분류값}   **정렬 분류 6종의 배타 분할.** same-day / prev-day / intraday /
 *                    stale / ambiguous / unknown. 종전에는 축퇴와 ambiguous만 세어
 *                    "분자만 있고 분모가 없는" 상태였다 — 어느 분류가 몇 건인지 회차마다
 *                    알 수 있게 전 계열을 같은 규칙으로 센다.
 *                    **항등식**: sum(align-6종) == 정렬 판정에 도달한 항목 수.
 *                    (조기반환 5종 no-meta/tauto/tautological/no-grade/no-baseline은
 *                     alignment가 대입되기 전에 빠지므로 분모에서 제외된다.)
 *   align-degenerate ⚠️ **위 6종과 배타가 아니다. 합산에 넣지 말 것.**
 *                    change≈0이라 same-day·prev-day 신호가 동시에 참인 회차를 세는
 *                    **오버레이**다(실측: prev-day 5건과 전부 겹침). 오류가 아니라
 *                    prev-day 우선 규칙이 실제로 발동한 횟수다.
 *   prov-legacy      출처 도장 없는 스냅샷(구버전 lastgood). **0으로 수렴해야 정상**이다 —
 *                    첫 성공 수집에서 전 항목이 재기록되므로 배포 확인 지표로 쓴다.
 * @returns {{ checked, blocked, skipped, skipReasons, counters, findings, fields, observations, blockDiversity }}
 */
export function runRelativeChecks(items, now = new Date()) {
  let checked = 0, blocked = 0, skipped = 0;
  const skipReasons = {};
  const counters = {};
  const findings = [];
  const fields = [];
  const observations = [];
  const bump = reason => { skipped++; skipReasons[reason] = (skipReasons[reason] ?? 0) + 1; };
  const tally = code => { counters[code] = (counters[code] ?? 0) + 1; };

  for (const it of items ?? []) {
    if (!it?.id) continue;

    const c = checkCross(it, now);
    const f = checkFlatness(it);
    if (Array.isArray(c.observations)) observations.push(...c.observations.map(o => ({ id: it.id, ...o })));
    // ⚠️ 스킵 여부와 무관하게 센다 — 구버전 스냅샷은 시계 폴백으로 검사가 **성립**하므로
    //    스킵되지 않는다. skipReasons만 보면 보이지 않는 상태다.
    // ⚠️ 코드에 ':'를 쓰지 않는다 — health.sanitizeCode가 콜론을 **제거**해서
    //    'prov:legacy'가 'provlegacy'로 뭉개진다(기존 flat-exempt:policy_rate가 그 사례다).
    if (c.provenance === 'legacy') tally('prov-legacy');
    // ── 정렬 분류 6종 — **여기 한 곳에서만 센다** ─────────────────────
    // checkCross가 alignment를 단일 반환값으로 내므로 기록 지점이 하나로 모인다.
    // 흩어서 세면 합이 안 맞고 항등식이 무의미해진다.
    // ⚠️ c.alignment는 **조기반환 5종에서는 undefined**다(그 경로는 alignment 대입 전에
    //    빠진다). 그래서 이 한 줄이 곧 "정렬 판정에 도달했는가"의 판별이기도 하다.
    if (c.alignment) tally(`align-${c.alignment}`);
    // 오버레이 — 위 6종과 배타가 아니므로 합산에서 제외된다(runRelativeChecks 주석).
    if (c.degenerate) tally('align-degenerate');

    // ⚠️ 스킵은 **검사 단위**로 센다. C와 평탄성은 성립 조건이 다르다 — 항목 단위로 세면
    //    "C를 못 했다"는 사실이 평탄성이 돌았다는 이유로 통째로 사라진다.
    if (c.state === 'skipped') bump(c.reason);
    if (f.state === 'skipped') bump(f.reason);
    // C가 checked라도 축별로 스킵될 수 있다(recalced / no-baseline) — 축 단위로도 센다.
    for (const a of c.axes ?? []) if (a.state === 'skipped') bump(`axis-${a.reason}`);

    const cRan = c.state === 'checked' && ((c.axes?.some(a => a.state === 'checked')) || c.staleFinding);
    if (!cRan && f.state === 'skipped') {
      fields.push({ field: it.id, ok: null, skipped: c.state === 'skipped' ? c.reason : 'no-axis' });
      continue;
    }
    checked++;
    let ok = true;
    const fail = finding => {
      if (ok) blocked++;
      ok = false;
      findings.push(finding);
    };

    // ── stale-history — 정렬이 성립하지 않을 만큼 history가 낡았다 ────
    if (c.staleFinding) {
      fail({
        id: it.id, kind: 'stale-history', checkKind: 'stale-history', grade: c.grade,
        priceDate: c.priceDate, historyDate: c.historyDate, priceSource: c.priceSource,
        alignment: c.alignment, gap: c.gap,
        detail: c.gap == null
          ? `history[-1] ${c.historyDate}이 price 거래일 ${c.priceDate}보다 미래 — 정렬 이상`
          : `history 미갱신 ${c.gap}거래일 (history[-1] ${c.historyDate} vs price 거래일 ${c.priceDate})`,
      });
    }

    for (const a of c.axes ?? []) {
      if (a.state !== 'checked' || a.ok) continue;
      fail({
        id: it.id, kind: 'cross', checkKind: a.checkKind, grade: c.grade,
        priceDate: c.priceDate, historyDate: c.historyDate, priceSource: c.priceSource,
        alignment: c.alignment,
        // ⚠️ 중립 문구 — 어느 쪽이 틀렸는지 이 검사로는 알 수 없다.
        detail: `[${a.checkKind}] 양측 불일치 ${(a.residual * 100).toFixed(3)}% > 허용 ${(a.tolerance * 100).toFixed(3)}%`
          + ` (정렬 ${c.alignment}, price거래일 ${c.priceDate}, history ${c.historyDate})`,
      });
    }

    if (f.state === 'checked' && !f.ok) {
      fail({
        id: it.id, kind: 'flat', checkKind: 'flat',
        priceDate: c.priceDate ?? null, historyDate: c.historyDate ?? null,
        priceSource: c.priceSource ?? it.source ?? null,
        detail: `${f.run}일 연속 동일값 ${f.value} (${f.from}~${f.to})`,
      });
    }

    fields.push({ field: it.id, ok, reason: ok ? null : (findings.at(-1)?.kind ?? 'violation'),
      detail: ok ? null : findings.at(-1)?.detail });
  }

  // ── 게이트 결함 추정용 원인 다양성 ─────────────────────────────────
  // "전 필드 동시 차단 = 게이트 결함"은 **필드 독립을 가정**한다. 날짜 오정렬처럼 공통
  // 원인이 작용하면 동시 차단이 정상 결과여서 그 추정이 성립하지 않는다. 그래서 차단
  // 집합의 다양성을 함께 넘긴다 — 단일 벤더 동시 차단은 게이트가 아니라 소스 문제다
  // (실측: nasdaq·dow·sp500·sox·vix는 price가 전부 CNBC 단일 bulk 콜이다).
  const blockDiversity = {
    sources: new Set(findings.map(x => x.priceSource ?? 'unknown')).size,
    kinds:   new Set(findings.map(x => x.checkKind ?? x.kind)).size,
    alignments: new Set(findings.map(x => x.alignment ?? 'n/a')).size,
    soleSource: (() => {
      const s = new Set(findings.map(x => x.priceSource ?? 'unknown'));
      return s.size === 1 ? [...s][0] : null;
    })(),
  };

  return { checked, blocked, skipped, skipReasons, counters, findings, fields, observations, blockDiversity };
}

/**
 * ── 범위 제외 기록(1단계 조사 결론) ───────────────────────────────────
 * · **급변 검사**: 보류. 한국 주식 일일 가격제한폭이 ±30%라 임계 30%가 상한가·하한가와
 *   정확히 충돌한다(정상 상한가를 이상으로 판정). KRX 원문은 6개 경로 전부 실패해
 *   (regulation.krx.co.kr 등 JS 렌더) 제한폭·예외(신규상장·정리매매·ETF)를 근거 있게
 *   적을 수 없다.  TODO: KRX 원문 확보 시 asset-meta에 유형별 임계를 얹어 재개할 것.
 * · **뉴스 교차확인**: 로드맵에서 제외. RSS 4종은 헤드라인만 주고 종목 태그가 없으며,
 *   감시 대상(HYPR·코스닥 3종)은 국내 RSS 게재율이 낮다. 결정적으로 매칭 실패 시
 *   행동을 정의할 수 없다 — "뉴스 없음"이 이상인지 미게재인지 구분되지 않아 경보로 쓰면
 *   상시 오탐이고 무시하면 검사가 무의미하다.
 * · **naver-index http-400**: 검사 2a 정의 밖. 명시적 HTTP 실패라 "200인데 값이 이상"이
 *   아니다(48시간 569성공/7실패, 시각 집중 없음). health가 계측하고 last-good이 폴백한다.
 * · **저유동성 무변동**: 판정 수단 없음. 거래량을 싣지 않는 한 "안 움직인 것"과 "거래가
 *   없던 것"을 구분할 수 없다 — 개별 종목을 평탄성에서 뺀 이유이며, **오탐 불가 구간**으로
 *   명시한다(여기에 검사를 넣으면 반드시 오탐이 난다).
 */
export const EXCLUDED_FROM_CHECK2 = ['sudden-move', 'news-cross', 'http-400', 'illiquid-flat'];
