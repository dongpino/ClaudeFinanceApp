/**
 * scripts/test-index-failover.js — 코스피/코스닥 지수 라이브 폴오버 검증(fetch 목킹).
 *
 * collectKR을 경유해 Naver 지수 실패 → Yahoo 폴오버와 source 동적화(Naver|Yahoo),
 * 지연시세 as_of 표기, 그리고 전 소스 실패 시 아이템 누락(= market-data가 last-good
 * stale로 받는 최후 방어선)을 확인한다. test-crypto-failover.js와 동일 방식.
 * health 기록(trackedFetch)은 Redis 미설정 시 no-op이라, "어느 호스트가 호출됐나"를 세어
 * naver-index(실패)·yahoo(성공) 신호가 각 소스로 나갔음(상태판 빨강/초록)을 검증한다.
 * 실행: node scripts/test-index-failover.js
 */
import { collectKR } from '../api/_collectors/kr.js';

const originalFetch = global.fetch;
const nowSec = Math.floor(Date.now() / 1000);

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

// Naver 지수 api 응답: [{closePrice, localTradedAt}, ...] (rows[0]=현재가, rows[1]=전일)
function naverIndexRows(base) {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const c = base - i * 3; // 최신이 앞(내림차순 날짜)
    const d = new Date((nowSec - i * 86400) * 1000).toISOString().slice(0, 10).replace(/-/g, '.');
    rows.push({ closePrice: c.toFixed(2), localTradedAt: `${d} 15:30:00` });
  }
  return rows;
}

// Yahoo v8 chart 응답: meta + timestamp[] + indicators.quote[0].close[]
function yahooChart(price, prevClose, { delayed = 900 } = {}) {
  const timestamp = [], close = [];
  for (let i = 0; i < 40; i++) { timestamp.push(nowSec - (39 - i) * 86400); close.push(price - (39 - i) * 2); }
  return {
    chart: { result: [{
      meta: { regularMarketPrice: price, chartPreviousClose: prevClose,
              regularMarketTime: nowSec, exchangeDataDelayedBy: delayed },
      timestamp,
      indicators: { quote: [{ close }] },
    }] },
  };
}

