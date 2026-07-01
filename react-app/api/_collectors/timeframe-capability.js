/**
 * timeframe-capability.js — 종목별 지원 타임프레임 capability map
 *
 * 원칙: 각 종목이 데이터 소스에서 뽑을 수 있는 최대치까지 켜고, 안 되는 건 끈다.
 *
 *   코인 (Binance 상장)     : 1m,5m,15m,30m,1h,4h,1d,1w  (Binance klines)
 *   코인 (Binance 미상장)   : 1h,4h,1d,1w                 (CoinGecko, 분봉 불가)
 *   미국주식 (Finnhub 무료) : 1d,1w                        (분봉은 유료 티어)
 *   지수 (나스닥/다우/코스피/VIX/원달러) : 1d,1w            (현행 유지)
 *
 * 종목 추가·소스 확장 시 이 파일의 TF 상수만 수정하면 됨.
 */

// ── capability 정의 (설정 분리) ─────────────────────────────
const TF = {
  CRYPTO_FULL:      ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'],
  CRYPTO_COINGECKO: ['1h', '4h', '1d', '1w'],
  STOCK:            ['1d', '1w'],
  INDEX:            ['1d', '1w'],
};

export const TIMEFRAME_SETS = TF;

// ── Binance 상장 여부 판정 (exchangeInfo?symbol=) ───────────
// 소스 우선순위는 btc-intraday.js와 동일 (Vercel 환경에서 api.binance.com 차단 대비)
const BINANCE_LISTED_CACHE = {};           // symbol(대문자) → { listed: bool, ts }
const BINANCE_CACHE_TTL    = 24 * 60 * 60 * 1000;   // 24시간 (상장 여부는 거의 안 바뀜)

async function fetchExchangeInfo(baseUrl, pair) {
  const url = `${baseUrl}/api/v3/exchangeInfo?symbol=${pair}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    // Binance는 존재하지 않는 심볼 조회 시 400 + {code:-1121,...} 반환
    if (res.status === 400) return false;
    throw new Error(`HTTP ${res.status}`);
  }
  const data = await res.json();
  const symbols = Array.isArray(data.symbols) ? data.symbols : [];
  return symbols.some(s => s.symbol === pair && s.status === 'TRADING');
}

/**
 * 코인 심볼의 Binance(USDT 마켓) 상장 여부 판정
 * 24시간 인메모리 캐시. 모든 소스 실패 시 false(미상장)로 폴백 → CoinGecko 범위 적용.
 * @param {string} symbol — 코인 심볼 (예: 'BTC'), 대소문자 무관
 * @returns {Promise<boolean>}
 */
export async function isBinanceListed(symbol) {
  const sym = (symbol ?? '').trim().toUpperCase();
  if (!sym) return false;

  const cached = BINANCE_LISTED_CACHE[sym];
  if (cached && Date.now() - cached.ts < BINANCE_CACHE_TTL) return cached.listed;

  const pair = `${sym}USDT`;

  for (const [label, baseUrl] of [
    ['binance.vision', 'https://data-api.binance.vision'],
    ['binance.com',    'https://api.binance.com'],
  ]) {
    try {
      const listed = await fetchExchangeInfo(baseUrl, pair);
      BINANCE_LISTED_CACHE[sym] = { listed, ts: Date.now() };
      console.log(`[timeframe-capability] ${sym}: Binance ${listed ? '상장' : '미상장'} (${label})`);
      return listed;
    } catch (e) {
      console.warn(`[timeframe-capability] ${sym} 확인 실패 (${label}): ${e.message}`);
    }
  }

  console.warn(`[timeframe-capability] ${sym}: 모든 소스 실패 → 미상장으로 폴백 (CoinGecko 범위)`);
  return false;
}

// ── 공개 함수 ────────────────────────────────────────────────

/**
 * 종목이 실제로 지원하는 타임프레임 배열 반환
 * @param {{ type: 'crypto'|'stock'|'index', id?: string, symbol?: string }} item
 * @returns {Promise<string[]>}
 */
export async function getSupportedTimeframes(item) {
  if (!item?.type) throw new Error('getSupportedTimeframes: item.type 필요');

  switch (item.type) {
    case 'stock':
      return TF.STOCK;

    case 'index': {
      // 레거시 'btc' 인덱스 칩: 실제로는 Binance 상장 코인이므로 crypto와 동일 판정
      if (item.id === 'btc') {
        const listed = await isBinanceListed('BTC');
        return listed ? TF.CRYPTO_FULL : TF.CRYPTO_COINGECKO;
      }
      return TF.INDEX;
    }

    case 'crypto': {
      const listed = await isBinanceListed(item.symbol);
      return listed ? TF.CRYPTO_FULL : TF.CRYPTO_COINGECKO;
    }

    default:
      throw new Error(`getSupportedTimeframes: 알 수 없는 type "${item.type}"`);
  }
}
