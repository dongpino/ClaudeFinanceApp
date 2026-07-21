/**
 * api/coin-price.js — CoinGecko 코인 시세 + 스파크라인
 *
 * GET /api/coin-price?ids=bitcoin,ethereum,solana
 *   → { items: [...], fetched_at: ISO }
 *
 * 반환 아이템 형식 (홈 카드와 호환):
 *   { id, symbol, name, price, prev_close, change, change_pct, direction,
 *     image, market_cap_rank, sparkline: number[], category, source }
 *
 * 캐시: 코인 조합별 5분 인메모리 (CDN s-maxage=300)
 * ids 상한: 최대 20개 (CoinGecko per_page 50으로 여유)
 */

import { fetchCoinPrices } from './_collectors/coingecko.js';
import { applyLastGoodFallback } from './_lib/last-good.js';

const CACHE     = {};
const CACHE_TTL = 5 * 60 * 1000;   // 5분
const MAX_IDS   = 20;

// commit(오염 방지) 자격 — 가격이 유효하고 스파크라인이 실제로 채워진 것만 성공본으로.
function validateCoinItem(item) {
  return item && Number.isFinite(item.price) && item.price > 0 &&
         Array.isArray(item.sparkline) && item.sparkline.length > 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const raw = String(req.query?.ids ?? '').trim();
  if (!raw) {
    return res.status(200).json({ items: [] });
  }

  // 정규화: 중복 제거, 소문자, 상한 적용
  const ids = [...new Set(
    raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  )].slice(0, MAX_IDS);

  if (ids.length === 0) {
    return res.status(200).json({ items: [] });
  }

  const key = ids.sort().join(',');

  // 캐시 히트
  if (CACHE[key] && Date.now() - CACHE[key].ts < CACHE_TTL) {
    const ageS = Math.floor((Date.now() - CACHE[key].ts) / 1000);
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Age', String(ageS));
    return res.status(200).json({ items: CACHE[key].data, fetched_at: CACHE[key].fetchedAt });
  }

  // fetchCoinPrices는 한 번의 요청으로 전 코인을 받아 실패 시 전량 throw다 —
  // 그 경우 collected=[]로 두고 요청 id 전부를 lastGood으로 폴백 서빙한다.
  let collected = [];
  let errorSummary;
  try {
    collected = await fetchCoinPrices(ids);
  } catch (err) {
    console.error('[coin-price] 오류(폴백 시도):', err.message);
    errorSummary = err.message;
  }

  const { items, stale } = await applyLastGoodFallback({
    ns: 'coin',
    collected,
    commitIds: ids,
    validate: validateCoinItem,
    errorSummary,
  });

  // 신선분도 폴백할 성공본도 전혀 없음 → 기존과 동일한 실패 응답(신규 심볼 등)
  if (items.length === 0) {
    return res.status(502).json({ error: 'CoinGecko 시세 조회 실패', details: errorSummary ?? '데이터 없음' });
  }

  const fetchedAt = new Date().toISOString();
  const isStale   = stale.length > 0;

  // 완전히 신선할 때만 5분 캐시에 적재 — stale은 캐시하지 않아 소스 복원 즉시 재시도된다.
  if (!isStale) CACHE[key] = { data: items, ts: Date.now(), fetchedAt };

  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
  res.setHeader('X-Cache', isStale ? 'STALE' : 'MISS');
  console.log(`[coin-price] ids=[${ids.join(',')}] → ${items.length}개${isStale ? ` (stale=${stale.join(',')})` : ''}`);
  items.forEach(it => {
    const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
    console.log(`  ${it.symbol}${it.stale ? '*' : ''} $${it.price.toLocaleString('en-US')}  ${sign(it.change_pct)}%  spark=${it.sparkline?.length ?? 0}pt`);
  });
  return res.status(200).json({ items, fetched_at: fetchedAt, ...(isStale ? { stale: true } : {}) });
}
