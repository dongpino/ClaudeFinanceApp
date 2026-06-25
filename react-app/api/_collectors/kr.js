/**
 * _collectors/kr.js — 코스피/원달러 수집 (Vercel 서버리스 전용)
 * data-collector-js/fetch-kr.js의 collectKR 로직과 동일.
 */

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
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function fetchEucKR(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return new TextDecoder('euc-kr').decode(await res.arrayBuffer());
}

// ── 코스피 ────────────────────────────────────────────
async function fetchKOSPICurrent() {
  const rows = await fetchJSON('https://m.stock.naver.com/api/index/KOSPI/price');
  if (rows.length < 2) throw new Error(`Naver 응답 행 부족: ${rows.length}`);
  const current   = cleanNum(rows[0].closePrice);
  const prevClose = cleanNum(rows[1].closePrice);
  return { current, prevClose, change: current - prevClose,
           changePct: prevClose ? (current - prevClose) / prevClose * 100 : 0,
           asOf: rows[0].localTradedAt + ' (Naver 종가)', source: 'Naver' };
}

async function fetchKOSPIHistory(pageSize = 30) {
  const rows = await fetchJSON(`https://m.stock.naver.com/api/index/KOSPI/price?pageSize=${pageSize}`);
  const result = rows.filter(r => r.localTradedAt && r.closePrice)
    .map(r => ({ date: r.localTradedAt, close: r2(cleanNum(r.closePrice)) }));
  if (result.length < 5) throw new Error(`KOSPI history 부족: ${result.length}행`);
  return result.sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function fetchKOSPIHistory90d(numPages = 15) {
  const extra = { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' };
  const seen  = new Map();
  for (let page = 1; page <= numPages; page++) {
    const html = await fetchEucKR(
      `https://finance.naver.com/sise/sise_index_day.naver?code=KOSPI&page=${page}`, extra
    );
    for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const dm = tr.match(/class="date"[^>]*>\s*(\d{4}\.\d{2}\.\d{2})/);
      if (!dm) continue;
      const cm = tr.match(/class="number_1"[^>]*>\s*([\d,]+\.\d{2})\s*<\/td>/);
      if (!cm) continue;
      try { const v = cleanNum(cm[1]); if (v > 100 && v < 20_000) seen.set(dm[1].replace(/\./g, '-'), r2(v)); }
      catch { /* skip */ }
    }
  }
  if (seen.size < 5) throw new Error(`sise_index_day 파싱 실패: ${seen.size}행`);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-90).map(([date, close]) => ({ date, close }));
}

// ── 원/달러 ──────────────────────────────────────────
async function fetchUSDKRWCurrent() {
  const html    = await fetchEucKR(
    'https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=FX_USDKRW&page=1',
    { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' }
  );
  const matches = [...html.matchAll(/(\d{4}\.\d{2}\.\d{2})\s*<\/td>\s*<td[^>]*>\s*([\d,]+\.\d{2})/gs)];
  if (matches.length < 2) throw new Error(`환율 행 ${matches.length}개 (최소 2개 필요)`);
  const current = cleanNum(matches[0][2]), prevClose = cleanNum(matches[1][2]);
  return { current, prevClose, change: current - prevClose,
           changePct: prevClose ? (current - prevClose) / prevClose * 100 : 0,
           asOf: matches[0][1].replace(/\./g, '-') + ' (Naver 환율)', source: 'Naver환율' };
}

async function fetchFrankfurterCurrent() {
  const data  = await fetchJSON(`https://api.frankfurter.app/${daysAgo(7)}..${todayKST()}?from=USD&to=KRW`);
  const rates = Object.entries(data.rates ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  if (rates.length < 2) throw new Error(`Frankfurter 데이터 부족: ${rates.length}포인트`);
  const current = rates.at(-1)[1].KRW, prevClose = rates.at(-2)[1].KRW;
  return { current, prevClose, change: current - prevClose,
           changePct: prevClose ? (current - prevClose) / prevClose * 100 : 0,
           asOf: fmtKST(), source: 'Frankfurter' };
}

async function fetchUSDKRWHistory(numPages = 3) {
  const extra = { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' };
  const seen  = new Map();
  for (let page = 1; page <= numPages; page++) {
    const html = await fetchEucKR(
      `https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=FX_USDKRW&page=${page}`, extra
    );
    for (const m of html.matchAll(/(\d{4}\.\d{2}\.\d{2})\s*<\/td>\s*<td[^>]*>\s*([\d,]+\.\d{2})/gs)) {
      try { seen.set(m[1].replace(/\./g, '-'), r2(cleanNum(m[2]))); } catch { /* skip */ }
    }
  }
  if (seen.size === 0) throw new Error('Naver 환율 history: 데이터 없음');
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, close]) => ({ date, close }));
}

