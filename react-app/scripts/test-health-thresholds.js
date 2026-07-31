/**
 * scripts/test-health-thresholds.js — judgeStatus의 기대주기 허용폭 고정(순수 계산).
 *
 * 홈 시세류는 크론이 아니라 사용자 트래픽으로 도는데 market-data.js가 Redis 공유 캐시
 * 5분을 앞단에 둬서 실호출 간격이 그만큼 벌어진다. coingecko/cnbc가 5분 기준(허용 15분)
 * 이었을 때 "앱을 15분만 안 열면 지연" 오탐이 났던 것을 회귀로 막는다.
 * 실행: node scripts/test-health-thresholds.js
 */
import {
  judgeStatus, storeFingerprint, envCounts, errorCounts, classifyError, kstHour, ENV_TAG,
} from '../api/_lib/health.js';

const NOW = Date.parse('2026-07-27T12:00:00Z');
const agoHours = h => new Date(NOW - h * 3600_000).toISOString();

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', msg); } }
const judge = (src, hours, extra = {}) =>
  judgeStatus(src, { lastSuccessAt: agoHours(hours), consecutiveFailures: 0, ...extra }, NOW);

// ── coingecko / cnbc: 8h 기대주기 → 24h까지 ok ──────────────────
for (const src of ['coingecko', 'cnbc']) {
  assert(judge(src, 0.5) === 'ok',  `${src}: 30분 전 성공 → ok`);
  assert(judge(src, 6)   === 'ok',  `${src}: 6시간 전 → ok (구 기준이면 stale이던 구간)`);
  assert(judge(src, 20)  === 'ok',  `${src}: 20시간 전 → ok (일 1회 크론 안쪽)`);
  assert(judge(src, 25)  === 'stale', `${src}: 25시간 전 → stale (크론도 안 돈 것)`);
}

// ── 온디맨드 소스(binance/twelvedata): 나이 기반 판정 배제 ──────
// 분석 탭/상세를 열 때만 호출돼 "호출 보장 하한"이 없다. 며칠 안 열었다고 '지연'이
// 뜨면 안 되고, 반대로 며칠 전 성공으로 초록불을 켜 둬도 안 된다(거짓 안심).
// 실제 사고(2026-07-27): exchangeInfo 미상장 400 1건이 binance를 '지연'으로 만들었다.
for (const src of ['binance', 'twelvedata']) {
  // 마지막 시도가 24h 안 → 나이와 무관하게 그 성패로만 판정
  assert(judge(src, 20) === 'ok', `${src}: 20시간 전 성공 → ok (나이 무시)`);
  assert(judgeStatus(src, { lastSuccessAt: agoHours(20), lastFailureAt: agoHours(2),
    consecutiveFailures: 1 }, NOW) === 'stale', `${src}: 최근 시도가 실패 → stale`);
  assert(judgeStatus(src, { lastSuccessAt: agoHours(2), lastFailureAt: agoHours(20),
    consecutiveFailures: 0 }, NOW) === 'ok', `${src}: 최근 시도가 성공 → ok (옛 실패 무시)`);

  // 마지막 시도가 24h 초과 → idle. 성공이든 실패든 현재 상태의 근거가 못 된다.
  assert(judge(src, 30) === 'idle', `${src}: 30시간 전 성공 → idle (미호출)`);
  assert(judgeStatus(src, { lastSuccessAt: agoHours(120), lastFailureAt: agoHours(30),
    consecutiveFailures: 1 }, NOW) === 'idle', `${src}: 5일 방치 → stale 아닌 idle`);

  // 예외 규칙은 그대로 우선한다
  assert(judgeStatus(src, { lastSuccessAt: agoHours(1), consecutiveFailures: 3 }, NOW) === 'down',
    `${src}: cf>=3이면 온디맨드라도 down`);
  assert(judgeStatus(src, null, NOW) === 'unknown', `${src}: 기록 없음 → unknown`);
}
// 온디맨드 소스는 EXPECTED_INTERVAL_SEC에 남아 있으면 안 된다(값이 죽은 채 오해를 부름).
assert(judge('binance', 30) !== judge('coingecko', 30),
  'binance는 coingecko의 8h 기준을 따라가지 않는다');

// ── 기존 기준이 흔들리지 않았는지(회귀) ─────────────────────────
assert(judge('naver', 0.1)  === 'ok',    'naver: 6분 전 → ok');
assert(judge('naver', 0.5)  === 'stale', 'naver: 30분 전 → stale (5분 기준 유지)');
assert(judge('fred', 20)    === 'ok',    'fred: 20시간 전 → ok (12h 기준)');
assert(judge('fred', 40)    === 'stale', 'fred: 40시간 전 → stale');
assert(judge('rss-yna', 5)  === 'ok',    'rss-yna: 5시간 전 → ok (3h 기준)');
assert(judge('rss-yna', 10) === 'stale', 'rss-yna: 10시간 전 → stale');

