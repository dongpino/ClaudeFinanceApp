/**
 * scripts/test-drawing-geometry.js — 도형 조작 기하 회귀 테스트
 *
 * 선 연장·선별 삭제·끝점 드래그가 공유하는 계산을 고정한다. 브라우저 없이 검증 가능한
 * 유일한 층이고, 세 기능의 동작이 갈리는 규칙(우선순위·동률·연장 제외)이 전부 여기 있다.
 *
 * 실행: node scripts/test-drawing-geometry.js
 */

import {
  distanceToSegment, extendSegmentRight, extendSegmentLeft, hitTest,
  SEGMENT_HIT_PX, ENDPOINT_HIT_PX,
} from '../src/drawingGeometry.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${label}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const seg = (id, x1, y1, x2, y2) => ({ id, kind: 'shape', x1, y1, x2, y2 });

// ── (1) 점-선분 거리 ─────────────────────────────────────────────────
{
  // 수평 선분 (0,0)-(100,0)
  assert(near(distanceToSegment(50, 10, 0, 0, 100, 0), 10), '1-1: 선분 위쪽 수직거리');
  assert(near(distanceToSegment(50, -7, 0, 0, 100, 0), 7),  '1-2: 선분 아래쪽 수직거리');
  assert(near(distanceToSegment(50, 0, 0, 0, 100, 0), 0),   '1-3: 선분 위의 점은 0');
  // 선분 **밖**은 가까운 끝점까지의 거리 — 무한 직선이 아니다
  assert(near(distanceToSegment(-10, 0, 0, 0, 100, 0), 10), '1-4: 왼쪽 바깥은 끝점까지');
  assert(near(distanceToSegment(130, 0, 0, 0, 100, 0), 30), '1-5: 오른쪽 바깥은 끝점까지');
  assert(near(distanceToSegment(103, 4, 0, 0, 100, 0), 5),  '1-6: 대각 바깥도 끝점까지(3-4-5)');
  // 대각선 (0,0)-(100,100): 점 (100,0)의 수직거리는 100/√2
  assert(near(distanceToSegment(100, 0, 0, 0, 100, 100), 100 / Math.SQRT2, 1e-9),
    '1-7: 45도 선분 수직거리');
  // 길이 0인 선분
  assert(near(distanceToSegment(3, 4, 10, 10, 10, 10), Math.hypot(7, 6)), '1-8: 길이 0이면 점까지');
}

// ── (2) 오른쪽 연장 ──────────────────────────────────────────────────
{
  // 기울기 1, 폭 500 → (100,100)에서 (500,500)까지
  const e = extendSegmentRight(seg('a', 0, 0, 100, 100), 500);
  assert(e && e.x1 === 100 && e.y1 === 100, '2-1: 연장 시작점은 오른쪽 끝점');
  assert(e && e.x2 === 500 && near(e.y2, 500), '2-2: 화면 오른쪽 끝까지, 기울기 유지');

  // 내려가는 기울기
  const down = extendSegmentRight(seg('b', 0, 200, 100, 100), 300);
  assert(down && near(down.y2, -100), '2-3: 음의 기울기도 그대로 외삽(화면 밖 y 허용)');

  // 점 순서가 뒤집혀도 **x가 큰 쪽**에서 뻗는다
  const rev = extendSegmentRight(seg('c', 100, 100, 0, 0), 500);
  assert(rev && rev.x1 === 100 && rev.y1 === 100 && near(rev.y2, 500),
    '2-4: 클릭 순서와 무관하게 미래(오른쪽) 방향');

  // 늘릴 것이 없는 경우
  assert(extendSegmentRight(seg('d', 10, 0, 10, 50), 500) === null, '2-5: 수직선(dx=0)은 연장 없음');
  assert(extendSegmentRight(seg('e', 0, 0, 500, 100), 500) === null, '2-6: 이미 오른쪽 끝이면 없음');
  assert(extendSegmentRight(seg('f', 0, 0, 600, 100), 500) === null, '2-7: 끝점이 화면 밖이면 없음');
  assert(extendSegmentRight(null, 500) === null, '2-8: 입력 없으면 null');
  assert(extendSegmentRight(seg('g', 0, 0, 10, 10), NaN) === null, '2-9: 폭이 비유한이면 null');
}

// ── (2b) 왼쪽 연장 — (2)와 같은 커버리지의 거울상 ────────────────────
{
  // 기울기 1, 왼쪽 끝 0 → (100,100)에서 왼쪽으로 뻗으면 (0,0)
  const e = extendSegmentLeft(seg('a', 100, 100, 300, 300));
  assert(e && e.x1 === 100 && e.y1 === 100, '2b-1: 연장 시작점은 왼쪽 끝점');
  assert(e && e.x2 === 0 && near(e.y2, 0), '2b-2: 화면 왼쪽 끝까지, 기울기 유지');

  // 내려가는 기울기 — 왼쪽으로 가면 위로 올라간다
  const down = extendSegmentLeft(seg('b', 100, 100, 200, 0));
  assert(down && near(down.y2, 200), '2b-3: 음의 기울기도 그대로 외삽(화면 밖 y 허용)');

  // 점 순서가 뒤집혀도 **x가 작은 쪽**에서 뻗는다
  const rev = extendSegmentLeft(seg('c', 300, 300, 100, 100));
  assert(rev && rev.x1 === 100 && rev.y1 === 100 && near(rev.y2, 0),
    '2b-4: 클릭 순서와 무관하게 과거(왼쪽) 방향');

  // 늘릴 것이 없는 경우
  assert(extendSegmentLeft(seg('d', 10, 0, 10, 50)) === null, '2b-5: 수직선(dx=0)은 연장 없음');
  assert(extendSegmentLeft(seg('e', 0, 0, 500, 100)) === null, '2b-6: 이미 왼쪽 끝이면 없음');
  assert(extendSegmentLeft(seg('f', -20, 0, 500, 100)) === null, '2b-7: 끝점이 화면 밖이면 없음');
  assert(extendSegmentLeft(null) === null, '2b-8: 입력 없으면 null');
  assert(extendSegmentLeft(seg('g', 10, 0, 20, 10), NaN) === null, '2b-9: 경계가 비유한이면 null');

  // 왼쪽 경계가 0이 아닌 경우(기본값 외 인자)
  const bounded = extendSegmentLeft(seg('h', 100, 100, 200, 200), 40);
  assert(bounded && bounded.x2 === 40 && near(bounded.y2, 40), '2b-10: 왼쪽 경계 인자 반영');

  // 양쪽 연장은 같은 직선 위에 있다 — 두 연장의 기울기가 원 선분과 일치
  const base = seg('i', 100, 100, 200, 150);   // 기울기 0.5
  const r = extendSegmentRight(base, 400), l = extendSegmentLeft(base, 0);
  assert(near((r.y2 - r.y1) / (r.x2 - r.x1), 0.5), '2b-11: 오른쪽 연장 기울기 일치');
  assert(near((l.y2 - l.y1) / (l.x2 - l.x1), 0.5), '2b-12: 왼쪽 연장 기울기 일치(같은 직선)');
}

