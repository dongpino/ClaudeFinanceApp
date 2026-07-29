/**
 * scripts/test-probe-capture.js — 크론 프로브 적재층 검증(순수 계산, 외부 호출·Redis 없음).
 *
 * 검증 대상:
 *  1. KST 키 생성    — kstDate/kstStamp가 UTC 자정 경계에서 KST 날짜로 넘어간다
 *  2. 크론 스케줄    — vercel.json의 UTC cron이 의도한 KST 시각/요일로 환산된다
 *  3. 기존 크론 보존 — briefing-cron 항목이 그대로 살아 있다(추가가 삭제로 새지 않게)
 *  4. 인증 규약      — CRON_SECRET 베어러 / DEBUG_SIGNALS_KEY 쿼리, 미설정 시 전부 거부
 *  5. 격리 규율      — 프로브가 수집 파이프라인(trackedFetch/collectors)을 import하지 않는다
 *
 * 실행: node scripts/test-probe-capture.js
 */
import { readFileSync } from 'node:fs';
import { kstDate, kstStamp, etStamp, isAuthorized, PROBE_TTL_SEC } from '../api/_lib/probe-store.js';

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', msg); } }

const vercelJson = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const crons = vercelJson.crons ?? [];

// ── 1. KST 키 생성 ─────────────────────────────────────────────
{
  // 23:40 UTC = 다음날 08:40 KST — 크론이 실제로 도는 순간의 경계다. 여기서 UTC 날짜를
  // 쓰면 하루 밀린 필드에 쌓여 "며칠치" 세기가 통째로 어긋난다.
  const at = new Date('2026-07-27T23:40:00Z');
  assert(kstDate(at) === '2026-07-28', `1: kstDate 23:40Z → 다음날 KST (실제: ${kstDate(at)})`);
  assert(kstStamp(at) === '2026-07-28 08:40 KST', `1: kstStamp (실제: ${kstStamp(at)})`);

  const noon = new Date('2026-07-28T14:00:00Z'); // CNBC 크론 시각 = 23:00 KST 같은 날
  assert(kstDate(noon) === '2026-07-28', `1: kstDate 14:00Z는 같은 KST 날짜 (실제: ${kstDate(noon)})`);
  assert(kstStamp(noon) === '2026-07-28 23:00 KST', `1: kstStamp 23:00 (실제: ${kstStamp(noon)})`);

  assert(PROBE_TTL_SEC === 604800, `1: TTL 7일 (실제: ${PROBE_TTL_SEC})`);

  // ET 병기 — 같은 UTC 순간이 계절에 따라 다른 ET 시각/꼬리표로 찍혀야 한다.
  // 이게 기록에 없으면 "23:00 KST 표본"이 장중인지 개장 전인지 사후에 알 수 없다.
  assert(etStamp(noon) === '2026-07-28 10:00 EDT', `1: 여름 ET 꼬리표 (실제: ${etStamp(noon)})`);
  const winter = new Date('2026-12-08T14:00:00Z');
  assert(etStamp(winter) === '2026-12-08 09:00 EST', `1: 겨울 ET 꼬리표 (실제: ${etStamp(winter)})`);
  assert(kstStamp(winter) === '2026-12-08 23:00 KST',
    `1: 같은 순간의 KST는 계절 무관 23:00 (실제: ${kstStamp(winter)})`);
  // 꼬리표를 하드코딩하지 않았는지 — 두 계절의 약어가 실제로 달라야 한다.
  assert(etStamp(noon).slice(-3) !== etStamp(winter).slice(-3), '1: EDT/EST가 구분돼야 함');
}

// ── 2. 크론 스케줄 → KST 환산 ──────────────────────────────────
// UTC cron "m h * * dows"를 KST 시각과 요일 집합으로 되돌린다. 여기서 검증하지 않으면
// "23:40 UTC가 08:40 KST"라는 암산이 코드 어디에도 고정되지 않는다.
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
function cronToKST(schedule) {
  const [min, hour, , , dowSpec] = schedule.split(/\s+/);
  const utcH = Number(hour);
  const kstH = (utcH + 9) % 24;
  const dayShift = utcH + 9 >= 24 ? 1 : 0; // UTC→KST에서 날짜가 넘어가면 요일도 +1
  const utcDows = dowSpec === '*' ? [0, 1, 2, 3, 4, 5, 6]
    : dowSpec.split(',').flatMap(part => {
        const m = /^(\d)-(\d)$/.exec(part);
        if (!m) return [Number(part)];
        const out = [];
        for (let d = Number(m[1]); d <= Number(m[2]); d++) out.push(d);
        return out;
      });
  return {
    time: `${String(kstH).padStart(2, '0')}:${min.padStart(2, '0')}`,
    days: utcDows.map(d => DOW[(d + dayShift) % 7]).join(''),
  };
}