// ── 연속 실패/이력 없음 규칙 ────────────────────────────────────
assert(judgeStatus('coingecko', { lastSuccessAt: agoHours(1), consecutiveFailures: 3 }, NOW) === 'down',
  'cf>=3이면 나이와 무관하게 down');
assert(judgeStatus('coingecko', null, NOW) === 'unknown', '기록 없음 → unknown');
assert(judgeStatus('coingecko', { lastFailureAt: agoHours(1), consecutiveFailures: 1 }, NOW) === 'stale',
  '성공 이력 없이 실패만(cf<3) → stale');

// ── 스토어 지문 / 환경 태그 ─────────────────────────────────────
// 로컬 .env.local이 프로덕션과 다른 KV를 가리켜 개발 DB를 덤프했던 사고(2026-07-27)
// 재발 방지층. 지문은 결정적이어야 하고, 호스트 원문을 담아선 안 된다.
{
  const A = 'https://correct-marten-133336.upstash.io';
  const B = 'https://exotic-ladybug-115699.upstash.io';
  assert(storeFingerprint(A) === storeFingerprint(A), '지문: 같은 URL → 같은 값(결정적)');
  assert(storeFingerprint(A) !== storeFingerprint(B), '지문: 다른 DB → 다른 값');
  assert(/^[0-9a-f]{8}$/.test(storeFingerprint(A)), '지문: hex 8자');
  assert(!storeFingerprint(A).includes('marten'), '지문: 호스트 원문 미포함');
  // 포트/경로/스킴이 붙어도 같은 호스트면 같은 지문
  assert(storeFingerprint('correct-marten-133336.upstash.io') === storeFingerprint(`${A}/`),
    '지문: 스킴/트레일링 슬래시 무시');
  assert(storeFingerprint(undefined) === null || typeof storeFingerprint(undefined) === 'string',
    '지문: 미설정이면 null');
  assert(storeFingerprint('') === null, '지문: 빈 문자열 → null');

  assert(typeof ENV_TAG === 'string' && ENV_TAG.length > 0, 'ENV_TAG: 항상 문자열');
  assert(ENV_TAG === (process.env.VERCEL_ENV ?? 'local'), 'ENV_TAG: VERCEL_ENV 없으면 local');

  assert(JSON.stringify(envCounts({ success: '5', failure: '1', 'env:production': '4', 'env:local': '2' }))
    === JSON.stringify({ production: 4, local: 2 }), 'envCounts: env:* 필드만 추출');
  assert(JSON.stringify(envCounts(null)) === '{}', 'envCounts: null → {}');
  assert(JSON.stringify(envCounts({ success: '5' })) === '{}', 'envCounts: env 필드 없으면 {}');
}

// ── classifyError: undici cause까지 벗겨내는지 ──────────────────
// rss-yna 간헐 실패가 lastError "fetch failed"로만 남아 정체 규명이 불가능했다.
// 진짜 원인은 err.cause.code에 있다 — 그걸 못 꺼내면 히스토그램이 무의미해진다.
{
  const wrapped = (code, message = 'some detail') => {
    const e = new TypeError('fetch failed');
    e.cause = Object.assign(new Error(message), code ? { code } : {});
    return e;
  };
  assert(classifyError(wrapped('ECONNRESET')) === 'ECONNRESET', 'cause.code ECONNRESET 추출');
  assert(classifyError(wrapped('ENOTFOUND')) === 'ENOTFOUND', 'cause.code ENOTFOUND 추출');
  assert(classifyError(wrapped('UND_ERR_CONNECT_TIMEOUT')) === 'UND_ERR_CONNECT_TIMEOUT',
    'undici 커넥트 타임아웃 코드 추출');
  assert(classifyError(new TypeError('fetch failed')) === 'fetch-failed',
    'cause 없는 fetch failed → fetch-failed');

  assert(classifyError(new Error('HTTP 403')) === 'http-403', 'HTTP 상태 → http-403');
  assert(classifyError(new Error('HTTP 429')) === 'http-429', 'HTTP 상태 → http-429');
  assert(classifyError(new Error('non-XML 응답 — 챌린지 의심')) === 'non-xml', '챌린지 → non-xml');

  const abort = new Error('The operation was aborted'); abort.name = 'AbortError';
  assert(classifyError(abort) === 'timeout', 'AbortError → timeout');
  const tout = new Error('timed out'); tout.name = 'TimeoutError';
  assert(classifyError(tout) === 'timeout', 'TimeoutError → timeout');

  // 해시 필드명이 되므로 카디널리티가 폭발하면 안 된다 — 공백/특수문자 정규화 확인
  const weird = new TypeError('fetch failed');
  weird.cause = Object.assign(new Error('x'), { code: 'WEIRD CODE: with/slash' });
  const c = classifyError(weird);
  assert(/^[A-Za-z0-9._-]+$/.test(c), `코드 정규화(해시 필드 안전): ${c}`);
  assert(c.length <= 40, '코드 길이 40자 이하로 클램프');
  assert(classifyError(null) === 'unknown', 'null → unknown');
}

