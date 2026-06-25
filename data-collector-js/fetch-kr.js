/**
 * fetch-kr.js — 코스피(^KS11) + 원/달러(USDKRW) 수집
 * (Python market_check.py + fetch_ohlc.py 이식)
 *
 * 소스 전략:
 *   코스피  현재가   : Naver mobile API  /api/index/KOSPI/price
 *   코스피  history  : 동일 API, pageSize=30
 *   코스피  hist_90d : Naver sise_index_day.naver (EUC-KR 스크래핑)
 *
 *   원/달러 현재가   : Naver exchangeDailyQuote.naver (EUC-KR HTML)
 *                     폴백: Frankfurter.app API
 *   원/달러 history  : 동일 URL 3페이지(30일) / 9페이지(90일) → Frankfurter 폴백
 *
 * 단독 실행: node fetch-kr.js
 * collect-all.js에서: import { collectKR } from './fetch-kr.js'
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

function todayKST() { return fmtKST().slice(0, 10); }

function daysAgo(n) {
  return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
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

// ──────────────────────────────────────────────────────
// 코스피 현재가 (Python: fetch_naver_kospi)
// ──────────────────────────────────────────────────────
async function fetchKOSPICurrent() {
  const rows = await fetchJSON('https://m.stock.naver.com/api/index/KOSPI/price');
  if (rows.length < 2) throw new Error(`Naver 응답 행 부족: ${rows.length}`);
  const current   = cleanNum(rows[0].closePrice);
  const prevClose = cleanNum(rows[1].closePrice);
  const change    = current - prevClose;
  const changePct = prevClose !== 0 ? change / prevClose * 100 : 0;
  const asOf      = rows[0].localTradedAt + ' (Naver 종가)';
  return { current, prevClose, change, changePct, asOf, source: 'Naver' };
}

// ──────────────────────────────────────────────────────
// 코스피 history (Python: _close_naver_kospi_mobile)
// ──────────────────────────────────────────────────────
async function fetchKOSPIHistory(pageSize = 30) {
  const url  = `https://m.stock.naver.com/api/index/KOSPI/price?pageSize=${pageSize}`;
  const rows = await fetchJSON(url);
  const result = rows
    .filter(r => r.localTradedAt && r.closePrice)
    .map(r => ({ date: r.localTradedAt, close: r2(cleanNum(r.closePrice)) }));
  if (result.length < 5)
    throw new Error(`KOSPI history 부족: ${result.length}행`);
  return result.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ──────────────────────────────────────────────────────
// 코스피 history_90d — Naver sise_index_day 웹 파싱
// (Python: _close_naver_kospi_web)
// ──────────────────────────────────────────────────────
async function fetchKOSPIHistory90d(numPages = 15) {
  const extraHeaders = { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' };
  const seen = new Map();
  for (let page = 1; page <= numPages; page++) {
    const url  = `https://finance.naver.com/sise/sise_index_day.naver?code=KOSPI&page=${page}`;
    const html = await fetchEucKR(url, extraHeaders);
    for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const dm = tr.match(/class="date"[^>]*>\s*(\d{4}\.\d{2}\.\d{2})/);
      if (!dm) continue;
      const dateStr = dm[1].replace(/\./g, '-');
      const cm = tr.match(/class="number_1"[^>]*>\s*([\d,]+\.\d{2})\s*<\/td>/);
      if (!cm) continue;
      try {
        const v = cleanNum(cm[1]);
        if (v > 100 && v < 20_000) seen.set(dateStr, r2(v));
      } catch { /* skip */ }
    }
  }
  if (seen.size < 5)
    throw new Error(`sise_index_day 파싱 실패: ${seen.size}행`);
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-90)
    .map(([date, close]) => ({ date, close }));
}

