/**
 * drawingGeometry.js — 도형 조작의 공통 기하 계산. **순수 함수만**(DOM·차트 API 없음).
 *
 * 선 연장·선별 삭제·끝점 드래그 세 기능이 전부 "커서가 어느 도형 위에 있나"와
 * "이 선분을 어디까지 늘리나"에 기대므로, 그 계산만 여기로 모아 테스트 가능하게 둔다.
 * 입력은 전부 **화면 좌표(px)**다 — 시간·가격 좌표로의 환산은 호출측(차트 API를 아는 쪽)이 한다.
 */

// ── 허용 반경 ────────────────────────────────────────────────────────
// 선분: 기존 지지/저항선 hover 허용치(AnalysisChart의 SR_HOVER_TOLERANCE_PX = 12)와 같은 값을
//   쓴다. 같은 화면에서 "선에 가까이 갔다"의 기준이 도형 종류마다 다르면 사용자가 두 규칙을
//   따로 익혀야 한다. 대각선이라 수직거리로 재는 것만 다르고 기준 거리는 같게 둔다.
// 끝점: 선분보다 **좁게** 잡는다(10px). 끝점 판정이 선분 판정을 이기므로(아래 hitTest),
//   같거나 넓으면 선분 중앙부를 노려도 끝점 근처에서 드래그가 먼저 걸려 삭제 hover가 뜨지 않는다.
//   시각 반지름 3px보다는 넉넉해야 손가락·마우스로 집을 수 있다.
export const SEGMENT_HIT_PX  = 12;
export const ENDPOINT_HIT_PX = 10;

/**
 * 점 (px,py)에서 선분 (x1,y1)-(x2,y2)까지의 **수직 거리**(선분 밖이면 가까운 끝점까지).
 * 무한 직선이 아니라 선분 기준이다 — 연장 구간은 판정에서 빼기 위함(hitTest 주석 참조).
 */
export function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1); // 두 점이 같으면 점까지의 거리
  // 선분을 [0,1]로 매개화한 뒤 사영 위치 t를 구간 안으로 자른다.
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 선분을 **오른쪽(미래 방향) 화면 끝까지** 늘린 연장 구간.
 *
 * ⚠️ **화면 좌표 외삽이다(시간축 외삽이 아니다).** lightweight-charts의 시간축은 실제 시간
 *    간격이 아니라 **봉 인덱스**로 균등 배치되고, 두 점을 잇는 선은 그 인덱스 공간에서 직선이다.
 *    그래서 화면에서 직선을 늘리는 것이 곧 인덱스 공간에서 늘리는 것과 같고, 이미 그려진
 *    선분과 **정의상 어긋날 수 없다**. 시간축으로 외삽하려면 존재하지 않는 미래 봉의 시각을
 *    지어내야 하는데(마지막 봉 이후에는 timeToCoordinate가 null), 그건 저장 구조를 건드리지
 *    않겠다는 이번 단계의 전제와도 충돌한다.
 *    한계: 가격축을 로그 스케일로 바꾸면 화면 직선 ≠ 가격 선형 직선이 된다(현재 이 앱은
 *    선형 고정). 다만 로그 차트에서도 추세선은 화면상 직선으로 긋는 것이 통용 관행이다.
 *
 * ⚠️ 어느 점을 찍었는지와 무관하게 **x가 큰 쪽**에서 뻗는다 — '미래'는 클릭 순서가 아니라
 *    시간축 방향이다.
 *
 * @param {{x1,y1,x2,y2}} seg
 * @param {number} width  페인 폭(px)
 * @returns {{x1,y1,x2,y2}|null} 늘릴 구간이 없으면 null
 */
export function extendSegmentRight(seg, width) {
  if (!seg || !Number.isFinite(width)) return null;
  const leftFirst = seg.x1 <= seg.x2;
  const ax = leftFirst ? seg.x1 : seg.x2, ay = leftFirst ? seg.y1 : seg.y2;
  const bx = leftFirst ? seg.x2 : seg.x1, by = leftFirst ? seg.y2 : seg.y1;
  const dx = bx - ax;
  if (dx <= 0) return null;      // 두 점이 같은 봉 → 기울기를 정의할 수 없다
  if (bx >= width) return null;  // 이미 오른쪽 끝을 넘었다
  const slope = (by - ay) / dx;
  return { x1: bx, y1: by, x2: width, y2: by + slope * (width - bx) };
}

