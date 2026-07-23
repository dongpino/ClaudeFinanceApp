/**
 * _collectors/daum-stock.js — 개별 KR 종목 현재가/일봉 라이브 폴오버 (Naver 장애 시)
 *
 * naver-stock.js의 개별종목 엔드포인트(m.stock.naver.com/api/stock/*)가 실패하면
 * Daum 금융 API로 대체한다. yahoo-index.js(지수 편)·crypto-ticker.js와 동일한
 * "타 소스 응답을 네이버 스키마로 정규화하는 어댑터" 패턴 — 호출측(fetchOneKRQuote/
 * fetchKRDailyHistory)이 소스 전환을 몰라도 되게 fetchOneKRQuote/fetchKRDailyHistory와
 * 동형 객체를 반환한다.
 *
 * 각 fetch는 trackedFetch라 health에 자동 집계된다(finance.daum.net → 'daum').
 * → 폴오버 발동 시 상태판에서 "naver 빨강 + daum 초록"으로 자연히 읽힘.
 *
 * ── 필드 매핑(로컬 실측 2026-07-23 확정) ─────────────────────────────
 *   현재가  price      = quote.tradePrice
 *   전일종가 prev_close = quote.prevClosingPrice   (Daum이 직접 제공)
 *   등락/율 change/pct  = tradePrice - prevClosingPrice 에서 직접 파생
 *                        (Daum changePrice는 부호 없음, changeRate는 분수 — 미사용)
 *   종목명  name        = quote.name
 *   장상태  marketStatus= DAUM_STATUS_MAP 정규화(아래)
 *   OHLC    history     = charts/days 의 openingPrice/highPrice/lowPrice/tradePrice/
 *                        candleAccTradeVolume, date(이미 YYYY-MM-DD)
 *
 * ── Daum 필수 헤더 ───────────────────────────────────────────────────
 *   Referer(종목별) 없으면 403. 차트는 X-Requested-With: XMLHttpRequest 추가 필요.
 */

import { trackedFetch } from '../_lib/health.js';
import { krStockSymbol } from '../_lib/symbol-map.js';

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};
const TIMEOUT_MS = 8000;

function r2(n) { return Math.round(n * 100) / 100; }
function direction(pct) { return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'; }

// Daum marketStatus → 네이버 토큰. 다운스트림(MarketCard.detectIssues)은 'PREOPEN'만
// 의미있게 본다(장전 0변동 오탐 억제). 실측 확인된 값만 매핑하고, 미지 토큰은 null 취급
// → PREOPEN 판정 미발동(오동작 방지). 장전 토큰은 프로브 실측 후 한 줄 추가.
const DAUM_STATUS_MAP = {
  REGULAR_HOURS: 'REGULAR_HOURS', // 장중 (실측 확인)
  // TODO(프로브 08:30~09:00 KST 실측): Daum 장전 토큰 → 'PREOPEN', 장마감 토큰 → 확정 후 추가
};
function normalizeStatus(s) { return DAUM_STATUS_MAP[s] ?? null; }

// 종목별 Referer(무결 시 403). 차트는 X-Requested-With 추가.
function daumHeaders(daumSymbol, { chart = false } = {}) {
  return {
    ...UA,
    Referer: `https://finance.daum.net/quotes/${daumSymbol}`,
    ...(chart ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
  };
}

async function fetchJSON(url, headers) {
  const res = await trackedFetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

/**
 * 현재가 폴오버 — naver-stock.js fetchOneKRQuote와 동형 아이템 반환.
 * @param {string} code — 6자리 종목코드(예: '005930')
 * @returns {Promise<object>} { id, symbol, name, price, prev_close, change, change_pct, direction, sparkline, category, source:'Daum', marketStatus }
 */
export async function fetchDaumQuote(code) {
  const sym  = krStockSymbol(code, 'daum'); // 005930 → A005930
  const data = await fetchJSON(
    `https://finance.daum.net/api/quotes/${sym}?summary=false&changeStatistics=true`,
    daumHeaders(sym)
  );
  const price     = Number(data.tradePrice);
  const prevClose = Number(data.prevClosingPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Daum ${code} 가격 이상: ${data.tradePrice}`);
  // 등락은 tradePrice-prevClosingPrice에서 직접 파생(부호/스케일 함정 회피, Naver 산식과 동형).
  const change    = Number.isFinite(prevClose) ? price - prevClose : 0;
  const changePct = Number.isFinite(prevClose) && prevClose ? (change / prevClose) * 100 : 0;
  console.log(`[daum-stock] ${code} 현재가 폴오버 ✅ ${price} (${changePct.toFixed(2)}%)`);
  return {
    id:         code,
    symbol:     code,
    name:       data.name ?? code,
    price,
    prev_close: r2(prevClose),
    change:     r2(change),
    change_pct: r2(changePct),
    direction:  direction(changePct),
    sparkline:  [],
    category:   '한국주식',
    source:     'Daum',
    marketStatus: normalizeStatus(data.marketStatus),
  };
}

/**
 * 일봉 히스토리 폴백 — naver-stock.js fetchKRDailyHistory와 동형 반환.
 * Daum은 단일 콜 limit=N (네이버 60행 페이지네이션보다 단순).
 * @param {string} code
 * @param {{ totalRows?: number }} [opts]
 * @returns {Promise<{ history, ohlc_available: true, source: string }>}
 */
export async function fetchDaumDailyHistory(code, { totalRows = 250 } = {}) {
  const sym  = krStockSymbol(code, 'daum');
  const rows = await fetchJSON(
    `https://finance.daum.net/api/charts/${sym}/days?limit=${totalRows}&adjusted=true`,
    daumHeaders(sym, { chart: true })
  );
  const list = Array.isArray(rows?.data) ? rows.data : [];
  const seen = new Map();
  for (const r of list) {
    const date  = String(r.date ?? '').slice(0, 10); // 이미 YYYY-MM-DD
    const close = Number(r.tradePrice);
    if (!date || !Number.isFinite(close) || close <= 0) continue;
    const vol = Number(r.candleAccTradeVolume);
    seen.set(date, {
      date,
      open:  r2(Number(r.openingPrice)),
      high:  r2(Number(r.highPrice)),
      low:   r2(Number(r.lowPrice)),
      close: r2(close),
      ...(Number.isFinite(vol) ? { volume: vol } : {}),
    });
  }
  if (seen.size < 10) throw new Error(`Daum ${code}: 히스토리 부족 (${seen.size}행)`);
  const history = [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-totalRows);
  console.log(`[daum-stock] ${code} 일봉 폴백 ✅ ${history.length}행`);
  return { history, ohlc_available: true, source: 'Daum' };
}
