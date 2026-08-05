/**
 * scripts/test-drawing-primitive.js — 도형 → 화면 좌표 선분 변환 회귀 테스트
 *
 * buildSegments는 브라우저 없이 검증할 수 있는 유일한 렌더링 경로다(캔버스에 실제로
 * 칠하는 부분은 수동 확인 대상). 특히 두 규칙을 고정한다:
 *   · 데이터 범위 밖(좌표 null) → 그 도형만 조용히 건너뛴다
 *   · 화면 밖(음수·폭 초과 좌표) → **버리지 않는다**(캔버스가 잘라 준다)
 *
 * 실행: node scripts/test-drawing-primitive.js
 */

import { buildSegments } from '../src/drawingPrimitive.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${label}`); }
}

// 시간축 스텁 — 데이터에 있는 날짜만 좌표를 준다(lightweight-charts의 timeToCoordinate와 동일 규약).
const BARS = { '2026-07-01': 10, '2026-07-15': 200, '2026-08-01': 400, '2026-08-20': 900 };
const toX = t => (t in BARS ? BARS[t] : null);
// 가격축 스텁 — 위가 0, 아래로 갈수록 큰 y (실제 차트와 같은 방향)
const toY = p => (Number.isFinite(p) ? 500 - p / 10 : null);

const shape = (id, t1, p1, t2, p2) => ({
  id, type: 'trendline', createdAt: 0,
  points: [{ time: t1, price: p1 }, { time: t2, price: p2 }],
});

// ── (1) 정상 변환 ────────────────────────────────────────────────────
{
  const segs = buildSegments([shape('a', '2026-07-01', 1000, '2026-08-01', 3000)], null, toX, toY);
  assert(segs.length === 1, '1-1: 선분 1개');
  assert(segs[0].kind === 'shape' && segs[0].id === 'a', '1-2: kind/id 보존');
  assert(segs[0].x1 === 10 && segs[0].x2 === 400, '1-3: x 좌표 변환');
  assert(segs[0].y1 === 400 && segs[0].y2 === 200, '1-4: y 좌표 변환');
}

// ── (2) 데이터 범위 밖 → 조용히 건너뛴다 ─────────────────────────────
{
  const segs = buildSegments([
    shape('a', '2026-07-01', 1000, '2026-08-01', 3000),
    shape('b', '2020-01-01', 1000, '2026-08-01', 3000),   // 시작점이 범위 밖
    shape('c', '2026-07-01', 1000, '2099-12-31', 3000),   // 끝점이 범위 밖
  ], null, toX, toY);
  assert(segs.length === 1 && segs[0].id === 'a', '2-1: 좌표 없는 도형만 제외, 나머지는 유지');
}

// ── (3) 화면 밖은 버리지 않는다 ──────────────────────────────────────
{
  const wideX = t => (t === '2026-07-01' ? -800 : t === '2026-08-01' ? 5000 : null);
  const segs = buildSegments([shape('a', '2026-07-01', 1000, '2026-08-01', 3000)], null, wideX, toY);
  assert(segs.length === 1, '3-1: 양 끝이 뷰포트 밖이어도 선분을 만든다(캔버스가 클리핑)');
  assert(segs[0].x1 === -800 && segs[0].x2 === 5000, '3-2: 음수·초과 좌표를 그대로 전달');
}

// ── (4) 깨진 입력 방어 ───────────────────────────────────────────────
{
  assert(buildSegments(null, null, toX, toY).length === 0, '4-1: shapes가 null이면 빈 배열');
  assert(buildSegments([null, undefined, {}], null, toX, toY).length === 0, '4-2: 비정상 항목 제외');
  assert(buildSegments([{ id: 'x', points: [{ time: '2026-07-01', price: 1000 }] }], null, toX, toY).length === 0,
    '4-3: 점이 1개면 제외');
  const nanPrice = shape('n', '2026-07-01', NaN, '2026-08-01', 3000);
  assert(buildSegments([nanPrice], null, toX, toY).length === 0, '4-4: 가격이 NaN이면 제외');
}

// ── (4b) 연장 플래그 — 양쪽 기본 켜짐, 방향별로 끌 수 있다 ───────────
{
  const on = buildSegments([shape('a', '2026-07-01', 1000, '2026-08-01', 3000)], null, toX, toY);
  assert(on[0].extendRight === true, '4b-1: 오른쪽 연장 기본 켜짐');
  assert(on[0].extendLeft === true,  '4b-2: 왼쪽 연장 기본 켜짐');

  const noR = buildSegments([{ ...shape('b', '2026-07-01', 1000, '2026-08-01', 3000), extendRight: false }],
    null, toX, toY);
  assert(noR[0].extendRight === false && noR[0].extendLeft === true,
    '4b-3: extendRight:false는 오른쪽만 끈다');

  const noL = buildSegments([{ ...shape('c', '2026-07-01', 1000, '2026-08-01', 3000), extendLeft: false }],
    null, toX, toY);
  assert(noL[0].extendLeft === false && noL[0].extendRight === true,
    '4b-4: extendLeft:false는 왼쪽만 끈다');
}

