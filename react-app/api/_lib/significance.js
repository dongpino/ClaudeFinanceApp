/**
 * api/_lib/significance.js — AI 브리핑 개선 Stage 1(Significance Engine) + Stage 2(일별 적재)
 *
 * Stage 1 목적: 홈탭 15종 지표(+FRED 매크로 발표 3종)의 스냅샷을 모아 "오늘 브리핑에서
 * 짚어야 할 만큼 의미 있는 움직임"을 규칙 기반으로 골라낸다.
 * Stage 2 목적: buildSignals() 결과를 하루 1건씩 Redis sorted set(signals:daily)에
 * 쌓아 향후(Stage 3) 5일 추세 문맥의 데이터 기반을 만든다 — 이번 단계에서는 적재만
 * 하고 브리핑 프롬프트에는 아직 연결하지 않는다. briefing-core.js는 수정하지 않는다.
 *
 * ── 재사용 원칙(중복 fetch 코드 없음) ──────────────────────────
 * - 홈 15종: market-data.js의 handleHome/briefing-core.js의 collectMarketSnapshot과
 *   동일하게 각 수집기를 { include90d: false }로 직접 호출한다(90일 OHLC 등 무거운
 *   데이터는 요청하지 않음 — history_90d는 항상 비어 있는 경량 모드).
 * - FRED 매크로(기준금리/CPI/실업률): api/macro.js가 이미 Redis에 캐시해둔 'macro:v1'을
 *   그대로 읽기만 한다(FRED 재호출 없음). 캐시가 없으면(콜드/미배포) 해당 3개 항목만
 *   fetched:false로 표시하고 나머지는 정상 진행한다.
 * - "이전 발표값 대비 변경" 판정을 위한 상태는 이 모듈이 별도로 'sig:macro:last'에
 *   저장한다(macro.js와는 다른 키 — 그쪽 캐시를 침범하지 않음).
 *
 * ── 일별 스냅샷 적재(signals:daily) ────────────────────────────
 * briefing-core.js의 일별 아카이브(briefing:day:*+briefing:days 두 키 조합)와는 다르게,
 * 여기서는 sorted set 하나에 "score=그 날짜 KST 자정 타임스탬프, member=buildSignals()
 * 결과 JSON 문자열"을 직접 담는다 — 데이터 자체가 멤버라 별도 날짜별 키가 필요 없다.
 * 하루 1개 원칙이라 같은 날 재호출되면 그 score의 기존 멤버를 지우고 다시 넣는다
 * (member 값 자체가 매번 달라지는 JSON이라 "같은 멤버면 자동 덮어씀"이 안 통해서
 * score로 찾아 지우는 방식이 필요함).
 */

import { Redis } from '@upstash/redis';
import { collectBTC }          from '../_collectors/btc.js';
import { collectUSIndices }    from '../_collectors/us-indices.js';
import { collectKR }           from '../_collectors/kr.js';
import { collectETH }          from '../_collectors/eth.js';
import { collectBtcDominance } from '../_collectors/btc-dominance.js';
import { collectFearGreed }    from '../_collectors/fear-greed.js';

// ── 상수 ──────────────────────────────────────────────────────

// itemCategories.js(프론트 탭 전용, categories가 배열이라 "이 종목에 어느 % 임계값을
// 적용할지"와는 다른 축)와 별개로, significance 판단에 필요한 자산군 하나만 지정한다.
const ASSET_CLASS = {
  nasdaq: 'index', dow: 'index', sp500: 'index', sox: 'index', kospi: 'index', kosdaq: 'index',
  vix: 'vix',
  usdkrw: 'fx', jpykrw: 'fx', dxy: 'fx',
  btc: 'crypto', eth: 'crypto',
  us10y: 'bond',        // unit:'percent' — %가 아니라 bp로 판단(경고 배지 예외 로직과 동일 원칙)
  dominance: 'dominance', // unit:'pct_pt'
  feargreed: 'sentiment', // unit:'score'
};
const EXPECTED_IDS = Object.keys(ASSET_CLASS);

