/**
 * fetch-btc.js — BTC 데이터 수집 (Python market_check.py + fetch_ohlc.py 이식)
 *
 * 소스 전략:
 *   현재가/전일대비  : CoinGecko /simple/price  (Python fetch_coingecko_btc)
 *   history 30d     : CoinGecko /market_chart   (Python fetch_history_coingecko_btc)
 *   history_90d     : Binance   /klines  →  CoinGecko /ohlc (Python fetch_ohlc_binance_btc)
 *
 * 단독 실행: node fetch-btc.js
 * collect-all.js에서: import { collectBTC } from './fetch-btc.js'
 * Node 18+ (built-in fetch 사용, 외부 의존성 없음)
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

// ──────────────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────────────

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

function tsToDateUTC(tsMs) {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function direction(change) {
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'flat';
}

function r2(n)  { return Math.round(n * 100)   / 100;   }
function r4(n)  { return Math.round(n * 10000) / 10000; }

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// ──────────────────────────────────────────────────────
// 1. 현재가 + 전일대비  (Python: fetch_coingecko_btc)
// ──────────────────────────────────────────────────────
async function fetchCurrentPrice() {
  const data = await fetchJSON(
    'https://api.coingecko.com/api/v3/simple/price' +
    '?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true'
  );
  const btc       = data.bitcoin;
  const current   = btc.usd;
  const changePct = btc.usd_24h_change;
  const prevClose = current / (1 + changePct / 100);
  const change    = current - prevClose;
  const asOf      = fmtKST(btc.last_updated_at * 1000);
  return { current, prevClose, change, changePct, asOf };
}

// ──────────────────────────────────────────────────────
// 2. history 30일  (Python: fetch_history_coingecko_btc)
// ──────────────────────────────────────────────────────
async function fetchHistory30() {
  const data = await fetchJSON(
    'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart' +
    '?vs_currency=usd&days=30&interval=daily'
  );
  const seen = new Map();
  for (const [tsMs, price] of data.prices) {
    seen.set(tsToDateUTC(tsMs), r2(price));
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, close]) => ({ date, close }));
}

// ──────────────────────────────────────────────────────
// 3-A. history_90d OHLC  (Python: fetch_ohlc_binance_btc)
// ──────────────────────────────────────────────────────
async function fetchHistory90dBinance(limit = 90) {
  const raw = await fetchJSON(
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=${limit}`
  );
  if (!Array.isArray(raw) || raw.length < 10)
    throw new Error(`Binance 데이터 부족: ${raw.length}행`);
  return raw.map(k => ({
    date:  tsToDateUTC(Number(k[0])),
    open:  r2(parseFloat(k[1])),
    high:  r2(parseFloat(k[2])),
    low:   r2(parseFloat(k[3])),
    close: r2(parseFloat(k[4])),
  }));
}

// ──────────────────────────────────────────────────────
// 3-B. history_90d OHLC 백업  (Python: fetch_ohlc_coingecko_btc)
// ──────────────────────────────────────────────────────
async function fetchHistory90dCoinGecko() {
  const raw = await fetchJSON(
    'https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=30'
  );
  if (!Array.isArray(raw) || raw.length < 5)
    throw new Error(`형식 오류: ${raw.length}행`);
  const daily = new Map();
  for (const [tsMs, o, h, l, c] of raw.sort((a, b) => a[0] - b[0])) {
    const ds = tsToDateUTC(tsMs);
    if (!daily.has(ds)) {
      daily.set(ds, { date: ds, open: o, high: h, low: l, close: c });
    } else {
      const d = daily.get(ds);
      d.high  = Math.max(d.high, h);
      d.low   = Math.min(d.low, l);
      d.close = c;
    }
  }
  const result = [...daily.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(d => ({ date: d.date, open: r2(d.open), high: r2(d.high), low: r2(d.low), close: r2(d.close) }));
  if (result.length < 5)
    throw new Error(`일별 집계 후 ${result.length}일 — 데이터 부족`);
  return result;
}

// ──────────────────────────────────────────────────────
// 4. 전일대비 보정  (Python: recalc_change_with_history)
// ──────────────────────────────────────────────────────
function recalcChange(item) {
  if (Math.abs(item.change) > 0.01) return;
  const h = item.history;
  if (!h || h.length < 2) {
    console.warn(`  [보정 스킵] ${item.name}: history 포인트 부족 (${h?.length ?? 0}개)`);
    return;
  }
  const hLast   = h[h.length - 1].close;
  const hPrev   = h[h.length - 2].close;
  const diffPct = hLast ? Math.abs(item.price - hLast) / hLast * 100 : 0;
  let newCurr, newPrev, mode;
  if (diffPct < 0.05) {
    newCurr = hLast;  newPrev = hPrev;  mode = '장마감';
  } else {
    newCurr = item.price;  newPrev = hLast;  mode = '이례';
  }
  const oldPct    = item.change_pct;
  item.price      = r2(newCurr);
  item.prev_close = r2(newPrev);
  item.change     = r2(newCurr - newPrev);
  item.change_pct = newPrev ? r4(item.change / newPrev * 100) : 0;
  item.direction  = direction(item.change);
  const fmt = n => (n >= 0 ? '+' : '') + n.toFixed(4) + '%';
  console.log(`  [보정] ${item.name}: ${fmt(oldPct)} → ${fmt(item.change_pct)}  (${mode})`);
  console.log(`         history[-1]=${hLast.toLocaleString()} (${h[h.length-1].date})`
            + `  history[-2]=${hPrev.toLocaleString()} (${h[h.length-2].date})`);
}

// ──────────────────────────────────────────────────────
// collectBTC — collect-all.js에서 import하여 사용
// Returns: item object
// ──────────────────────────────────────────────────────
export async function collectBTC() {
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);

  console.log('[BTC 1/3] 현재가 (CoinGecko)...');
  const price = await fetchCurrentPrice();
  console.log(`  $${price.current.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}  change=${sign(price.change)} (${sign(price.changePct)}%)  as_of=${price.asOf}`);

  console.log('[BTC 2/3] history 30일...');
  const history = await fetchHistory30();
  console.log(`  ${history.length}포인트  (${history[0]?.date} ~ ${history.at(-1)?.date})`);

  console.log('[BTC 3/3] history_90d OHLC...');
  let history90d = [], ohlcAvailable = false;
  try {
    history90d = await fetchHistory90dBinance(90);
    ohlcAvailable = true;
    console.log(`  [Binance] OK  ${history90d.length}일  (${history90d[0]?.date} ~ ${history90d.at(-1)?.date})`);
  } catch (e) {
    console.warn(`  [Binance 실패] ${e.message}`);
    try {
      console.log('  [CoinGecko 백업]...');
      history90d = await fetchHistory90dCoinGecko();
      ohlcAvailable = true;
      console.log(`  [CoinGecko 백업] OK  ${history90d.length}일`);
    } catch (e2) {
      console.warn(`  [CoinGecko도 실패] ${e2.message}`);
    }
  }

  const item = {
    id:             'btc',
    name:           '비트코인 BTC-USD',
    symbol:         'BTC-USD',
    price:          r2(price.current),
    prev_close:     r2(price.prevClose),
    change:         r2(price.change),
    change_pct:     r4(price.changePct),
    direction:      direction(price.change),
    source:         'CoinGecko',
    as_of:          price.asOf,
    category:       '크립토',
    history,
    ohlc_available: ohlcAvailable,
    history_90d:    history90d,
  };

  console.log('[BTC] 전일대비 보정...');
  recalcChange(item);
  if (Math.abs(item.change) > 0.01)
    console.log(`  [보정 불필요] change=${sign(item.change)}`);

  return item;
}

// ──────────────────────────────────────────────────────
// main — 단독 실행용 래퍼 (헤더/저장/요약 추가)
// ──────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('  BTC 데이터 수집 (JS — Python 이식 검증용)');
  console.log(`  조회 시각: ${fmtKST()}`);
  console.log('='.repeat(60));
  console.log();

  const item = await collectBTC();

  const output  = { updated_at: fmtKST(), items: [item] };
  const outPath = join(__dirname, 'btc_result.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n[저장] ${outPath}`);

  console.log('\n' + '='.repeat(60));
  console.log('  수집 결과 요약');
  console.log('='.repeat(60));
  const fmtN = (n, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  console.log(`  price:          $${fmtN(item.price)}`);
  console.log(`  prev_close:     $${fmtN(item.prev_close)}`);
  console.log(`  change:         ${sign(item.change)}`);
  console.log(`  change_pct:     ${item.change_pct >= 0 ? '+' : ''}${item.change_pct.toFixed(4)}%`);
  console.log(`  direction:      ${item.direction}`);
  console.log(`  history:        ${item.history.length}포인트  (${item.history[0]?.date} ~ ${item.history.at(-1)?.date})`);
  console.log(`  ohlc_available: ${item.ohlc_available}`);
  console.log(`  history_90d:    ${item.history_90d.length}일  (${item.history_90d[0]?.date} ~ ${item.history_90d.at(-1)?.date})`);
  if (item.history_90d[0]) {
    console.log(`    first: ${JSON.stringify(item.history_90d[0])}`);
    console.log(`    last:  ${JSON.stringify(item.history_90d.at(-1))}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
