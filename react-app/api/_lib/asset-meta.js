/**
 * api/_lib/asset-meta.js — 자산·지표 메타 원본(single source of truth)
 *
 * 로드맵 ③ **검사 1(절대 타당성)**의 기준표다. 소스가 200으로 성공하면서 형태가 깨진 값
 * (NaN/Infinity/""/"N/A"/null)이나 정의역 밖 값을 캐시·:latest에 넣지 않기 위한 판정 근거를
 * 여기 한 곳에 모은다.
 *
 * ⚠️ **음수 가격은 하위 사례일 뿐이다.** 실제 위험은 파서 실패가 0으로 표현되는 것이고,
 *    그래서 이 표는 "양수 여부"가 아니라 **유형별 정의역**을 적는다.
 *
 * ── 이 파일이 원본인 것(3중 관리 → 1중) ──────────────────────────────
 *   · NON_PRICE_UNITS  (종전 src/components/MarketCard.jsx 하드코딩)
 *   · FALLBACK_IDS     (종전 api/market-data.js 하드코딩)
 *   · 정의역 검증       (종전 없음 — bok-rate.js만 자체 보유)
 *   파생값이 종전 하드코딩과 같은지는 scripts/test-value-guard.js가 고정한다(전환 실수 방지).
 *
 * ⚠️ 의존성 없음(순수 데이터 + 순수 함수). 클라이언트(src/)에서도 import하므로
 *    node: 모듈이나 Redis를 절대 들이지 말 것.
 *
 * ── 검사 1의 범위(중요) ──────────────────────────────────────────────
 *   **레벨값의 형태·정의역만** 본다. change/change_pct(변동 축)는 하락일에 음수가
 *   정상이고 0도 정상이라 여기서 판정하지 않는다 — "200인데 change가 0" 유형의 과거
 *   4건(네이버 장전 0 반환, us10y r2 반올림 뭉갬 등)은 **검사 2b(change 축)** 재료다.
 *   클라이언트 detectIssues의 경고도 그대로 둔다(서버 차단과 역할 분담).
 */

/**
 * @typedef {object} AssetMeta
 * @property {'price'|'rate'|'ratio'|'score'} kind  유형
 * @property {string|null} unit        MarketCard 표시 단위(null이면 가격)
 * @property {number|null} min         정의역 하한(포함). null이면 무제한
 * @property {number|null} max         정의역 상한(포함). null이면 무제한
 * @property {boolean} allowNegative   음수가 정상인가
 * @property {boolean} fallback        last-good commit/폴백 대상인가
 */

// ── 검사 2a(상대 타당성 — 가격 축)용 메타 ─────────────────────────────
// cross : price와 history가 **서로 다른 소스**다. history[-1] 대조가 진짜 교차검산이 된다.
//         예) CNBC 7종 — price=CNBC quote, history=Naver sise/Naver world/FRED/CBOE
// semi  : 같은 소스의 **다른 엔드포인트**다. 소스 전체가 죽으면 둘 다 죽으므로 장애는
//         못 잡지만, **한쪽 파서만 깨진 편측 실패**는 잡을 수 있다(그게 이 등급의 전부다).
// tauto : 같은 소스의 같은 계열이라 대조가 동어반복이다 → C 검사 **제외**.
//         btc/eth/dominance가 여기 속한다(현재가·history 모두 CoinGecko).
// tautological : **같은 응답의 같은 행**이라 잔차가 정의상 0이다 → C 검사 제외.
//         tauto보다 강한 조건이다. tauto는 "같은 벤더라 서로를 반증하지 못한다"이고
//         이쪽은 "애초에 같은 숫자를 두 번 읽었다"다 — 파서가 하나뿐이라 semi가 약속하는
//         '편측 파서 실패 감지'조차 성립하지 않는다. 사유를 구분해 기록하는 이유가 이것이다.
//
// ⚠️ **등급은 소스 구조에서 나온다. 스냅샷 1회의 잔차로 정하지 않는다.**
//    2026-07-30 강등 근거는 코드 구조다(잔차 0 실측은 그 구조의 확인일 뿐):
//      kospi·kosdaq  fetchIndexCurrent  = m.stock.naver.com/api/index/{code}/price rows[0],[1]
//                    fetchIndexHistory  = **같은 엔드포인트** ?pageSize=30      (kr.js:45-62)
//      usdkrw·jpykrw fetchExchangeCurrent = exchangeDailyQuote.naver page=1 matches[0],[1]
//                    fetchExchangeHistory = **같은 페이지** 1~3               (kr.js:134-176)
//    반대로 419530·028300·080220은 잔차가 오늘 0이어도 semi를 유지한다 —
//      quote=/api/stock/{code}/basic ↔ history=/api/stock/{code}/price (naver-stock.js:76, :147)
//      **엔드포인트가 달라** 한쪽 파서만 깨지면 잡힌다. 항등이 아니라 우연한 일치다.
const CROSS = 'cross', SEMI = 'semi', TAUTO = 'tauto', TAUTOLOGICAL = 'tautological';

