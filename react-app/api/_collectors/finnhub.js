/**
 * _collectors/finnhub.js — Finnhub 미국 주식 검색 · 시세 모듈
 *
 * 인증: X-Finnhub-Token 헤더 (process.env.FINNHUB_API_KEY)
 * 무료 티어 한도: 60 req/min
 *
 * 사용 엔드포인트:
 *   GET /search?q=          심볼·회사명 자동완성  무료
 *   GET /quote?symbol=      현재가·전일종가·등락  무료
 *   GET /stock/candle       일봉 스파크라인       무료 (US 주식, resolution=D 한정)
 */

import { trackedFetch } from '../_lib/health.js';

const FH_BASE = 'https://finnhub.io/api/v1';

/** 키 존재 여부 (핸들러에서 조기 체크용) */
export function hasKey() {
  return Boolean(process.env.FINNHUB_API_KEY);
}

function getKey() {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) throw new Error('FINNHUB_API_KEY 환경변수가 설정되지 않았습니다');
  return k;
}

async function fhFetch(path) {
  const key = getKey();
  // token을 URL 파라미터로 전달 (헤더 방식과 동일하지만 호환성이 더 넓음)
  const sep = path.includes('?') ? '&' : '?';
  const url = `${FH_BASE}${path}${sep}token=${encodeURIComponent(key)}`;
  const res  = await trackedFetch(url, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 로그에 키 노출 방지
    throw new Error(`Finnhub HTTP ${res.status} — ${path.split('?')[0]} — ${text.slice(0, 120)}`);
  }
  return res.json();
}

function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }
function direction(pct) { return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'; }

// ── 검색 ──────────────────────────────────────────────────────────

/**
 * 미국 주식 심볼 / 회사명 검색
 * @param {string} query
 * @returns {{ symbol, name, type }[]} 최대 20개 (Common Stock + ETP만)
 */
export async function searchStocks(query) {
  const q = query?.trim() ?? '';
  if (!q) return [];

  const data    = await fhFetch(`/search?q=${encodeURIComponent(q)}`);
  const results = Array.isArray(data.result) ? data.result : [];

  return results
    .filter(r => r.type === 'Common Stock' || r.type === 'ETP')
    .slice(0, 20)
    .map(r => ({
      symbol: r.displaySymbol ?? r.symbol ?? '',
      name:   r.description  ?? '',
      type:   r.type         ?? '',
    }));
}

// ── 시세 + 스파크라인 ──────────────────────────────────────────────

/**
 * 복수 심볼 시세 + 30일 일봉 스파크라인
 * @param {string[]} symbols — 대문자 심볼 배열 ['AAPL', 'MSFT']
 * @returns {object[]} 홈 카드 호환 형식 (null 제외됨)
 */
export async function fetchStockPrices(symbols) {
  if (!symbols || symbols.length === 0) return [];

  const to   = Math.floor(Date.now() / 1000);
  const from = to - 35 * 24 * 60 * 60; // 35 캘린더일(영업일 ~25일 확보)

  const results = await Promise.all(
    symbols.map(sym => fetchOneStock(sym, from, to))
  );
  return results.filter(Boolean);
}

async function fetchOneStock(symbol, from, to) {
  try {
    const [quoteResult, candleResult] = await Promise.allSettled([
      fhFetch(`/quote?symbol=${encodeURIComponent(symbol)}`),
      fhFetch(`/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}`),
    ]);

    // quote 실패 시 전체 실패
    if (quoteResult.status === 'rejected') throw quoteResult.reason;
    const quote = quoteResult.value;

    // quote.c === 0 이고 quote.pc === 0 이면 유효하지 않은 심볼
    if (quote.c === 0 && quote.pc === 0) {
      console.warn(`[finnhub] ${symbol}: 유효하지 않은 심볼 (가격 0)`);
      return null;
    }

    const price    = r2(quote.c  ?? 0);
    const prevClose = r2(quote.pc ?? price);
    const change   = r2(quote.d  ?? (price - prevClose));
    const changePct = r4(quote.dp ?? 0);

    // 스파크라인: 일봉 종가 배열 (무료 티어 미지원 시 빈 배열)
    const candle   = candleResult.status === 'fulfilled' ? candleResult.value : null;
    const rawClose = (candle?.s === 'ok' && Array.isArray(candle.c)) ? candle.c : [];
    const step     = Math.max(1, Math.floor(rawClose.length / 30));
    const sparkline = rawClose
      .filter((_, i) => i % step === 0)
      .map(v => r2(v));

    return {
      id:         symbol.toUpperCase(),
      symbol:     symbol.toUpperCase(),
      // name은 의도적으로 symbol로 채움: 저장된 watchlist 항목의 name(회사명)을
      // UI 계층(SearchPage.getLiveItem)에서 덮어쓰므로 API 레벨에서 별도 조회 불필요
      name:       symbol.toUpperCase(),
      price,
      prev_close: prevClose,
      change,
      change_pct: changePct,
      direction:  direction(changePct),
      sparkline,
      category:   '미국주식',
      source:     'Finnhub',
    };
  } catch (err) {
    console.error(`[finnhub] ${symbol} 조회 실패:`, err.message);
    return null;
  }
}
