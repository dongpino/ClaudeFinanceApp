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
 *   4건(네이버 장전 0 반환, us10y r2 반올림 뭉갬 등)은 **검사 2(상대 타당성)** 재료다.
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

/** 가격류 공통 — 0 초과 무제한. 0은 "파서가 실패했다"의 가장 흔한 표현이라 배제한다. */
const PRICE = { kind: 'price', unit: null, min: 0, max: null, allowNegative: false, fallback: true, exclusiveMin: true };

export const ASSET_META = {
  // ── 지수·가격 ────────────────────────────────────────────────
  nasdaq: PRICE, dow: PRICE, sp500: PRICE, sox: PRICE,
  kospi: PRICE, kosdaq: PRICE,
  btc: PRICE, eth: PRICE,
  vix: PRICE,                       // 변동성지수. 이론상 0 초과이며 상한은 두지 않는다.
  dxy: PRICE,                       // 달러인덱스 — 지수라 레벨이 양수. 상한 없음.
  usdkrw: PRICE, jpykrw: PRICE,
  HYPR: PRICE, 419530: PRICE, '028300': PRICE, '080220': PRICE,  // '우미 투자' 워치리스트

  // ── 금리(음수 실재) ──────────────────────────────────────────
  // ⚠️ 마이너스 금리는 일본·유럽에서 실제로 있었다. "양수여야 함"을 적용할 수 없는 항목.
  //    상·하한은 상식 밖 값(파싱 사고)만 걸리게 넓게 잡는다.
  us10y:        { kind: 'rate', unit: 'percent', min: -10, max: 30, allowNegative: true, fallback: true },
  kr_base_rate: { kind: 'rate', unit: 'pct_pt',  min: -10, max: 30, allowNegative: true, fallback: true },

  // ── 정의역이 명확한 비율·점수 ────────────────────────────────
  // ⚠️ **하한 0을 포함한다**(종전 공통 규칙 price>0과 충돌했던 지점). 공포탐욕 0과
  //    도미넌스 0은 이론상 정상값이며, 0을 이상값으로 막으면 정상 데이터가 폴백으로 밀린다.
  dominance: { kind: 'ratio', unit: 'pct_pt', min: 0, max: 100, allowNegative: false, fallback: true },
  feargreed: { kind: 'score', unit: 'score',  min: 0, max: 100, allowNegative: false, fallback: true },
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
 *    이 구간은 **검사 2(상대 타당성)**가 담당한다 — 직전 값 대비 변화폭·부호 지속성처럼
 *    "값 하나만 보고는 알 수 없는" 축으로 판정해야 한다. 검사 2 재료로 이관된 기존 이력:
 *      · 네이버 장전 quote가 change/change_pct를 0으로 반환(실측, 삼성전자 재현)
 *      · us10y r2 반올림으로 0.01%p 미만 변동이 0으로 뭉개짐 → r4로 정밀도 보존
 *      · us-indices recalcChange(|change| ≤ 0.01이면 history로 재계산)
 */
export const MACRO_FIELD_SPEC = {
  // 미국 기준금리 목표범위 — 음수 정책금리가 실재하므로 rate 규칙을 그대로 쓴다.
  'fomc.rate':    { numeric: ['upper', 'lower'], metaId: 'us10y' },
  // CPI YoY/MoM은 **변동률**이라 음수가 정상이다. 상식 밖(±100%p)만 거른다.
  'cpi':          { numeric: ['yoy', 'mom'],     metaId: '__pct_change__' },
  'unemployment': { numeric: ['rate'],           metaId: '__pct_level__' },
  'bok':          { numeric: ['rate'],           metaId: 'kr_base_rate' },
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