// ── 세션(market) ─────────────────────────────────────────────────────
// "폐장일 때만 검사한다"는 실행 조건과 **거래일 파생**(relative-guard.tradingDateOf)에 쓴다.
// 값은 relative-guard.js의 SESSION 키다 — 그쪽이 개·폐장 시각과 종류를 갖는다.
//   US     : 주식 intraday 세션(09:30~16:00 ET). 지수·변동성지수·개별 미국 종목.
//   KR     : 주식 intraday 세션(09:00~15:30 KST).
//   FX     : **평일 연속 세션. 주말만 폐장.** FX·금리는 주식이 닫힌 뒤에도 계속 거래된다.
//   CRYPTO : 24시간. 폐장이 없고 전부 tauto라 C 실행 조건에는 실제로 쓰이지 않는다.
//
// ⚠️ dxy·us10y를 US(주식) 세션에 묶어 둔 것이 오탐의 직접 원인이었다(2026-07-30 분리).
//    16:00 ET에 주식이 닫혀도 FX·금리는 살아 있으므로 그 시간대 price는 실시간 값이고
//    전일 종가와 벌어지는 게 정상이다. 실측:
//    [저장소:9072dee8:health:validate:fields:relative@2026-07-30T00:38:40Z]
//    us10y가 18:59 ET(=주식 폐장·금리 거래중) 회차에 1.493%로 위반 기록됐다.
const US = 'US', KR = 'KR', FX = 'FX', CRYPTO = 'CRYPTO';

// ── 갱신 주기와 성격 ─────────────────────────────────────────────────
// 평탄성(파서 동결) 검사의 면제 여부를 **여기서 파생**한다. 항목마다 boolean 플래그를
// 손으로 다는 대신 "이 값이 원래 어떤 리듬으로 움직이는가"를 적고 규칙이 읽게 한다
// (단일 원본 파생 원칙 — FALLBACK_IDS·NON_PRICE_UNITS와 같은 방식).
//   cadence : 값이 갱신되는 주기. monthly/quarterly는 일 단위로 보면 당연히 평탄하다.
//   type    : 값의 성격. policy_rate는 **동결이 정상 상태**이고 그 길이 자체가 정보다
//             (MarketCard의 FREEZE_AFTER_DAYS=49가 그 전제로 동작한다).
const DAILY = 'daily', MONTHLY = 'monthly', QUARTERLY = 'quarterly';
const POLICY_RATE = 'policy_rate';

/** 평탄성 검사를 면제할 갱신 주기 — 일 단위로 보면 평탄한 게 정상인 것들. */
const FLAT_EXEMPT_CADENCES = new Set([MONTHLY, QUARTERLY]);
/** 평탄성 검사를 면제할 값 성격 — 평탄함 자체가 정상 신호인 것들. */
const FLAT_EXEMPT_TYPES = new Set([POLICY_RATE]);

/** 가격류 공통 — 0 초과 무제한. 0은 "파서가 실패했다"의 가장 흔한 표현이라 배제한다. */
const PRICE = { kind: 'price', unit: null, min: 0, max: null, allowNegative: false, fallback: true, exclusiveMin: true };

