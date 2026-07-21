/**
 * scripts/test-last-good.js — _lib/last-good.js 로직 검증(실제 Redis 없이 인메모리 페이크).
 *
 * 스테이징/Redis 대상 검증(coingecko 키 손상 재현, TTL=-1 실측 등)은 배포 환경에서
 * 수동으로 하고, 여기서는 헬퍼의 순수 병합/commit/fill/오염방지/TTL-없음 규약을
 * 결정적으로 확인한다.  실행: node scripts/test-last-good.js
 */
import { applyLastGoodFallback, __setRedisClientForTest } from '../api/_lib/last-good.js';
import { classifySource, SOURCES, getHealthSnapshot } from '../api/_lib/health.js';

// ── 인메모리 페이크 Redis (pipeline().get/set + exec만 구현) ──
function makeFakeRedis() {
  const store = new Map();     // key → value
  const setCalls = [];         // { key, value, options } — TTL 유무 검증용
  function pipeline() {
    const ops = [];
    return {
      get(key) { ops.push(() => store.get(key) ?? null); return this; },
      set(key, value, options) {
        ops.push(() => { store.set(key, value); setCalls.push({ key, value, options }); return 'OK'; });
        return this;
      },
      async exec() { return ops.map(op => op()); },
    };
  }
  return { pipeline, _store: store, _setCalls: setCalls };
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', msg); } }

const priceItem = (id, over = {}) => ({ id, price: 100, history: Array.from({ length: 10 }, (_, i) => ({ close: i })), ...over });
const validate = it => it && Number.isFinite(it.price) && it.price > 0 && Array.isArray(it.history) && it.history.length >= 5;

async function run() {
  // ── 1. 전량 성공: commit + asOf 부착 + stale 없음 ──────────────
  {
    const fake = makeFakeRedis(); __setRedisClientForTest(fake);
    const { items, stale } = await applyLastGoodFallback({
      ns: 'test', collected: [priceItem('a'), priceItem('b')], commitIds: ['a', 'b'], validate,
    });
    assert(stale.length === 0, '1: stale 없음');
    assert(items.every(it => typeof it.asOf === 'string'), '1: 모든 아이템에 asOf');
    assert(items.every(it => !it.stale), '1: stale 플래그 없음');
    assert(fake._setCalls.length === 2, '1: lastGood 2건 저장');
    assert(fake._setCalls.every(c => c.options === undefined), '1: TTL 옵션 없음(무기한)');
    assert(fake._store.has('lastgood:test:a') && fake._store.has('lastgood:test:b'), '1: 키 저장됨');
  }

  // ── 2. 오염 방지: 유효하지 않은 신선분은 commit 안 됨 ──────────
  {
    const fake = makeFakeRedis(); __setRedisClientForTest(fake);
    await applyLastGoodFallback({
      ns: 'test', collected: [priceItem('a', { price: 0 }), priceItem('b', { history: [] }), { id: 'c', price: null }],
      commitIds: ['a', 'b', 'c'], validate,
    });
    assert(fake._setCalls.length === 0, '2: 이상값(가격0/빈history/null)은 lastGood 미저장');
  }

  // ── 3. 실패 후 폴백: 저장된 성공본을 stale로 서빙(asOf=저장시각) ─
  {
    const fake = makeFakeRedis(); __setRedisClientForTest(fake);
    // 먼저 성공 저장
    await applyLastGoodFallback({ ns: 'test', collected: [priceItem('a', { price: 111 })], commitIds: ['a'], validate });
    const savedAsOf = fake._store.get('lastgood:test:a').asOf;
    // 이후 수집 실패(collected=[]) → 폴백 서빙
    const { items, stale } = await applyLastGoodFallback({
      ns: 'test', collected: [], commitIds: ['a'], validate, errorSummary: 'coingecko down',
    });
    assert(stale.includes('a'), '3: a가 stale로 폴백');
    const a = items.find(it => it.id === 'a');
    assert(a && a.stale === true, '3: stale:true 부착');
    assert(a.price === 111, '3: 마지막 성공값 서빙');
    assert(a.asOf === savedAsOf, '3: asOf=성공본 수집시각');
    assert(a.error === 'coingecko down', '3: error 요약 부착');
  }

  // ── 4. 성공본 없는 신규 심볼: 그냥 빠짐(기존 동작) ─────────────
  {
    const fake = makeFakeRedis(); __setRedisClientForTest(fake);
    const { items, stale } = await applyLastGoodFallback({
      ns: 'test', collected: [], commitIds: ['newsym'], validate,
    });
    assert(items.length === 0 && stale.length === 0, '4: 폴백 성공본 없으면 미포함');
  }

  // ── 5. 범위 밖 아이템은 통과 + asOf만 보강 / fill은 요청분만 ────
  {
    const fake = makeFakeRedis(); __setRedisClientForTest(fake);
    // dominance 성공본 미리 저장
    await applyLastGoodFallback({ ns: 'test', collected: [priceItem('dominance')], commitIds: ['dominance'], validate });
    fake._setCalls.length = 0;
    // btc(범위 밖) + 실패한 dominance만 요청, commit은 전체 scope지만 fill은 요청분에 한정 X
    const { items } = await applyLastGoodFallback({
      ns: 'test', collected: [priceItem('btc')], commitIds: ['kospi', 'dominance'], fillIds: ['btc'], validate,
    });
    const btc = items.find(it => it.id === 'btc');
    assert(btc && typeof btc.asOf === 'string' && !btc.stale, '5: 범위 밖(btc) 통과+asOf');
    assert(!items.some(it => it.id === 'dominance'), '5: fill 범위(btc)에 없는 dominance는 폴백 안 함');
  }

  // ── 6. Redis 없음: 폴백/commit 없이 신선분만(수집 절대 안 깨짐) ─
  {
    __setRedisClientForTest(null);
    const { items, stale } = await applyLastGoodFallback({
      ns: 'test', collected: [priceItem('a')], commitIds: ['a', 'b'], validate,
    });
    assert(items.length === 1 && items[0].id === 'a' && stale.length === 0, '6: Redis 없으면 신선분만, 예외 없음');
  }

  // ── 7. CNBC 미국 지수: servable로 라이브 노출, commit은 완전분만 ─
  {
    const fake = makeFakeRedis(); __setRedisClientForTest(fake);
    const servable = it => it && Number.isFinite(it.price) && it.price > 0;
    // nasdaq: quote는 성공(가격 有)했지만 history 서브페치 실패(빈 배열) → 라이브 노출, commit 없음
    const { items, stale } = await applyLastGoodFallback({
      ns: 'market', collected: [priceItem('nasdaq', { history: [] })],
      commitIds: ['nasdaq'], validate, servable,
    });
    const nasdaq = items.find(it => it.id === 'nasdaq');
    assert(nasdaq && typeof nasdaq.asOf === 'string' && !nasdaq.stale, '7: CNBC 지수 history 실패해도 라이브 노출');
    assert(stale.length === 0, '7: 라이브 값이 있으면 stale 폴백 안 함');
    assert(fake._setCalls.length === 0, '7: 불완전 스냅샷은 lastGood 미승격(오염 방지)');
  }

  // ── 8. CNBC quote 죽음: 저장된 성공본으로 폴백(us-indices 사각지대) ─
  {
    const fake = makeFakeRedis(); __setRedisClientForTest(fake);
    const servable = it => it && Number.isFinite(it.price) && it.price > 0;
    await applyLastGoodFallback({ ns: 'market', collected: [priceItem('sox', { price: 5000 })], commitIds: ['sox'], validate, servable });
    const { items, stale } = await applyLastGoodFallback({
      ns: 'market', collected: [], commitIds: ['sox'], validate, servable, errorSummary: 'CNBC 응답 형식 오류',
    });
    const sox = items.find(it => it.id === 'sox');
    assert(stale.includes('sox') && sox?.stale === true && sox.price === 5000, '8: CNBC 죽으면 US 지수 stale 폴백');
    assert(sox.error === 'CNBC 응답 형식 오류', '8: CNBC 폴백 error 요약 부착');
  }

  // ── 9. health: CNBC quote 호스트가 'cnbc'로 분류되고 SOURCES에 등장 ─
  {
    assert(classifySource('https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=.IXIC') === 'cnbc', '9: CNBC quote → cnbc');
    assert(classifySource('https://cdn.cboe.com/api/global/us_indices/VIX_History.csv') === null, '9: CBOE는 여전히 비대상(null)');
    assert(SOURCES.includes('cnbc'), '9: SOURCES에 cnbc 포함(/api/health 노출)');
  }

  // ── 10. getHealthSnapshot이 lastError 필드를 노출하는지(관측성 갭 보완) ─
  {
    const snap = await getHealthSnapshot(); // Redis 미설정 → unknown 배열
    assert(Array.isArray(snap) && snap.length === SOURCES.length, '10: 스냅샷 = 전 소스');
    assert(snap.every(s => 'lastError' in s), '10: 모든 항목에 lastError 필드 노출');
  }

  console.log(`\n[test-last-good] ${pass} passed, ${fail} failed`);
  __setRedisClientForTest(undefined);
  if (fail) process.exit(1);
}

run().catch(e => { console.error('테스트 실행 오류:', e); process.exit(1); });
