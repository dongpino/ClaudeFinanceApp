/**
 * api/stock-search.js — 주식 심볼 검색 (미국=Finnhub, 한국=Naver)
 *
 * GET /api/stock-search?q={query}[&market=us|kr]  (market 생략 시 us, 하위 호환)
 *   → { results: [{ symbol, name, type }] }
 *
 * 캐시: 동일 (market,쿼리) 조합 5분 인메모리 (CDN s-maxage=300)
 * Rate limit 보호: 클라이언트 디바운스(300ms) + 서버 5분 캐시
 * market=us는 FINNHUB_API_KEY 필요(미설정 시 503). market=kr은 Naver 공개 API라 키 불요.
 */

import { searchStocks, hasKey } from './_collectors/finnhub.js';
import { searchKRStocks } from './_collectors/naver-stock.js';

const CACHE     = {};
const CACHE_TTL = 5 * 60 * 1000;  // 5분 (심볼·회사명은 거의 변하지 않음)
const MAX_KEYS  = 200;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const market = String(req.query?.market ?? 'us').toLowerCase();
  if (market !== 'us' && market !== 'kr') {
    return res.status(400).json({ error: `알 수 없는 market: ${market} (허용: us, kr)` });
  }

  if (market === 'us' && !hasKey()) {
    return res.status(503).json({
      error:   'FINNHUB_API_KEY 미설정',
      details: 'Vercel 환경변수 또는 로컬 .env.local에 FINNHUB_API_KEY를 추가하세요',
    });
  }

  const q = String(req.query?.q ?? '').trim();
  if (q.length < 1) {
    return res.status(200).json({ results: [] });
  }

  const key = `${market}:${q.toLowerCase()}`;

  if (CACHE[key] && Date.now() - CACHE[key].ts < CACHE_TTL) {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({ results: CACHE[key].data });
  }

  try {
    const results = market === 'kr' ? await searchKRStocks(q) : await searchStocks(q);

    if (Object.keys(CACHE).length >= MAX_KEYS) {
      for (const k in CACHE) delete CACHE[k];
    }
    CACHE[key] = { data: results, ts: Date.now() };

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'MISS');
    console.log(`[stock-search] market=${market} q="${q}" → ${results.length}개`);
    return res.status(200).json({ results });
  } catch (err) {
    console.error('[stock-search] 오류:', err.message);
    return res.status(502).json({ error: `${market === 'kr' ? 'Naver' : 'Finnhub'} 검색 실패`, details: err.message });
  }
}