export const ASSET_META = {
  // ── 지수·가격 ────────────────────────────────────────────────
  // CNBC quote ↔ Naver sise/world·FRED·CBOE history — 소스가 완전히 다르다(cross).
  nasdaq: { ...PRICE, cross: CROSS, market: US, quantum: 0.01 },
  dow:    { ...PRICE, cross: CROSS, market: US, quantum: 0.01 },
  sp500:  { ...PRICE, cross: CROSS, market: US, quantum: 0.01 },
  sox:    { ...PRICE, cross: CROSS, market: US, quantum: 0.01 },
  // ⚠️ 종전 semi → **tautological 강등**(2026-07-30). 현재가와 history가 같은 엔드포인트의
  //    같은 행이다(kr.js:45-62) — price = rows[0].closePrice, history[-1] = 같은 rows[0].
  //    [계산@2026-07-30T01:49:26Z 프로덕션 9072dee8] price−history[-1] = 0.00000000,
  //    prevClose−history[-2] = 0.00000000 (kospi 5663.24 / kosdaq 662.68). 우연이 아니라 정의다.
  //    ⚠️ Naver 실패 시 Yahoo(^KS11/^KQ11) 폴오버가 현재가만 갈아치우므로 그때는 진짜 교차가
  //       된다 — 그 축은 별건(로드맵 ① 겸용)으로 다룬다. 상시 등급은 항등이 맞다.
  kospi:  { ...PRICE, cross: TAUTOLOGICAL, market: KR, quantum: 0.01 },
  kosdaq: { ...PRICE, cross: TAUTOLOGICAL, market: KR, quantum: 0.01 },
  // 현재가·history 모두 CoinGecko 계열 → 대조가 동어반복(tauto). C 검사에서 제외한다.
  btc: { ...PRICE, cross: TAUTO, market: CRYPTO },
  eth: { ...PRICE, cross: TAUTO, market: CRYPTO },
  // 변동성지수. history는 Naver world→CBOE. **주식 파생상품이라 US 세션 유지**다 —
  // VIX는 CBOE 정규장(주식과 동일)에 종가가 확정된다.
  vix: { ...PRICE, cross: CROSS, market: US, quantum: 0.01 },
  // ⚠️ FX 세션 — 주식과 함께 닫히지 않는다. history는 Naver marketIndex(exchange/FX_USDX).
  dxy: { ...PRICE, cross: CROSS, market: FX, quantum: 0.01 },
  // ── 원화 환율: KR 세션 유지 + tautological 강등 ─────────────
  // ⚠️ **KR 세션 유지의 근거를 정정한다(2026-07-30).** 종전 주석은 "서울 외환시장 정규시간
  //    09:00~15:30이 KR 주식 세션과 같아서"라고 적었는데 그 근거는 성립하지 않는다 —
  //    서울 외환시장은 개편으로 정규시간이 늘었고 공휴일에도 거래된다.
  //    성립하는 근거는 시장이 아니라 **소스 발행 캘린더**다. 검사가 대조하는 것은 시장이
  //    아니라 Naver 환율 표이고, 그 표는 KRX 영업일만 발행한다:
  //    [자체실측 @2026-07-30T01:34:43Z 프로덕션 9072dee8, history_90d 2026-03-19~07-29]
  //      구간 내 평일 KR 공휴일 5건(05-01·05-05·05-25·06-03·07-17) 전부 캔들 없음 → 0/5
  //      대조군 kospi·kosdaq도 0/5 (동일 패턴) / FX 세션인 dxy 3/3·us10y 3/4 (반대 패턴)
  //      usdkrw ↔ jpykrw 90일 날짜 집합 **완전 동일** — 소스 수준에서 두 통화가 구분 안 됨
  //    ⚠️ **KRW-FX 세션은 신설하지 않는다.** 아래 항등 강등으로 C 검사가 아예 돌지 않으므로
  //       폐장 판정이 결과에 영향을 주지 않는다. 더 근본적으로 price = 캔들 row 0이라
  //       공휴일에 캔들이 없으면 price도 갱신되지 않아 **오탐이 구조적으로 불가능**하다
  //       (dxy를 옮긴 근거 — 캔들은 붙는데 폐장으로 잡혀 오탐 — 이 여기서는 성립하지 않는다).
  // ⚠️ 종전 semi → tautological 강등: 현재가·history가 같은 페이지의 같은 행이다(kr.js:134-176).
  //    [계산@2026-07-30T01:49:26Z] usdkrw·jpykrw 모두 price−history[-1]=0, prevClose−history[-2]=0.
  //    TODO(검사 2b 이후): Frankfurter 폴백 시에만 price 소스가 갈려 진짜 교차가 된다.
  //      단 그 잔차(실측 0.44%, kr.js:148-152)는 ECB 기준환율의 **1일 시차**에서 오는 값이라
  //      vix 11.859%와 같은 날짜 오정렬 유형이다 — 검출 근거로 쓰지 말 것. 거래일 정렬을
  //      먼저 세운 뒤에 판단한다.
  usdkrw: { ...PRICE, cross: TAUTOLOGICAL, market: KR, quantum: 0.01 },
  jpykrw: { ...PRICE, cross: TAUTOLOGICAL, market: KR, quantum: 0.01 },
  // ── 개별 종목 ────────────────────────────────────────────────
  // 평탄성 검사에서 제외한다(저유동성·거래정지를 판정할 수단이 없어서).
  // ⚠️ 코스닥 3종은 **semi 유지**다. 잔차가 오늘 0이지만 항등이 아니다 —
  //    quote=/api/stock/{code}/basic ↔ history=/api/stock/{code}/price (naver-stock.js:76, :147).
  //    엔드포인트가 달라 한쪽 파서만 깨지면 잡힌다. 등급은 구조로 정하고 스냅샷으로 정하지 않는다.
  // ⚠️ HYPR는 실은 semi가 아니다 — price=Finnhub, history=Twelve Data로 **벤더가 다르다**
  //    (watchlist.js:71-72). 등급 정의상 cross에 해당한다. 실측도 항등이 아니다:
  //    [계산@2026-07-30T01:49:26Z] price−history[-1]=0 이지만 prevClose−history[-2]=−0.01.
  //    TODO: cross 승격 검토(허용 바닥이 0.2%→0.5%로 완화되는 부작용을 함께 판단해야 함).
  //    지금은 등급을 건드리지 않는다 — singleName이라 평탄성에서 빠지고, C도 [B] 이후에
  //    거래일 정렬이 서야 의미가 생긴다.
  HYPR:     { ...PRICE, cross: SEMI, market: US, quantum: 0.01, singleName: true },
  419530:   { ...PRICE, cross: SEMI, market: KR, quantum: 1, singleName: true },
  '028300': { ...PRICE, cross: SEMI, market: KR, quantum: 1, singleName: true },
  '080220': { ...PRICE, cross: SEMI, market: KR, quantum: 1, singleName: true },

  // ── 금리(음수 실재) ──────────────────────────────────────────
  // ⚠️ 마이너스 금리는 일본·유럽에서 실제로 있었다. "양수여야 함"을 적용할 수 없는 항목.
  //    상·하한은 상식 밖 값(파싱 사고)만 걸리게 넓게 잡는다.
  // ⚠️ price는 r4, history는 r2 — **거친 쪽(0.01)이 양자화 스텝**이다. 실측 잔차 0.217%가
  //    정확히 0.01/4.61이라 이 산정의 근거가 된다.
  // ⚠️ FX 세션 — 국채금리도 주식 폐장 후 계속 움직인다. history는 Naver marketIndex
  //    (bond/US10YT=RR, us-indices.js:222). **FRED가 아니다** — FRED는 dow·sp500 폴백 전용.
  us10y:        { kind: 'rate', unit: 'percent', min: -10, max: 30, allowNegative: true, fallback: true, cross: CROSS, market: FX, quantum: 0.01 },
  kr_base_rate: { kind: 'rate', unit: 'pct_pt',  min: -10, max: 30, allowNegative: true, fallback: true, cross: TAUTO, market: KR, cadence: MONTHLY, type: POLICY_RATE },

  // ── 정의역이 명확한 비율·점수 ────────────────────────────────
  // ⚠️ **하한 0을 포함한다**(종전 공통 규칙 price>0과 충돌했던 지점). 공포탐욕 0과
  //    도미넌스 0은 이론상 정상값이며, 0을 이상값으로 막으면 정상 데이터가 폴백으로 밀린다.
  dominance: { kind: 'ratio', unit: 'pct_pt', min: 0, max: 100, allowNegative: false, fallback: true, cross: TAUTO, market: CRYPTO },
  feargreed: { kind: 'score', unit: 'score',  min: 0, max: 100, allowNegative: false, fallback: true, cross: TAUTO, market: CRYPTO },
};

