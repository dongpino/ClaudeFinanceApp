/**
 * scripts/test-rss-retry.js — RSS 네트워크 재시도 동작 고정 (목킹, 외부 네트워크 미사용)
 *
 * 배경: rss-yna가 2026-07-25부터 프로덕션 성공률 ~20%로 떨어졌는데 로컬 웜 호출은
 * 90~100%였다. 실패 정체는 ECONNRESET/timeout(커넥션 계열)이고, 바로 다음 시도는
 * 성공하는 패턴이었다 → 네트워크 계열 1회 재시도를 4피드 공통으로 도입.
 *
 * 이 테스트가 고정하는 계약:
 *   1. 네트워크 계열(ECONNRESET/timeout) 1회 실패 → 재시도 성공 → 최종 성공,
 *      health는 success로 집계되고 retry:attempt/retry:recovered가 각각 +1
 *   2. HTTP 4xx는 재시도하지 않는다(같은 답이 올 뿐 — 지연·상대 부담만 늘린다)
 *   3. 두 번 다 네트워크 실패면 failure 1건 + retry:attempt만 +1(recovered 없음)
 *
 * 구현: KV 쓰기를 로컬 HTTP 싱크로 받아 파이프라인 원문을 직접 검사하고,
 * globalThis.fetch를 가로채 RSS URL만 시나리오로 응답한다(KV 호출은 원본 fetch로 통과).
 * 실행: node scripts/test-rss-retry.js
 */
import http from 'node:http';

// ── KV 싱크 (health 기록 관측) ──────────────────────────────────
const writes = [];
const sink = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let n = 1;
    try { const cmds = JSON.parse(body); writes.push(...cmds); n = cmds.length; } catch { /* noop */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.from({ length: n }, () => ({ result: 1 }))));
  });
});
await new Promise(r => sink.listen(0, '127.0.0.1', r));
process.env.KV_REST_API_URL   = `http://127.0.0.1:${sink.address().port}`;
process.env.KV_REST_API_TOKEN = 'test-token';

// ── RSS 응답 목킹 ───────────────────────────────────────────────
const XML = (n = 12) => '<?xml version="1.0"?><rss><channel>' +
  Array.from({ length: n }, (_, i) =>
    `<item><title>코스피 급등 테스트 기사 ${i}</title><description>증시 상승 요약</description>` +
    `<pubDate>${new Date().toUTCString()}</pubDate><link>https://example.test/${i}</link></item>`).join('') +
  '</channel></rss>';

const okRes = () => new Response(XML(), { status: 200, headers: { 'content-type': 'application/xml' } });
const httpRes = status => new Response('nope', { status, headers: { 'content-type': 'text/plain' } });
const netErr = (code = 'ECONNRESET') => {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error(`read ${code}`), { code });
  return e;
};
const abortErr = () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; };

const realFetch = globalThis.fetch;
let scenario = {};          // host조각 → 응답 시퀀스(꺼내 쓰는 큐)
let callCount = {};         // host조각 → 호출 횟수

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith(process.env.KV_REST_API_URL)) return realFetch(url, opts);
  const key = Object.keys(scenario).find(k => u.includes(k));
  if (!key) throw new Error(`목킹되지 않은 URL: ${u}`);
  callCount[key] = (callCount[key] ?? 0) + 1;
  const step = scenario[key].shift() ?? scenario[key].last;
  scenario[key].last = step;
  if (typeof step === 'function') {
    const out = step();
    if (out instanceof Error) throw out;
    return out;
  }
  return step;
};

const { collectRSSNews } = await import('../api/_collectors/rss.js');

const settle = () => new Promise(r => setTimeout(r, 900));
const reset  = () => { writes.length = 0; callCount = {}; };
const cmds   = () => writes.map(c => c.join(' '));
const has    = re => cmds().some(c => re.test(c));

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✗ FAIL:', m); } };

// 항상 성공하는 나머지 두 피드(테스트 대상은 yna 하나로 고정)
const healthyOthers = () => ({
  'asiae.co.kr':  [okRes, okRes, okRes],
  'edaily.co.kr': [okRes, okRes, okRes],
});

