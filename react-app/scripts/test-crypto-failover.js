/**
 * scripts/test-crypto-failover.js — 크립토 현재가/스파크라인 라이브 폴오버 검증(fetch 목킹).
 *
 * collectBTC를 경유해 CoinGecko 실패 → Binance → Bybit 순차 폴오버와 source 동적화,
 * 그리고 전 소스 실패 시 reject(= market-data가 last-good stale로 받는 최후 방어선)를 확인한다.
 * health 기록(trackedFetch)은 Redis 미설정 시 no-op이라, 여기선 "어느 호스트가 호출됐나"를
 * 세어 coingecko(실패)·binance/bybit(성공) 신호가 실제로 각 소스로 나갔음을 검증한다.
 * 실행: node scripts/test-crypto-failover.js
 */
import { collectBTC } from '../api/_collectors/btc.js';

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

// 30개짜리 일봉 klines(Binance 포맷: [openTime, o,h,l,c,v,...])
function binanceKlines(base) {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const ts = (nowSec - (29 - i) * 86400) * 1000;
    const c = base + i;
    out.push([ts, `${c - 1}`, `${c + 2}`, `${c - 2}`, `${c}`, '100']);
  }
  return out;
}
// Bybit kline: 최신이 앞 → 역순 배열, 항목 [startMs, o,h,l,c,v,turnover]
function bybitKlines(base) {
  return binanceKlines(base).map(k => [...k, '0']).reverse();
}

// 소스별 성공 여부 config로 global.fetch를 라우팅
function installFetch(cfg, counts) {
  global.fetch = async (url) => {
    const u = String(url);
    const host = u.includes('data-api.binance.vision') ? 'binance' // vision/com 모두 health상 binance
      : u.includes('api.binance.com') ? 'binance'
      : u.includes('bybit.com') ? 'bybit'
      : u.includes('coingecko.com') ? 'coingecko' : 'other';
    counts[host] = (counts[host] || 0) + 1;

    // CoinGecko
    if (u.includes('coingecko.com') && u.includes('simple/price'))
      return cfg.cgCurrent ? makeRes({ bitcoin: { usd: 66000, usd_24h_change: 1.5, last_updated_at: nowSec } }) : FAIL;
    if (u.includes('coingecko.com') && u.includes('market_chart')) {
      if (!cfg.cgHistory) return FAIL;
      const prices = [];
      for (let i = 0; i < 30; i++) prices.push([(nowSec - (29 - i) * 86400) * 1000, 66000 + i]);
      return makeRes({ prices });
    }
    // Binance ticker(24hr) / klines(1d)
    if (u.includes('binance') && u.includes('ticker/24hr'))
      return cfg.binanceTicker ? makeRes({ lastPrice: '66123.45', priceChangePercent: '2.0', prevClosePrice: '64827', closeTime: Date.now() }) : FAIL;
    if (u.includes('binance') && u.includes('klines'))
      return cfg.binanceKline ? makeRes(binanceKlines(66000)) : FAIL;
    // Bybit tickers / kline
    if (u.includes('bybit') && u.includes('market/tickers'))
      return cfg.bybitTicker ? makeRes({ retCode: 0, result: { list: [{ lastPrice: '66222.2', price24hPcnt: '0.03', prevPrice24h: '64293' }] } }) : FAIL;
    if (u.includes('bybit') && u.includes('market/kline'))
      return cfg.bybitKline ? makeRes({ retCode: 0, result: { list: bybitKlines(66000) } }) : FAIL;

    return makeRes('not found', { status: 404 });
  };
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ FAIL:', msg); } }

async function run() {
  // ── 1. 정상: CoinGecko 소스, 기존 형식 유지 ──
  {
    const counts = {};
    installFetch({ cgCurrent: true, cgHistory: true }, counts);
    const it = await collectBTC({ include90d: false });
    assert(it.source === 'CoinGecko', `1: 정상 시 source=CoinGecko (got ${it.source})`);
    assert(it.price > 0 && it.history.length >= 5, '1: 가격/히스토리 정상');
    assert(!it.stale, '1: stale 아님');
  }

  // ── 2. CoinGecko 현재가+30d 실패 → Binance 폴오버(현재가+스파크라인), source=Binance ──
  {
    const counts = {};
    installFetch({ cgCurrent: false, cgHistory: false, binanceTicker: true, binanceKline: true }, counts);
    const it = await collectBTC({ include90d: false });
    assert(it.source === 'Binance', `2: 폴오버 source=Binance (got ${it.source})`);
    assert(it.price > 0, '2: 라이브 가격 유지');
    assert(it.history.length >= 5, '2: 스파크라인 Binance 폴백 채워짐');
    assert(!it.stale, '2: stale 아님(라이브 폴오버라 최후방어선 미발동)');
    assert(counts.coingecko >= 1 && counts.binance >= 1, '2: coingecko(실패)·binance(성공) 양쪽 호출됨 → 상태판 빨강/초록');
  }

  // ── 3. Binance까지 실패 → Bybit 폴오버, source=Bybit ──
  {
    const counts = {};
    installFetch({ cgCurrent: false, cgHistory: false, binanceTicker: false, binanceKline: false, bybitTicker: true, bybitKline: true }, counts);
    const it = await collectBTC({ include90d: false });
    assert(it.source === 'Bybit', `3: Bybit 폴오버 source=Bybit (got ${it.source})`);
    assert(it.price > 0 && it.history.length >= 5, '3: Bybit 가격+스파크라인');
    assert(counts.bybit >= 1, '3: bybit 호출됨');
  }

  // ── 4. 전 소스 실패 → collectBTC reject (market-data가 last-good stale로 받는 지점) ──
  {
    const counts = {};
    installFetch({ cgCurrent: false, cgHistory: false, binanceTicker: false, binanceKline: false, bybitTicker: false, bybitKline: false }, counts);
    let threw = false;
    try { await collectBTC({ include90d: false }); } catch { threw = true; }
    assert(threw, '4: 현재가 전 소스 실패 시 collectBTC reject → 상위 last-good 폴백');
  }

  // ── 5. priceOverride(홈 배치)의 source가 item.source로 전파 ──
  {
    const counts = {};
    installFetch({ cgCurrent: true, cgHistory: true }, counts);
    const cg = await collectBTC({ include90d: false, priceOverride: { current: 70000, prevClose: 69000, change: 1000, changePct: 1.45, asOf: 'x', source: 'CoinGecko' } });
    assert(cg.source === 'CoinGecko' && cg.price === 70000, '5: priceOverride(CoinGecko) → source 전파');
    const bn = await collectBTC({ include90d: false, priceOverride: { current: 70000, prevClose: 69000, change: 1000, changePct: 1.45, asOf: 'x', source: 'Binance' } });
    assert(bn.source === 'Binance', '5: priceOverride(Binance) → source=Binance 전파');
  }

  console.log(`\n[test-crypto-failover] ${pass} passed, ${fail} failed`);
  global.fetch = originalFetch;
  if (fail) process.exit(1);
}

run().catch(e => { console.error('테스트 실행 오류:', e); global.fetch = originalFetch; process.exit(1); });
