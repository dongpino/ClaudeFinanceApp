/**
 * _collectors/crypto-ticker.js — 크립토 현재가/일봉 라이브 폴오버 (CoinGecko 장애 시)
 *
 * CoinGecko /simple/price(현재가)·/market_chart(30d 스파크라인)가 실패하면 Binance/Bybit
 * 실시간 소스로 대체한다. 소스 우선순위는 기존 히스토리 체인(btc-intraday.js
 * fetchIntradaySources)과 동일:
 *   data-api.binance.vision → api.binance.com → api.bybit.com
 *
 * 각 fetch는 trackedFetch라 health에 자동 집계된다(vision/com→'binance', bybit→'bybit').
 * → 폴오버 발동 시 상태판에서 "coingecko 빨강 + binance(또는 bybit) 초록"으로 자연히 읽힘.
 *
 * 반환 현재가 형식은 btc.js/eth.js의 fetchCurrentPrice와 동일 + source 필드:
 *   { current, prevClose, change, changePct, asOf, source: 'Binance' | 'Bybit' }
 */

import { trackedFetch } from '../_lib/health.js';

const HEADERS    = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
const TIMEOUT_MS = 8000;

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}
function r2(n) { return Math.round(n * 100) / 100; }
function tsToDateUTC(tsMs) { return new Date(tsMs).toISOString().slice(0, 10); }

async function fetchJSON(url) {
  const res = await trackedFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// ── 현재가: 소스별 ────────────────────────────────────────────
// Binance 24hr ticker. prevClose는 CoinGecko와 동일 산식(current/(1+pct/100))으로 파생해
// 소스 전환에도 change/prev_close 계산 규약을 일치시킨다.
async function tickerBinance(host, pair) {
  const d = await fetchJSON(`https://${host}/api/v3/ticker/24hr?symbol=${pair}`);
  const current   = parseFloat(d.lastPrice);
  const changePct = parseFloat(d.priceChangePercent);
  if (!Number.isFinite(current) || current <= 0) throw new Error(`Binance ticker 가격 이상: ${d.lastPrice}`);
  if (!Number.isFinite(changePct)) throw new Error(`Binance ticker 변동률 이상: ${d.priceChangePercent}`);
  const prevClose = current / (1 + changePct / 100);
  const asOf = d.closeTime ? fmtKST(Number(d.closeTime)) : fmtKST();
  return { current, prevClose, change: current - prevClose, changePct, asOf, source: 'Binance' };
}

// Bybit spot ticker. price24hPcnt은 분수(예: 0.0183) → ×100. asOf 타임스탬프 없음 → now()(승인됨).
async function tickerBybit(pair) {
  const d = await fetchJSON(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${pair}`);
  if (d.retCode !== 0) throw new Error(`Bybit retCode=${d.retCode} ${d.retMsg ?? ''}`);
  const t = d?.result?.list?.[0];
  if (!t) throw new Error('Bybit tickers 응답에 list 없음');
  const current   = parseFloat(t.lastPrice);
  const changePct = parseFloat(t.price24hPcnt) * 100;
  if (!Number.isFinite(current) || current <= 0) throw new Error(`Bybit ticker 가격 이상: ${t.lastPrice}`);
  if (!Number.isFinite(changePct)) throw new Error(`Bybit ticker 변동률 이상: ${t.price24hPcnt}`);
  const prevClose = current / (1 + changePct / 100);
  return { current, prevClose, change: current - prevClose, changePct, asOf: fmtKST(), source: 'Bybit' };
}

/**
 * 현재가 폴오버 — vision → binance.com → bybit 순차, 첫 성공 반환.
 * @param {string} pair — 예: 'BTCUSDT'
 * @returns {Promise<{current, prevClose, change, changePct, asOf, source}>}
 */
export async function fetchCryptoTicker(pair) {
  const attempts = [
    ['binance.vision', () => tickerBinance('data-api.binance.vision', pair)],
    ['binance.com',    () => tickerBinance('api.binance.com', pair)],
    ['bybit',          () => tickerBybit(pair)],
  ];
  const errors = [];
  for (const [label, fn] of attempts) {
    try {
      const p = await fn();
      console.log(`[crypto-ticker] ${pair} 현재가 폴오버 ✅ ${label}: $${p.current} (${p.changePct.toFixed(2)}%)`);
      return p;
    } catch (e) {
      console.warn(`[crypto-ticker] ${pair} 현재가 ❌ ${label}: ${e.message}`);
      errors.push(`${label}: ${e.message}`);
    }
  }
  throw new Error(`${pair} 현재가 전 소스 실패: ${errors.join(' | ')}`);
}

// ── 30d 일봉 종가(스파크라인 폴백): 소스별 ────────────────────
// UTC 캔들 경계 차이는 보정 없이 수용(승인됨) — 카드 미니차트 용도라 무영향.
async function dailyBinance(host, pair, limit) {
  const raw = await fetchJSON(`https://${host}/api/v3/klines?symbol=${pair}&interval=1d&limit=${limit}`);
  if (!Array.isArray(raw) || raw.length < 5) throw new Error(`Binance klines 부족: ${raw?.length ?? 0}행`);
  return raw.map(k => ({ date: tsToDateUTC(Number(k[0])), close: r2(parseFloat(k[4])) }));
}
async function dailyBybit(pair, limit) {
  const d = await fetchJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=D&limit=${limit}`);
  if (d.retCode !== 0) throw new Error(`Bybit retCode=${d.retCode} ${d.retMsg ?? ''}`);
  const list = d?.result?.list;
  if (!Array.isArray(list) || list.length < 5) throw new Error(`Bybit klines 부족: ${list?.length ?? 0}행`);
  // Bybit은 최신 봉이 앞 → reverse해 오름차순. 항목: [startMs, o, h, l, c, volume, turnover]
  return [...list].reverse().map(k => ({ date: tsToDateUTC(Number(k[0])), close: r2(parseFloat(k[4])) }));
}

/**
 * 30d 일봉 종가 폴백 — vision → binance.com → bybit 순차, 첫 성공 반환.
 * @param {string} pair — 예: 'BTCUSDT'
 * @param {number} limit
 * @returns {Promise<Array<{date, close}>>}
 */
export async function fetchCryptoDailyCloses(pair, limit = 30) {
  const attempts = [
    ['binance.vision', () => dailyBinance('data-api.binance.vision', pair, limit)],
    ['binance.com',    () => dailyBinance('api.binance.com', pair, limit)],
    ['bybit',          () => dailyBybit(pair, limit)],
  ];
  const errors = [];
  for (const [label, fn] of attempts) {
    try {
      const h = await fn();
      console.log(`[crypto-ticker] ${pair} 30d 스파크라인 폴백 ✅ ${label}: ${h.length}일`);
      return h;
    } catch (e) {
      console.warn(`[crypto-ticker] ${pair} 일봉 ❌ ${label}: ${e.message}`);
      errors.push(`${label}: ${e.message}`);
    }
  }
  throw new Error(`${pair} 30d 일봉 전 소스 실패: ${errors.join(' | ')}`);
}
