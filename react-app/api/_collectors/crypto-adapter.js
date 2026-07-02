/**
 * crypto-adapter.js — 임의 코인 분석 데이터 어댑터
 *
 * Binance 상장 코인   : 기존 btc-intraday.js를 심볼 파라미터화해서 재사용
 *                       (분봉~시간봉은 klines, 일봉도 Binance 1d klines → CoinGecko 폴백)
 * Binance 미상장 코인 : CoinGecko market_chart
 *                       (1h/4h는 시간봉을 그대로/4개씩 다운샘플, 1d는 일봉, 1w는 toWeekly)
 *
 * 반환 형식은 index/stock 어댑터와 동일: { history, ohlc_available, source }
 */

import { isBinanceListed } from './timeframe-capability.js';
import { fetchIntradayKlines, BTC_INTRADAY_TFS } from './btc-intraday.js';
import { fetchCoinMarketChart } from './coingecko.js';
import { toWeekly } from './weekly-transform.js';

function r2(n) { return Math.round(n * 100) / 100; }
function tsToDate(tsMs) { return new Date(tsMs).toISOString().slice(0, 10); }

// ── Binance 일봉(250개) 수집 — 심볼 파라미터화, CoinGecko 폴백 ──────
async function fetchBinanceDaily(pair, coingeckoId) {
  const sources = [
    ['binance.vision', `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=1d&limit=250`],
    ['binance.com',    `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=250`],
  ];

  for (const [label, url] of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length < 10) throw new Error(`행 부족: ${raw?.length ?? 0}`);
      const history = raw.map(k => ({
        date:   tsToDate(Number(k[0])),
        open:   r2(parseFloat(k[1])),
        high:   r2(parseFloat(k[2])),
        low:    r2(parseFloat(k[3])),
        close:  r2(parseFloat(k[4])),
        volume: r2(parseFloat(k[5])),
      }));
      return { history, ohlc_available: true, source: `Binance(${label})` };
    } catch (e) {
      console.warn(`[crypto-adapter] ${pair} 일봉 ${label} 실패: ${e.message}`);
    }
  }

  console.warn(`[crypto-adapter] ${pair} 일봉 Binance 전체 실패 → CoinGecko 폴백`);
  return fetchCoinGeckoDaily(coingeckoId);
}

// ── CoinGecko 시간봉/4시간봉/일봉 (Binance 미상장 코인) ──────────────
async function fetchCoinGeckoHourly(id) {
  const prices  = await fetchCoinMarketChart(id, 12);   // 2~90일 구간 → 자동 시간봉
  const history = prices
    .slice(-300)
    .map(([tsMs, price]) => ({ time: Math.floor(tsMs / 1000), close: r2(price) }));
  if (history.length < 10) throw new Error(`CoinGecko ${id} 시간봉 부족: ${history.length}행`);
  return { history, ohlc_available: false, source: 'CoinGecko(hourly)' };
}

async function fetchCoinGecko4h(id) {
  const prices = await fetchCoinMarketChart(id, 90);    // 자동 시간봉(최대 범위)
  const downsampled = [];
  for (let i = 3; i < prices.length; i += 4) downsampled.push(prices[i]);   // 4개씩 묶어 마지막 값 대표
  const history = downsampled
    .slice(-250)
    .map(([tsMs, price]) => ({ time: Math.floor(tsMs / 1000), close: r2(price) }));
  if (history.length < 10) throw new Error(`CoinGecko ${id} 4시간봉 부족: ${history.length}행`);
  return { history, ohlc_available: false, source: 'CoinGecko(4h 다운샘플)' };
}

async function fetchCoinGeckoDaily(id) {
  const prices = await fetchCoinMarketChart(id, 265, 'daily');
  const seen = new Map();
  for (const [tsMs, price] of prices) seen.set(tsToDate(tsMs), r2(price));
  const history = [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-250)
    .map(([date, close]) => ({ date, close }));
  if (history.length < 10) throw new Error(`CoinGecko ${id} 일봉 부족: ${history.length}행`);
  return { history, ohlc_available: false, source: 'CoinGecko(daily)' };
}

// ── 공개 함수 ────────────────────────────────────────────────────────

/**
 * 임의 코인의 분석 데이터 조회
 * @param {string} id     — CoinGecko coin id (CoinGecko 조회/폴백용)
 * @param {string} symbol — 코인 심볼 (Binance 상장 판정 및 페어 구성용, 예: 'ETH')
 * @param {string} tf
 * @returns {Promise<{ history, ohlc_available, source }>}
 */
export async function fetchCryptoByTF(id, symbol, tf) {
  const listed = await isBinanceListed(symbol);

  if (listed) {
    const pair = `${symbol.toUpperCase()}USDT`;

    if (BTC_INTRADAY_TFS.includes(tf)) {
      return fetchIntradayKlines(pair, tf);
    }

    const daily = await fetchBinanceDaily(pair, id);
    if (tf === '1w') {
      const weekly = toWeekly(daily.history, daily.ohlc_available);
      return { history: weekly, ohlc_available: true, source: daily.source + ' → 주봉 변환' };
    }
    if (tf === '1d') return daily;
    throw new Error(`crypto ${symbol}(상장): 지원하지 않는 tf "${tf}"`);
  }

  // Binance 미상장 → CoinGecko
  switch (tf) {
    case '1h': return fetchCoinGeckoHourly(id);
    case '4h': return fetchCoinGecko4h(id);
    case '1d': return fetchCoinGeckoDaily(id);
    case '1w': {
      const daily  = await fetchCoinGeckoDaily(id);
      const weekly = toWeekly(daily.history, false);
      return { history: weekly, ohlc_available: true, source: daily.source + ' → 주봉 변환' };
    }
    default:
      throw new Error(`crypto ${id}(미상장): 지원하지 않는 tf "${tf}"`);
  }
}
