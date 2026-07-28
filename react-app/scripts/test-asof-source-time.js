/**
 * scripts/test-asof-source-time.js — as_of가 "호출 시각"이 아니라 "소스 갱신 시각"을
 * 반영하는지 고정 (목킹, 외부 네트워크 미사용).
 *
 * 배경(2026-07-28 감사): 여러 수집기가 as_of에 fmtKST()(호출 시각)를 찍고 있었다.
 * 하루 1회만 갱신되는 지표에서도 "지금 값"인 것처럼 보여, 오후에 열면 오전 09:00
 * 기준 데이터에 오후 시각이 찍혔다. 소스가 시각 필드를 주는데도 안 쓰고 있었다.
 *
 * 이 테스트가 고정하는 계약:
 *   1. fear-greed  — as_of 날짜 = data[0].timestamp의 날짜, history 마지막 날짜와 일치
 *   2. dominance   — as_of 날짜 = updated_at을 KST로 환산한 날짜
 *   3. 둘 다 "오늘"이 아닌 과거 timestamp를 주면 그 과거 날짜가 나와야 한다
 *      (호출 시각으로 덮어쓰지 않는다 — 이게 원래 버그였다)
 *   4. UTC/KST 경계: updated_at이 15:00Z 이후면 KST로는 다음 날이다
 *   5. 시각 필드가 없으면 크래시하지 않고 현재 시각으로 폴백
 *
 * 실행: node scripts/test-asof-source-time.js
 */

const realFetch = globalThis.fetch;
let routes = {};
globalThis.fetch = async (url) => {
  const u = String(url);
  const key = Object.keys(routes).find(k => u.includes(k));
  if (!key) throw new Error(`목킹되지 않은 URL: ${u}`);
  const body = routes[key];
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

const { collectFearGreed } = await import('../api/_collectors/fear-greed.js');
const { collectBtcDominance } = await import('../api/_collectors/btc-dominance.js');

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) { pass++; } else { fail++; console.error('  ✗ FAIL:', m); } };

// 오늘(KST)을 문자열로 — "과거 날짜가 나왔다"를 검사하려면 오늘이 뭔지 알아야 한다.
const todayKST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

// ── 1. fear-greed: 소스 timestamp를 쓰는가 ──────────────────────
{
  // 2026-07-20T00:00:00Z — 오늘이 아닌 과거로 고정
  const ts = Math.floor(Date.parse('2026-07-20T00:00:00Z') / 1000);
  const day = 86400;
  routes = {
    'alternative.me': { data: [
      { value: '29', value_classification: 'Fear',    timestamp: String(ts) },
      { value: '31', value_classification: 'Fear',    timestamp: String(ts - day) },
      { value: '55', value_classification: 'Neutral', timestamp: String(ts - 2 * day) },
    ] },
  };
  const it = await collectFearGreed({ include90d: false });

  assert(it.as_of.startsWith('2026-07-20'), `1: 소스 timestamp의 날짜 사용 (실제: "${it.as_of}")`);
  assert(!it.as_of.startsWith(todayKST), '1: 호출 시각(오늘)으로 덮어쓰지 않음');
  assert(/\(.+\)/.test(it.as_of), `1: 'YYYY-MM-DD (라벨)' 형식 (실제: "${it.as_of}")`);
  assert(it.as_of.slice(0, 10) === it.history.at(-1).date,
    `1: as_of 날짜 == history 마지막 날짜 (${it.as_of.slice(0, 10)} vs ${it.history.at(-1).date})`);
  assert(it.price === 29 && it.grade === 'Fear', '1: 기존 값 파싱 무영향(회귀)');
}

// ── 2. dominance: updated_at을 KST 날짜로 ───────────────────────
{
  routes = {
    'coingecko.com': { data: {
      market_cap_percentage: { btc: 56.37 },
      updated_at: Math.floor(Date.parse('2026-07-20T04:55:58Z') / 1000), // KST 13:55, 같은 날
    } },
  };
  const it = await collectBtcDominance({ include90d: false });
  assert(it.as_of.startsWith('2026-07-20'), `2: updated_at의 KST 날짜 사용 (실제: "${it.as_of}")`);
  assert(!it.as_of.startsWith(todayKST), '2: 호출 시각(오늘)으로 덮어쓰지 않음');
  assert(/\(.+\)/.test(it.as_of), `2: 'YYYY-MM-DD (라벨)' 형식 (실제: "${it.as_of}")`);
  assert(it.price === 56.37, '2: 값 파싱 무영향(회귀)');
}

// ── 3. UTC/KST 경계 — 15:00Z 이후는 KST로 다음 날 ───────────────
// UTC 날짜만 잘라 쓰면 여기서 하루가 어긋난다. fmtKST 경유가 맞는지 확인.
{
  routes = {
    'coingecko.com': { data: {
      market_cap_percentage: { btc: 50 },
      updated_at: Math.floor(Date.parse('2026-07-20T15:30:00Z') / 1000), // KST 2026-07-21 00:30
    } },
  };
  const it = await collectBtcDominance({ include90d: false });
  assert(it.as_of.startsWith('2026-07-21'),
    `3: 15:30Z → KST 익일(07-21)로 표기 (실제: "${it.as_of}")`);
}
{
  routes = {
    'coingecko.com': { data: {
      market_cap_percentage: { btc: 50 },
      updated_at: Math.floor(Date.parse('2026-07-20T14:30:00Z') / 1000), // KST 2026-07-20 23:30
    } },
  };
  const it = await collectBtcDominance({ include90d: false });
  assert(it.as_of.startsWith('2026-07-20'), `3: 14:30Z → KST 당일(07-20) 유지 (실제: "${it.as_of}")`);
}

// ── 4. 시각 필드 부재 시 폴백(크래시 금지) ──────────────────────
{
  routes = { 'coingecko.com': { data: { market_cap_percentage: { btc: 44.4 } } } }; // updated_at 없음
  const it = await collectBtcDominance({ include90d: false });
  assert(it.price === 44.4, '4: updated_at 없어도 수집은 성공');
  assert(it.as_of.startsWith(todayKST), `4: 근거 없으면 현재 시각으로 폴백 (실제: "${it.as_of}")`);
  assert(/\(.+\)/.test(it.as_of), '4: 폴백에서도 형식 유지');
}

globalThis.fetch = realFetch;
console.log(`\n[test-asof-source-time] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
