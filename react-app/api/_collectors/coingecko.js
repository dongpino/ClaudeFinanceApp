/**
 * _collectors/coingecko.js — CoinGecko 검색 · 시세 공통 모듈
 *
 * 사용 엔드포인트 (무료 공개 API, 키 불필요):
 *   /search?query=     → 코인명 자동완성 (id, symbol, name, thumb)
 *   /coins/markets     → 시세 + 스파크라인 (24h 변동률 포함)
 *
 * Rate limit (CoinGecko 무료): 비공식 ~30 req/min
 * → coin-search 핸들러에서 1분 캐시, coin-price 핸들러에서 5분 캐시로 보호
 */

const CG_BASE = 'https://api.coingecko.com/api/v3';

const HEADERS = {
  'Accept':          'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':      'Mozilla/5.0 (compatible; ClaudeFinanceApp/1.0)',
};

async function cgFetch(path) {
  const url = `${CG_BASE}${path}`;
  const res  = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CoinGecko HTTP ${res.status} — ${url} — ${text.slice(0, 120)}`);
  }
  return res.json();
}

function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }
function direction(pct) { return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'; }

/**
 * 코인 검색 자동완성
 * @param {string} query — 검색어 (최소 1자)
 * @returns {{ id, symbol, name, thumb, market_cap_rank }[]} 최대 20개
 */
export async function searchCoins(query) {
  const q = query?.trim() ?? '';
  if (!q) return [];

  const data = await cgFetch(`/search?query=${encodeURIComponent(q)}`);
  const coins = Array.isArray(data.coins) ? data.coins : [];

  return coins.slice(0, 20).map(c => ({
    id:              c.id             ?? '',
    symbol:          (c.symbol ?? '').toUpperCase(),
    name:            c.name           ?? '',
    thumb:           c.thumb          ?? null,   // 작은 썸네일 URL
    market_cap_rank: c.market_cap_rank ?? null,
  }));
}

/**
 * 선택 코인 시세 + 7일 스파크라인
 * @param {string[]} ids — CoinGecko coin id 배열 (예: ['bitcoin', 'ethereum'])
 * @returns {{ id, symbol, name, price, change_pct, direction, sparkline, image }[]}
 */
export async function fetchCoinPrices(ids) {
  if (!ids || ids.length === 0) return [];

  const idStr = ids.join(',');
  const data  = await cgFetch(
    `/coins/markets?vs_currency=usd&ids=${encodeURIComponent(idStr)}` +
    `&order=market_cap_desc&per_page=50&page=1` +
    `&sparkline=true&price_change_percentage=24h`
  );

  if (!Array.isArray(data)) throw new Error('coins/markets 응답 형식 오류');

  return data.map(c => {
    const changePct  = c.price_change_percentage_24h ?? 0;
    const price      = c.current_price ?? 0;
    const prevClose  = changePct !== -100 ? price / (1 + changePct / 100) : price;

    // 스파크라인: 7일치 1시간봉(168pt) → 30pt 이하로 다운샘플
    const rawSpark = c.sparkline_in_7d?.price ?? [];
    const step     = Math.max(1, Math.floor(rawSpark.length / 30));
    const sparkline = rawSpark
      .filter((_, i) => i % step === 0)
      .map(v => r2(v));

    return {
      id:              c.id ?? '',
      symbol:          (c.symbol ?? '').toUpperCase(),
      name:            c.name ?? '',
      price:           r2(price),
      prev_close:      r2(prevClose),
      change:          r2(price - prevClose),
      change_pct:      r4(changePct),
      direction:       direction(changePct),
      image:           c.image ?? null,        // 큰 이미지 URL
      market_cap_rank: c.market_cap_rank ?? null,
      sparkline,
      category:        '크립토',
      source:          'CoinGecko',
    };
  });
}