// 임계값 — 자산군별로 한곳에 모아 수정 쉽게.
export const THRESHOLDS = {
  INDEX_PCT:        1.0,  // 주가지수 |변화율| %
  FX_PCT:           0.5,  // 환율 |변화율| %
  VIX_PCT:          5.0,  // VIX |변화율| %
  VIX_LEVEL_CROSS: 20,    // VIX 절대값 20 상향/하향 돌파
  CRYPTO_PCT:       3.0,  // 크립토 가격 |변화율| %
  BOND_BP:          5,    // unit:'percent'(국채금리 등) |변동| bp(1bp=0.01%p)
  DOMINANCE_PCT_PT: 1.0,  // BTC 도미넌스 |변동| %p
  SENTIMENT_SCORE: 10,    // 공포탐욕지수 |변동| 포인트(0~100 스케일)
};

const MACRO_CACHE_KEY    = 'macro:v1';      // api/macro.js가 쓰는 캐시 키 — 재조회만, FRED 재호출 없음
const SIG_MACRO_LAST_KEY = 'sig:macro:last'; // "마지막으로 확인한 발표값" — 이 모듈 전용 상태

const DAILY_SNAPSHOT_KEY    = 'signals:daily'; // sorted set: score=KST 자정 타임스탬프, member=signals JSON
const DAILY_RETENTION_DAYS  = 30;
const DAY_MS                = 24 * 60 * 60 * 1000;

// ── 유틸 ──────────────────────────────────────────────────────

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

function sign(n) { return (n >= 0 ? '+' : '') + n.toFixed(2); }

// 해당 시각이 KST로 몇 년-몇 월-며칠인지 구한 뒤, 그 날짜의 "00:00:00 KST"를
// UTC epoch ms로 환산한다(KST=UTC+9라 자정 KST는 전날 15:00 UTC).
function kstMidnightScore(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear(), mo = kst.getUTCMonth(), d = kst.getUTCDate();
  return Date.UTC(y, mo, d) - 9 * 60 * 60 * 1000;
}

// ── Redis (지연 생성, 실패 시 null 폴백 — 프로젝트 공통 패턴) ──
let redisClient;
function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[significance] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — 매크로 발표 감지 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

async function getCachedMacro() {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(MACRO_CACHE_KEY);
  } catch (e) {
    console.error('[significance] macro:v1 조회 실패:', e.message);
    return null;
  }
}

async function getLastMacroSnapshot() {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(SIG_MACRO_LAST_KEY);
  } catch (e) {
    console.error('[significance] sig:macro:last 조회 실패:', e.message);
    return null;
  }
}

async function saveMacroSnapshot(snap) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(SIG_MACRO_LAST_KEY, snap);
  } catch (e) {
    console.error('[significance] sig:macro:last 저장 실패:', e.message);
  }
}

// macro:v1 캐시 → 발표성 지표 3종(기준금리/CPI/실업률). compareKey는 "발표값이 실제로
// 바뀌었는지" 판정용 — asOf처럼 매일 갱신되는 날짜 필드는 제외하고 값 자체만 담는다
// (안 그러면 FRED 일별 시계열의 날짜만 바뀌어도 "변경"으로 오탐한다).
function buildMacroReleaseIndicators(macroCached) {
  const fomcRate = macroCached?.fomc?.rate ?? null;
  const cpi      = macroCached?.cpi ?? null;
  const unemp    = macroCached?.unemployment ?? null;

  return [
    fomcRate
      ? { id: 'fred_fomc_rate', name: '기준금리(FOMC)', category: 'macro_release', fetched: true,
          value: { upper: fomcRate.upper, lower: fomcRate.lower }, asOf: fomcRate.asOf,
          compareKey: `${fomcRate.upper}|${fomcRate.lower}` }
      : { id: 'fred_fomc_rate', name: '기준금리(FOMC)', category: 'macro_release', fetched: false },

    cpi
      ? { id: 'fred_cpi', name: 'CPI YoY', category: 'macro_release', fetched: true,
          value: cpi.yoy, refMonth: cpi.refMonth,
          compareKey: `${cpi.refMonth}|${cpi.yoy}` }
      : { id: 'fred_cpi', name: 'CPI YoY', category: 'macro_release', fetched: false },

    unemp
      ? { id: 'fred_unemployment', name: '실업률', category: 'macro_release', fetched: true,
          value: unemp.rate, refMonth: unemp.refMonth,
          compareKey: `${unemp.refMonth}|${unemp.rate}` }
      : { id: 'fred_unemployment', name: '실업률', category: 'macro_release', fetched: false },
  ];
}

