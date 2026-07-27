/**
 * scripts/test-health-thresholds.js — judgeStatus의 기대주기 허용폭 고정(순수 계산).
 *
 * 홈 시세류는 크론이 아니라 사용자 트래픽으로 도는데 market-data.js가 Redis 공유 캐시
 * 5분을 앞단에 둬서 실호출 간격이 그만큼 벌어진다. coingecko/cnbc가 5분 기준(허용 15분)
 * 이었을 때 "앱을 15분만 안 열면 지연" 오탐이 났던 것을 회귀로 막는다.
 * 실행: node scripts/test-health-thresholds.js
 */
import { judgeStatus, storeFingerprint, envCounts, ENV_TAG } from '../api/_lib/health.js';

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

console.log(`\n${fail === 0 ? '✓ 전체 통과' : '✗ 실패 있음'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
