/**
 * _collectors/us-indices.js — 나스닥/다우/VIX 수집 (Vercel 서버리스 전용)
 * data-collector-js/fetch-us-indices.js의 collectUSIndices 로직과 동일.
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

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.text();
}

async function fetchCNBCBulk() {
  const params = new URLSearchParams({
    symbols: '.IXIC|.DJI|.VIX', requestMethod: 'itv',
    noform: '1', partnerId: '2', fund: '1', exthrs: '1', output: 'json', events: '0',
  });
  const data = await fetchJSON(`https://quote.cnbc.com/quote-html-webservice/quote.htm?${params}`);
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
  return {
    id, name, symbol,
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

async function fetchHistoryNaverSise(naverSymbol, numPages = 3) {
  const extra = { Accept: 'text/html,application/xhtml+xml,*/*', Referer: 'https://finance.naver.com/' };
  const seen  = new Map();
  const pat   = /<tr[^>]*>\s*<td[^>]*>\s*(\d{4}\.\d{2}\.\d{2})\s*<\/td>\s*<td[^>]*>\s*<span[^>]*>\s*([\d,]+\.?\d*)\s*<\/span>/gs;
  const pages = await Promise.all(
    Array.from({ length: numPages }, (_, i) =>
      fetchEucKR(`https://finance.naver.com/world/sise.naver?symbol=${encodeURIComponent(naverSymbol)}&page=${i + 1}`, extra)
    )
  );
  for (const text of pages) {
    for (const m of text.matchAll(pat)) {
      try { seen.set(m[1].replace(/\./g, '-'), r2(cleanNum(m[2]))); } catch { /* skip */ }
    }
  }
  if (seen.size === 0) throw new Error(`Naver sise 파싱 결과 없음 (symbol=${naverSymbol})`);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, close]) => ({ date, close }));
}

async function fetchHistoryFRED(fredId, numRows = 90) {
  const text = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${fredId}`);
  const rows  = text.trim().split('\n').slice(1)
    .map(line => { const [date, val] = line.split(','); return { date: date?.trim(), val: val?.trim() }; })
    .filter(r => r.date && r.val && r.val !== '.' && r.val !== '')
    .slice(-numRows)
    .map(r => ({ date: r.date, close: r2(parseFloat(r.val)) }));
  if (rows.length < 5) throw new Error(`FRED ${fredId} 데이터 부족: ${rows.length}행`);
  return rows;
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

export async function collectUSIndices({ include90d = true } = {}) {
  // CNBC bulk (실패 시 3종목 전체 실패 — 같은 API 공유)
  const cnbc   = await fetchCNBCBulk();
  const nasdaq = buildItemFromCNBC(cnbc['.IXIC'], { id: 'nasdaq', name: '나스닥 (^IXIC)', symbol: '^IXIC', category: '지수' });
  const dow    = buildItemFromCNBC(cnbc['.DJI'],  { id: 'dow',    name: '다우존스 (^DJI)', symbol: '^DJI',  category: '지수' });
  const vix    = buildItemFromCNBC(cnbc['.VIX'],  { id: 'vix',    name: 'VIX 공포지수',    symbol: '^VIX',  category: '지수' });

  // history 30일 (per-item isolation)
  await Promise.allSettled([
    fetchHistoryNaverSise('NAS@IXIC', 3).then(h => { nasdaq.history = h; }).catch(e => console.warn(`[nasdaq] history 실패: ${e.message}`)),
    fetchHistoryFRED('DJIA',   30).then(h => { dow.history   = h; }).catch(e => console.warn(`[dow] history 실패: ${e.message}`)),
    fetchHistoryFRED('VIXCLS', 30).then(h => { vix.history   = h; }).catch(e => console.warn(`[vix] history 실패: ${e.message}`)),
  ]);

  // history_90d — 상세 요청 시에만 수집
  if (include90d) {
    await Promise.allSettled([
      fetchHistoryNaverSise('NAS@IXIC', 9).then(h => { nasdaq.history_90d = h; }).catch(e => console.warn(`[nasdaq] history_90d 실패: ${e.message}`)),
      fetchHistoryFRED('DJIA',   90).then(h => { dow.history_90d   = h; }).catch(e => console.warn(`[dow] history_90d 실패: ${e.message}`)),
      fetchHistoryFRED('VIXCLS', 90).then(h => { vix.history_90d   = h; }).catch(e => console.warn(`[vix] history_90d 실패: ${e.message}`)),
    ]);
  }

  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  for (const it of [nasdaq, dow, vix]) {
    recalcChange(it);
    console.log(`[${it.id}] ${it.price.toLocaleString()}  ${sign(it.change)} (${sign(it.change_pct)}%)  hist=${it.history.length}  hist_90d=${it.history_90d.length}`);
  }

  return [nasdaq, dow, vix];
}