/** 가격이 아닌 지표의 단위 집합 — MarketCard가 쓰던 하드코딩의 원본. */
export const NON_PRICE_UNITS = new Set(
  Object.values(ASSET_META).map(m => m.unit).filter(Boolean)
);

/** last-good commit/폴백 대상 id 집합 — market-data.js가 쓰던 하드코딩의 원본. */
export const FALLBACK_IDS = new Set(
  Object.entries(ASSET_META).filter(([, m]) => m.fallback).map(([id]) => id)
);

/**
 * 평탄성(파서 동결) 검사 면제 여부 — **cadence/type에서 파생**한다.
 *
 * ⚠️ 항목별 boolean 플래그(flatExempt: true)를 손으로 달지 않는다. 그러면 "왜 면제인가"가
 *    사라지고 새 항목이 들어올 때 판단 근거 없이 복사된다. 여기서는 **값의 성질**만 적고
 *    (월별로 갱신된다 / 정책금리다) 면제는 규칙이 도출한다.
 *
 * 면제 사유 둘:
 *   · cadence가 monthly·quarterly — 일 단위로 보면 평탄한 게 당연하다(월 1회 갱신되는
 *     값의 일별 시계열은 정의상 같은 값이 반복된다).
 *   · type이 policy_rate — **동결이 정상 상태**이고 그 길이 자체가 정보다. 실측으로
 *     kr_base_rate는 24개월 연속 2.75%이며, 평탄성을 적용하면 정의상 상시 오탐이다.
 *
 * ⚠️ 종전에는 kr_base_rate가 stale-baseline(기준선이 3일보다 낡음)이라는 **다른 이유로
 *    우연히** 빠지고 있었다. history가 일별로 바뀌거나 기준선 임계가 늘어나면 즉시
 *    상시 오탐이 되는 상태였다 — 그 우연을 명시적 규칙으로 대체한 것이 이 함수다.
 *
 * @param {string} id  ASSET_META 키 또는 MACRO_FIELD_SPEC 키('cpi'·'fomc.rate' 등)
 */
