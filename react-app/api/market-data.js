/**
 * api/market-data.js — Vercel 서버리스 함수
 *
 * GET /api/market-data
 *   → 19종목 현재가 + 30일 history (history_90d 없음, 홈 화면용 경량)
 *
 * GET /api/market-data?id=btc  (또는 nasdaq / dow / sp500 / sox / kospi / kosdaq / vix /
 *                                usdkrw / jpykrw / us10y / dxy / eth / dominance / feargreed /
 *                                HYPR / 419530 / 028300 / 080220 — "우미 투자" 워치리스트)
 *   → 해당 1종목의 전체 데이터 (history_90d 포함, 상세 화면용)
 *
 * 캐싱: 인메모리 5분 + CDN s-maxage=300
 */

import { collectBTC }         from './_collectors/btc.js';
import { collectUSIndices }   from './_collectors/us-indices.js';
import { collectKR }          from './_collectors/kr.js';
import { collectETH }         from './_collectors/eth.js';
import { collectBtcDominance } from './_collectors/btc-dominance.js';
import { collectFearGreed }   from './_collectors/fear-greed.js';
import { collectWatchlist, WATCHLIST_IDS } from './_collectors/watchlist.js';
import { applyLastGoodFallback } from './_lib/last-good.js';

// ── last-good 폴백 대상 ──────────────────────────────────────────
// KR 지수(naver)·환율·도미넌스(coingecko)·공포탐욕(alternative-me)·우미 워치리스트
// (naver / finnhub·twelvedata), CNBC 단일 소스 US 지수(나스닥/다우/S&P500/SOX/VIX/
// US10Y/DXY), 그리고 btc/eth까지.
// btc/eth의 자체 소스폴백(binance→bybit)은 history에만 해당하고 현재가(=CoinGecko
// /simple/price)에는 폴백이 전혀 없어, CoinGecko 장애 시 두 카드가 통째로 사라지던
// 사각지대였다 — last-good으로 stale 서빙해 카드 실종을 막는다. (Binance 티커 라이브
// 폴오버는 로드맵 '이중화' 단계 별건 — 이번엔 last-good만.)
const FALLBACK_IDS = new Set([
  'kospi', 'kosdaq', 'usdkrw', 'jpykrw', 'dominance', 'feargreed',
  'nasdaq', 'dow', 'sp500', 'sox', 'vix', 'us10y', 'dxy',
  'btc', 'eth',
  ...WATCHLIST_IDS,
]);
const FALLBACK_ERR = '실시간 수집 실패 — 마지막 성공본 서빙';

// commit(오염 방지) 자격 — 가격이 유효(유한·양수)하고 미니차트가 실제로 채워진 스냅샷만
// lastGood으로 승격한다. dominance는 history를 매일 자체 축적하는 중이라 짧은 history가
// 정상 상태(history_bootstrapping)이므로 길이 검사에서 제외한다.
function validateMarketItem(item) {
  if (!item || !Number.isFinite(item.price) || item.price <= 0) return false;
  if (item.history_bootstrapping) return true;
  return Array.isArray(item.history) && item.history.length >= 5;
}

// 라이브 노출 자격 — 유효한 가격만 받았으면(history 서브페치가 실패해도) 그대로 보여준다.
// CNBC quote는 성공했는데 Naver/FRED history만 실패한 미국 지수를 stale로 오강등하거나
// 떨구지 않기 위한 완화 조건(부족한 차트는 detectIssues의 기존 "차트 데이터 부족" 경고가 담당).
function servableMarketItem(item) {
  return item && Number.isFinite(item.price) && item.price > 0;
}

// ── 캐시 ────────────────────────────────────────────────
let   cacheHome   = null;   // { data: { updated_at, items }, timestamp }
const cacheDetail = {};     // { [id]: { data: { updated_at, item }, timestamp } }
const CACHE_TTL_MS = 5 * 60 * 1000;
const ITEM_ORDER   = [
  'nasdaq', 'dow', 'sp500', 'sox', 'kospi', 'kosdaq',
  'btc', 'eth',
  'vix', 'usdkrw', 'jpykrw',
  'us10y', 'dxy',
  'dominance', 'feargreed',
  ...WATCHLIST_IDS, // '우미 투자' 탭(홈, itemCategories.js) — HYPR/419530/028300/080220
];
const US_INDICES_IDS = ['nasdaq', 'dow', 'sp500', 'sox', 'vix', 'us10y', 'dxy'];

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

function setCacheHeaders(res, hit) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.setHeader('X-Cache', hit ? 'HIT' : 'MISS');
}

// ── 메인 핸들러 ──────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const id = req.query?.id ?? null;
  return id ? handleDetail(req, res, id) : handleHome(req, res);
}