/**
 * 선분을 **왼쪽(과거 방향) 화면 끝까지** 늘린 연장 구간. extendSegmentRight의 거울상이다.
 *
 * 계산 근거는 오른쪽과 동일하다(화면 좌표 외삽 — 위 주석 참조). 방향 판정도 같은 규칙으로
 * **x가 작은 쪽**에서 뻗는다 — 클릭 순서와 무관하다.
 *
 * @param {{x1,y1,x2,y2}} seg
 * @param {number} [left=0] 페인 왼쪽 경계(px). 기본 0.
 * @returns {{x1,y1,x2,y2}|null} 늘릴 구간이 없으면 null
 */
export function extendSegmentLeft(seg, left = 0) {
  if (!seg || !Number.isFinite(left)) return null;
  const leftFirst = seg.x1 <= seg.x2;
  const ax = leftFirst ? seg.x1 : seg.x2, ay = leftFirst ? seg.y1 : seg.y2;
  const bx = leftFirst ? seg.x2 : seg.x1, by = leftFirst ? seg.y2 : seg.y1;
  const dx = bx - ax;
  if (dx <= 0) return null;   // 두 점이 같은 봉 → 기울기를 정의할 수 없다
  if (ax <= left) return null; // 이미 왼쪽 끝에 닿았다
  const slope = (by - ay) / dx;
  return { x1: ax, y1: ay, x2: left, y2: ay + slope * (left - ax) };
}

/**
 * 몸통 평행 이동의 **봉 델타를 데이터 범위 안으로 자른다.**
 *
 * ⚠️ **두 점에 같은 델타를 적용해야 기울기와 길이가 보존된다.** 그래서 한쪽 점이 경계에
 *    닿아도 그 점만 멈추지 않고 **둘 다 함께** 멈춘다 — 한쪽만 멈추면 그 순간부터 선이
 *    회전한다(평행 이동이 아니게 된다). 이 함수가 따로 있는 이유가 그것이다.
 * ⚠️ 범위를 넘는 이동을 **거부하지 않고 경계까지 미끄러지게** 자른다. 거부하면 손가락은
 *    움직이는데 선이 굳어 "잡은 것이 풀렸나"로 읽힌다. 경계에 붙어 따라오면 "여기가 끝"이
 *    화면에 그대로 드러난다.
 * ⚠️ 시간축만 자른다. **가격은 자르지 않는다** — 가격축 밖도 유효한 수이고(스케일을 넘겨도
 *    값은 성립한다), 끝점 드래그도 같은 규칙이다. 두 조작이 다르게 굴면 그게 다음 결함이 된다.
 *
 * @param {number[]} indices    각 점의 현재 봉 인덱스
 * @param {number} rawDelta     커서가 민 봉 수(정수)
 * @param {number} lastIndex    마지막 봉 인덱스(= 데이터 길이 − 1)
 * @returns {number} 잘린 델타. 인덱스가 하나라도 유한하지 않으면 0(이동 없음)
 */
export function clampBarDelta(indices, rawDelta, lastIndex) {
  if (!Array.isArray(indices) || indices.length === 0) return 0;
  if (!Number.isFinite(rawDelta) || !Number.isFinite(lastIndex)) return 0;
  let min = Infinity, max = -Infinity;
  for (const i of indices) {
    if (!Number.isFinite(i)) return 0; // 데이터에 없는 점 — 인덱스 공간이 성립하지 않는다
    if (i < min) min = i;
    if (i > max) max = i;
  }
  return Math.max(-min, Math.min(lastIndex - max, rawDelta));
}

/**
 * 두 점을 **같은 델타로** 옮긴 결과. 기울기·길이 불변.
 *
 * 시간축은 **봉 인덱스**로(이산), 가격축은 값으로(연속) 민다. 화면 x 델타를 두 점에 각각
 * 적용하면 두 점이 서로 다른 봉으로 스냅돼 **기울기가 변한다** — lightweight-charts의
 * 시간축은 실제 시간 간격이 아니라 봉 인덱스로 균등 배치되는 이산 축이기 때문이다.
 * 그래서 화면 델타를 **봉 수 하나**로 환산한 뒤 두 점에 같이 적용한다.
 *
 * 여기서 만드는 것은 화면 좌표가 아니라 **저장 좌표**(time·price)다. 반올림은 하지 않는다 —
 * 호출측이 끝점 드래그와 같은 roundPrice를 적용한다.
 *
 * @param {{points, indices, times, rawBarDelta, priceDelta}} p
 *   points  원본 점 배열(드래그 시작 시점 사본)
 *   indices 각 점의 봉 인덱스
 *   times   봉 인덱스 → 시각 배열(차트에 넣은 데이터 순서 그대로)
 * @returns {Array<object>} 옮겨진 점 배열. 입력이 성립하지 않으면 원본을 그대로 돌려준다
 */