// ── (5) 미리보기 — 커서 끝은 화면 좌표 그대로 ────────────────────────
{
  const preview = { from: { time: '2026-07-15', price: 2000 }, to: { x: 333, y: 77 } };
  const segs = buildSegments([], preview, toX, toY);
  assert(segs.length === 1 && segs[0].kind === 'preview', '5-1: 미리보기 선분 생성');
  assert(segs[0].x1 === 200 && segs[0].y1 === 300, '5-2: 시작점은 시간·가격을 변환');
  assert(segs[0].x2 === 333 && segs[0].y2 === 77, '5-3: 끝점은 커서 좌표를 그대로 사용');

  // 확정 도형과 함께 오면 미리보기가 마지막(=위에 그려짐)
  const both = buildSegments([shape('a', '2026-07-01', 1000, '2026-08-01', 3000)], preview, toX, toY);
  assert(both.length === 2 && both[1].kind === 'preview', '5-4: 미리보기는 마지막에 그린다');

  // 첫 점이 범위 밖이면 미리보기도 만들지 않는다
  const outside = { from: { time: '2020-01-01', price: 2000 }, to: { x: 1, y: 2 } };
  assert(buildSegments([], outside, toX, toY).length === 0, '5-5: 시작점이 범위 밖이면 미리보기 없음');
  // to가 없는 반쪽 미리보기도 무시
  assert(buildSegments([], { from: { time: '2026-07-15', price: 2000 } }, toX, toY).length === 0,
    '5-6: to가 없으면 미리보기 없음');
  assert(buildSegments([], null, toX, toY).length === 0, '5-7: preview가 null이면 없음');
}

// ── (6) 피보나치 — 레벨선·구간 경계·앵커 ────────────────────────────
{
  const fib = (id, t1, p1, t2, p2) => ({
    id, type: 'fib', createdAt: 0,
    points: [{ time: t1, price: p1 }, { time: t2, price: p2 }],
  });
  // 저점 1000(첫 클릭=100%) → 고점 3000(둘째 클릭=0%)
  const segs = buildSegments([fib('f', '2026-07-01', 1000, '2026-08-01', 3000)], null, toX, toY);
  assert(segs.length === 1 && segs[0].type === 'fib', '6-1: type이 보존된다(렌더러 분기 근거)');
  assert(segs[0].levels.length === 9, '6-2: 레벨 9개');
  assert(segs[0].levels[0].price === 3000 && segs[0].levels[6].price === 1000,
    '6-3: 0%는 둘째 클릭, 100%는 첫 클릭');
  assert(segs[0].levels[0].y === toY(3000), '6-4: 레벨 y는 가격축 변환 결과');
  // 구간 경계는 x 정렬 결과 — 클릭 순서와 무관하다
  assert(segs[0].xMin === 10 && segs[0].xMax === 400, '6-5: xMin/xMax는 정렬된 경계');
  const rev = buildSegments([fib('f', '2026-08-01', 3000, '2026-07-01', 1000)], null, toX, toY);
  assert(rev[0].xMin === 10 && rev[0].xMax === 400, '6-6: 거꾸로 그어도 경계는 같다');
  assert(rev[0].levels[0].price === 1000, '6-7: 다만 0%는 클릭 순서를 따른다');

  // 앵커 두 점은 추세선과 **같은 자리**에 남는다 — 조작 코드가 종류를 몰라도 되는 근거
  assert(segs[0].x1 === 10 && segs[0].y1 === toY(1000), '6-8: 앵커1 좌표');
  assert(segs[0].x2 === 400 && segs[0].y2 === toY(3000), '6-9: 앵커2 좌표');

  // 판정선 — 레벨마다 수평선 하나, x는 구간 경계로 고정(연장 구간 제외)
  assert(segs[0].hitLines.length === 9, '6-10: 판정선도 9개');
  assert(segs[0].hitLines.every(l => l.x1 === 10 && l.x2 === 400), '6-11: 판정선은 구간 안으로 제한');
  assert(segs[0].hitLines[0].y1 === segs[0].hitLines[0].y2, '6-12: 판정선은 수평');

  // 데이터 범위 밖 규칙은 추세선과 동일 — 그 도형만 건너뛴다
  assert(buildSegments([fib('f', '2026-01-01', 1000, '2026-08-01', 3000)], null, toX, toY).length === 0,
    '6-13: 좌표 없는 Fib은 통째로 건너뛴다');
  // 추세선은 hitLines를 갖지 않는다(있으면 종전 판정이 바뀐다)
  const tl = buildSegments([shape('a', '2026-07-01', 1000, '2026-08-01', 3000)], null, toX, toY);
  assert(tl[0].hitLines === undefined, '6-14: 추세선에는 hitLines가 붙지 않는다');
  assert(tl[0].type === 'trendline', '6-15: 추세선도 type을 싣는다');
}

console.log(fail === 0 ? `✓ 전체 통과 — pass ${pass}, fail ${fail}` : `✗ 실패 — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
