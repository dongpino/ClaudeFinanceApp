/**
 * api/_lib/relative-guard.js — **검사 2a(상대 타당성 — 가격 축)**. 순수 로직, 네트워크·Redis 없음.
 *
 * 검사 1(절대 타당성)이 "값 하나만 보고 알 수 있는 것"을 담당했다면 여기는 **두 값을
 * 견줘야 알 수 있는 것**을 본다. 1단계 조사에서 범위를 크게 좁혔다:
 *   · C(교차소스 대조) — price ↔ history[-1]
 *   · 평탄성(파서 동결) — history가 여러 날 완전히 같은 값
 * 급변·뉴스 교차확인·naver-index 400은 제외했다(근거는 파일 하단 EXCLUDED 주석).
 *
 * ── 이름이 '2a'인 이유 = **change 축은 아직 미커버**다 ────────────────
 * 여기서 보는 것은 **레벨값(price)** 뿐이다. change/change_pct(변동 축)는 검사 1이
 * "하락일에 음수·보합에 0이 정상"이라 손대지 않고 검사 2 계열로 이관했는데, 그 이관을 받은
 * 것이 이 파일이고 **아직 change 축을 구현하지 않았다.** 즉 아래 4건은 지금 어느 검사도
 * 잡지 않는다:
 *   ⚠️ TODO(검사 2b — change 축): 미커버 4건. 설계는 tradingDateOf()를 전제로 한다.
 *     ① 네이버 장전 quote가 change/change_pct를 0으로 반환 (실측, 삼성전자 재현)
 *     ② us10y r2 반올림으로 0.01%p 미만 변동이 0으로 뭉개짐 (→ r4로 정밀도 보존 완료,
 *        그러나 "뭉개졌는지 감지"하는 검사는 없다)
 *     ③ us-indices recalcChange(|change| ≤ 0.01이면 history로 재계산) — 재계산이 옳게
 *        됐는지 검증하는 축이 없다
 *     ④ 클라이언트 detectIssues가 경고 0건인데 실제로는 change가 틀린 경우
 *   방향: prevClose(= price − change)를 history[-2].close와 대조하면 change 축이
 *   레벨 축과 같은 양자화 허용오차로 판정된다. 거래일 정렬이 선행 조건이라 이 커밋에서
 *   tradingDateOf()를 먼저 넣었다.
 *
 * ⚠️ **차단하지 않는다. 경보만 한다.** 이 검사는 이미 서빙된 값의 사후 검증이라 막을
 *    대상이 없다(검사 1은 캐시 진입 전이라 차단이 성립했다). 서빙 경로에 개입하지 않음은
 *    market-data.js:243에서 반환값을 쓰지 않는 것으로 코드상 보장된다.
 * ⚠️ **C 위반이 곧 price 오류라는 뜻이 아니다.** history 쪽 파서가 깨졌을 수도 있다 —
 *    어느 쪽이 틀렸는지는 이 검사로 알 수 없으므로 문구를 "양측 불일치"로 중립하게 쓴다.
 */

import { ASSET_META, isFlatExempt } from './asset-meta.js';
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

/**
 * 아이템의 as_of 문자열/Date → Date. 홈 아이템은 'YYYY-MM-DD HH:mm KST' 형식을 쓴다
 * (market-data.fmtKST) — Date.parse가 'KST'를 못 읽으므로 직접 처리한다.
 * @returns {Date|null} 해석 불가면 null
 */