export function isFlatExempt(id) {
  const meta = ASSET_META[id] ?? MACRO_FIELD_SPEC[id];
  if (!meta) return { exempt: false, reason: null };
  if (FLAT_EXEMPT_TYPES.has(meta.type)) return { exempt: true, reason: meta.type };
  if (FLAT_EXEMPT_CADENCES.has(meta.cadence)) return { exempt: true, reason: `cadence-${meta.cadence}` };
  return { exempt: false, reason: null };
}

/**
 * 레벨값 1개의 절대 타당성 판정.
 * @param {string} id     ASSET_META 키. 없으면 가격류 기본 규칙을 적용한다.
 * @param {unknown} value
 * @returns {{ ok: boolean, reason: string|null }}  reason은 health 히스토그램용 짧은 코드
 */
export function validateLevel(id, value) {
  const meta = ASSET_META[id] ?? PRICE;
  // 숫자가 아닌 것(""·"N/A"·null·undefined·객체)은 형태 붕괴다. 문자열 숫자도 통과시키지
  // 않는다 — 통과시키면 하류의 산술이 조용히 문자열 연결로 바뀐다.
  if (typeof value !== 'number') return { ok: false, reason: 'not-number' };
  if (!Number.isFinite(value)) return { ok: false, reason: Number.isNaN(value) ? 'nan' : 'infinite' };
  if (!meta.allowNegative && value < 0) return { ok: false, reason: 'negative' };
  if (meta.min != null) {
    if (meta.exclusiveMin ? value <= meta.min : value < meta.min) return { ok: false, reason: 'below-min' };
  }
  if (meta.max != null && value > meta.max) return { ok: false, reason: 'above-max' };
  return { ok: true, reason: null };
}

