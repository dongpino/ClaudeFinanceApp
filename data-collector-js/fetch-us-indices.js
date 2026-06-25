/**
 * fetch-us-indices.js — 나스닥(^IXIC), 다우(^DJI), VIX 수집
 * (Python market_check.py + fetch_ohlc.py 이식)
 *
 * 소스 전략:
 *   현재가/전일대비 : CNBC /quote-html-webservice (bulk .IXIC|.DJI|.VIX)
 *                    change = current - prev_close 직접 계산 (API change 필드 미사용)
 *   history 30일    : 나스닥 → Naver world/sise.naver (EUC-KR)
 *                     다우   → FRED DJIA CSV
 *                     VIX    → FRED VIXCLS CSV
 *   history_90d     : 동일 소스, numRows/numPages 확대 (close only, ohlc_available=false)
 *   장마감 보정     : |change| ≤ 0.01 이면 history 기반 재계산 (Python recalc_change_with_history)
 *
 * 단독 실행: node fetch-us-indices.js
 * collect-all.js에서: import { collectUSIndices } from './fetch-us-indices.js'
 * Node 18+ (built-in fetch + TextDecoder EUC-KR)
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────
// 유틸
// ──────────────────────────────────────────────────────
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
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

function direction(change) {
  if (change > 0) return 'up';
  if (change < 0) return 'down';
  return 'flat';
}

function r2(n)  { return Math.round(n * 100)   / 100;   }
function r4(n)  { return Math.round(n * 10000) / 10000; }

function cleanNum(s) {
  return parseFloat(String(s).replace(/,/g, '').replace(/%/g, '').trim());
}

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function fetchEucKR(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder('euc-kr').decode(buf);
}

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.text();
}

// ──────────────────────────────────────────────────────
// CNBC 현재가 (Python: _fetch_cnbc_bulk + fetch_cnbc)
//   change = current - prev_close  (API change 필드 무시)
// ──────────────────────────────────────────────────────
async function fetchCNBCBulk() {
  const params = new URLSearchParams({
    symbols:       '.IXIC|.DJI|.VIX',
    requestMethod: 'itv',
    noform:        '1',
    partnerId:     '2',
    fund:          '1',
    exthrs:        '1',
    output:        'json',
    events:        '0',
  });
  const data = await fetchJSON(
    `https://quote.cnbc.com/quote-html-webservice/quote.htm?${params}`
  );
  const quotes = data?.ITVQuoteResult?.ITVQuote;
  if (!Array.isArray(quotes) || quotes.length === 0)
    throw new Error(`CNBC 응답 형식 오류: ${JSON.stringify(data).slice(0, 200)}`);
  const bySymbol = {};
  for (const q of quotes) bySymbol[q.symbol] = q;
  return bySymbol;
}

function buildItemFromCNBC(q, { id, name, symbol, category }) {
  const current   = cleanNum(q.last);
  const prevClose = cleanNum(q.previous_day_closing);
  const change    = current - prevClose;
  const changePct = prevClose !== 0 ? change / prevClose * 100 : 0;
  const apiDir = (q.changetype ?? '').toUpperCase();
  if (apiDir && ((apiDir === 'UP') !== (change > 0)) && Math.abs(change) > 0.01) {
    console.warn(`  [WARN] CNBC ${q.symbol}: changetype=${apiDir} 이지만 계산 change=${change > 0 ? '+' : ''}${change.toFixed(2)} — 계산값 우선`);
  }
  return {
    id,
    name,
    symbol,
    price:          r2(current),
    prev_close:     r2(prevClose),
    change:         r2(change),
    change_pct:     r4(changePct),
    direction:      direction(change),
    source:         'CNBC',
    as_of:          fmtKST(),
    category,
    history:        [],
    ohlc_available: false,
    history_90d:    [],
  };
}

// ──────────────────────────────────────────────────────
// Naver world/sise.naver — 나스닥 역사 (Python: _close_naver_sise)
// ──────────────────────────────────────────────────────
async function fetchHistoryNaverSise(naverSymbol, numPages = 3) {
  const extraHeaders = {
    Accept:  'text/html,application/xhtml+xml,*/*',
    Referer: 'https://finance.naver.com/',
  };
  const seen = new Map();
  for (let page = 1; page <= numPages; page++) {
    const url  = `https://finance.naver.com/world/sise.naver?symbol=${encodeURIComponent(naverSymbol)}&page=${page}`;
    const text = await fetchEucKR(url, extraHeaders);
    const pat  = /<tr[^>]*>\s*<td[^>]*>\s*(\d{4}\.\d{2}\.\d{2})\s*<\/td>\s*<td[^>]*>\s*<span[^>]*>\s*([\d,]+\.?\d*)\s*<\/span>/gs;
    for (const m of text.matchAll(pat)) {
      const dateStr = m[1].replace(/\./g, '-');
      try { seen.set(dateStr, r2(cleanNum(m[2]))); } catch { /* skip */ }
    }
  }
  if (seen.size === 0)
    throw new Error(`Naver sise 파싱 결과 없음 (symbol=${naverSymbol})`);
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, close]) => ({ date, close }));
}