// ── (3) 히트테스트 — 기본 ────────────────────────────────────────────
{
  const segs = [seg('a', 0, 100, 200, 100)];
  assert(hitTest(segs, 100, 100).kind === 'segment', '3-1: 선분 위는 segment');
  assert(hitTest(segs, 100, 100 + SEGMENT_HIT_PX).kind === 'segment', '3-2: 허용치 경계는 포함');
  assert(hitTest(segs, 100, 100 + SEGMENT_HIT_PX + 1) === null, '3-3: 허용치 밖은 null');
  assert(hitTest(segs, 1, 100).kind === 'endpoint', '3-4: 끝점 근처는 endpoint');
  assert(hitTest(segs, 0, 100).index === 0 && hitTest(segs, 200, 100).index === 1,
    '3-5: 끝점 인덱스 0/1 구분');
  assert(hitTest([], 10, 10) === null, '3-6: 도형이 없으면 null');
  assert(hitTest(null, 10, 10) === null, '3-7: null 입력 방어');
}

// ── (4) 우선순위 — 끝점이 선분을 이긴다 ──────────────────────────────
{
  const segs = [seg('a', 0, 100, 200, 100)];
  // 끝점에서 5px 떨어진 지점: 선분 판정(거리 0)도 성립하지만 끝점이 이겨야 한다
  const h = hitTest(segs, 5, 100);
  assert(h.kind === 'endpoint' && h.index === 0, '4-1: 끝점 반경 안에서는 선분보다 끝점 우선');
  // 끝점 반경 밖(선분 위)이면 선분
  const h2 = hitTest(segs, ENDPOINT_HIT_PX + 5, 100);
  assert(h2.kind === 'segment', '4-2: 끝점 반경을 벗어나면 선분');
}

// ── (5) 겹칠 때 — 가장 가까운 것, 동률이면 나중에 그린 것 ────────────
{
  const segs = [seg('old', 0, 100, 200, 100), seg('new', 0, 108, 200, 108)];
  assert(hitTest(segs, 100, 101).id === 'old', '5-1: 더 가까운 도형이 잡힌다');
  assert(hitTest(segs, 100, 107).id === 'new', '5-2: 반대쪽도 마찬가지');
  // 정확히 중간(각 4px) → 동률 → 나중 항목(위에 그려진 것)
  assert(hitTest(segs, 100, 104).id === 'new', '5-3: 동률이면 배열 뒤쪽(위에 그려진 것)');

  // 끝점 동률도 같은 규칙
  const eps = [seg('old', 50, 50, 150, 50), seg('new', 50, 50, 150, 60)];
  const h = hitTest(eps, 50, 50);
  assert(h.kind === 'endpoint' && h.id === 'new', '5-4: 끝점 동률도 뒤쪽 우선');
}

// ── (6) 연장 구간은 **양쪽 다** 판정 대상이 아니다 ───────────────────
{
  const segs = [seg('a', 200, 100, 300, 100)];
  // 오른쪽 연장선상 — 그려지기는 하지만 hover는 걸리지 않아야 한다
  assert(hitTest(segs, 600, 100) === null, '6-1: 오른쪽 연장 구간 위에서는 hit 없음');
  // 왼쪽 연장선상 — 과거 캔들 위를 덮지만 마찬가지로 걸리지 않는다
  assert(hitTest(segs, 20, 100) === null, '6-2: 왼쪽 연장 구간 위에서도 hit 없음');
  // 끝점 바로 옆까지는 걸린다(선분의 끝)
  assert(hitTest(segs, 300 + ENDPOINT_HIT_PX, 100).kind === 'endpoint', '6-3: 오른쪽 끝점 반경까지는 걸림');
  assert(hitTest(segs, 200 - ENDPOINT_HIT_PX, 100).kind === 'endpoint', '6-4: 왼쪽 끝점 반경까지는 걸림');
}

// ── (7) 미리보기 선분은 판정 대상이 아니다 ───────────────────────────
{
  const segs = [{ id: '__preview__', kind: 'preview', x1: 0, y1: 0, x2: 100, y2: 0 }];
  assert(hitTest(segs, 50, 0) === null, '7-1: kind==="preview"는 무시');
}

console.log(fail === 0 ? `✓ 전체 통과 — pass ${pass}, fail ${fail}` : `✗ 실패 — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
