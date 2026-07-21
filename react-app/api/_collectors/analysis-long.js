/**
 * _collectors/analysis-long.js — 분석 탭 전용 장기 히스토리 (목표 250 거래일)
 * api/analysis.js 및 scripts/test-long-data.js에서 공용
 */

import { trackedFetch } from '../_lib/health.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

function r2(n) { return Math.round(n * 100) / 100; }
function cleanNum(s) { return parseFloat(String(s).replace(/,/g, '').replace(/%/g, '').trim()); }
function tsToDate(tsMs) { return new Date(tsMs).toISOString().slice(0, 10); }

async function fetchJSON(url) {
  const res = await trackedFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await trackedFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.text();
}

async function fetchEucKR(url, extraHeaders = {}) {
  const res = await trackedFetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return new TextDecoder('euc-kr').decode(await res.arrayBuffer());
}

// ── Naver World API 멀티페이지 (DJI / VIX / IXIC 시도용) ─
async function fetchNaverWorldLong(symbol, totalRows = 250) {
  const pageSize = 60;
  const numPages = Math.ceil(totalRows / pageSize) + 1; // 여유 1페이지
  const pages = await Promise.all(
    Array.from({ length: numPages }, (_, i) =>
      fetchJSON(
        `https://api.stock.naver.com/index/${encodeURIComponent(symbol)}/price?pageSize=${pageSize}&page=${i + 1}`
      ).catch(() => [])
    )
  );
  const seen = new Map();
  for (const rows of pages) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const date = r.localTradedAt?.slice(0, 10);
      const val  = cleanNum(r.closePrice ?? '0');
      if (date && !isNaN(val) && val > 0) seen.set(date, r2(val));
    }
  }
  if (seen.size < 10) throw new Error(`Naver World ${symbol}: 데이터 부족 ${seen.size}행`);
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-totalRows)
    .map(([date, close]) => ({ date, close }));
}

// ── Naver sise 멀티페이지 (나스닥 폴백) ──────────────────
async function fetchNaverSiseLong(naverSymbol, numPages = 25) {
  const extra = { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' };
  const seen  = new Map();
  const pat   = /<tr[^>]*>\s*<td[^>]*>\s*(\d{4}\.\d{2}\.\d{2})\s*<\/td>\s*<td[^>]*>\s*<span[^>]*>\s*([\d,]+\.?\d*)\s*<\/span>/gs;
  const texts = await Promise.all(
    Array.from({ length: numPages }, (_, i) =>
      fetchEucKR(
        `https://finance.naver.com/world/sise.naver?symbol=${encodeURIComponent(naverSymbol)}&page=${i + 1}`,
        extra
      ).catch(() => '')
    )
  );
  for (const text of texts) {
    for (const m of text.matchAll(pat)) {
      try { seen.set(m[1].replace(/\./g, '-'), r2(cleanNum(m[2]))); } catch { /* skip */ }
    }
  }
  if (seen.size < 10) throw new Error(`Naver sise ${naverSymbol}: 파싱 실패 ${seen.size}행`);
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-250)
    .map(([date, close]) => ({ date, close }));
}

// ── FRED CSV (다우 폴백) ───────────────────────────────────
async function fetchFREDLong(fredId, numRows = 250) {
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
  if (rows.length < 10) throw new Error(`FRED ${fredId} 부족: ${rows.length}행`);
  return rows;
}

// ─────────────────────────────────────────────────────────
// 공개 함수: 각각 { history, ohlc_available, source } 반환
// ─────────────────────────────────────────────────────────