// ──────────────────────────────────────────────────────
// FRED CSV — 다우(DJIA) / VIX(VIXCLS) 역사 (Python: _close_fred)
// ──────────────────────────────────────────────────────
async function fetchHistoryFRED(fredId, numRows = 90) {
  const url   = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${fredId}`;
  const text  = await fetchText(url);
  const lines = text.trim().split('\n');
  const rows  = lines
    .slice(1)
    .map(line => { const [date, val] = line.split(','); return { date: date?.trim(), val: val?.trim() }; })
    .filter(r => r.date && r.val && r.val !== '.' && r.val !== '')
    .slice(-numRows)
    .map(r => ({ date: r.date, close: r2(parseFloat(r.val)) }));
  if (rows.length < 5)
    throw new Error(`FRED ${fredId} 데이터 부족: ${rows.length}행`);
  return rows;
}

// ──────────────────────────────────────────────────────
// 전일대비 보정 (Python: recalc_change_with_history)
// ──────────────────────────────────────────────────────
function recalcChange(item) {
  if (Math.abs(item.change) > 0.01) return;
  const h = item.history;
  if (!h || h.length < 2) {
    console.warn(`  [보정 스킵] ${item.name}: history 부족 (${h?.length ?? 0}개)`);
    return;
  }
  const hLast   = h[h.length - 1].close;
  const hPrev   = h[h.length - 2].close;
  const diffPct = hLast ? Math.abs(item.price - hLast) / hLast * 100 : 0;
  let newCurr, newPrev, mode;
  if (diffPct < 0.05) {
    newCurr = hLast;   newPrev = hPrev;   mode = '장마감';
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

function sanityCheck(item, lo, hi) {
  const warns = [];
  if (item.price < lo || item.price > hi)
    warns.push(`가격 ${item.price.toLocaleString()} ∉ [${lo.toLocaleString()}, ${hi.toLocaleString()}]`);
  if (Math.abs(item.change_pct) > 20)
    warns.push(`변동률 ${item.change_pct.toFixed(2)}% — 20% 초과`);
  if (item.change !== 0 && item.change_pct !== 0 && (item.change > 0) !== (item.change_pct > 0))
    warns.push(`change(${item.change > 0 ? '+' : '-'}) vs change_pct(${item.change_pct > 0 ? '+' : '-'}) 부호 불일치`);
  const status = warns.length === 0 ? 'OK' : '⚑ ';
  console.log(`  [Sanity ${status}] ${item.name}: ${item.price.toLocaleString()}`);
  for (const w of warns) console.warn(`    ⚑ ${w}`);
}

// ──────────────────────────────────────────────────────
// collectUSIndices — collect-all.js에서 import하여 사용
//
//   CNBC bulk 실패 → 3종목 전체 실패 (같은 API)
//   history/history_90d 실패 → 해당 종목만 history=[], 나머지 정상 진행
// Returns: [nasdaq, dow, vix]
// ──────────────────────────────────────────────────────
export async function collectUSIndices() {
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);

  // ── 1. CNBC 현재가 (3종목 공유 API — 실패 시 전체 실패) ──
  console.log('[US 1/3] CNBC 현재가 (bulk .IXIC|.DJI|.VIX)...');
  const cnbc = await fetchCNBCBulk();

  const nasdaq = buildItemFromCNBC(cnbc['.IXIC'], { id: 'nasdaq', name: '나스닥 (^IXIC)', symbol: '^IXIC', category: '지수' });
  const dow    = buildItemFromCNBC(cnbc['.DJI'],  { id: 'dow',    name: '다우존스 (^DJI)', symbol: '^DJI',  category: '지수' });
  const vix    = buildItemFromCNBC(cnbc['.VIX'],  { id: 'vix',    name: 'VIX 공포지수',    symbol: '^VIX',  category: '지수' });

  for (const it of [nasdaq, dow, vix])
    console.log(`  OK  [CNBC] ${it.name}: ${it.price.toLocaleString()}  ${sign(it.change)} (${(it.change_pct >= 0 ? '+' : '') + it.change_pct.toFixed(4)}%)`);

  // ── 2. history 30일 (per-item isolation) ─────────────────
  console.log('[US 2/3] history 30일...');

  console.log('  [나스닥] Naver sise (3pages)...');
  try {
    nasdaq.history = await fetchHistoryNaverSise('NAS@IXIC', 3);
    console.log(`  OK  ${nasdaq.history.length}포인트  (${nasdaq.history[0]?.date} ~ ${nasdaq.history.at(-1)?.date})`);
  } catch (e) {
    console.warn(`  [나스닥 history 실패] ${e.message}`);
  }

  console.log('  [다우] FRED DJIA (30일)...');
  try {
    dow.history = await fetchHistoryFRED('DJIA', 30);
    console.log(`  OK  ${dow.history.length}포인트  (${dow.history[0]?.date} ~ ${dow.history.at(-1)?.date})`);
  } catch (e) {
    console.warn(`  [다우 history 실패] ${e.message}`);
  }

  console.log('  [VIX] FRED VIXCLS (30일)...');
  try {
    vix.history = await fetchHistoryFRED('VIXCLS', 30);
    console.log(`  OK  ${vix.history.length}포인트  (${vix.history[0]?.date} ~ ${vix.history.at(-1)?.date})`);
  } catch (e) {
    console.warn(`  [VIX history 실패] ${e.message}`);
  }

  // ── 3. history_90d (per-item isolation) ──────────────────
  console.log('[US 3/3] history_90d...');

  console.log('  [나스닥] Naver sise (9pages)...');
  try {
    nasdaq.history_90d = await fetchHistoryNaverSise('NAS@IXIC', 9);
    console.log(`  OK  ${nasdaq.history_90d.length}일  (${nasdaq.history_90d[0]?.date} ~ ${nasdaq.history_90d.at(-1)?.date})`);
  } catch (e) {
    console.warn(`  [나스닥 history_90d 실패] ${e.message}`);
  }

  console.log('  [다우] FRED DJIA (90일)...');
  try {
    dow.history_90d = await fetchHistoryFRED('DJIA', 90);
    console.log(`  OK  ${dow.history_90d.length}일  (${dow.history_90d[0]?.date} ~ ${dow.history_90d.at(-1)?.date})`);
  } catch (e) {
    console.warn(`  [다우 history_90d 실패] ${e.message}`);
  }

  console.log('  [VIX] FRED VIXCLS (90일)...');
  try {
    vix.history_90d = await fetchHistoryFRED('VIXCLS', 90);
    console.log(`  OK  ${vix.history_90d.length}일  (${vix.history_90d[0]?.date} ~ ${vix.history_90d.at(-1)?.date})`);
  } catch (e) {
    console.warn(`  [VIX history_90d 실패] ${e.message}`);
  }

  // ── 4. 전일대비 보정 ──────────────────────────────────────
  console.log('[US] 전일대비 보정...');
  for (const it of [nasdaq, dow, vix]) {
    recalcChange(it);
    if (Math.abs(it.change) > 0.01)
      console.log(`  [보정 불필요] ${it.name}: change=${sign(it.change)}`);
  }

  // ── 5. Sanity check ───────────────────────────────────────
  console.log('[US] Sanity check...');
  sanityCheck(nasdaq, 10_000, 30_000);
  sanityCheck(dow,    40_000, 60_000);
  sanityCheck(vix,    5,      90);

  return [nasdaq, dow, vix];
}

// ──────────────────────────────────────────────────────
// main — 단독 실행용 래퍼
// ──────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('  미국 지수 수집 (나스닥 · 다우 · VIX)');
  console.log(`  조회 시각: ${fmtKST()}`);
  console.log('='.repeat(60));
  console.log();

  const items = await collectUSIndices();

  const output  = { updated_at: fmtKST(), items };
  const outPath = join(__dirname, 'us_indices_result.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n[저장] ${outPath}`);

  console.log('\n' + '='.repeat(60));
  console.log('  수집 결과 요약');
  console.log('='.repeat(60));
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  for (const it of items) {
    console.log(`  ${it.name.padEnd(18)} ${String(it.price.toLocaleString()).padStart(12)}  ${sign(it.change).padStart(10)} (${(it.change_pct >= 0 ? '+' : '') + it.change_pct.toFixed(4)}%)  [${it.source}]`);
    console.log(`    history=${it.history.length}포인트  history_90d=${it.history_90d.length}일  ohlc_available=${it.ohlc_available}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