// ── 1. collectSnapshot ──────────────────────────────────────────
// 홈탭 15종(경량, include90d:false) + FRED 매크로 발표 3종(캐시 읽기) → 통일된 스냅샷.
// 개별 수집기 실패는 Promise.allSettled로 격리 — 실패한 그룹의 항목만 fetched:false.
export async function collectSnapshot() {
  const [usResult, btcResult, krResult, ethResult, domResult, fngResult] = await Promise.allSettled([
    collectUSIndices({ include90d: false }),
    collectBTC({ include90d: false }),
    collectKR({ include90d: false }),
    collectETH({ include90d: false }),
    collectBtcDominance({ include90d: false }),
    collectFearGreed({ include90d: false }),
  ]);

  const byId = {};
  for (const [label, result] of [
    ['US 지수', usResult], ['BTC', btcResult], ['KR 지표', krResult],
    ['ETH', ethResult], ['BTC 도미넌스', domResult], ['공포탐욕지수', fngResult],
  ]) {
    if (result.status === 'fulfilled') {
      const arr = Array.isArray(result.value) ? result.value : [result.value];
      for (const it of arr) { if (it?.id) byId[it.id] = it; }
    } else {
      console.error(`[significance] ${label} 수집 실패: ${result.reason?.message ?? result.reason}`);
    }
  }

  const indicators = EXPECTED_IDS.map(id => {
    const raw = byId[id];
    if (!raw) return { id, category: ASSET_CLASS[id], fetched: false };
    return {
      id, name: raw.name, category: ASSET_CLASS[id],
      price: raw.price, prev_close: raw.prev_close,
      change: raw.change, change_pct: raw.change_pct,
      direction: raw.direction, unit: raw.unit ?? null,
      fetched: true,
    };
  });

  const macroCached      = await getCachedMacro();
  const macroIndicators  = buildMacroReleaseIndicators(macroCached);
  const allIndicators    = [...indicators, ...macroIndicators];
  const fetchFailures    = allIndicators.filter(it => !it.fetched).map(it => it.id);

  return { indicators: allIndicators, fetchFailures };
}

// ── 2. flagNotable ───────────────────────────────────────────────
// 일반 자산은 자산군별 임계값(THRESHOLDS)으로 즉시 판정. FRED 매크로 발표 3종은
// "이전에 확인한 값과 다른가"로 판정하며, 그 "이전 값" 자체가 이 함수의 부수효과로
// Redis에 갱신된다(처음 실행이라 비교 대상이 없으면 베이스라인만 저장, notable 아님).
function isNotableAsset(item) {
  const cls = item.category;
  if (cls === 'vix') {
    if (Math.abs(item.change_pct) >= THRESHOLDS.VIX_PCT) return true;
    const prev = item.prev_close, cur = item.price;
    if (typeof prev === 'number' && typeof cur === 'number') {
      const crossedUp   = prev < THRESHOLDS.VIX_LEVEL_CROSS && cur >= THRESHOLDS.VIX_LEVEL_CROSS;
      const crossedDown = prev >= THRESHOLDS.VIX_LEVEL_CROSS && cur < THRESHOLDS.VIX_LEVEL_CROSS;
      if (crossedUp || crossedDown) return true;
    }
    return false;
  }
  if (cls === 'bond')      return Math.abs(item.change) * 100 >= THRESHOLDS.BOND_BP; // change는 %p 단위 → ×100=bp
  if (cls === 'dominance') return Math.abs(item.change) >= THRESHOLDS.DOMINANCE_PCT_PT;
  if (cls === 'sentiment') return Math.abs(item.change) >= THRESHOLDS.SENTIMENT_SCORE;
  if (cls === 'index')     return Math.abs(item.change_pct) >= THRESHOLDS.INDEX_PCT;
  if (cls === 'fx')        return Math.abs(item.change_pct) >= THRESHOLDS.FX_PCT;
  if (cls === 'crypto')    return Math.abs(item.change_pct) >= THRESHOLDS.CRYPTO_PCT;
  return false;
}

