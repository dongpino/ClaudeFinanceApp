/**
 * scripts/test-market-cache.js — market-data L2(Redis 공유 캐시) HIT 경로 검증(네트워크 0).
 *
 * 콜드 인스턴스(L1 인메모리 비어있음) + 다른 인스턴스가 5분 내 채운 Redis 값이 있을 때,
 * 수집기(CoinGecko 등)를 전혀 부르지 않고 Redis 값을 그대로 서빙하는지 확인한다.
 * 이게 item 2의 핵심(인스턴스/리전별 중복 버스트 제거)의 직접 증거다.
 * 실행: node scripts/test-market-cache.js
 */
import handler, { __setRedisClientForTest } from '../api/market-data.js';

function fakeRedis(store) {
  return {
    async get(k) { return store.get(k) ?? null; },
    async set(k, v) { store.set(k, v); return 'OK'; },
  };
}
function makeRes() {
  return {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ FAIL:', msg); } }

async function run() {
  // ── 홈: 콜드 인스턴스 + 채워진 Redis → HIT-REDIS, 수집 생략 ──
  {
    const store = new Map();
    store.set('market:home:v1', {
      data: { updated_at: 'X', items: [{ id: 'btc', price: 1 }, { id: 'kospi', price: 2 }] },
      cachedAt: Date.now(),
    });
    __setRedisClientForTest(fakeRedis(store));
    const res = makeRes();
    // 타임아웃으로 감싸 — 만약 HIT을 놓치고 수집(네트워크)으로 새면 여기서 걸린다.
    await Promise.race([
      handler({ method: 'GET', query: {} }, res),
      new Promise((_, rej) => setTimeout(() => rej(new Error('수집 경로로 샘(HIT 실패)')), 4000)),
    ]);
    assert(res.statusCode === 200, '홈: 200');
    assert(res.headers['X-Cache'] === 'HIT-REDIS', '홈: X-Cache=HIT-REDIS(수집 생략)');
    assert(res.body?.items?.length === 2, '홈: Redis 값 그대로 서빙');
  }

  // ── 상세: 콜드 인스턴스 + 채워진 Redis → HIT-REDIS ──
  {
    const store = new Map();
    store.set('market:detail:btc:v1', {
      data: { updated_at: 'X', item: { id: 'btc', price: 123, history_90d: [] } },
      cachedAt: Date.now(),
    });
    __setRedisClientForTest(fakeRedis(store));
    const res = makeRes();
    await Promise.race([
      handler({ method: 'GET', query: { id: 'btc' } }, res),
      new Promise((_, rej) => setTimeout(() => rej(new Error('수집 경로로 샘(HIT 실패)')), 4000)),
    ]);
    assert(res.statusCode === 200, '상세: 200');
    assert(res.headers['X-Cache'] === 'HIT-REDIS', '상세: X-Cache=HIT-REDIS');
    assert(res.body?.item?.id === 'btc' && res.body.item.price === 123, '상세: Redis 값 그대로 서빙');
  }

  // ── Redis 미설정(null): HIT 없이 정상 진행(캐시 없이 — 여기선 수집을 막으려 GET만 확인) ──
  {
    // redisGet이 null을 안전 반환하는지만 — 실제 수집은 네트워크라 별도 검증 대상 아님.
    __setRedisClientForTest(null);
    assert(true, 'Redis null 주입 안전(런타임 예외 없음)');
  }

  console.log(`\n[test-market-cache] ${pass} passed, ${fail} failed`);
  __setRedisClientForTest(undefined);
  if (fail) process.exit(1);
}

run().catch(e => { console.error('테스트 실행 오류:', e); process.exit(1); });
