/**
 * _collectors/kr.js — 코스피/코스닥/원달러/원엔 수집 (Vercel 서버리스 전용)
 */

import { trackedFetch } from '../_lib/health.js';
import { fetchYahooIndexCurrent, fetchYahooIndexDailyCloses } from './yahoo-index.js';
import { KR_INDEX_SYMBOLS } from '../_lib/symbol-map.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
function daysAgo(n) { return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10); }
function direction(change) { return change > 0 ? 'up' : change < 0 ? 'down' : 'flat'; }
function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }
function cleanNum(s) { return parseFloat(String(s).replace(/,/g, '').replace(/%/g, '').trim()); }

async function fetchJSON(url) {
  const res = await trackedFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function fetchEucKR(url, extraHeaders = {}) {
  const res = await trackedFetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return new TextDecoder('euc-kr').decode(await res.arrayBuffer());
}

// ── 코스피/코스닥 공통 (Naver 지수 코드로 파라미터화: KOSPI | KOSDAQ) ──
async function fetchIndexCurrent(naverCode) {
  const rows = await fetchJSON(`https://m.stock.naver.com/api/index/${naverCode}/price`);
  if (rows.length < 2) throw new Error(`Naver 응답 행 부족(${naverCode}): ${rows.length}`);
  const current   = cleanNum(rows[0].closePrice);
  const prevClose = cleanNum(rows[1].closePrice);
  return { current, prevClose, change: current - prevClose,
           changePct: prevClose ? (current - prevClose) / prevClose * 100 : 0,
           asOf: rows[0].localTradedAt + ' (Naver 종가)', source: 'Naver' };
}

async function fetchIndexHistory(naverCode, pageSize = 30) {
  const rows = await fetchJSON(`https://m.stock.naver.com/api/index/${naverCode}/price?pageSize=${pageSize}`);
  const result = rows.filter(r => r.localTradedAt && r.closePrice)
    .map(r => ({ date: r.localTradedAt, close: r2(cleanNum(r.closePrice)) }));
  if (result.length < 5) throw new Error(`${naverCode} history 부족: ${result.length}행`);
  return result.sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function fetchIndexHistory90d(naverCode, numPages = 15) {
  const extra = { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' };
  const seen  = new Map();
  const pages = await Promise.all(
    Array.from({ length: numPages }, (_, i) =>
      fetchEucKR(`https://finance.naver.com/sise/sise_index_day.naver?code=${naverCode}&page=${i + 1}`, extra)
    )
  );
  for (const html of pages) {
    for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const dm = tr.match(/class="date"[^>]*>\s*(\d{4}\.\d{2}\.\d{2})/);
      if (!dm) continue;
      const cm = tr.match(/class="number_1"[^>]*>\s*([\d,]+\.\d{2})\s*<\/td>/);
      if (!cm) continue;
      try { const v = cleanNum(cm[1]); if (v > 100 && v < 20_000) seen.set(dm[1].replace(/\./g, '-'), r2(v)); }
      catch { /* skip */ }
    }
  }
  if (seen.size < 5) throw new Error(`sise_index_day 파싱 실패(${naverCode}): ${seen.size}행`);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-90).map(([date, close]) => ({ date, close }));
}

// 코스피/코스닥 공통 조립 — id/name/symbol/naverCode만 다르고 나머지 로직은 동일.
// symbol(^KS11/^KQ11)이 곧 Yahoo 심볼 — Naver 실패 시 Yahoo 라이브 폴오버에 재사용한다.
// 우선순위: Naver 라이브 > Yahoo 라이브 > (상위 market-data의) last-good stale > 실패.
async function buildIndexItem({ id, name, symbol, naverCode }, include90d, sign) {
  // 현재가: Naver 우선, 실패(에러/타임아웃/행부족) 시 Yahoo 폴오버. 여기서 Yahoo가 성공하면
  // 아이템이 fresh로 수집돼 last-good을 아예 거치지 않는다(성공본 유무와 무관하게 라이브 우선).
  let kc;
  try {
    kc = await fetchIndexCurrent(naverCode);
  } catch (e) {
    console.warn(`[${id}] Naver 현재가 실패: ${e.message} → Yahoo 폴오버`);
    kc = await fetchYahooIndexCurrent(symbol);
  }
  const item = {
    id, name, symbol,
    price: r2(kc.current), prev_close: r2(kc.prevClose),
    change: r2(kc.change), change_pct: r4(kc.changePct),
    direction: direction(kc.change), source: kc.source, as_of: kc.asOf,
    category: '지수', history: [], ohlc_available: false, history_90d: [],
  };
  const tasks = [
    fetchIndexHistory(naverCode, 30)
      .then(h => { item.history = h; })
      .catch(async e => {
        console.warn(`[${id}] history Naver 실패: ${e.message} → Yahoo 30d 폴백`);
        item.history = await fetchYahooIndexDailyCloses(symbol, 30).catch(e2 => { console.warn(`[${id}] history Yahoo도 실패: ${e2.message}`); return []; });
      }),
  ];
  if (include90d) {
    tasks.push(
      fetchIndexHistory90d(naverCode, 15)
        .then(h => { item.history_90d = h; })
        .catch(async e => {
          console.warn(`[${id}] history_90d Naver 실패: ${e.message} → Yahoo 90d 폴백`);
          item.history_90d = await fetchYahooIndexDailyCloses(symbol, 90).catch(e2 => { console.warn(`[${id}] history_90d Yahoo도 실패: ${e2.message}`); return []; });
        })
    );
  }
  await Promise.allSettled(tasks);
  recalcChange(item);
  console.log(`[${id}] ${item.price.toLocaleString()}  ${sign(item.change)} (${sign(item.change_pct)}%)  hist=${item.history.length}  hist_90d=${item.history_90d.length}`);
  return item;
}

// ── 환율 공통 (Naver marketindexCd로 파라미터화: FX_USDKRW | FX_JPYKRW 등) ──
// perUnits: Frankfurter 폴백에서 "몇 단위당" 원화인지(원/엔은 100엔당 원화가 한국 관례 —
// Naver 페이지 자체가 "일본 JPY(100엔)"로 이미 그 기준으로 주므로, Frankfurter(1엔당)
// 폴백만 ×100 스케일이 필요하다. 2026-07-07 Naver 페이지 확인).
async function fetchExchangeCurrent(marketindexCd) {
  const html    = await fetchEucKR(
    `https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=${marketindexCd}&page=1`,
    { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' }
  );
  const matches = [...html.matchAll(/(\d{4}\.\d{2}\.\d{2})\s*<\/td>\s*<td[^>]*>\s*([\d,]+\.\d{2})/gs)];
  if (matches.length < 2) throw new Error(`환율 행 ${matches.length}개 (최소 2개 필요)`);
  const current = cleanNum(matches[0][2]), prevClose = cleanNum(matches[1][2]);
  return { current, prevClose, change: current - prevClose,
           changePct: prevClose ? (current - prevClose) / prevClose * 100 : 0,
           asOf: matches[0][1].replace(/\./g, '-') + ' (Naver 환율)', source: 'Naver환율' };
}

async function fetchFrankfurterCurrent(fromCcy, perUnits = 1) {
  const data  = await fetchJSON(`https://api.frankfurter.app/${daysAgo(7)}..${todayKST()}?from=${fromCcy}&to=KRW`);
  const rates = Object.entries(data.rates ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  if (rates.length < 2) throw new Error(`Frankfurter 데이터 부족: ${rates.length}포인트`);
  const current = rates.at(-1)[1].KRW * perUnits, prevClose = rates.at(-2)[1].KRW * perUnits;
  return { current, prevClose, change: current - prevClose,
           changePct: prevClose ? (current - prevClose) / prevClose * 100 : 0,
           asOf: fmtKST(), source: 'Frankfurter' };
}

async function fetchExchangeHistory(marketindexCd, numPages = 3) {
  const extra = { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' };
  const seen  = new Map();
  const pages = await Promise.all(
    Array.from({ length: numPages }, (_, i) =>
      fetchEucKR(`https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=${marketindexCd}&page=${i + 1}`, extra)
    )
  );
  for (const html of pages) {
    for (const m of html.matchAll(/(\d{4}\.\d{2}\.\d{2})\s*<\/td>\s*<td[^>]*>\s*([\d,]+\.\d{2})/gs)) {
      try { seen.set(m[1].replace(/\./g, '-'), r2(cleanNum(m[2]))); } catch { /* skip */ }
    }
  }
  if (seen.size === 0) throw new Error(`Naver 환율 history 없음(${marketindexCd})`);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, close]) => ({ date, close }));
}

async function fetchFrankfurterHistory(fromCcy, tradingDays = 30, perUnits = 1) {
  const calDays = Math.round(tradingDays * 1.8);
  const data    = await fetchJSON(`https://api.frankfurter.app/${daysAgo(calDays)}..${todayKST()}?from=${fromCcy}&to=KRW`);
  const rates   = Object.entries(data.rates ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-tradingDays);
  if (rates.length < 5) throw new Error(`Frankfurter history 부족: ${rates.length}행`);
  return rates.map(([date, v]) => ({ date, close: r2(v.KRW * perUnits) }));
}

// 원/달러·원/엔 공통 조립 — id/name/marketindexCd/fromCcy(Frankfurter 폴백용)/perUnits만 다르다.
async function buildExchangeItem({ id, name, symbol, marketindexCd, fromCcy, perUnits = 1 }, include90d, sign) {
  let cur;
  try {
    cur = await fetchExchangeCurrent(marketindexCd);
  } catch (e) {
    console.warn(`[${id}] Naver 실패: ${e.message} → Frankfurter 폴백`);
    cur = await fetchFrankfurterCurrent(fromCcy, perUnits);
  }
  const item = {
    id, name, symbol,
    price: r2(cur.current), prev_close: r2(cur.prevClose),
    change: r2(cur.change), change_pct: r4(cur.changePct),
    direction: direction(cur.change), source: cur.source, as_of: cur.asOf,
    category: '환율', history: [], ohlc_available: false, history_90d: [],
  };
  const tasks = [
    fetchExchangeHistory(marketindexCd, 3)
      .then(h => { if (h.length < 10) throw new Error(`포인트 부족: ${h.length}`); item.history = h; })
      .catch(async e => {
        console.warn(`[${id}] history Naver 실패: ${e.message} → Frankfurter 폴백`);
        item.history = await fetchFrankfurterHistory(fromCcy, 30, perUnits).catch(e2 => { console.warn(`[${id}] history 폴백도 실패: ${e2.message}`); return []; });
      }),
  ];
  if (include90d) {
    tasks.push(
      fetchExchangeHistory(marketindexCd, 9)
        .then(h => { if (h.length < 10) throw new Error(`포인트 부족: ${h.length}`); item.history_90d = h; })
        .catch(async e => {
          console.warn(`[${id}] history_90d Naver 실패: ${e.message} → Frankfurter 폴백`);
          item.history_90d = await fetchFrankfurterHistory(fromCcy, 90, perUnits).catch(e2 => { console.warn(`[${id}] history_90d 폴백도 실패: ${e2.message}`); return []; });
        })
    );
  }
  await Promise.allSettled(tasks);
  recalcChange(item);
  console.log(`[${id}] ${item.price.toLocaleString()}  ${sign(item.change)} (${sign(item.change_pct)}%)  hist=${item.history.length}  hist_90d=${item.history_90d.length}`);
  return item;
}

// ── 공통 ─────────────────────────────────────────────
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

export async function collectKR({ include90d = true } = {}) {
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);

  // 코스피·코스닥·원/달러·원/엔을 병렬로 수집 (순차 → 병렬: ~8-12s → ~4-6s)
  const [kospiResult, kosdaqResult, krwResult, jpyResult] = await Promise.allSettled([

    // ── 코스피 ─────────────────────────────────── (심볼은 symbol-map.js에 집약)
    buildIndexItem({ id: 'kospi', name: '코스피 (^KS11)', symbol: KR_INDEX_SYMBOLS.kospi.yahoo, naverCode: KR_INDEX_SYMBOLS.kospi.naverIndex }, include90d, sign),

    // ── 코스닥 ───────────────────────────────────────
    buildIndexItem({ id: 'kosdaq', name: '코스닥 (^KQ11)', symbol: KR_INDEX_SYMBOLS.kosdaq.yahoo, naverCode: KR_INDEX_SYMBOLS.kosdaq.naverIndex }, include90d, sign),

    // ── 원/달러 ──────────────────────────────────────
    buildExchangeItem({ id: 'usdkrw', name: '원/달러', symbol: 'USDKRW', marketindexCd: 'FX_USDKRW', fromCcy: 'USD' }, include90d, sign),

    // ── 원/엔(100엔) — Naver 자체가 100엔 기준으로 표기하므로 Frankfurter 폴백만 ×100 ──
    buildExchangeItem({ id: 'jpykrw', name: '원/엔(100엔)', symbol: 'JPYKRW', marketindexCd: 'FX_JPYKRW', fromCcy: 'JPY', perUnits: 100 }, include90d, sign),

  ]);

  const items = [];
  if (kospiResult.status === 'fulfilled') items.push(kospiResult.value);
  else console.error(`[kospi] 수집 실패: ${kospiResult.reason?.message}`);
  if (kosdaqResult.status === 'fulfilled') items.push(kosdaqResult.value);
  else console.error(`[kosdaq] 수집 실패: ${kosdaqResult.reason?.message}`);
  if (krwResult.status === 'fulfilled') items.push(krwResult.value);
  else console.error(`[usdkrw] 수집 실패: ${krwResult.reason?.message}`);
  if (jpyResult.status === 'fulfilled') items.push(jpyResult.value);
  else console.error(`[jpykrw] 수집 실패: ${jpyResult.reason?.message}`);

  return items;
}