/**
 * macro 계열 필드값(객체) 검증 — 어느 서브필드가 숫자여야 하는지의 정의.
 * macro.js/macro-history.js가 :latest로 승격하기 전에 통과해야 한다.
 * 여기 없는 필드는 검사하지 않는다(문자열 refMonth·asOf 등).
 *
 * ⚠️ **검사 1의 잔여 한계 — 인수인계 지점(2026-07-29 기록)**
 *    macro 필드는 **0과 음수가 정상값**이다(CPI 디플레이션, 0% 정책금리, 보합 0.0%p).
 *    그래서 "파서가 실패해 0을 반환하는" 형태 붕괴를 **검사 1은 원리적으로 잡을 수 없다** —
 *    정상값과 구분되지 않기 때문이다. 시세류(가격 >0)에서는 0을 배제할 수 있지만 여기서는
 *    같은 수단을 쓸 수 없다.
 *    이 구간은 **검사 2 계열**이 담당한다 — 직전 값 대비 변화폭·부호 지속성처럼
 *    "값 하나만 보고는 알 수 없는" 축으로 판정해야 한다. 검사 2b 재료로 이관된 기존 이력:
 *      · 네이버 장전 quote가 change/change_pct를 0으로 반환(실측, 삼성전자 재현)
 *      · us10y r2 반올림으로 0.01%p 미만 변동이 0으로 뭉개짐 → r4로 정밀도 보존
 *      · us-indices recalcChange(|change| ≤ 0.01이면 history로 재계산)
 */
export const MACRO_FIELD_SPEC = {
  // 미국 기준금리 목표범위 — 음수 정책금리가 실재하므로 rate 규칙을 그대로 쓴다.
  'fomc.rate':    { numeric: ['upper', 'lower'], metaId: 'us10y', cadence: DAILY,   type: POLICY_RATE },
  // CPI YoY/MoM은 **변동률**이라 음수가 정상이다. 상식 밖(±100%p)만 거른다.
  'cpi':          { numeric: ['yoy', 'mom'],     metaId: '__pct_change__', cadence: MONTHLY },
  'unemployment': { numeric: ['rate'],           metaId: '__pct_level__', cadence: MONTHLY },
  'bok':          { numeric: ['rate'],           metaId: 'kr_base_rate', cadence: MONTHLY, type: POLICY_RATE },
};

// macro 전용 가상 메타 — 자산이 아니라 통계량이라 ASSET_META에 두지 않는다.
const MACRO_VIRTUAL = {
  __pct_change__: { kind: 'rate', unit: 'percent', min: -100, max: 100, allowNegative: true },
  __pct_level__:  { kind: 'rate', unit: 'percent', min: 0,    max: 100, allowNegative: false },
};

/**
 * macro 필드 객체 검증. **null은 여기서 판정하지 않는다**(호출측의 승계 규칙이 먼저다).
 * @returns {{ ok: boolean, reason: string|null, field: string|null }}
 */
export function validateMacroField(key, value) {
  const spec = MACRO_FIELD_SPEC[key];
  if (!spec) return { ok: true, reason: null, field: null };       // 정의 없는 필드는 통과
  if (value == null || typeof value !== 'object') return { ok: false, reason: 'not-object', field: null };
  for (const f of spec.numeric) {
    const v = value[f];
    // 서브필드가 아예 없는 경우(undefined)는 소스 스키마 변경 신호 — 막는다.
    const meta = MACRO_VIRTUAL[spec.metaId] ?? ASSET_META[spec.metaId] ?? null;
    const r = meta ? validateLevelWithMeta(meta, v) : validateLevel(spec.metaId, v);
    if (!r.ok) return { ok: false, reason: r.reason, field: f };
  }
  return { ok: true, reason: null, field: null };
}

function validateLevelWithMeta(meta, value) {
  if (typeof value !== 'number') return { ok: false, reason: 'not-number' };
  if (!Number.isFinite(value)) return { ok: false, reason: Number.isNaN(value) ? 'nan' : 'infinite' };
  if (!meta.allowNegative && value < 0) return { ok: false, reason: 'negative' };
  if (meta.min != null && value < meta.min) return { ok: false, reason: 'below-min' };
  if (meta.max != null && value > meta.max) return { ok: false, reason: 'above-max' };
  return { ok: true, reason: null };
}
