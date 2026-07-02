/**
 * _collectors/naver-stock.js — 한국 주식(코스피/코스닥) 검색·시세·과거데이터
 *
 * Twelve Data 무료 티어는 KRX 심볼을 지원하지 않음
 * (실측: /quote, /time_series 모두 404 "available starting with the Pro or Venture plan" — 2026-07-02 확인).
 * 대신 analysis-long.js의 fetchLongKOSPI(지수)와 동일한 계열인 Naver 모바일 API를
 * 개별 종목 엔드포인트로 사용한다 — 인증 불필요, 무료.
 *
 * 사용 엔드포인트:
 *   GET https://ac.stock.naver.com/ac?q=&target=stock         자동완성 검색
 *   GET https://m.stock.naver.com/api/stock/{code}/basic      현재가·등락률
 *   GET https://m.stock.naver.com/api/stock/{code}/price      일봉 히스토리 (페이지네이션)
 *
 * 종목 코드(code)는 6자리 숫자 문자열(예: '005930' 삼성전자) — 워치리스트에서
 * { type:'stock', market:'KR', id:code, symbol:code, name } 형태로 저장한다.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

function r2(n) { return Math.round(n * 100) / 100; }
function cleanNum(s) { return parseFloat(String(s ?? '').replace(/,/g, '').replace(/%/g, '').trim()); }
function direction(pct) { return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'; }

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// ── 검색 ──────────────────────────────────────────────────────────

/**
 * 한국 주식 종목 검색 (코스피/코스닥, 종목명·코드)
 * @param {string} query
 * @returns {Promise<{ symbol, name, type }[]>} 최대 20개
 */
export async function searchKRStocks(query) {
  const q = query?.trim() ?? '';
  if (!q) return [];

  const data  = await fetchJSON(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`);
  const items = Array.isArray(data.items) ? data.items : [];

  return items
    .filter(it => it.nationCode === 'KOR' && it.category === 'stock')
    .slice(0, 20)
    .map(it => ({
      symbol: it.code ?? '',
      name:   it.name ?? '',
      type:   it.typeName ?? '',   // 코스피 / 코스닥
    }));
}

// ── 현재가 ────────────────────────────────────────────────────────

/**
 * 복수 종목코드의 현재가·등락률 (stock-quote.js 호환 형식)
 * @param {string[]} codes — 6자리 종목코드 배열
 * @returns {Promise<object[]>} null 제외됨
 */
export async function fetchKRQuotes(codes) {
  if (!codes || codes.length === 0) return [];
  const results = await Promise.all(codes.map(fetchOneKRQuote));
  return results.filter(Boolean);
}

async function fetchOneKRQuote(code) {
  try {
    const data = await fetchJSON(`https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/basic`);

    const price      = cleanNum(data.closePrice);
    const change     = cleanNum(data.compareToPreviousClosePrice);
    const changePct  = cleanNum(data.fluctuationsRatio);
    if (isNaN(price) || price <= 0) {
      console.warn(`[naver-stock] ${code}: 유효하지 않은 시세`);
      return null;
    }

    return {
      id:         code,
      symbol:     code,
      // name은 종목명(한글) 그대로 사용 — Finnhub 경로와 달리 워치리스트 name으로
      // 덮어쓰지 않아도 이미 사람이 읽을 수 있는 값이라 별도 처리 불필요
      name:       data.stockName ?? code,
      price,
      prev_close: r2(price - change),
      change:     r2(change),
      change_pct: r2(changePct),
      direction:  direction(changePct),
      sparkline:  [],
      category:   '한국주식',
      source:     'Naver',
    };
  } catch (err) {
    console.error(`[naver-stock] ${code} 시세 조회 실패:`, err.message);
    return null;
  }
}

// ── 과거 일봉 히스토리 ────────────────────────────────────────────

/**
 * 종목코드의 일봉 히스토리 (최근 250 거래일 목표)
 * pageSize 상한이 60~79 사이(실측: 60 성공, 80 실패)라 여러 페이지를 병렬 수집
 * @param {string} code
 * @returns {Promise<{ history, ohlc_available: true, source: string }>}
 */
export async function fetchKRDailyHistory(code) {
  const pageSize  = 60;
  const totalRows = 250;
  const numPages  = Math.ceil(totalRows / pageSize) + 1;   // 여유 1페이지

  const pages = await Promise.all(
    Array.from({ length: numPages }, (_, i) =>
      fetchJSON(`https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/price?pageSize=${pageSize}&page=${i + 1}`)
        .catch(() => [])
    )
  );

  const seen = new Map();
  for (const rows of pages) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const date = r.localTradedAt?.slice(0, 10);
      const close = cleanNum(r.closePrice);
      if (!date || isNaN(close) || close <= 0) continue;
      const vol = Number(r.accumulatedTradingVolume);
      seen.set(date, {
        date,
        open:  r2(cleanNum(r.openPrice)),
        high:  r2(cleanNum(r.highPrice)),
        low:   r2(cleanNum(r.lowPrice)),
        close: r2(close),
        ...(Number.isFinite(vol) ? { volume: vol } : {}),
      });
    }
  }

  if (seen.size < 10) throw new Error(`Naver ${code}: 히스토리 부족 (${seen.size}행)`);

  const history = [...seen.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-totalRows);

  return { history, ohlc_available: true, source: 'Naver mobile API' };
}