export async function flagNotable(snapshot) {
  const notable = [];

  for (const item of snapshot.indicators) {
    if (!item.fetched || item.category === 'macro_release') continue;
    if (isNotableAsset(item)) notable.push(item.id);
  }

  const macroItems  = snapshot.indicators.filter(it => it.category === 'macro_release' && it.fetched);
  const lastSnap    = await getLastMacroSnapshot();
  const currentSnap = {};
  for (const it of macroItems) {
    currentSnap[it.id] = { compareKey: it.compareKey };
    const prev = lastSnap?.[it.id];
    if (prev && prev.compareKey !== it.compareKey) notable.push(it.id);
    // prev가 없으면(첫 실행) 비교 대상이 없다 — notable 처리하지 않고 베이스라인만 저장.
  }
  await saveMacroSnapshot(currentSnap);

  return notable;
}

// ── 3. detectPatterns ────────────────────────────────────────────
// 각 패턴은 {id, condition(byId), description(byId)} — 배열에 추가만 하면 확장된다.
function indicatorsById(snapshot) {
  const map = {};
  for (const it of snapshot.indicators) map[it.id] = it;
  return map;
}

export const PATTERNS = [
  {
    id: 'DECOUPLING',
    condition: m => {
      const n = m.nasdaq, k = m.kospi;
      if (!n?.fetched || !k?.fetched) return false;
      return (n.change_pct >= 1.0 && k.change_pct <= -1.0) || (n.change_pct <= -1.0 && k.change_pct >= 1.0);
    },
    description: m => `나스닥 ${sign(m.nasdaq.change_pct)}% vs 코스피 ${sign(m.kospi.change_pct)}% — 미·한 증시 괴리`,
  },
  {
    id: 'IDIOSYNCRATIC',
    condition: m => {
      const v = m.vix, k = m.kospi;
      if (!v?.fetched || !k?.fetched) return false;
      return v.change < 0 && k.change_pct <= -2.0;
    },
    description: m => `VIX 하락(${sign(m.vix.change_pct)}%)에도 코스피 ${sign(m.kospi.change_pct)}% — 글로벌 리스크가 아닌 국내 개별 이슈 시사`,
  },
  {
    id: 'FX_RULED_OUT',
    condition: m => {
      const f = m.usdkrw, k = m.kospi;
      if (!f?.fetched || !k?.fetched) return false;
      return Math.abs(f.change_pct) < 0.3 && Math.abs(k.change_pct) >= 2.0;
    },
    description: m => `코스피 ${sign(m.kospi.change_pct)}%지만 원/달러는 ${sign(m.usdkrw.change_pct)}%로 거의 안 움직임 — 환율 요인 배제`,
  },
  {
    id: 'RISK_DIVERGENCE',
    condition: m => {
      const b = m.btc, n = m.nasdaq;
      if (!b?.fetched || !n?.fetched) return false;
      const oppositeSign = b.change_pct !== 0 && n.change_pct !== 0 && Math.sign(b.change_pct) !== Math.sign(n.change_pct);
      return oppositeSign && Math.abs(b.change_pct) >= 1.0 && Math.abs(n.change_pct) >= 1.0;
    },
    description: m => `BTC ${sign(m.btc.change_pct)}% vs 나스닥 ${sign(m.nasdaq.change_pct)}% — 위험자산 내 괴리`,
  },
];