async function fetchFrankfurterHistory(tradingDays = 30) {
  const calDays = Math.round(tradingDays * 1.8);
  const data    = await fetchJSON(`https://api.frankfurter.app/${daysAgo(calDays)}..${todayKST()}?from=USD&to=KRW`);
  const rates   = Object.entries(data.rates ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).slice(-tradingDays);
  if (rates.length < 5) throw new Error(`Frankfurter history 부족: ${rates.length}행`);
  return rates.map(([date, v]) => ({ date, close: r2(v.KRW) }));
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

export async function collectKR() {
  const sign  = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  const items = [];

  // ── 코스피 (단독 격리) ───────────────────────────
  try {
    const kc    = await fetchKOSPICurrent();
    const kospi = {
      id: 'kospi', name: '코스피 (^KS11)', symbol: '^KS11',
      price: r2(kc.current), prev_close: r2(kc.prevClose),
      change: r2(kc.change), change_pct: r4(kc.changePct),
      direction: direction(kc.change), source: kc.source, as_of: kc.asOf,
      category: '지수', history: [], ohlc_available: false, history_90d: [],
    };

    await Promise.allSettled([
      fetchKOSPIHistory(30).then(h => { kospi.history = h; }).catch(e => console.warn(`[kospi] history 실패: ${e.message}`)),
      fetchKOSPIHistory90d(15).then(h => { kospi.history_90d = h; }).catch(e => console.warn(`[kospi] history_90d 실패: ${e.message}`)),
    ]);

    recalcChange(kospi);
    console.log(`[kospi] ${kospi.price.toLocaleString()}  ${sign(kospi.change)} (${sign(kospi.change_pct)}%)  hist=${kospi.history.length}  hist_90d=${kospi.history_90d.length}`);
    items.push(kospi);
  } catch (e) {
    console.error(`[kospi] 수집 실패: ${e.message}`);
  }

  // ── 원/달러 (단독 격리) ──────────────────────────
  try {
    let krc;
    try {
      krc = await fetchUSDKRWCurrent();
    } catch (e) {
      console.warn(`[usdkrw] Naver 실패: ${e.message} → Frankfurter 폴백`);
      krc = await fetchFrankfurterCurrent();
    }

    const krw = {
      id: 'usdkrw', name: '원/달러', symbol: 'USDKRW',
      price: r2(krc.current), prev_close: r2(krc.prevClose),
      change: r2(krc.change), change_pct: r4(krc.changePct),
      direction: direction(krc.change), source: krc.source, as_of: krc.asOf,
      category: '환율', history: [], ohlc_available: false, history_90d: [],
    };

    await Promise.allSettled([
      fetchUSDKRWHistory(3)
        .then(h => { if (h.length < 10) throw new Error(`포인트 부족: ${h.length}`); krw.history = h; })
        .catch(async e => {
          console.warn(`[usdkrw] history Naver 실패: ${e.message} → Frankfurter 폴백`);
          krw.history = await fetchFrankfurterHistory(30).catch(e2 => { console.warn(`[usdkrw] history 폴백도 실패: ${e2.message}`); return []; });
        }),
      fetchUSDKRWHistory(9)
        .then(h => { if (h.length < 10) throw new Error(`포인트 부족: ${h.length}`); krw.history_90d = h; })
        .catch(async e => {
          console.warn(`[usdkrw] history_90d Naver 실패: ${e.message} → Frankfurter 폴백`);
          krw.history_90d = await fetchFrankfurterHistory(90).catch(e2 => { console.warn(`[usdkrw] history_90d 폴백도 실패: ${e2.message}`); return []; });
        }),
    ]);

    recalcChange(krw);
    console.log(`[usdkrw] ${krw.price.toLocaleString()}  ${sign(krw.change)} (${sign(krw.change_pct)}%)  hist=${krw.history.length}  hist_90d=${krw.history_90d.length}`);
    items.push(krw);
  } catch (e) {
    console.error(`[usdkrw] 수집 실패: ${e.message}`);
  }

  return items;
}