// ── 1. ECONNRESET → 재시도 성공 ────────────────────────────────
reset();
scenario = { 'yna.co.kr': [() => netErr('ECONNRESET'), okRes], ...healthyOthers() };
let news = await collectRSSNews(8);
await settle();
assert(callCount['yna.co.kr'] === 2, `ECONNRESET: yna를 2회 호출(재시도 발동). 실제 ${callCount['yna.co.kr']}회`);
assert(has(/hincrby health:daily:rss-yna:\S+ retry:attempt 1/), 'ECONNRESET: retry:attempt +1');
assert(has(/hincrby health:daily:rss-yna:\S+ retry:recovered 1/), 'ECONNRESET: retry:recovered +1');
assert(has(/hincrby health:daily:rss-yna:\S+ success 1/), 'ECONNRESET: 최종 success로 집계');
assert(!has(/hincrby health:daily:rss-yna:\S+ failure 1/), 'ECONNRESET: 구제된 건은 failure로 안 셈');
assert(news.length > 0, 'ECONNRESET: 기사 수집됨(수집 결과 정상)');

// ── 2. AbortError(타임아웃) → 재시도 성공 ──────────────────────
reset();
scenario = { 'yna.co.kr': [abortErr, okRes], ...healthyOthers() };
await collectRSSNews(8);
await settle();
assert(callCount['yna.co.kr'] === 2, 'timeout: 재시도 발동');
assert(has(/retry:recovered 1/), 'timeout: 구제 카운트');
assert(has(/hincrby health:daily:rss-yna:\S+ success 1/), 'timeout: 최종 success');

// ── 3. HTTP 404 → 재시도 없음 ──────────────────────────────────
reset();
scenario = { 'yna.co.kr': [() => httpRes(404), okRes], ...healthyOthers() };
await collectRSSNews(8);
await settle();
assert(callCount['yna.co.kr'] === 1, `404: 재시도 없이 1회만 호출. 실제 ${callCount['yna.co.kr']}회`);
assert(!has(/retry:attempt/), '404: retry 카운터 미발동');
assert(has(/hincrby health:daily:rss-yna:\S+ err:http-404 1/), '404: err:http-404 히스토그램');
assert(has(/hincrby health:daily:rss-yna:\S+ failure 1/), '404: failure로 집계');

// ── 4. HTTP 500 → 재시도 없음 ──────────────────────────────────
reset();
scenario = { 'yna.co.kr': [() => httpRes(500), okRes], ...healthyOthers() };
await collectRSSNews(8);
await settle();
assert(callCount['yna.co.kr'] === 1, '500: 재시도 없이 1회만 호출');
assert(has(/err:http-500 1/), '500: err:http-500 히스토그램');

// ── 5. 두 번 다 네트워크 실패 → 최종 실패 ──────────────────────
reset();
scenario = { 'yna.co.kr': [() => netErr('ECONNRESET'), () => netErr('ECONNRESET')], ...healthyOthers() };
news = await collectRSSNews(8);
await settle();
assert(callCount['yna.co.kr'] === 2, '연속 실패: 2회까지만 시도(무한 재시도 아님)');
assert(has(/retry:attempt 1/), '연속 실패: retry:attempt +1');
assert(!has(/retry:recovered/), '연속 실패: recovered 미증가');
assert(has(/hincrby health:daily:rss-yna:\S+ failure 1/), '연속 실패: failure 1건');
assert(has(/err:ECONNRESET 1/), '연속 실패: err:ECONNRESET 히스토그램');
assert(news.length > 0, '연속 실패: 나머지 피드로 기사 확보(graceful fallback 유지)');

// ── 6. 다른 피드에도 동일 적용(yna 전용 특례 아님) ─────────────
reset();
scenario = {
  'yna.co.kr': [okRes],
  'asiae.co.kr': [() => netErr('ETIMEDOUT'), okRes],
  'edaily.co.kr': [okRes],
};
await collectRSSNews(8);
await settle();
assert(callCount['asiae.co.kr'] === 2, 'asiae도 동일하게 재시도(4피드 공통 적용)');
assert(has(/hincrby health:daily:rss-asiae:\S+ retry:recovered 1/), 'asiae: 구제 카운트');

sink.close();
globalThis.fetch = realFetch;
console.log(`\n[test-rss-retry] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
