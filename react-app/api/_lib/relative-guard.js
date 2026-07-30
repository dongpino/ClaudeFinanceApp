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
 * 거래일 정렬(tradingDateOf)을 세운 뒤 change 축을 편입했다(2026-07-30). prevClose는
 * price − change로 만들고 전 거래일 종가와 대조한다 — 레벨 축과 같은 양자화 허용오차를
 * 쓰되 반올림이 두 번 겹치므로 2양자를 허용한다.
 *
 *   커버 상태 — 검사 1이 넘긴 미커버 4건 중:
 *     ① 네이버 장전 quote change=0            → **커버.** change가 잘못 0이면 prevClose가
 *        당일 종가가 되어 전 거래일 종가와 벌어진다. 정당한 보합이면 잔차 0으로 통과한다.
 *     ② us10y r2 반올림 뭉갬                   → **미커버(원리적).** 오차가 정의상 1양자
 *        미만이라 값 대조로는 잡을 수 없다. observations의 internal-prevclose가 그 증상을
 *        관측하지만 임계 산정 전이라 계상하지 않는다.
 *     ③ recalcChange 검증                      → **커버.** 발동 시 change 축은 항등이 되므로
 *        recalced로 스킵하고 **원본값**으로 cross-prevclose-origin 축을 따로 돌린다.
 *     ④ detectIssues 0경고인데 change 오류      → **부분 커버.** 오차가 2양자 허용을 넘을 때.
 *
 * ── 시계 게이팅을 없앤 이유 ──────────────────────────────────────────
 * 종전에는 폐장일 때만 돌렸다. "장중엔 price와 history[-1]이 어긋나는 게 정상"이라서였는데,
 * 그 어긋남은 **어느 캔들과 견주는지를 잘못 고른 결과**였다(vix 11.859%는 정확히 VIX의
 * 1일 변동폭이었다). 거래일을 맞추면 장중에도 견줄 짝이 있다 — 당일 캔들이 없으면 가격
 * 축이 성립하지 않을 뿐이고 change 축은 그대로 돈다.
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
 *   non-trading-day     주말·휴장일. 전 거래일
 *   continuous-weekday  FX·금리 평일
 *   continuous-weekend  FX·금리 주말 → 직전 금요일
 *   utc-date            크립토(24시간, 세션 경계가 없어 UTC 날짜를 쓴다)
 *
 * @param {string} id      ASSET_META 키
 * @param {Date|string|number} at  price의 관측 시각(as_of)
 * @returns {{ date: string|null, market: string|null, basis: string }}
 */