// 소스별 성공 여부 config로 global.fetch 라우팅. 환율(exchange/frankfurter)은 이번 검증
// 범위 밖 — 항상 500으로 떨궈 usdkrw/jpykrw는 자연 누락시키고 kospi/kosdaq만 검증한다.
function installFetch(cfg, counts) {
  global.fetch = async (url) => {
    const u = String(url);
    const host = u.includes('finance.yahoo.com') ? 'yahoo'
      : u.includes('stock.naver.com') || u.includes('finance.naver.com') ? 'naver-index'
      : u.includes('frankfurter') ? 'frankfurter' : 'other';
    counts[host] = (counts[host] || 0) + 1;

    // Naver 지수 현재가/30d (m.stock.naver.com/api/index/{KOSPI|KOSDAQ}/price)
    if (u.includes('m.stock.naver.com/api/index/KOSPI/price'))
      return cfg.naverIndex ? makeRes(naverIndexRows(6797.42)) : FAIL;
    if (u.includes('m.stock.naver.com/api/index/KOSDAQ/price'))
      return cfg.naverIndex ? makeRes(naverIndexRows(852.10)) : FAIL;

    // Yahoo (query1/query2) — ^KS11 / ^KQ11
    if (u.includes('finance.yahoo.com') && u.includes('KS11'))
      return cfg.yahoo ? makeRes(yahooChart(6797.42, 6750.00)) : FAIL;
    if (u.includes('finance.yahoo.com') && u.includes('KQ11'))
      return cfg.yahoo ? makeRes(yahooChart(852.10, 848.00)) : FAIL;

    // 환율/기타 — 범위 밖, 항상 실패 → usdkrw/jpykrw 누락(검증 무관)
    return FAIL;
  };
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ FAIL:', msg); } }
function pick(items, id) { return items.find(it => it.id === id); }

async function run() {
  // ── 1. 정상: Naver 소스, 픽셀 동일(source=Naver, 지연문구 없음) ──
  {
    const counts = {};
    installFetch({ naverIndex: true, yahoo: true }, counts);
    const items = await collectKR({ include90d: false });
    const kospi = pick(items, 'kospi');
    assert(kospi, '1: kospi 아이템 존재');
    assert(kospi?.source === 'Naver', `1: 정상 시 source=Naver (got ${kospi?.source})`);
    assert(kospi?.history.length >= 5, '1: Naver 30d 히스토리 정상');
    assert(!kospi?.stale, '1: stale 아님');
    assert(!/지연/.test(kospi?.as_of ?? ''), '1: Naver 경로는 지연문구 없음(픽셀 동일)');
    assert(counts.yahoo === undefined, '1: Naver 정상이면 Yahoo 미호출(대기 유지)');
  }

  // ── 2. Naver 지수 실패 → Yahoo 폴오버(현재가+30d), source=Yahoo, 값 정합, 지연표기 ──
  {
    const counts = {};
    installFetch({ naverIndex: false, yahoo: true }, counts);
    const items = await collectKR({ include90d: false });
    const kospi = pick(items, 'kospi');
    assert(kospi, '2: 폴오버 후 kospi 아이템 유지');
    assert(kospi?.source === 'Yahoo', `2: 폴오버 source=Yahoo (got ${kospi?.source})`);
    assert(kospi?.price >= 6797 && kospi?.price < 6798, `2: 값 정합 KOSPI 6797대 (got ${kospi?.price})`);
    assert(kospi?.history.length >= 5, '2: 스파크라인 Yahoo 30d 폴백 채워짐');
    assert(!kospi?.stale, '2: stale 아님(라이브 폴오버라 last-good 미발동)');
    assert(/기준 · ~\d+분 지연/.test(kospi?.as_of ?? ''), `2: 지연시세 표기 "HH:mm 기준 · ~N분 지연" (got "${kospi?.as_of}")`);
    assert(/~15분 지연/.test(kospi?.as_of ?? ''), `2: 900초→15분 반올림 (got "${kospi?.as_of}")`);
    assert(counts['naver-index'] >= 1 && counts.yahoo >= 1, '2: naver-index(실패)·yahoo(성공) 양쪽 호출 → 상태판 빨강/초록');
    // 코스닥도 함께 폴오버 확인
    const kosdaq = pick(items, 'kosdaq');
    assert(kosdaq?.source === 'Yahoo' && kosdaq?.price >= 852 && kosdaq?.price < 853, `2: 코스닥도 Yahoo 폴오버 값 정합 (got ${kosdaq?.price})`);
  }

  // ── 3. 전 소스 실패(Naver+Yahoo) → kospi 아이템 누락(= 상위 last-good stale 서빙 지점) ──
  {
    const counts = {};
    installFetch({ naverIndex: false, yahoo: false }, counts);
    const items = await collectKR({ include90d: false });
    assert(!pick(items, 'kospi'), '3: 현재가 전 소스 실패 시 kospi 누락 → 상위 last-good 폴백');
    assert(counts['naver-index'] >= 1 && counts.yahoo >= 1, '3: Naver·Yahoo 모두 시도됨(라이브 우선순위)');
  }

  // ── 4. 지연 필드 없음/0 → "~15분 지연" 폴백 문구 ──
  {
    const counts = {};
    global.fetch = async (url) => {
      const u = String(url);
      counts[u.includes('yahoo') ? 'yahoo' : 'naver-index'] = 1;
      if (u.includes('m.stock.naver.com/api/index')) return FAIL;
      if (u.includes('finance.yahoo.com') && u.includes('KS11')) return makeRes(yahooChart(6797.42, 6750, { delayed: 0 }));
      if (u.includes('finance.yahoo.com') && u.includes('KQ11')) return makeRes(yahooChart(852.10, 848, { delayed: 0 }));
      return FAIL;
    };
    const items = await collectKR({ include90d: false });
    const kospi = pick(items, 'kospi');
    assert(/~15분 지연/.test(kospi?.as_of ?? ''), `4: exchangeDataDelayedBy=0 → "~15분 지연" 폴백 (got "${kospi?.as_of}")`);
  }

  console.log(`\n[test-index-failover] ${pass} passed, ${fail} failed`);
  global.fetch = originalFetch;
  if (fail) process.exit(1);
}

run().catch(e => { console.error('테스트 실행 오류:', e); global.fetch = originalFetch; process.exit(1); });
