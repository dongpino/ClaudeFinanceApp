/**
 * scripts/test-drawings-store.js — 그리기 도형 영속성 레이어 회귀 테스트
 *
 * 이 단계는 렌더링이 없어 화면으로 확인할 수 있는 것이 거의 없다. 그래서 눈으로 볼 수
 * 없는 쪽(심볼별 격리·깨진 데이터 방어)을 여기서 고정한다.
 * ⚠️ 클릭 → 좌표 변환 경로는 브라우저 없이는 실행할 수 없어 이 테스트의 범위 밖이다.
 *
 * 실행: node scripts/test-drawings-store.js
 */

// ── localStorage 스텁 (Node에는 없다) ────────────────────────────────
let store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

const { STORAGE_KEY, DRAWING_TYPE, makeShape, loadDrawings, saveDrawings } =
  await import('../src/drawingsStore.js');

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${label}`); }
}
function reset() { store = {}; }

const KEY_A = 'index::KOSPI';
const KEY_B = 'stock:US:AAPL';
const pts = (t1, p1, t2, p2) => [{ time: t1, price: p1 }, { time: t2, price: p2 }];

// ── (1) 생성 ─────────────────────────────────────────────────────────
{
  reset();
  const s = makeShape(DRAWING_TYPE.TRENDLINE, pts('2026-07-01', 2500, '2026-08-01', 2700));
  assert(s !== null, '1-1: 유효한 2점이면 도형 생성');
  assert(typeof s.id === 'string' && s.id.length > 0, '1-2: id 부여');
  assert(s.type === 'trendline', '1-3: type 보존');
  assert(s.points.length === 2, '1-4: points 2개');
  assert(Number.isFinite(s.createdAt), '1-5: createdAt epoch ms');
  // UTCTimestamp(숫자) 시간축도 지원 — 분봉 타임프레임
  assert(makeShape('trendline', pts(1754000000, 1.5, 1754086400, 1.6)) !== null,
    '1-6: 숫자 time(UTCTimestamp)도 유효');
  // 좌표가 깨지면 도형을 만들지 않는다
  assert(makeShape('trendline', pts('2026-07-01', NaN, '2026-08-01', 2700)) === null,
    '1-7: price가 NaN이면 null');
  assert(makeShape('trendline', [{ time: '2026-07-01', price: 1 }]) === null,
    '1-8: 점이 1개면 null');
}

// ── (2) 저장/복원 왕복 ───────────────────────────────────────────────
{
  reset();
  const s = makeShape('trendline', pts('2026-07-01', 2500, '2026-08-01', 2700));
  saveDrawings(KEY_A, [s]);
  const back = loadDrawings(KEY_A);
  assert(back.length === 1, '2-1: 1건 복원');
  assert(back[0].id === s.id, '2-2: id 동일');
  assert(back[0].points[0].time === '2026-07-01' && back[0].points[1].price === 2700,
    '2-3: 좌표 왕복 무손실');
}

// ── (3) 심볼별 격리 — 이 단계의 핵심 요구 ────────────────────────────
{
  reset();
  const a = makeShape('trendline', pts('2026-07-01', 2500, '2026-08-01', 2700));
  const b = makeShape('trendline', pts('2026-07-02', 210, '2026-08-02', 230));
  saveDrawings(KEY_A, [a]);
  saveDrawings(KEY_B, [b]);
  assert(loadDrawings(KEY_A).length === 1 && loadDrawings(KEY_A)[0].id === a.id,
    '3-1: A 심볼은 A 도형만');
  assert(loadDrawings(KEY_B).length === 1 && loadDrawings(KEY_B)[0].id === b.id,
    '3-2: B 심볼은 B 도형만');
  // 원래 심볼로 돌아오면 그대로 복원된다(다른 심볼 저장이 덮어쓰지 않는다)
  saveDrawings(KEY_B, [b, makeShape('trendline', pts('2026-07-03', 1, '2026-07-04', 2))]);
  assert(loadDrawings(KEY_A).length === 1, '3-3: B를 갱신해도 A는 불변');
  assert(loadDrawings('index::NOSUCH').length === 0, '3-4: 없는 심볼은 빈 배열');
  assert(loadDrawings(null).length === 0, '3-5: symbolKey 없으면 빈 배열');
}

// ── (4) 깨진 데이터 방어 — 에러로 죽지 않고 조용히 빈 배열 ───────────
{
  reset();
  store[STORAGE_KEY] = '{이건 JSON이 아니다';
  assert(loadDrawings(KEY_A).length === 0, '4-1: JSON 파싱 실패 → 빈 배열');

  reset();
  store[STORAGE_KEY] = '"문자열"';
  assert(loadDrawings(KEY_A).length === 0, '4-2: 객체가 아닌 최상위 → 빈 배열');

  reset();
  store[STORAGE_KEY] = '[1,2,3]';
  assert(loadDrawings(KEY_A).length === 0, '4-3: 배열 최상위 → 빈 배열');

  reset();
  store[STORAGE_KEY] = JSON.stringify({ [KEY_A]: 'not-an-array' });
  assert(loadDrawings(KEY_A).length === 0, '4-4: 심볼 값이 배열이 아님 → 빈 배열');

  // 일부만 깨진 경우 — 성한 것은 살린다
  reset();
  const good = makeShape('trendline', pts('2026-07-01', 2500, '2026-08-01', 2700));
  store[STORAGE_KEY] = JSON.stringify({
    [KEY_A]: [good, { id: 'x' }, null, { id: 'y', type: 't', points: [{ time: null, price: 1 }, { time: 2, price: 2 }] }],
  });
  const survived = loadDrawings(KEY_A);
  assert(survived.length === 1 && survived[0].id === good.id,
    '4-5: 깨진 항목만 걸러내고 성한 것은 유지');
}

// ── (5) 빈 배열 저장은 키 제거 (srLinesStore와 동일 규약) ────────────
{
  reset();
  saveDrawings(KEY_A, [makeShape('trendline', pts('2026-07-01', 1, '2026-07-02', 2))]);
  saveDrawings(KEY_A, []);
  const all = JSON.parse(store[STORAGE_KEY]);
  assert(!(KEY_A in all), '5-1: 빈 배열이면 심볼 키 자체를 제거');
  assert(loadDrawings(KEY_A).length === 0, '5-2: 제거 후 빈 배열');
}

// ── (6) 저장 실패해도 throw하지 않는다 ───────────────────────────────
{
  reset();
  const orig = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  let threw = false;
  try { saveDrawings(KEY_A, [makeShape('trendline', pts('2026-07-01', 1, '2026-07-02', 2))]); }
  catch { threw = true; }
  globalThis.localStorage.setItem = orig;
  assert(!threw, '6-1: localStorage 쓰기 실패를 삼킨다(호출부가 죽지 않는다)');
}

// ── (7) 피보나치 — **저장 구조가 그대로임을 고정한다** ───────────────
// 도구가 늘어도 이 층은 바뀌지 않아야 한다. type을 문자열로 나르기만 하는 설계가
// 실제로 성립하는지가 여기서 드러난다(분기 코드가 하나도 없어야 한다).
{
  store = {};
  const pts = [{ time: '2026-07-01', price: 1000 }, { time: '2026-08-01', price: 3000 }];
  const fib = makeShape(DRAWING_TYPE.FIB, pts);
  assert(fib !== null && fib.type === 'fib', '7-1: fib 도형이 만들어진다');
  assert(Array.isArray(fib.points) && fib.points.length === 2, '7-2: 점은 여전히 2개(구조 불변)');
  assert(typeof fib.id === 'string' && Number.isFinite(fib.createdAt), '7-3: id·createdAt 규약 동일');

  const tl = makeShape(DRAWING_TYPE.TRENDLINE, pts);
  saveDrawings('stock:kr:005930', [tl, fib]);
  const back = loadDrawings('stock:kr:005930');
  assert(back.length === 2, '7-4: 두 종류가 한 목록에 섞여 저장·복원된다');
  assert(back[1].type === 'fib' && back[1].points[1].price === 3000, '7-5: type과 좌표가 왕복에서 보존');
  assert(JSON.parse(store[STORAGE_KEY])['stock:kr:005930'].length === 2, '7-6: 저장 키 구조 동일');

  // 검증 규칙도 종류와 무관하다 — 깨진 fib은 그것만 빠진다
  saveDrawings('stock:kr:000660', [fib, { id: 'x', type: 'fib', points: [{ time: 'd', price: NaN }] }]);
  assert(loadDrawings('stock:kr:000660').length === 1, '7-7: 깨진 fib만 걸러진다');
}

console.log(fail === 0 ? `✓ 전체 통과 — pass ${pass}, fail ${fail}` : `✗ 실패 — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
