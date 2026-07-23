/**
 * scripts/test-daum-failover.js — 개별 KR 종목 현재가/일봉 Daum 폴오버 검증(fetch 목킹).
 *
 * naver-stock.js의 fetchKRQuotes/fetchKRDailyHistory를 경유해 Naver 실패 → Daum 폴오버와
 * source 동적화(Naver|Daum), 등락 파생(tradePrice-prevClosingPrice), marketStatus 정규화,
 * 그리고 전 소스 실패 시 null(= 상위 last-good stale로 받는 최후 방어선)을 확인한다.
 * test-index-failover.js와 동일 방식(호출 호스트 카운트로 상태판 빨강/초록 신호 검증).
 * 실행: node scripts/test-daum-failover.js
 */
import { fetchKRQuotes, fetchKRDailyHistory } from '../api/_collectors/naver-stock.js';

const originalFetch = global.fetch;

function makeRes(jsonBody, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
    text: async () => (typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody)),
    headers: { get: () => null },
  };
}
const FAIL = makeRes({ msg: 'simulated failure' }, { status: 500 });

// Naver price(일봉) 응답: 배열 [{localTradedAt, openPrice, highPrice, lowPrice, closePrice, accumulatedTradingVolume}]
function naverHistoryRows(base, n = 40) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const c = base - i * 10;
    const d = new Date((Math.floor(Date.now() / 1000) - i * 86400) * 1000).toISOString().slice(0, 10);
    rows.push({ localTradedAt: `${d} 00:00:00`, openPrice: `${c - 5}`, highPrice: `${c + 8}`,
                lowPrice: `${c - 8}`, closePrice: c.toLocaleString('en-US'), accumulatedTradingVolume: `${1000000 + i}` });
  }
  return rows;
}
// Daum charts/days 응답: { data: [{date, openingPrice, highPrice, lowPrice, tradePrice, candleAccTradeVolume}] }
function daumHistoryRows(base, n = 40) {
  const data = [];
  for (let i = 0; i < n; i++) {
    const c = base - i * 10;
    const d = new Date((Math.floor(Date.now() / 1000) - i * 86400) * 1000).toISOString().slice(0, 10);
    data.push({ date: d, openingPrice: c - 5, highPrice: c + 8, lowPrice: c - 8, tradePrice: c, candleAccTradeVolume: 2000000 + i });
  }
  return { data };
}

