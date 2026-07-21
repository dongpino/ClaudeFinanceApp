/**
 * _collectors/btc.js — BTC 수집 (Vercel 서버리스 전용)
 * data-collector-js/fetch-btc.js의 collectBTC 로직과 동일.
 * main()/file I/O 제거, export만 남긴 서버리스 전용 버전.
 */

import { trackedFetch } from '../_lib/health.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

function tsToDateUTC(tsMs) { return new Date(tsMs).toISOString().slice(0, 10); }
function direction(change) { return change > 0 ? 'up' : change < 0 ? 'down' : 'flat'; }
function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }

async function fetchJSON(url) {
  const res = await trackedFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function fetchCurrentPrice() {
  const data = await fetchJSON(
    'https://api.coingecko.com/api/v3/simple/price' +
    '?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true'
  );
  const btc       = data.bitcoin;
  const current   = btc.usd;
  const changePct = btc.usd_24h_change;
  const prevClose = current / (1 + changePct / 100);
  return { current, prevClose, change: current - prevClose, changePct, asOf: fmtKST(btc.last_updated_at * 1000) };
}

async function fetchHistory30() {
  const data = await fetchJSON(
    'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=30&interval=daily'
  );
  const seen = new Map();
  for (const [tsMs, price] of data.prices) seen.set(tsToDateUTC(tsMs), r2(price));
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, close]) => ({ date, close }));
}

// Binance는 data-api.binance.vision(CDN, Vercel 지역차단 없음) 우선, api.binance.com은
// 폴백 — btc-intraday.js와 동일 체인. 예전엔 api.binance.com 직격이라 Vercel에서 451/403로
// 매번 실패해 CoinGecko /ohlc 백업콜(불필요한 CoinGecko 부하)을 유발했다.
async function fetchHistory90dBinance(limit = 90) {
  const path = `/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=${limit}`;
  let raw;
  try {
    raw = await fetchJSON(`https://data-api.binance.vision${path}`);
  } catch (e) {
    console.warn(`[btc] binance.vision 실패: ${e.message} → api.binance.com`);
    raw = await fetchJSON(`https://api.binance.com${path}`);
  }
  if (!Array.isArray(raw) || raw.length < 10) throw new Error(`Binance 데이터 부족: ${raw.length}행`);
  return raw.map(k => ({
    date: tsToDateUTC(Number(k[0])),
    open: r2(parseFloat(k[1])), high: r2(parseFloat(k[2])),
    low:  r2(parseFloat(k[3])), close: r2(parseFloat(k[4])),
  }));
}

async function fetchHistory90dCoinGecko() {
  const raw = await fetchJSON('https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=30');
  if (!Array.isArray(raw) || raw.length < 5) throw new Error(`형식 오류: ${raw.length}행`);
  const daily = new Map();
  for (const [tsMs, o, h, l, c] of raw.sort((a, b) => a[0] - b[0])) {
    const ds = tsToDateUTC(tsMs);
    if (!daily.has(ds)) daily.set(ds, { date: ds, open: o, high: h, low: l, close: c });
    else { const d = daily.get(ds); d.high = Math.max(d.high, h); d.low = Math.min(d.low, l); d.close = c; }
  }
  const result = [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(d => ({ date: d.date, open: r2(d.open), high: r2(d.high), low: r2(d.low), close: r2(d.close) }));
  if (result.length < 5) throw new Error(`일별 집계 후 ${result.length}일 — 데이터 부족`);
  return result;
}

function recalcChange(item) {
  if (Math.abs(item.change) > 0.01) return;
  const h = item.history;
  if (!h || h.length < 2) return;
  const hLast = h[h.length - 1].close, hPrev = h[h.length - 2].close;
  const diffPct = hLast ? Math.abs(item.price - hLast) / hLast * 100 : 0;
  const [newCurr, newPrev] = diffPct < 0.05 ? [hLast, hPrev] : [item.price, hLast];
  item.price      = r2(newCurr);
  item.prev_close = r2(newPrev);
  item.change     = r2(newCurr - newPrev);
  item.change_pct = newPrev ? r4(item.change / newPrev * 100) : 0;
  item.direction  = direction(item.change);
}

// priceOverride: 홈 aggregation이 btc+eth 현재가를 /simple/price 1콜로 병합해 넘겨주는
// 통로(crypto-simple-price.js). 없으면(상세 경로 등) 종전대로 자체 조회한다.
export async function collectBTC({ include90d = true, priceOverride = null } = {}) {
  const price    = priceOverride ?? await fetchCurrentPrice();
  const history  = await fetchHistory30();

  let history_90d = [], ohlc_available = false;
  if (include90d) {
    try {
      history_90d    = await fetchHistory90dBinance(90);
      ohlc_available = true;
    } catch (e) {
      console.warn(`[btc] Binance 실패: ${e.message} → CoinGecko 백업`);
      try {
        history_90d    = await fetchHistory90dCoinGecko();
        ohlc_available = true;
      } catch (e2) {
        console.warn(`[btc] CoinGecko도 실패: ${e2.message}`);
      }
    }
  }

  const item = {
    id: 'btc', name: '비트코인 BTC-USD', symbol: 'BTC-USD',
    price:          r2(price.current),
    prev_close:     r2(price.prevClose),
    change:         r2(price.change),
    change_pct:     r4(price.changePct),
    direction:      direction(price.change),
    source:         'CoinGecko',
    as_of:          price.asOf,
    category:       '크립토',
    history,
    ohlc_available,
    history_90d,
  };
  recalcChange(item);
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  console.log(`[btc] $${item.price.toLocaleString('en-US')}  ${sign(item.change)} (${sign(item.change_pct)}%)  hist=${history.length}  hist_90d=${history_90d.length}`);
  return item;
}