export function detectPatterns(snapshot) {
  const m = indicatorsById(snapshot);
  const matched = [];
  for (const p of PATTERNS) {
    try {
      if (p.condition(m)) matched.push({ id: p.id, description: p.description(m) });
    } catch (e) {
      console.warn(`[significance] 패턴 ${p.id} 판정 실패(데이터 부족 등): ${e.message}`);
    }
  }
  return matched;
}

// ── 4. buildSignals ──────────────────────────────────────────────
export async function buildSignals() {
  const snapshot = await collectSnapshot();
  const notable  = await flagNotable(snapshot);
  const patterns = detectPatterns(snapshot);

  console.log(
    `[significance] indicators=${snapshot.indicators.length} notable=${notable.length} ` +
    `patterns=${patterns.length} fetchFailures=${snapshot.fetchFailures.length}`
  );

  return {
    timestamp:  fmtKST(),
    indicators: snapshot.indicators,
    notable,
    patterns,
    meta: { fetchFailures: snapshot.fetchFailures },
  };
}

// ── Stage 2: 일별 스냅샷 적재 ──────────────────────────────────
// 저장 실패는 완전히 격리한다 — 호출부(브리핑 cron 등)는 이 함수가 절대 throw하지
// 않는다고 가정할 수 있고, 실패 시에도 브리핑 생성 자체는 정상 진행돼야 하기 때문.
export async function saveSnapshot(signals) {
  const r = getRedis();
  if (!r) {
    console.warn('[significance] Redis 없음 — 일별 스냅샷 저장 스킵');
    return { saved: false, reason: 'no-redis' };
  }
  try {
    const score  = kstMidnightScore();
    const member = JSON.stringify(signals);

    // 하루 1개 원칙: 같은 날짜(score) 기존 멤버 제거 후 새로 저장(덮어쓰기).
    await r.zremrangebyscore(DAILY_SNAPSHOT_KEY, score, score);
    await r.zadd(DAILY_SNAPSHOT_KEY, { score, member });

    // 30일 초과분 정리.
    const cutoff = score - DAILY_RETENTION_DAYS * DAY_MS;
    await r.zremrangebyscore(DAILY_SNAPSHOT_KEY, '-inf', cutoff);

    console.log(`[significance] 일별 스냅샷 저장 완료 (score=${score})`);
    return { saved: true, score };
  } catch (e) {
    console.error('[significance] 일별 스냅샷 저장 실패(호출부에는 전파하지 않음):', e.message);
    return { saved: false, reason: e.message };
  }
}

// 최근 days일 스냅샷 — 날짜 오름차순(오래된→최신). Stage 3(추세 문맥)에서 사용 예정.
export async function getRecentSnapshots(days = 5) {
  const r = getRedis();
  if (!r) return [];
  try {
    const cutoff = kstMidnightScore() - (days - 1) * DAY_MS;
    // @upstash/redis는 저장된 값이 JSON처럼 보이면 zrange 결과에서도 자동으로
    // parse해서 돌려준다(get/set과 동일한 동작) — saveSnapshot()에서 JSON.stringify로
    // 넣었더라도 여기서 다시 JSON.parse하면 "이미 객체인 것을 parse"해서 예외가 나고,
    // 그 예외를 삼키면 전부 null이 돼 조용히 빈 배열을 반환하는 버그가 된다(실측으로 확인).
    return await r.zrange(DAILY_SNAPSHOT_KEY, cutoff, '+inf', { byScore: true });
  } catch (e) {
    console.error('[significance] 일별 스냅샷 조회 실패:', e.message);
    return [];
  }
}
