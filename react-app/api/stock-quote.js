/**
 * api/stock-quote.js — 주식 현재가 조회 (미국=Finnhub, 한국=Naver)
 *
 * GET /api/stock-quote?symbols=AAPL,MSFT,GOOGL[&market=us|kr]  (market 생략 시 us, 하위 호환)
 *   → { items: [...], fetched_at: ISO }
 *
 * 반환 아이템 형식 (홈 카드·즐겨찾기 칩 호환):
 *   { id, symbol, name, price, prev_close, change, change_pct, direction,
 *     sparkline: number[], category, source }
 *
 * 캐시: (market,심볼 조합)별 5분 인메모리 (CDN s-maxage=300)
 * symbols 상한: 최대 10개
 * market=us는 각 심볼당 Finnhub 2 req (quote+candle) → 20 req/batch, 60 req/min 무료 한도 내.
 * market=kr은 Naver 공개 API(무인증) — 심볼은 6자리 종목코드라 대문자 변환은 영향 없음(no-op).
 * market=us 키 미설정 시: 503 + 안내 메시지.
 */

import { fetchStockPrices, hasKey } from './_collectors/finnhub.js';
import { fetchKRQuotes } from './_collectors/naver-stock.js';

const CACHE     = {};
const CACHE_TTL = 5 * 60 * 1000;  // 5분
const MAX_SYMS  = 10;

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

  const raw = String(req.query?.symbols ?? '').trim();
  if (!raw) {
    return res.status(200).json({ items: [] });
  }

  // 정규화: 중복 제거, 대문자, 상한 적용
  const symbols = [...new Set(
    raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  )].slice(0, MAX_SYMS);

  if (symbols.length === 0) {
    return res.status(200).json({ items: [] });
  }

  const key = `${market}:${symbols.sort().join(',')}`;

  if (CACHE[key] && Date.now() - CACHE[key].ts < CACHE_TTL) {
    const ageS = Math.floor((Date.now() - CACHE[key].ts) / 1000);
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Age', String(ageS));
    return res.status(200).json({ items: CACHE[key].data, fetched_at: CACHE[key].fetchedAt });
  }

  try {
    const items     = market === 'kr' ? await fetchKRQuotes(symbols) : await fetchStockPrices(symbols);
    const fetchedAt = new Date().toISOString();

    CACHE[key] = { data: items, ts: Date.now(), fetchedAt };

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'MISS');
    console.log(`[stock-quote] market=${market} symbols=[${symbols.join(',')}] → ${items.length}개`);
    items.forEach(it => {
      const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
      console.log(`  ${it.symbol} ${it.price.toLocaleString('en-US')}  ${sign(it.change_pct)}%`);
    });
    return res.status(200).json({ items, fetched_at: fetchedAt });
  } catch (err) {
    console.error('[stock-quote] 오류:', err.message);
    return res.status(502).json({ error: `${market === 'kr' ? 'Naver' : 'Finnhub'} 시세 조회 실패`, details: err.message });
  }
}