// ──────────────────────────────────────────────────────
// 원/달러 현재가 (Python: fetch_naver_usdkrw)
// ──────────────────────────────────────────────────────
async function fetchUSDKRWCurrent() {
  const html = await fetchEucKR(
    'https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=FX_USDKRW&page=1',
    { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' }
  );
  const pat     = /(\d{4}\.\d{2}\.\d{2})\s*<\/td>\s*<td[^>]*>\s*([\d,]+\.\d{2})/gs;
  const matches = [...html.matchAll(pat)];
  if (matches.length < 2)
    throw new Error(`환율 행 ${matches.length}개 (최소 2개 필요)`);
  const current   = cleanNum(matches[0][2]);
  const prevClose = cleanNum(matches[1][2]);
  const change    = current - prevClose;
  const changePct = prevClose !== 0 ? change / prevClose * 100 : 0;
  const asOf      = matches[0][1].replace(/\./g, '-') + ' (Naver 환율)';
  return { current, prevClose, change, changePct, asOf, source: 'Naver환율' };
}

// ──────────────────────────────────────────────────────
// 원/달러 현재가 폴백 (Python: fetch_frankfurter_usdkrw)
// ──────────────────────────────────────────────────────
async function fetchFrankfurterCurrent() {
  const end   = todayKST();
  const start = daysAgo(7);
  const data  = await fetchJSON(
    `https://api.frankfurter.app/${start}..${end}?from=USD&to=KRW`
  );
  const rates = Object.entries(data.rates ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (rates.length < 2)
    throw new Error(`Frankfurter 데이터 부족: ${rates.length}포인트`);
  const current   = rates[rates.length - 1][1].KRW;
  const prevClose = rates[rates.length - 2][1].KRW;
  const change    = current - prevClose;
  const changePct = prevClose !== 0 ? change / prevClose * 100 : 0;
  return { current, prevClose, change, changePct, asOf: fmtKST(), source: 'Frankfurter' };
}

// ──────────────────────────────────────────────────────
// 원/달러 history (Python: _close_usdkrw_naver)
// ──────────────────────────────────────────────────────
async function fetchUSDKRWHistory(numPages = 3) {
  const extraHeaders = { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' };
  const seen = new Map();
  for (let page = 1; page <= numPages; page++) {
    const url  = `https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=FX_USDKRW&page=${page}`;
    const html = await fetchEucKR(url, extraHeaders);
    const pat  = /(\d{4}\.\d{2}\.\d{2})\s*<\/td>\s*<td[^>]*>\s*([\d,]+\.\d{2})/gs;
    for (const m of html.matchAll(pat)) {
      const dateStr = m[1].replace(/\./g, '-');
      try { seen.set(dateStr, r2(cleanNum(m[2]))); } catch { /* skip */ }
    }
  }
  if (seen.size === 0) throw new Error('Naver 환율 history: 데이터 없음');
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, close]) => ({ date, close }));
}