export function movePointsParallel({ points, indices, times, rawBarDelta, priceDelta } = {}) {
  if (!Array.isArray(points) || !Array.isArray(indices) || !Array.isArray(times)) return points ?? [];
  if (points.length !== indices.length) return points;
  const barDelta = clampBarDelta(indices, rawBarDelta, times.length - 1);
  const dp = Number.isFinite(priceDelta) ? priceDelta : 0;
  return points.map((p, i) => {
    const t = times[indices[i] + barDelta];
    return {
      ...p,
      // 표에 없으면(방어) 원래 시각을 유지한다 — 없는 시각을 지어내지 않는다.
      time:  t === undefined ? p.time : t,
      price: Number.isFinite(p?.price) ? p.price + dp : p?.price,
    };
  });
}

/**
 * 커서 위치에 걸리는 도형 1건.
 *
 * ── 우선순위와 동률 규칙 ─────────────────────────────────────────────
 * ① **끝점이 선분을 이긴다.** 끝점 근처에서는 이동(드래그) 의도가 삭제 의도보다 우선한다고 본다.
 *    끝점을 잡으려 했는데 삭제 ×가 뜨면 되돌릴 수 없는 조작(삭제)이 앞에 서게 된다.
 *    ⚠️ 몸통 드래그가 생긴 뒤로 이 규칙은 **"끝점 이동 vs 몸통 이동"도 가른다.** 경계는
 *       모호하지 않다 — 끝점까지의 거리가 **정확히 endpointPx(10)이면 끝점**이고(`d <= endpointPx`),
 *       그 바깥에서만 선분 판정으로 내려간다. 두 반경이 다르므로(10 < 12) 끝점 띠는 선분 띠
 *       **안에** 있고, 겹치는 구간의 주인은 항상 끝점이다.
 * ② 같은 종류끼리는 **가장 가까운 것**. 거리가 같으면 **배열 뒤쪽**이 이긴다 — 렌더러가
 *    배열 순서대로 그려 뒤쪽이 위에 보이므로, 눈에 보이는 것이 잡히는 것과 일치한다.
 * ⚠️ **연장 구간은 양쪽 다 판정하지 않는다.** 연장은 화면 끝까지 가므로 판정에 넣으면
 *    그 띠 전체가 도형 hover 구역이 되어 크로스헤어·클릭을 방해한다. 사용자가 "그 선"을
 *    지목하려는 자연스러운 지점은 실제로 찍은 두 점 사이다.
 *    왼쪽 연장은 빈 여백이 아니라 **과거 캔들 위**를 덮으므로 오히려 더 강한 제외 근거가
 *    된다 — 그 영역의 주 용도는 캔들을 크로스헤어로 읽는 것이고, 판정 띠가 그 위를 가로지르면
 *    도형을 만들지 않은 사용자까지 방해를 받는다.
 *
 * @param {Array<{id,kind,x1,y1,x2,y2}>} segs  buildSegments 결과(kind==='shape'만 본다)
 * @returns {{kind:'endpoint'|'segment', id:string, index?:0|1, distance:number, x:number, y:number}|null}
 */
export function hitTest(segs, px, py, opts) {
  const segmentPx  = opts?.segmentPx  ?? SEGMENT_HIT_PX;
  const endpointPx = opts?.endpointPx ?? ENDPOINT_HIT_PX;

  let ep = null;
  for (const s of segs ?? []) {
    if (s?.kind !== 'shape') continue;
    for (const index of [0, 1]) {
      const ex = index === 0 ? s.x1 : s.x2;
      const ey = index === 0 ? s.y1 : s.y2;
      const d = Math.hypot(px - ex, py - ey);
      // `<=`라서 동률이면 나중 항목이 이긴다(위에 그려진 것이 잡힌다).
      if (d <= endpointPx && (!ep || d <= ep.distance)) {
        ep = { kind: 'endpoint', id: s.id, index, distance: d, x: ex, y: ey };
      }
    }
  }
  if (ep) return ep;

  let sg = null;
  for (const s of segs ?? []) {
    if (s?.kind !== 'shape') continue;
    const d = distanceToSegment(px, py, s.x1, s.y1, s.x2, s.y2);
    if (d <= segmentPx && (!sg || d <= sg.distance)) {
      sg = { kind: 'segment', id: s.id, distance: d, x: px, y: py };
    }
  }
  return sg;
}