// BTC: Binance 250일 OHLC → CoinGecko 1년 close-only
// Binance는 data-api.binance.vision(CDN, Vercel 지역차단 없음) 우선, api.binance.com은
// 폴백 — btc-intraday.js와 동일 체인. 예전엔 api.binance.com 직격이라 Vercel에서 451/403로
// 매번 실패해 불필요한 CoinGecko 백업콜을 유발했다.
export async function fetchLongBTC() {
  try {
    const path = '/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=250';
    let raw;
    try {
      raw = await fetchJSON(`https://data-api.binance.vision${path}`);
    } catch (ve) {
      console.warn(`[analysis/btc] binance.vision 실패: ${ve.message} → api.binance.com`);
      raw = await fetchJSON(`https://api.binance.com${path}`);
    }
    if (!Array.isArray(raw) || raw.length < 10) throw new Error(`Binance 행 부족: ${raw.length}`);
    const history = raw.map(k => ({
      date:   tsToDate(Number(k[0])),
      open:   r2(parseFloat(k[1])),
      high:   r2(parseFloat(k[2])),
      low:    r2(parseFloat(k[3])),
      close:  r2(parseFloat(k[4])),
      volume: r2(parseFloat(k[5])),
    }));
    return { history, ohlc_available: true, source: 'Binance' };
  } catch (e) {
    console.warn(`[analysis/btc] Binance 실패: ${e.message} → CoinGecko 폴백`);
    const data = await fetchJSON(
      'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily'
    );
    const seen = new Map();
    for (const [tsMs, price] of data.prices) seen.set(tsToDate(tsMs), r2(price));
    const history = [...seen.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(-250)
      .map(([date, close]) => ({ date, close }));
    if (history.length < 10) throw new Error(`CoinGecko 부족: ${history.length}행`);
    return { history, ohlc_available: false, source: 'CoinGecko' };
  }
}

// 나스닥: Naver World .IXIC 멀티페이지 → Naver sise NAS@IXIC 25페이지
export async function fetchLongNasdaq() {
  try {
    const history = await fetchNaverWorldLong('.IXIC', 250);
    return { history, ohlc_available: false, source: 'Naver World .IXIC' };
  } catch (e) {
    console.warn(`[analysis/nasdaq] Naver World .IXIC 실패: ${e.message} → sise 폴백`);
    const history = await fetchNaverSiseLong('NAS@IXIC', 25);
    return { history, ohlc_available: false, source: 'Naver sise NAS@IXIC' };
  }
}

// 다우: Naver World .DJI 멀티페이지 → FRED DJIA
export async function fetchLongDow() {
  try {
    const history = await fetchNaverWorldLong('.DJI', 250);
    return { history, ohlc_available: false, source: 'Naver World .DJI' };
  } catch (e) {
    console.warn(`[analysis/dow] Naver World 실패: ${e.message} → FRED 폴백`);
    const history = await fetchFREDLong('DJIA', 250);
    return { history, ohlc_available: false, source: 'FRED DJIA' };
  }
}

// VIX: CBOE CDN CSV (전체 히스토리 제공, 250행 슬라이스)
export async function fetchLongVIX() {
  const text = await fetchText(
    'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv'
  );
  const rows = text.trim().split('\n').slice(1)
    .map(line => {
      const parts = line.split(',');
      if (parts.length < 5) return null;
      const [mm, dd, yyyy] = parts[0].trim().split('/');
      if (!yyyy) return null;
      const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
      const val = parseFloat(parts[4].trim());
      return isNaN(val) || val <= 0 ? null : { date: iso, close: r2(val) };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-250);
  if (rows.length < 10) throw new Error(`CBOE VIX 부족: ${rows.length}행`);
  return { history: rows, ohlc_available: false, source: 'CBOE CDN CSV' };
}

// KOSPI: Naver 모바일 API pageSize=250 → sise_index_day 40페이지 폴백
export async function fetchLongKOSPI() {
  try {
    const rows = await fetchJSON(
      'https://m.stock.naver.com/api/index/KOSPI/price?pageSize=250'
    );
    if (!Array.isArray(rows) || rows.length < 10)
      throw new Error(`API 응답 부족: ${rows?.length ?? 0}행`);
    const history = rows
      .filter(r => r.localTradedAt && r.closePrice)
      .map(r => ({ date: r.localTradedAt, close: r2(cleanNum(r.closePrice)) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(-250);
    if (history.length < 10) throw new Error(`파싱 후 부족: ${history.length}행`);
    return { history, ohlc_available: false, source: 'Naver mobile API' };
  } catch (e) {
    console.warn(`[analysis/kospi] API 실패: ${e.message} → sise_index_day 폴백`);
    const extra = { Accept: 'text/html,*/*', Referer: 'https://finance.naver.com/' };
    const seen  = new Map();
    const texts = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        fetchEucKR(
          `https://finance.naver.com/sise/sise_index_day.naver?code=KOSPI&page=${i + 1}`,
          extra
        ).catch(() => '')
      )
    );
    for (const html of texts) {
      for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
        const dm = tr.match(/class="date"[^>]*>\s*(\d{4}\.\d{2}\.\d{2})/);
        if (!dm) continue;
        const cm = tr.match(/class="number_1"[^>]*>\s*([\d,]+\.\d{2})\s*<\/td>/);
        if (!cm) continue;
        try {
          const v = cleanNum(cm[1]);
          if (v > 100 && v < 20_000) seen.set(dm[1].replace(/\./g, '-'), r2(v));
        } catch { /* skip */ }
      }
    }
    if (seen.size < 10) throw new Error(`sise_index_day 파싱 실패: ${seen.size}행`);
    const history = [...seen.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(-250)
      .map(([date, close]) => ({ date, close }));
    return { history, ohlc_available: false, source: 'Naver sise_index_day' };
  }
}

// USD/KRW: Frankfurter 250 거래일 (1.8 × 250 ≈ 450 달력일)
export async function fetchLongUSDKRW() {
  const tradingDays = 250;
  const calDays     = Math.round(tradingDays * 1.8);
  const start       = new Date(Date.now() - calDays * 86400_000).toISOString().slice(0, 10);
  const today       = new Date().toISOString().slice(0, 10);
  const data        = await fetchJSON(
    `https://api.frankfurter.app/${start}..${today}?from=USD&to=KRW`
  );
  const rates = Object.entries(data.rates ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-tradingDays);
  if (rates.length < 10) throw new Error(`Frankfurter 부족: ${rates.length}행`);
  return {
    history: rates.map(([date, v]) => ({ date, close: r2(v.KRW) })),
    ohlc_available: false,
    source: 'Frankfurter',
  };
}
