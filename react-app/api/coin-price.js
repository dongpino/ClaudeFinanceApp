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

const CACHE     = {};
const CACHE_TTL = 5 * 60 * 1000;   // 5분
const MAX_IDS   = 20;

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

  try {
    const items     = await fetchCoinPrices(ids);
    const fetchedAt = new Date().toISOString();

    CACHE[key] = { data: items, ts: Date.now(), fetchedAt };

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'MISS');
    console.log(`[coin-price] ids=[${ids.join(',')}] → ${items.length}개`);
    items.forEach(it => {
      const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
      console.log(`  ${it.symbol} $${it.price.toLocaleString('en-US')}  ${sign(it.change_pct)}%  spark=${it.sparkline.length}pt`);
    });
    return res.status(200).json({ items, fetched_at: fetchedAt });
  } catch (err) {
    console.error('[coin-price] 오류:', err.message);
    return res.status(502).json({ error: 'CoinGecko 시세 조회 실패', details: err.message });
  }
}
