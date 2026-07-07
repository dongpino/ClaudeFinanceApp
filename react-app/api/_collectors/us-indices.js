/**
 * _collectors/us-indices.js — 나스닥/다우/VIX/미국채10년/DXY 수집 (Vercel 서버리스 전용)
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
    symbols: '.IXIC|.DJI|.VIX|US10Y|.DXY', requestMethod: 'itv',
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

// unit: 'percent'면 값 자체가 %(예: 국채 금리) — 카드에서 "4.25%" / 등락 "+0.2bp"로 표시,
// 다른 카드의 등락률(%)과 혼동되지 않도록 change_pct는 표시하지 않는다(MarketCard/DetailPage 참고).
// percent 종목은 change를 r2(소수 2자리)로 반올림하면 0.01%p 미만의 실제 변동(예: +0.002%p)이
// 0으로 뭉개져 "계산 실패"로 오인되므로(us10y 사례), r4(소수 4자리)로 정밀도를 보존한다.
function buildItemFromCNBC(q, { id, name, symbol, category, unit }) {
  const current   = cleanNum(q.last);
  const prevClose = cleanNum(q.previous_day_closing);
  const change    = current - prevClose;
  const changePct = prevClose !== 0 ? change / prevClose * 100 : 0;
  return {
    id, name, symbol,
    price:          r2(current),
    prev_close:     r2(prevClose),
    change:         unit === 'percent' ? r4(change) : r2(change),
    change_pct:     r4(changePct),
    direction:      direction(change),
    source:         'CNBC',
    as_of:          fmtKST(),
    category,
    unit,
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
  const today = new Date().toISOString().slice(0, 10);
  const past  = new Date(Date.now() - Math.round(numRows * 1.8) * 86400_000).toISOString().slice(0, 10);
  const text  = await fetchText(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${fredId}&observation_start=${past}&observation_end=${today}`
  );
  const rows = text.trim().split('\n').slice(1)
    .map(line => { const [date, val] = line.split(','); return { date: date?.trim(), val: val?.trim() }; })
    .filter(r => r.date && r.val && r.val !== '.' && r.val !== '')
    .slice(-numRows)
    .map(r => ({ date: r.date, close: r2(parseFloat(r.val)) }));
  if (rows.length < 5) throw new Error(`FRED ${fredId} 데이터 부족: ${rows.length}행`);
  return rows;
}

// CBOE VIX 공식 CDN CSV — 네이버 장애 시 VIX history 독립 백업
// CDN 호스팅으로 IP 차단 없음, 오늘자 데이터 제공
async function fetchHistoryCBOEVIX(numRows = 30) {
  const text = await fetchText('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv');
  const rows = text.trim().split('\n').slice(1)
    .map(line => {
      const parts = line.split(',');
      if (parts.length < 5) return null;
      const [mm, dd, yyyy] = parts[0].trim().split('/');
      if (!yyyy) return null;
      const iso  = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
      const val  = parseFloat(parts[4].trim()); // CLOSE column
      return isNaN(val) || val <= 0 ? null : { date: iso, close: r2(val) };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-numRows);
  if (rows.length < 5) throw new Error(`CBOE VIX CSV 데이터 부족: ${rows.length}행`);
  return rows;
}

// Naver World Index API (api.stock.naver.com) — DJI/VIX 히스토리 소스
// pageSize 최대 60 제한
async function fetchHistoryNaverWorld(symbol, numRows = 30) {
  // API max pageSize=60; 90d 요청도 pageSize=60(≈ 60 거래일 ≈ 84 달력일)으로 충분
  const pageSize = Math.min(numRows, 60);
  const rows = await fetchJSON(
    `https://api.stock.naver.com/index/${encodeURIComponent(symbol)}/price?pageSize=${pageSize}&page=1`
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`Naver world ${symbol} 데이터 없음`);
  return rows
    .map(r => ({ date: r.localTradedAt.slice(0, 10), close: r2(cleanNum(r.closePrice)) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));  // API는 최신순 → 날짜 오름차순 정렬
}

// Naver Market Index API(m.stock.naver.com) — 환율/채권 등 category+reutersCode 기반 시세.
// 미 10년물 금리(category=bond, reutersCode=US10YT=RR)와 DXY(category=exchange,
// reutersCode=FX_USDX) 히스토리 소스. pageSize 10~60 제한(60 초과 요청 시 400 응답).
async function fetchHistoryNaverMarketIndex(category, reutersCode, numRows = 30) {
  const pageSize = Math.max(10, Math.min(numRows, 60));
  const data = await fetchJSON(
    `https://m.stock.naver.com/front-api/marketIndex/prices?page=1&pageSize=${pageSize}` +
    `&category=${category}&reutersCode=${encodeURIComponent(reutersCode)}`
  );
  const rows = data?.result;
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`Naver marketIndex ${category}/${reutersCode} 데이터 없음`);
  return rows
    .map(r => ({ date: r.localTradedAt.slice(0, 10), close: r2(cleanNum(r.closePrice)) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function recalcChange(item) {
  // percent 단위(국채금리 등)는 CNBC 원본을 r4로 이미 정밀 보존했으므로 history 폴백을 타지 않는다.
  // 국채금리는 하루 변동이 0.01%p 미만인 날이 흔해 이 임계값(과 history 기반 재계산)이
  // "정상적으로 작은 변동"을 "CNBC 값 의심"으로 오인시키기 때문(us10y 사례).
  if (item.unit === 'percent') return;
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
  // CNBC bulk (실패 시 5종목 전체 실패 — 같은 API 공유)
  const cnbc   = await fetchCNBCBulk();
  const nasdaq = buildItemFromCNBC(cnbc['.IXIC'],  { id: 'nasdaq', name: '나스닥 (^IXIC)',        symbol: '^IXIC', category: '지수' });
  const dow    = buildItemFromCNBC(cnbc['.DJI'],   { id: 'dow',    name: '다우존스 (^DJI)',        symbol: '^DJI',  category: '지수' });
  const vix    = buildItemFromCNBC(cnbc['.VIX'],   { id: 'vix',    name: 'VIX 공포지수',           symbol: '^VIX',  category: '지수' });
  const us10y  = buildItemFromCNBC(cnbc['US10Y'],  { id: 'us10y',  name: '미국 10년물 국채금리',   symbol: 'US10Y', category: '매크로', unit: 'percent' });
  const dxy    = buildItemFromCNBC(cnbc['.DXY'],   { id: 'dxy',    name: '달러인덱스 (DXY)',       symbol: '.DXY',  category: '매크로' });

  // history 30일 (per-item isolation)
  // Dow  : Naver World → FRED DJIA (로컬 확인, Vercel 불확실)
  // VIX  : Naver World → CBOE CDN CSV (완전 독립, Vercel 확인됨)
  // US10Y/DXY : Naver Market Index API(m.stock.naver.com) — 단일 소스, 폴백 없음(다른 지표와 동일 수준)
  await Promise.allSettled([
    fetchHistoryNaverSise('NAS@IXIC', 3)
      .then(h => { nasdaq.history = h; })
      .catch(e => console.warn(`[nasdaq] history 실패: ${e.message}`)),

    fetchHistoryNaverWorld('.DJI', 30)
      .catch(e => { console.warn(`[dow] Naver world 실패: ${e.message} → FRED 폴백`); return fetchHistoryFRED('DJIA', 30); })
      .then(h => { dow.history = h; })
      .catch(e => console.warn(`[dow] history 실패: ${e.message}`)),

    fetchHistoryNaverWorld('.VIX', 30)
      .catch(e => { console.warn(`[vix] Naver world 실패: ${e.message} → CBOE CSV 폴백`); return fetchHistoryCBOEVIX(30); })
      .then(h => { vix.history = h; })
      .catch(e => console.warn(`[vix] history 실패: ${e.message}`)),

    fetchHistoryNaverMarketIndex('bond', 'US10YT=RR', 30)
      .then(h => { us10y.history = h; })
      .catch(e => console.warn(`[us10y] history 실패: ${e.message}`)),

    fetchHistoryNaverMarketIndex('exchange', 'FX_USDX', 30)
      .then(h => { dxy.history = h; })
      .catch(e => console.warn(`[dxy] history 실패: ${e.message}`)),
  ]);

  // history_90d — 상세 요청 시에만 수집 (US10Y/DXY는 Naver marketIndex pageSize 상한 60으로 대체)
  if (include90d) {
    await Promise.allSettled([
      fetchHistoryNaverSise('NAS@IXIC', 9)
        .then(h => { nasdaq.history_90d = h; })
        .catch(e => console.warn(`[nasdaq] history_90d 실패: ${e.message}`)),

      fetchHistoryNaverWorld('.DJI', 90)
        .catch(e => { console.warn(`[dow] Naver world 90d 실패: ${e.message} → FRED 폴백`); return fetchHistoryFRED('DJIA', 90); })
        .then(h => { dow.history_90d = h; })
        .catch(e => console.warn(`[dow] history_90d 실패: ${e.message}`)),

      fetchHistoryNaverWorld('.VIX', 90)
        .catch(e => { console.warn(`[vix] Naver world 90d 실패: ${e.message} → CBOE CSV 폴백`); return fetchHistoryCBOEVIX(90); })
        .then(h => { vix.history_90d = h; })
        .catch(e => console.warn(`[vix] history_90d 실패: ${e.message}`)),

      fetchHistoryNaverMarketIndex('bond', 'US10YT=RR', 60)
        .then(h => { us10y.history_90d = h; })
        .catch(e => console.warn(`[us10y] history_90d 실패: ${e.message}`)),

      fetchHistoryNaverMarketIndex('exchange', 'FX_USDX', 60)
        .then(h => { dxy.history_90d = h; })
        .catch(e => console.warn(`[dxy] history_90d 실패: ${e.message}`)),
    ]);
  }

  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  for (const it of [nasdaq, dow, vix, us10y, dxy]) {
    recalcChange(it);
    console.log(`[${it.id}] ${it.price.toLocaleString()}  ${sign(it.change)} (${sign(it.change_pct)}%)  hist=${it.history.length}  hist_90d=${it.history_90d.length}`);
  }

  return [nasdaq, dow, vix, us10y, dxy];
}