export function parseAsOf(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v !== 'string') return null;
  // 'KST'는 서머타임이 없어 +09:00 고정이 어느 계절에도 참이다(probe-store.js와 같은 근거).
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*KST$/);
  if (m) return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}+09:00`);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * **그 시점에 관측된 price가 속한 거래일.** 항목의 세션(ASSET_META.market)으로 판정한다.
 *
 * basis 어휘 — 사람이 "왜 그 날짜인가"를 되짚을 수 있게 함께 돌려준다.
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
  const when = parseAsOf(at);
  if (!when) return { date: null, market, basis: 'unparsable-asof' };
  // 크립토는 폐장이 없어 '거래일'이 세션으로 정의되지 않는다. 캔들 날짜도 UTC 기준이다.
  if (market === 'CRYPTO') return { date: when.toISOString().slice(0, 10), market, basis: 'utc-date' };
  const s = SESSION[market];
  if (!s) return { date: null, market, basis: 'unknown-market' };

  const { date, minutes } = localParts(when, s.tz);

  if (s.kind === 'continuous') {
    // 주말이면 직전 금요일 — 일요일 저녁에 장이 재개돼도 **완결된 마지막 거래일**은
    // 금요일이다(소스가 일요일 캔들을 발행하지 않는다). isMarketClosed와 답이 다른 게
    // 정상이다 — 저쪽은 "지금 거래 중인가", 이쪽은 "price가 어느 날의 값인가"를 답한다.
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

/** @returns {number} 상대 허용 오차(비율). price가 작을수록 커진다(양자화 지배). */
export function crossTolerance(id, price) {
  const meta = ASSET_META[id] ?? {};
  const floor = meta.cross === 'cross' ? CROSS_FLOOR_REL : SEMI_FLOOR_REL;
  const quantum = meta.quantum ?? 0.01;
  const p = Math.abs(price);
  if (!p) return floor;
  return Math.max(floor, quantum / p);   // 1스텝 = 두 값 반올림 차이의 상한
}

/**
 * C 검사 1건. 폐장이 아니거나 대조가 성립하지 않으면 **skipped**로 돌려보낸다
 * (checked로 세면 "검사했는데 통과"와 "아예 못 했다"가 섞인다).
 * @returns {{ state:'checked'|'skipped', ok?:boolean, reason:string, residual?:number, tolerance?:number }}
 */
export function checkCross(item, now = new Date()) {
  const meta = ASSET_META[item?.id];
  if (!meta) return { state: 'skipped', reason: 'no-meta' };
  if (meta.cross === 'tauto') return { state: 'skipped', reason: 'tauto' };
  if (meta.cross !== 'cross' && meta.cross !== 'semi') return { state: 'skipped', reason: 'no-grade' };

  const { closed, reason: mkt } = isMarketClosed(meta.market, now);
  if (!closed) return { state: 'skipped', reason: 'market-open' };

  const price = item.price;
  const hist = Array.isArray(item.history) ? item.history : [];
  const last = hist.length ? hist[hist.length - 1]?.close : null;
  if (!Number.isFinite(price) || !Number.isFinite(last)) return { state: 'skipped', reason: 'no-baseline' };

  const tolerance = crossTolerance(item.id, price);
  const residual = Math.abs(last - price) / Math.abs(price || 1);
  return {
    state: 'checked', ok: residual <= tolerance,
    reason: mkt, residual, tolerance, grade: meta.cross,
  };
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

// ── 기준선 나이 ──────────────────────────────────────────────────────
// 조사 말미 지적: "기준선이 있는데 낡은" 경우를 checked로 세면 checked>0이 "검사가
// 유효했다"를 보장하지 못한다. 나이가 임계를 넘으면 skipped-stale-baseline으로 뺀다.
export const BASELINE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3일

export function baselineTooOld(item, now = new Date()) {
  const hist = Array.isArray(item?.history) ? item.history : [];
  const lastDate = hist.length ? hist[hist.length - 1]?.date : null;
  if (!lastDate) return { stale: true, ageMs: null };
  const ageMs = now.getTime() - Date.parse(`${lastDate}T00:00:00Z`);
  return { stale: ageMs > BASELINE_MAX_AGE_MS, ageMs };
}

/**
 * 아이템 배열 → 검사 2a 결과 집계. **순수 함수**(호출측이 Redis에 기록한다).
 * @returns {{ checked, blocked, skipped, skipReasons, findings, fields }}
 */
export function runRelativeChecks(items, now = new Date()) {
  let checked = 0, blocked = 0, skipped = 0;
  const skipReasons = {};
  const findings = [];
  const fields = [];
  const skip = (id, reason) => {
    skipped++;
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    fields.push({ field: id, ok: null, skipped: reason });
  };

  for (const it of items ?? []) {
    if (!it?.id) continue;
    // ① 기준선 나이 — 낡았으면 아예 검사하지 않는다(checked에 넣지 않는 것이 핵심).
    const age = baselineTooOld(it, now);
    if (age.stale) { skip(it.id, age.ageMs == null ? 'no-baseline' : 'stale-baseline'); continue; }

    const c = checkCross(it, now);
    const f = checkFlatness(it);
    // ⚠️ 스킵은 **검사 단위**로 센다. C와 평탄성은 실행 조건이 다르다 — 장중엔 C만 못 하고
    //    평탄성(일봉 기반)은 그대로 돈다. 항목 단위로 세면 "C를 못 했다"는 사실이
    //    평탄성이 돌았다는 이유로 통째로 사라진다.
    if (c.state === 'skipped') { skipped++; skipReasons[c.reason] = (skipReasons[c.reason] ?? 0) + 1; }
    if (f.state === 'skipped') { skipped++; skipReasons[f.reason] = (skipReasons[f.reason] ?? 0) + 1; }
    if (c.state === 'skipped' && f.state === 'skipped') {
      fields.push({ field: it.id, ok: null, skipped: c.reason });
      continue;
    }
    checked++;
    let ok = true;
    if (c.state === 'checked' && !c.ok) {
      ok = false; blocked++;
      findings.push({
        id: it.id, kind: 'cross', grade: c.grade,
        // ⚠️ 중립 문구 — 어느 쪽이 틀렸는지 이 검사로는 알 수 없다.
        detail: `양측 불일치 ${(c.residual * 100).toFixed(3)}% > 허용 ${(c.tolerance * 100).toFixed(3)}%`,
      });
    }
    if (f.state === 'checked' && !f.ok) {
      if (ok) blocked++;
      ok = false;
      findings.push({
        id: it.id, kind: 'flat',
        detail: `${f.run}일 연속 동일값 ${f.value} (${f.from}~${f.to})`,
      });
    }
    fields.push({ field: it.id, ok, reason: ok ? null : (findings.at(-1)?.kind ?? 'violation'),
      detail: ok ? null : findings.at(-1)?.detail });
  }
  return { checked, blocked, skipped, skipReasons, findings, fields };
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