// ──────────────────────────────────────────────────────
// 원/달러 history 폴백 (Python: _close_usdkrw_frankfurter)
// ──────────────────────────────────────────────────────
async function fetchFrankfurterHistory(tradingDays = 30) {
  const calDays = Math.round(tradingDays * 1.8);
  const end   = todayKST();
  const start = daysAgo(calDays);
  const data  = await fetchJSON(
    `https://api.frankfurter.app/${start}..${end}?from=USD&to=KRW`
  );
  const rates = Object.entries(data.rates ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-tradingDays);
  if (rates.length < 5)
    throw new Error(`Frankfurter history 부족: ${rates.length}행`);
  return rates.map(([date, v]) => ({ date, close: r2(v.KRW) }));
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
// collectKR — collect-all.js에서 import하여 사용
//
//   코스피/원달러 각각 per-item try/catch
//   한 종목 실패 시 나머지 정상 반환
// Returns: [kospi, krw] (실패한 종목은 배열에서 제외)
// ──────────────────────────────────────────────────────
export async function collectKR() {
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  const items = [];

  // ── 코스피 ──────────────────────────────────────────
  try {
    console.log('[KR 코스피 1/3] 현재가 (Naver mobile API)...');
    const kc = await fetchKOSPICurrent();
    const kospi = {
      id:             'kospi',
      name:           '코스피 (^KS11)',
      symbol:         '^KS11',
      price:          r2(kc.current),
      prev_close:     r2(kc.prevClose),
      change:         r2(kc.change),
      change_pct:     r4(kc.changePct),
      direction:      direction(kc.change),
      source:         kc.source,
      as_of:          kc.asOf,
      category:       '지수',
      history:        [],
      ohlc_available: false,
      history_90d:    [],
    };
    console.log(`  ${kospi.price.toLocaleString()}  ${sign(kospi.change)} (${(kospi.change_pct >= 0 ? '+' : '') + kospi.change_pct.toFixed(4)}%)`);

    console.log('[KR 코스피 2/3] history 30일 (Naver pageSize=30)...');
    try {
      kospi.history = await fetchKOSPIHistory(30);
      console.log(`  OK  ${kospi.history.length}포인트  (${kospi.history[0]?.date} ~ ${kospi.history.at(-1)?.date})`);
    } catch (e) {
      console.warn(`  [코스피 history 실패] ${e.message}`);
    }

    console.log('[KR 코스피 3/3] history_90d (Naver sise_index_day, 15pages)...');
    try {
      kospi.history_90d = await fetchKOSPIHistory90d(15);
      console.log(`  OK  ${kospi.history_90d.length}일  (${kospi.history_90d[0]?.date} ~ ${kospi.history_90d.at(-1)?.date})`);
    } catch (e) {
      console.warn(`  [코스피 history_90d 실패] ${e.message}`);
    }

    console.log('[KR 코스피] 전일대비 보정...');
    recalcChange(kospi);
    if (Math.abs(kospi.change) > 0.01)
      console.log(`  [보정 불필요] change=${sign(kospi.change)}`);

    console.log('[KR 코스피] Sanity check...');
    sanityCheck(kospi, 2_000, 20_000);

    items.push(kospi);
  } catch (e) {
    console.error(`[코스피 수집 실패] ${e.message}`);
  }

  // ── 원/달러 ─────────────────────────────────────────
  try {
    console.log('[KR 원/달러 1/3] 현재가 (Naver exchangeDailyQuote)...');
    let krc;
    try {
      krc = await fetchUSDKRWCurrent();
      console.log(`  OK  [Naver환율]  ${krc.current.toLocaleString()}  ${sign(krc.change)} (${(krc.changePct >= 0 ? '+' : '') + krc.changePct.toFixed(4)}%)`);
    } catch (e) {
      console.warn(`  Naver환율 실패: ${e.message}  → Frankfurter 폴백...`);
      krc = await fetchFrankfurterCurrent();
      console.log(`  OK  [Frankfurter]  ${krc.current.toLocaleString()}`);
    }

    const krw = {
      id:             'usdkrw',
      name:           '원/달러',
      symbol:         'USDKRW',
      price:          r2(krc.current),
      prev_close:     r2(krc.prevClose),
      change:         r2(krc.change),
      change_pct:     r4(krc.changePct),
      direction:      direction(krc.change),
      source:         krc.source,
      as_of:          krc.asOf,
      category:       '환율',
      history:        [],
      ohlc_available: false,
      history_90d:    [],
    };

    console.log('[KR 원/달러 2/3] history 30일 (Naver 3pages)...');
    try {
      krw.history = await fetchUSDKRWHistory(3);
      if (krw.history.length < 10) throw new Error(`포인트 부족: ${krw.history.length}`);
      console.log(`  OK  [Naver] ${krw.history.length}포인트  (${krw.history[0]?.date} ~ ${krw.history.at(-1)?.date})`);
    } catch (e) {
      console.warn(`  Naver 실패: ${e.message}  → Frankfurter 폴백...`);
      try {
        krw.history = await fetchFrankfurterHistory(30);
        console.log(`  OK  [Frankfurter] ${krw.history.length}포인트`);
      } catch (e2) {
        console.warn(`  [원/달러 history 실패] ${e2.message}`);
      }
    }

    console.log('[KR 원/달러 3/3] history_90d (Naver 9pages)...');
    try {
      krw.history_90d = await fetchUSDKRWHistory(9);
      if (krw.history_90d.length < 10) throw new Error(`포인트 부족: ${krw.history_90d.length}`);
      console.log(`  OK  [Naver] ${krw.history_90d.length}일  (${krw.history_90d[0]?.date} ~ ${krw.history_90d.at(-1)?.date})`);
    } catch (e) {
      console.warn(`  Naver 실패: ${e.message}  → Frankfurter 폴백...`);
      try {
        krw.history_90d = await fetchFrankfurterHistory(90);
        console.log(`  OK  [Frankfurter] ${krw.history_90d.length}일`);
      } catch (e2) {
        console.warn(`  [원/달러 history_90d 실패] ${e2.message}`);
      }
    }

    console.log('[KR 원/달러] 전일대비 보정...');
    recalcChange(krw);
    if (Math.abs(krw.change) > 0.01)
      console.log(`  [보정 불필요] change=${sign(krw.change)}`);

    console.log('[KR 원/달러] Sanity check...');
    sanityCheck(krw, 1_000, 2_000);

    items.push(krw);
  } catch (e) {
    console.error(`[원/달러 수집 실패] ${e.message}`);
  }

  return items;
}

// ──────────────────────────────────────────────────────
// main — 단독 실행용 래퍼
// ──────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('  한국 지표 수집 (코스피 · 원/달러)');
  console.log(`  조회 시각: ${fmtKST()}`);
  console.log('='.repeat(60));
  console.log();

  const items = await collectKR();

  const output  = { updated_at: fmtKST(), items };
  const outPath = join(__dirname, 'kr_result.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n[저장] ${outPath}`);

  console.log('\n' + '='.repeat(60));
  console.log('  수집 결과 요약');
  console.log('='.repeat(60));
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  for (const it of items) {
    console.log(`  ${it.name.padEnd(14)} ${String(it.price.toLocaleString()).padStart(10)}  ${sign(it.change).padStart(8)} (${(it.change_pct >= 0 ? '+' : '') + it.change_pct.toFixed(4)}%)  [${it.source}]`);
    console.log(`    history=${it.history.length}포인트  history_90d=${it.history_90d.length}일  as_of="${it.as_of}"`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