// ── errorCounts / kstHour ───────────────────────────────────────
{
  assert(JSON.stringify(errorCounts({ success: '3', failure: '11', 'err:ECONNRESET': '9', 'err:http-403': '2' }))
    === JSON.stringify({ ECONNRESET: 9, 'http-403': 2 }), 'errorCounts: err:* 필드만 추출');
  assert(JSON.stringify(errorCounts(null)) === '{}', 'errorCounts: null → {}');
  // env:*와 err:*가 같은 해시에 섞여 있어도 서로 침범하지 않아야 한다
  const mixed = { 'env:production': '5', 'err:timeout': '2' };
  assert(JSON.stringify(envCounts(mixed)) === JSON.stringify({ production: 5 }), 'envCounts: err:* 미포함');
  assert(JSON.stringify(errorCounts(mixed)) === JSON.stringify({ timeout: 2 }), 'errorCounts: env:* 미포함');

  // KST 시간 버킷: UTC 15:00 = KST 자정 → 날짜가 넘어가고 시각은 '00'(24 아님)
  assert(kstHour(new Date('2026-07-27T15:00:00Z')) === '2026-07-28T00',
    'kstHour: UTC 15:00 → KST 익일 00시 (h23, 24 아님)');
  assert(kstHour(new Date('2026-07-27T14:59:59Z')) === '2026-07-27T23', 'kstHour: 경계 직전 23시');
  assert(kstHour(new Date('2026-07-27T05:39:28Z')) === '2026-07-27T14', 'kstHour: UTC 05:39 → KST 14시');
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(kstHour()), 'kstHour: YYYY-MM-DDTHH 형식');
}

// ── 빌드 신원(build) — 값 노출 금지가 핵심 성질이다 ─────────────────────
{
  const { buildIdentity } = await import('../api/health.js');
  const SAVED = { ...process.env };
  try {
    // 실제 Vercel 런타임 형상을 흉내낸다(값에 비밀이 섞여 있는 상황).
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_GIT_COMMIT_SHA = '190449a1234567890abcdef1234567890abcdef12';
    process.env.VERCEL_GIT_COMMIT_REF = 'master';
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_TESTONLY';
    process.env.VERCEL_REGION = 'icn1';
    process.env.VERCEL_OIDC_TOKEN = 'SECRET-MUST-NOT-LEAK';

    const b = buildIdentity();
    assert(b.commitSha === '190449a1234567890abcdef1234567890abcdef12', 'build: commitSha 노출');
    assert(b.commitRef === 'master' && b.vercelEnv === 'production', 'build: ref/env 노출');
    assert(b.deploymentId === 'dpl_TESTONLY' && b.region === 'icn1', 'build: deploymentId/region 노출');

    // ⭐ 핵심 — envKeys는 **이름만** 담는다. 값이 한 글자라도 섞이면 실패한다.
    assert(Array.isArray(b.envKeys), 'build: envKeys는 배열');
    assert(b.envKeys.includes('VERCEL_OIDC_TOKEN'), 'build: 키 이름은 담는다');
    const flat = JSON.stringify(b.envKeys);
    assert(!flat.includes('SECRET-MUST-NOT-LEAK'), 'build: ⚠️ envKeys에 값이 섞이면 안 된다');
    assert(!flat.includes('dpl_TESTONLY'), 'build: envKeys에 deploymentId 값도 섞이지 않는다');
    assert(b.envKeys.every(k => typeof k === 'string' && k.startsWith('VERCEL')),
      'build: VERCEL 접두 키만, 전부 문자열');
    assert(b.envKeys.every(k => process.env[k] !== undefined), 'build: 실재하는 키만');
    const sorted = [...b.envKeys].sort();
    assert(JSON.stringify(b.envKeys) === JSON.stringify(sorted), 'build: 정렬됨');

    // 미주입 환경(로컬)에서는 null — "설정 꺼짐"과 구분하는 신호가 envKeys다.
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const b2 = buildIdentity();
    assert(b2.commitSha === null, 'build: 미주입이면 null(undefined 아님)');
    assert(!b2.envKeys.includes('VERCEL_GIT_COMMIT_SHA'),
      'build: 키가 사라지면 envKeys에서도 빠진다 — 노출 설정 꺼짐 판별의 근거');

    // 매 호출 새로 계산한다(모듈 상수로 굳으면 목적이 무너진다)
    process.env.VERCEL_GIT_COMMIT_SHA = 'aaaaaaa';
    assert(buildIdentity().commitSha === 'aaaaaaa', 'build: 매 호출 process.env에서 다시 읽는다');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
    Object.assign(process.env, SAVED);
  }
}

console.log(`\n${fail === 0 ? '✓ 전체 통과' : '✗ 실패 있음'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