{
  const daum = crons.find(c => c.path === '/api/probe-daum-status');
  assert(!!daum, '2: probe-daum-status 크론이 vercel.json에 있어야 함');
  if (daum) {
    const k = cronToKST(daum.schedule);
    // 08:40 KST = 장 시작(09:00) 20분 전 — 장전 토큰이 나오는 유일한 창.
    assert(k.time === '08:40', `2: daum 08:40 KST (실제: ${k.time})`);
    // 월~토 — 평일 장전 + 토요일 휴장 토큰(둘이 같은 값인지가 관건).
    assert(k.days === '월화수목금토', `2: daum 월~토 (실제: ${k.days})`);
  }

  const cnbc = crons.find(c => c.path === '/api/probe-cnbc-format');
  assert(!!cnbc, '2: probe-cnbc-format 크론이 vercel.json에 있어야 함');
  if (cnbc) {
    const k = cronToKST(cnbc.schedule);
    assert(k.time === '23:00', `2: cnbc 23:00 KST (실제: ${k.time})`);
    // ⚠️ 요청은 화~토였지만 월~금이 맞다 — 23:00 KST는 ET 같은 날 오전이라 요일이 밀리지
    // 않는다(토 23:00 KST = 토 오전 ET = 휴장, 화~토로 잡으면 월요일 장을 놓친다).
    // 이 assert가 그 판단을 고정한다: 되돌리려면 여기부터 고쳐야 한다.
    assert(k.days === '월화수목금', `2: cnbc 월~금(= 미 장중 5일) (실제: ${k.days})`);

    // 서머타임 실검: 14:00 UTC가 여름엔 ET 10:00(장중), 겨울엔 09:00(개장 전).
    const etHour = d => Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
    }).format(d));
    assert(etHour(new Date('2026-07-28T14:00:00Z')) === 10, '2: 여름(EDT) 14:00Z = 10시 ET 장중');
    assert(etHour(new Date('2026-12-08T14:00:00Z')) === 9,
      '2: 겨울(EST) 14:00Z = 9시 ET — 개장 전. 겨울까지 끌면 15:00Z로 옮길 것');
  }
}

// ── 3. 기존 크론 보존 ──────────────────────────────────────────
{
  const briefing = crons.find(c => c.path === '/api/briefing-cron');
  assert(!!briefing && briefing.schedule === '30 23 * * *',
    `3: briefing-cron "30 23 * * *" 그대로여야 함 (실제: ${JSON.stringify(briefing)})`);
  // 총 개수를 고정하는 이유: 크론 추가가 기존 항목 삭제로 새는 사고를 막는다. 늘릴 때는
  // 이 목록을 함께 갱신할 것 — 숫자만 올리면 가드가 무의미해지므로 경로까지 열거한다.
  const expected = ['/api/briefing-cron', '/api/probe-daum-status', '/api/probe-cnbc-format',
    '/api/holiday-audit-cron'];
  assert(crons.map(c => c.path).sort().join(',') === expected.slice().sort().join(','),
    `3: 크론 4개 구성 (실제: ${crons.map(c => c.path).join(',')})`);
  // KASI 자동대조는 일 1회(06:20 KST = 21:20 UTC) — 요일 제한 없음.
  const audit = crons.find(c => c.path === '/api/holiday-audit-cron');
  assert(audit?.schedule === '20 21 * * *', `3: holiday-audit 일 1회 (실제: ${audit?.schedule})`);
  assert(cronToKST(audit.schedule).time === '06:20', `3: 06:20 KST (실제: ${cronToKST(audit.schedule).time})`);
}

// ── 4. 인증 규약 ───────────────────────────────────────────────
{
  const saved = { cron: process.env.CRON_SECRET, dbg: process.env.DEBUG_SIGNALS_KEY };
  try {
    process.env.CRON_SECRET = 'cs';
    process.env.DEBUG_SIGNALS_KEY = 'dk';
    assert(isAuthorized({ headers: { authorization: 'Bearer cs' }, query: {} }), '4: 크론 베어러 통과');
    assert(isAuthorized({ headers: {}, query: { key: 'dk' } }), '4: 수동 키 통과');
    assert(!isAuthorized({ headers: { authorization: 'Bearer wrong' }, query: {} }), '4: 틀린 베어러 거부');
    assert(!isAuthorized({ headers: {}, query: { key: 'wrong' } }), '4: 틀린 키 거부');
    assert(!isAuthorized({ headers: {}, query: {} }), '4: 무인증 거부');

    // 환경변수 미설정이면 그 경로는 성립하지 않는다 — 빈 값끼리 맞아떨어져 뚫리면 안 된다.
    delete process.env.CRON_SECRET;
    delete process.env.DEBUG_SIGNALS_KEY;
    assert(!isAuthorized({ headers: { authorization: 'Bearer undefined' }, query: {} }),
      '4: CRON_SECRET 미설정 시 베어러 거부');
    assert(!isAuthorized({ headers: {}, query: { key: '' } }), '4: DEBUG_SIGNALS_KEY 미설정 시 키 거부');
  } finally {
    if (saved.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.cron;
    if (saved.dbg === undefined) delete process.env.DEBUG_SIGNALS_KEY; else process.env.DEBUG_SIGNALS_KEY = saved.dbg;
  }
}

// ── 5. 격리 규율 ───────────────────────────────────────────────
// 프로브가 수집 경로를 import하면 (a) trackedFetch로 health가 오염되고
// (b) "실패해도 무영향"이 깨진다. 소스로 직접 고정한다.
{
  // 주석은 걷어내고 본다 — 이 파일들의 헤더 주석이 "trackedFetch를 쓰지 않는 이유"를
  // 설명하느라 그 단어를 담고 있어서, 원문 그대로 검사하면 설명이 위반으로 잡힌다.
  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const f of ['../api/probe-daum-status.js', '../api/probe-cnbc-format.js']) {
    const src = stripComments(readFileSync(new URL(f, import.meta.url), 'utf8'));
    const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map(m => m[1]);
    assert(imports.every(p => p === './_lib/probe-store.js'),
      `5: ${f}는 probe-store만 import해야 함 (실제: ${imports.join(', ')})`);
    assert(!/trackedFetch/.test(src), `5: ${f}에 trackedFetch 금지(health 오염)`);
    // 판정 로직 금지(요구사항) — 원문 그대로 적재만.
    assert(!/DAUM_STATUS_MAP|normalizeStatus/.test(src), `5: ${f}에 토큰 정규화 금지`);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} test-probe-capture: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
