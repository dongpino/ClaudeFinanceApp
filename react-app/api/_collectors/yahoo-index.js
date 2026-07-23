/**
 * _collectors/yahoo-index.js — 코스피/코스닥 지수 라이브 폴오버 (Naver 장애 시)
 *
 * Naver 지수 수집(m.stock.naver.com api + finance.naver.com HTML scrape)이 실패하면
 * Yahoo v8 chart(query1 → query2)로 대체한다. crypto-ticker.js와 동일한 "네이버 스키마로
 * 정규화하는 어댑터" 패턴 — kr.js의 fetchIndexCurrent/fetchIndexHistory 반환형을 그대로
 * 흉내내 호출측(buildIndexItem)이 소스 전환을 몰라도 되게 한다.
 *
 * 각 fetch는 trackedFetch라 health에 자동 집계된다(finance.yahoo.com → 'yahoo').
 * → 폴오버 발동 시 상태판에서 "naver-index 빨강 + yahoo 초록"으로 자연히 읽힘.
 *
 * ── 필드 매핑(probe-backup.js 실측 확인) ──────────────────────────────
 *   current   = chart.result[0].meta.regularMarketPrice
 *   prevClose = chart.result[0].meta.chartPreviousClose   (⚠ prevClose 아님)
 *   change/pct= current-prevClose 파생 (Naver와 동일 산식)
 *   asOf      = regularMarketTime(HH:mm KST) + '~N분 지연'(exchangeDataDelayedBy 기반)
 *   30d/90d   = timestamp[] + indicators.quote[0].close[] 페어링
 *
 * Yahoo 지수는 무료 티어 지연시세다 — as_of에 "~N분 지연"을 명시해 사용자가 라이브로
 * 오인하지 않게 한다(정직성 원칙). source='Yahoo'는 카드 출처 배지에 그대로 노출된다.
 */

import { trackedFetch } from '../_lib/health.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};
const TIMEOUT_MS = 8000;

function r2(n) { return Math.round(n * 100) / 100; }
function tsToDateUTC(tsMs) { return new Date(tsMs).toISOString().slice(0, 10); }

// KST "HH:mm" — 카드 폭이 좁아(모바일 170px) 날짜 생략, 시:분만(승인된 as_of 형식).
function fmtHMKST(tsMs = Date.now()) {
  const kst = new Date(tsMs + 9 * 60 * 60 * 1000);
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${mi}`;
}

// exchangeDataDelayedBy(초) → "~N분 지연". 분 단위 반올림(900초→15분). 필드 없거나 0이면
// "~15분 지연" 폴백(Yahoo 지수 무료티어 표준 지연).
function delayLabel(meta) {
  const sec = Number(meta?.exchangeDataDelayedBy);
  const mins = Number.isFinite(sec) && sec > 0 ? Math.round(sec / 60) : 15;
  return `~${mins}분 지연`;
}

// ^KS11 → %5EKS11 (Yahoo v8 경로 인코딩)
function encodeSymbol(sym) { return encodeURIComponent(sym); }

// Yahoo v8 chart — query1 우선, 실패(에러/비200/스키마 이상) 시 query2 재시도(probe 패턴).
// trackedFetch라 query1 실패·query2 성공이 각각 health에 기록된다(consecutiveFailures는
// 성공에서 0으로 리셋 → net 초록).
async function fetchYahooChart(yahooSymbol, range) {
  const path = `/v8/finance/chart/${encodeSymbol(yahooSymbol)}?interval=1d&range=${range}`;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const errors = [];
  for (const host of hosts) {
    try {
      const res = await trackedFetch(`https://${host}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const result = j?.chart?.result?.[0];
      if (!result?.meta) throw new Error('chart.result[0].meta 없음');
      return result;
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
    }
  }
  throw new Error(`Yahoo ${yahooSymbol} 전 호스트 실패: ${errors.join(' | ')}`);
}

/**
 * 현재가 폴오버 — Naver fetchIndexCurrent와 동형의 객체 반환.
 * @param {string} yahooSymbol — 예: '^KS11'
 * @returns {Promise<{current, prevClose, change, changePct, asOf, source:'Yahoo'}>}
 */
export async function fetchYahooIndexCurrent(yahooSymbol) {
  const result = await fetchYahooChart(yahooSymbol, '5d');
  const m = result.meta;
  const current   = Number(m.regularMarketPrice);
  const prevClose = Number(m.chartPreviousClose);
  if (!Number.isFinite(current) || current <= 0) throw new Error(`Yahoo 가격 이상: ${m.regularMarketPrice}`);
  if (!Number.isFinite(prevClose) || prevClose <= 0) throw new Error(`Yahoo 전일종가 이상: ${m.chartPreviousClose}`);
  const asOf = `${m.regularMarketTime ? fmtHMKST(m.regularMarketTime * 1000) : fmtHMKST()} 기준 · ${delayLabel(m)}`;
  console.log(`[yahoo-index] ${yahooSymbol} 현재가 폴오버 ✅ ${current} (prev ${prevClose})`);
  return { current, prevClose, change: current - prevClose,
           changePct: prevClose ? (current - prevClose) / prevClose * 100 : 0,
           asOf, source: 'Yahoo' };
}

/**
 * 일봉 종가 폴백 — Naver fetchIndexHistory/History90d와 동형의 [{date,close}] 반환.
 * @param {string} yahooSymbol
 * @param {number} days — 30(스파크라인) | 90(상세)
 * @returns {Promise<Array<{date, close}>>}
 */
export async function fetchYahooIndexDailyCloses(yahooSymbol, days = 30) {
  const range = days <= 35 ? '2mo' : '6mo';  // 거래일 여유분 확보 후 마지막 days개로 슬라이스
  const result = await fetchYahooChart(yahooSymbol, range);
  const ts     = result.timestamp ?? [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const seen = new Map();
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;   // 휴장일 등 null 캔들 스킵
    seen.set(tsToDateUTC(ts[i] * 1000), r2(c));         // Yahoo ts는 초 → ms
  }
  const rows = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, close]) => ({ date, close }));
  if (rows.length < 5) throw new Error(`Yahoo ${yahooSymbol} history 부족: ${rows.length}행`);
  console.log(`[yahoo-index] ${yahooSymbol} ${days}d 히스토리 폴백 ✅ ${rows.length}행`);
  return rows.slice(-days);
}