export function tradingDateOf(id, at = new Date()) {
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
    return { date: prevTradingDay(date, s.holidays), market, basis: 'pre-open' };
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
//   [계산@2026-07-30T02:10:30Z 프로덕션 9072dee8]
//   HYPR prevClose 0.91 vs history[-2] 0.92 → 잔차 1.099%,
//        1양자 허용 0.01/0.91 = 1.099% → 잔차 == 허용, 경계에 정확히 걸림
//        2양자 허용 2.198% → 여유 있게 통과
const QUANTA_PRICE = 1, QUANTA_PREVCLOSE = 2;

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
 * ── 정렬 4분기 ───────────────────────────────────────────────────────
 *   same-day  history[-1].date === price 거래일  → 가격 축 + change 축
 *   prev-day  history[-1].date === 전 거래일      → change 축만(당일 캔들 부재는 정상)
 *   stale     그보다 낡음                          → **그 자체가 finding**(파서 동결 증상)
 *   no-date   거래일을 못 구함                     → 스킵(정렬 기준 없이는 판정 불가)
 *
 * @returns {{
 *   state:'checked'|'skipped', reason?:string, alignment?:string, gap?:number|null,
 *   priceDate?:string|null, historyDate?:string|null, priceSource?:string|null,
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

  const price = item.price;
  const hist = Array.isArray(item.history) ? item.history : [];
  const h1 = hist.at(-1), h2 = hist.at(-2);
  // history나 price가 아예 없으면 정렬할 것이 없다 — 유일하게 남은 '기준선 없음' 스킵.
  if (!Number.isFinite(price) || !Number.isFinite(h1?.close)) {
    return { state: 'skipped', reason: 'no-baseline' };
  }

  const holidayKey = holidayKeyOf(meta.market);
  const priceDate = tradingDateOf(item.id, item.as_of ?? now).date;
  if (!priceDate) return { state: 'skipped', reason: 'no-trading-date' };
  const pv = prevTradingDay(priceDate, holidayKey);

  let alignment;
  if (h1.date === priceDate)   alignment = 'same-day';
  else if (h1.date === pv)     alignment = 'prev-day';
  else                         alignment = 'stale';

  const base = {
    state: 'checked', alignment, priceDate, historyDate: h1.date,
    priceSource: item.source ?? null, grade: meta.cross,
    gap: tradingDaysBetween(h1.date, priceDate, holidayKey),
  };

  const axes = [], observations = [];
  const mkAxis = (checkKind, observed, expected, denom, quanta) => {
    if (!Number.isFinite(observed) || !Number.isFinite(expected)) {
      axes.push({ checkKind, state: 'skipped', reason: 'no-baseline' });
      return;
    }
    const tolerance = crossTolerance(item.id, denom, quanta);
    const residual = Math.abs(expected - observed) / Math.abs(denom || 1);
    axes.push({ checkKind, state: 'checked', ok: residual <= tolerance,
      residual, tolerance, observed, expected, quanta });
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

  const prevClose = Number.isFinite(item.change) ? price - item.change : NaN;

  if (alignment === 'same-day') {
    mkAxis('cross-price', price, h1.close, price, QUANTA_PRICE);
  }
  // change 축의 대조 캔들 — same-day면 history[-2], prev-day면 history[-1].
  const changeBaseline = alignment === 'same-day' ? h2?.close : h1.close;

  // ── recalcChange 발동 항목 — change 축이 history에서 파생돼 항등이다 ──
  // us-indices.recalcChange가 |change| ≤ 0.01일 때 price/prev_close를 history 값으로
  // 덮어쓴다. 그러면 prevClose ↔ history 대조가 자기 자신과의 비교가 되거나(분기 1),
  // 한 칸 밀린 값과의 비교가 되어 체계적 오탐이 된다(분기 2).
  // 그래서 **원본값으로 별도 검사**한다 — 그게 "재계산이 옳았는가"의 유일한 판정 경로다.
  const rc = item.change_recalced;
  if (rc?.from) {
    axes.push({ checkKind: 'cross-prevclose', state: 'skipped', reason: 'recalced' });
    const origPrev = rc.from.price - rc.from.change;
    mkAxis('cross-prevclose-origin', origPrev, changeBaseline, origPrev, QUANTA_PREVCLOSE);
  } else {
    mkAxis('cross-prevclose', prevClose, changeBaseline, prevClose, QUANTA_PREVCLOSE);
  }

  // ── 관측 전용 축: internal-prevclose ────────────────────────────────
  // item.prev_close(소스가 준 필드) ↔ price − change. history가 필요 없어 24시간 성립한다.
  // ⚠️ **blocked에 계상하지 않는다.** 실측 2건이 잡히는데(HYPR 0.01 / us10y 0.001) 둘 다
  //    정상 반올림일 가능성이 높다 — unit별 정밀도 규약(percent=r4, 그 외 r2)에서 기대
  //    오차를 파생해야 임계를 정할 수 있다. TODO([E] 이후): 임계 산정 후 계상 여부 재판단.
  if (Number.isFinite(item.prev_close) && Number.isFinite(prevClose)) {
    const diff = Math.abs(item.prev_close - prevClose);
    observations.push({
      checkKind: 'internal-prevclose', observeOnly: true,
      observed: prevClose, expected: item.prev_close, diff,
      residual: Math.abs(prevClose) ? diff / Math.abs(prevClose) : null,
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
 * @returns {{ checked, blocked, skipped, skipReasons, findings, fields, observations, blockDiversity }}
 */
export function runRelativeChecks(items, now = new Date()) {
  let checked = 0, blocked = 0, skipped = 0;
  const skipReasons = {};
  const findings = [];
  const fields = [];
  const observations = [];
  const bump = reason => { skipped++; skipReasons[reason] = (skipReasons[reason] ?? 0) + 1; };

  for (const it of items ?? []) {
    if (!it?.id) continue;

    const c = checkCross(it, now);
    const f = checkFlatness(it);
    if (Array.isArray(c.observations)) observations.push(...c.observations.map(o => ({ id: it.id, ...o })));

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

  return { checked, blocked, skipped, skipReasons, findings, fields, observations, blockDiversity };
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
