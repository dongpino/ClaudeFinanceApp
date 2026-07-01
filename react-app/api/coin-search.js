/**
 * api/coin-search.js — CoinGecko 코인 검색 자동완성
 *
 * GET /api/coin-search?q={query}
 *   → { results: [{ id, symbol, name, thumb, market_cap_rank }] }
 *
 * 캐시: 동일 쿼리 1분 인메모리 (CDN s-maxage=60)
 * Rate limit 보호: 클라이언트 디바운스(300ms) + 서버 1분 캐시
 */

import { searchCoins } from './_collectors/coingecko.js';

// 쿼리별 1분 인메모리 캐시 (서버리스 인스턴스 내)
const CACHE     = {};
const CACHE_TTL = 60 * 1000;   // 1분
const MAX_KEYS  = 200;          // 메모리 보호: 키 상한 초과 시 전체 초기화

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const q = String(req.query?.q ?? '').trim();
  if (q.length < 1) {
    return res.status(200).json({ results: [] });
  }

  const key = q.toLowerCase();

  // 캐시 히트
  if (CACHE[key] && Date.now() - CACHE[key].ts < CACHE_TTL) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({ results: CACHE[key].data });
  }

  try {
    const results = await searchCoins(q);

    // 캐시 저장 (키 상한 초과 시 리셋)
    if (Object.keys(CACHE).length >= MAX_KEYS) {
      for (const k in CACHE) delete CACHE[k];
    }
    CACHE[key] = { data: results, ts: Date.now() };

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
    res.setHeader('X-Cache', 'MISS');
    console.log(`[coin-search] q="${q}" → ${results.length}개`);
    return res.status(200).json({ results });
  } catch (err) {
    console.error('[coin-search] 오류:', err.message);
    return res.status(502).json({ error: 'CoinGecko 검색 실패', details: err.message });
  }
}