// ── 홈 (9종목, 30일만) ────────────────────────────────────
async function handleHome(req, res) {
  if (cacheHome && Date.now() - cacheHome.timestamp < CACHE_TTL_MS) {
    const ageS = Math.floor((Date.now() - cacheHome.timestamp) / 1000);
    console.log(`[market-data/home] Cache HIT (age=${ageS}s)`);
    setCacheHeaders(res, true);
    return res.status(200).json(cacheHome.data);
  }

  const startMs = Date.now();
  console.log(`[market-data/home] Cache MISS — 수집 시작 (${fmtKST()})`);

  const [usResult, btcResult, krResult, ethResult, dominanceResult, fngResult, watchlistResult] = await Promise.allSettled([
    collectUSIndices({ include90d: false }),
    collectBTC({ include90d: false }),
    collectKR({ include90d: false }),
    collectETH({ include90d: false }),
    collectBtcDominance({ include90d: false }),
    collectFearGreed({ include90d: false }),
    collectWatchlist({ include90d: false }),
  ]);

  const itemsById = {};
  for (const [label, result] of [
    ['US 지수', usResult], ['BTC', btcResult], ['KR 지표', krResult],
    ['ETH', ethResult], ['BTC 도미넌스', dominanceResult], ['공포탐욕지수', fngResult],
    ['우미 워치리스트', watchlistResult],
  ]) {
    if (result.status === 'fulfilled') {
      const arr = Array.isArray(result.value) ? result.value : [result.value];
      for (const it of arr) { if (it?.id) itemsById[it.id] = it; }
    } else {
      console.error(`[market-data/home] ${label} 실패: ${result.reason?.message ?? result.reason}`);
    }
  }

  // last-good 폴백: 이번에 성공한 scope 종목은 성공본으로 승격, 실패한 scope 종목은
  // 마지막 성공본으로 대신 서빙(stale:true). 범위 밖(US 지수/btc/eth)은 그대로 통과.
  const { items: merged, stale } = await applyLastGoodFallback({
    ns: 'market',
    collected: Object.values(itemsById),
    commitIds: FALLBACK_IDS,
    validate: validateMarketItem,
    servable: servableMarketItem,
    errorSummary: FALLBACK_ERR,
  });
  const finalById = {};
  for (const it of merged) if (it?.id) finalById[it.id] = it;

  const items   = ITEM_ORDER.filter(id => finalById[id]).map(id => finalById[id]);
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  if (items.length === 0) {
    console.error(`[market-data/home] 전체 실패 (${elapsed}s)`);
    return res.status(500).json({ error: '데이터 수집 실패' });
  }

  const staleNote = stale.length ? ` (stale=${stale.length}: ${stale.join(',')})` : '';
  console.log(`[market-data/home] ${items.length}/${ITEM_ORDER.length} 종목 완료 (${elapsed}s)${staleNote}`);
  const data = { updated_at: fmtKST(), items };
  cacheHome = { data, timestamp: Date.now() };

  setCacheHeaders(res, false);
  return res.status(200).json(data);
}

// ── 상세 (1종목, 90일 포함) ───────────────────────────────
async function handleDetail(req, res, id) {
  if (!ITEM_ORDER.includes(id)) {
    return res.status(400).json({ error: `알 수 없는 종목 ID: ${id}` });
  }

  const cached = cacheDetail[id];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[market-data/detail/${id}] Cache HIT`);
    setCacheHeaders(res, true);
    return res.status(200).json(cached.data);
  }

  const startMs = Date.now();
  console.log(`[market-data/detail/${id}] Cache MISS — 수집 시작`);

  // 그룹 수집이 통째로 throw해도(예: dominance/feargreed 단일 소스 실패) 여기서 흡수하고
  // 아래 폴백으로 넘긴다 — scope 종목이면 마지막 성공본으로 서빙할 기회를 준다.
  let collected = [];
  try {
    if (id === 'btc') {
      collected = [await collectBTC({ include90d: true })];
    } else if (id === 'eth') {
      collected = [await collectETH({ include90d: true })];
    } else if (id === 'dominance') {
      collected = [await collectBtcDominance({ include90d: true })];
    } else if (id === 'feargreed') {
      collected = [await collectFearGreed({ include90d: true })];
    } else if (US_INDICES_IDS.includes(id)) {
      collected = await collectUSIndices({ include90d: true });
    } else if (WATCHLIST_IDS.includes(id)) {
      collected = await collectWatchlist({ include90d: true });
    } else {
      collected = await collectKR({ include90d: true });
    }
  } catch (e) {
    console.error(`[market-data/detail/${id}] 수집 실패(폴백 시도): ${e.message}`);
  }

  // 이 그룹에서 온 scope 종목은 lastGood 갱신(commit). 폴백 서빙(fill)은 요청 종목
  // 하나로만 한정해야 한다 — commit 범위(FALLBACK_IDS) 전체로 fill하면 이 요청과
  // 무관한 다른 scope 종목까지 lastGood에서 끌어와 상세 응답에 섞이기 때문.
  const { items: merged } = await applyLastGoodFallback({
    ns: 'market',
    collected,
    commitIds: FALLBACK_IDS,
    fillIds: FALLBACK_IDS.has(id) ? [id] : [],
    validate: validateMarketItem,
    servable: servableMarketItem,
    errorSummary: FALLBACK_ERR,
  });

  // 그룹 전체를 캐시에 저장 (부수 효과: 같은 그룹 다른 종목 재요청 시 HIT)
  const now = Date.now();
  for (const it of merged) {
    if (it?.id) cacheDetail[it.id] = { data: { updated_at: fmtKST(), item: it }, timestamp: now };
  }

  const data = cacheDetail[id]?.data;
  if (!data) {
    console.error(`[market-data/detail/${id}] 수집 실패(폴백 성공본도 없음)`);
    return res.status(500).json({ error: '데이터 수집 실패' });
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const staleNote = data.item.stale ? ' [stale]' : '';
  console.log(`[market-data/detail/${id}] 완료 (${elapsed}s)  hist_90d=${data.item.history_90d?.length ?? 0}${staleNote}`);

  setCacheHeaders(res, false);
  return res.status(200).json(data);
}
