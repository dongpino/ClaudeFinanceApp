/**
 * api/market-data.js — Vercel 서버리스 함수
 *
 * GET /api/market-data
 *   → 15종목 현재가 + 30일 history (history_90d 없음, 홈 화면용 경량)
 *
 * GET /api/market-data?id=btc  (또는 nasdaq / dow / sp500 / sox / kospi / kosdaq / vix /
 *                                usdkrw / jpykrw / us10y / dxy / eth / dominance / feargreed)
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

  const [usResult, btcResult, krResult, ethResult, dominanceResult, fngResult] = await Promise.allSettled([
    collectUSIndices({ include90d: false }),
    collectBTC({ include90d: false }),
    collectKR({ include90d: false }),
    collectETH({ include90d: false }),
    collectBtcDominance({ include90d: false }),
    collectFearGreed({ include90d: false }),
  ]);

  const itemsById = {};
  for (const [label, result] of [
    ['US 지수', usResult], ['BTC', btcResult], ['KR 지표', krResult],
    ['ETH', ethResult], ['BTC 도미넌스', dominanceResult], ['공포탐욕지수', fngResult],
  ]) {
    if (result.status === 'fulfilled') {
      const arr = Array.isArray(result.value) ? result.value : [result.value];
      for (const it of arr) { if (it?.id) itemsById[it.id] = it; }
    } else {
      console.error(`[market-data/home] ${label} 실패: ${result.reason?.message ?? result.reason}`);
    }
  }

  const items   = ITEM_ORDER.filter(id => itemsById[id]).map(id => itemsById[id]);
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  if (items.length === 0) {
    console.error(`[market-data/home] 전체 실패 (${elapsed}s)`);
    return res.status(500).json({ error: '데이터 수집 실패' });
  }

  console.log(`[market-data/home] ${items.length}/${ITEM_ORDER.length} 종목 완료 (${elapsed}s)`);
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

  try {
    let collected;
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
    } else {
      collected = await collectKR({ include90d: true });
    }

    // 그룹 전체를 캐시에 저장 (부수 효과: 같은 그룹 다른 종목 재요청 시 HIT)
    const now = Date.now();
    for (const it of collected) {
      if (it?.id) cacheDetail[it.id] = { data: { updated_at: fmtKST(), item: it }, timestamp: now };
    }

    const data = cacheDetail[id]?.data;
    if (!data) return res.status(500).json({ error: `${id} 수집 실패` });

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`[market-data/detail/${id}] 완료 (${elapsed}s)  hist_90d=${data.item.history_90d?.length ?? 0}`);

    setCacheHeaders(res, false);
    return res.status(200).json(data);

  } catch (e) {
    console.error(`[market-data/detail/${id}] 실패: ${e.message}`);
    return res.status(500).json({ error: '데이터 수집 실패', details: e.message });
  }
}