// cfg로 소스별 성패 라우팅. counts로 어느 호스트가 호출됐는지 집계.
function installFetch(cfg, counts, { daumStatus = 'REGULAR_HOURS' } = {}) {
  global.fetch = async (url) => {
    const u = String(url);
    const host = u.includes('finance.daum.net') ? 'daum'
      : u.includes('stock.naver.com') ? 'naver' : 'other';
    counts[host] = (counts[host] || 0) + 1;

    // Naver 현재가 /basic
    if (u.includes('m.stock.naver.com/api/stock/') && u.includes('/basic'))
      return cfg.naverQuote
        ? makeRes({ closePrice: '270,250', compareToPreviousClosePrice: '9,750', fluctuationsRatio: '3.74', stockName: '삼성전자', marketStatus: 'PREOPEN' })
        : FAIL;
    // Naver 일봉 /price
    if (u.includes('m.stock.naver.com/api/stock/') && u.includes('/price'))
      return cfg.naverHistory ? makeRes(naverHistoryRows(270000)) : FAIL;

    // Daum 현재가 /api/quotes/A005930
    if (u.includes('finance.daum.net/api/quotes/'))
      return cfg.daumQuote
        ? makeRes({ tradePrice: 270250, prevClosingPrice: 260500, name: '삼성전자', marketStatus: daumStatus,
                    change: 'RISE', changePrice: 9750, changeRate: 0.037428 })
        : FAIL;
    // Daum 일봉 /api/charts/A005930/days
    if (u.includes('finance.daum.net/api/charts/'))
      return cfg.daumHistory ? makeRes(daumHistoryRows(270000)) : FAIL;

    return makeRes('not found', { status: 404 });
  };
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ FAIL:', msg); } }

async function run() {
  const CODE = '005930';

  // ── 1. 정상: Naver 소스, 픽셀 동일(source=Naver, marketStatus 원문 유지) ──
  {
    const counts = {};
    installFetch({ naverQuote: true, naverHistory: true, daumQuote: true, daumHistory: true }, counts);
    const [q] = await fetchKRQuotes([CODE]);
    assert(q?.source === 'Naver', `1: 정상 시 source=Naver (got ${q?.source})`);
    assert(q?.price === 270250 && q?.change_pct === 3.74, `1: Naver 값 정합 (price ${q?.price}, pct ${q?.change_pct})`);
    assert(q?.marketStatus === 'PREOPEN', '1: Naver marketStatus 원문 유지(PREOPEN)');
    assert(counts.daum === undefined, '1: Naver 정상이면 Daum 미호출(대기 유지)');
  }

  // ── 2. Naver 현재가 실패 → Daum 폴오버: source=Daum, 등락 파생 정확, marketStatus 정규화 ──
  {
    const counts = {};
    installFetch({ naverQuote: false, naverHistory: true, daumQuote: true, daumHistory: true }, counts);
    const [q] = await fetchKRQuotes([CODE]);
    assert(q, '2: 폴오버 후 아이템 유지');
    assert(q?.source === 'Daum', `2: 폴오버 source=Daum (got ${q?.source})`);
    assert(q?.price === 270250, `2: Daum tradePrice (got ${q?.price})`);
    assert(q?.prev_close === 260500, `2: Daum prevClosingPrice 직접 사용 (got ${q?.prev_close})`);
    assert(q?.change === 9750, `2: change = tradePrice-prevClosingPrice 파생 (got ${q?.change})`);
    assert(q?.change_pct === 3.74, `2: pct = change/prev*100 파생 (got ${q?.change_pct})`);
    assert(q?.direction === 'up', '2: direction 파생');
    assert(q?.marketStatus === 'REGULAR_HOURS', `2: Daum REGULAR_HOURS 정규화 유지 (got ${q?.marketStatus})`);
    assert(counts.naver >= 1 && counts.daum >= 1, '2: naver(실패)·daum(성공) 양쪽 호출 → 상태판 빨강/초록');
  }

  // ── 3. Naver 히스토리 실패 → Daum 일봉 폴백: OHLC 정합, source=Daum ──
  {
    const counts = {};
    installFetch({ naverQuote: true, naverHistory: false, daumQuote: true, daumHistory: true }, counts);
    const h = await fetchKRDailyHistory(CODE, { totalRows: 30 });
    assert(h?.source === 'Daum', `3: 히스토리 폴백 source=Daum (got ${h?.source})`);
    assert(h?.history.length === 30, `3: 30행 슬라이스 (got ${h?.history.length})`);
    const last = h?.history.at(-1);
    assert(last && last.open && last.high && last.low && last.close && Number.isFinite(last.volume), '3: OHLCV 완비');
    assert(h?.ohlc_available === true, '3: ohlc_available');
    assert(counts.daum >= 1, '3: daum 호출됨');
  }

  // ── 4. 전 소스 실패(Naver+Daum 현재가) → null (상위 last-good 폴백 지점) ──
  {
    const counts = {};
    installFetch({ naverQuote: false, naverHistory: false, daumQuote: false, daumHistory: false }, counts);
    const quotes = await fetchKRQuotes([CODE]); // null 필터됨 → 빈 배열
    assert(quotes.length === 0, '4: 현재가 전 소스 실패 시 fetchKRQuotes 빈 배열 → 상위 last-good');
    assert(counts.naver >= 1 && counts.daum >= 1, '4: Naver·Daum 모두 시도됨(라이브 우선순위)');
    // 히스토리도 전 소스 실패 → throw (호출측이 .catch하는 계약)
    let threw = false;
    try { await fetchKRDailyHistory(CODE, { totalRows: 30 }); } catch { threw = true; }
    assert(threw, '4: 히스토리 전 소스 실패 시 throw(호출측 .catch 계약)');
  }

  // ── 5. Daum 미지 marketStatus 토큰 → null (PREOPEN 판정 미발동, 오동작 방지) ──
  {
    const counts = {};
    installFetch({ naverQuote: false, daumQuote: true }, counts, { daumStatus: 'SOME_FUTURE_TOKEN' });
    const [q] = await fetchKRQuotes([CODE]);
    assert(q?.marketStatus === null, `5: 미지 토큰 → null (got ${JSON.stringify(q?.marketStatus)})`);
  }

  console.log(`\n[test-daum-failover] ${pass} passed, ${fail} failed`);
  global.fetch = originalFetch;
  if (fail) process.exit(1);
}

run().catch(e => { console.error('테스트 실행 오류:', e); global.fetch = originalFetch; process.exit(1); });
