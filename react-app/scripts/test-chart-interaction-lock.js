/**
 * scripts/test-chart-interaction-lock.js — 차트 조작 잠금/복원 회귀 테스트
 *
 * 2026-08-04 회귀: 끝점 드래그를 한 번 하면 차트의 스크롤·줌이 **영구히** 죽었다.
 * 원인은 `chart.options()`가 내부 객체를 **참조로** 돌려주는데 그것을 스냅샷으로 착각해
 * 들고 있었던 것이다 — `applyOptions`가 그 객체를 제자리 변조하므로, 복원 시점의
 * '원본'은 이미 all-false였다.
 *
 * ⚠️ **이 테스트의 핵심은 가짜 차트가 그 성질을 그대로 흉내내는 것이다.**
 *    options()가 복사본을 주는 순한 가짜로 만들면 결함 있는 코드도 통과해 버린다 —
 *    이번 회귀가 기존 자동 테스트를 전부 통과하고 프로덕션 직전까지 온 이유가 정확히
 *    "옵션 왕복을 아무도 검증하지 않았다"는 것이었다.
 *    아래 성질은 설치본 4.2.3에서 헤드리스로 실측해 확인했다:
 *      · chart.options() === chart.options()                        → true (같은 객체)
 *      · applyOptions({handleScroll:false}) 후 앞서 캡처한 참조의 값 → 전부 false로 변조됨
 *      · applyOptions(boolean)은 하위 플래그 전부를 그 값으로 정규화
 *
 * 실행: node scripts/test-chart-interaction-lock.js
 */

import { createInteractionLock } from '../src/chartInteractionLock.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${label}`); }
}
const json = v => JSON.stringify(v);

// ── 실측 동작을 모사한 가짜 차트 ─────────────────────────────────────
const DEFAULTS = () => ({
  handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  handleScale:  { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
});

function setAllLeaves(target, value) {
  for (const k of Object.keys(target)) {
    if (target[k] && typeof target[k] === 'object') setAllLeaves(target[k], value);
    else target[k] = value;
  }
}
function mergeInPlace(dst, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === 'object' && dst[k] && typeof dst[k] === 'object') mergeInPlace(dst[k], src[k]);
    else dst[k] = src[k];
  }
}

function makeFakeChart() {
  const opts = DEFAULTS();
  let applyCount = 0;
  return {
    // ★ 내부 객체를 **참조로** 돌려준다(실측 성질)
    options: () => opts,
    applyOptions(patch) {
      applyCount++;
      for (const key of ['handleScroll', 'handleScale']) {
        if (!(key in patch)) continue;
        const v = patch[key];
        // ★ boolean은 하위 플래그 전부로 정규화되며 **기존 객체를 제자리 변조**한다(실측 성질)
        if (typeof v === 'boolean') setAllLeaves(opts[key], v);
        else mergeInPlace(opts[key], v);
      }
    },
    _applyCount: () => applyCount,
  };
}

const scrollAlive = c => c.options().handleScroll.horzTouchDrag === true
  && c.options().handleScroll.mouseWheel === true;

// ── (0) 가짜 차트가 실제 성질을 흉내내는지부터 확인 ──────────────────
{
  const c = makeFakeChart();
  assert(c.options() === c.options(), '0-1: options()는 같은 객체를 돌려준다(참조)');
  const captured = c.options().handleScroll;
  c.applyOptions({ handleScroll: false });
  assert(captured.horzTouchDrag === false, '0-2: 캡처한 참조가 제자리 변조된다');
  assert(json(c.options().handleScroll) === json({ mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false }),
    '0-3: boolean은 하위 플래그 전부로 정규화된다');
}

// ── (1) ★ 이번 회귀의 재현 — 참조를 스냅샷으로 착각하면 복원이 실패한다 ──
// 수정 전 코드와 같은 방식. **이 단언이 깨지면 라이브러리 동작이 바뀐 것이므로
// chartInteractionLock의 깊은 복사 근거를 다시 확인해야 한다.**
{
  const c = makeFakeChart();
  const before = json(c.options().handleScroll);
  const naiveRestore = { handleScroll: c.options().handleScroll, handleScale: c.options().handleScale };
  c.applyOptions({ handleScroll: false, handleScale: false });
  c.applyOptions(naiveRestore);
  assert(json(c.options().handleScroll) !== before,
    '1-1: 복사 없이 캡처하면 복원에 실패한다(회귀 재현 — 이것이 실패하면 전제 재확인)');
  assert(!scrollAlive(c), '1-2: 그 결과 스크롤이 죽은 채로 남는다');
}

// ── (2) 잠금 → 해제 후 원본과 완전히 같아야 한다 ─────────────────────
{
  const c = makeFakeChart();
  const before = { scroll: json(c.options().handleScroll), scale: json(c.options().handleScale) };
  const lock = createInteractionLock(c);

  lock.lock();
  assert(lock.isLocked(), '2-1: 잠금 상태');
  assert(!scrollAlive(c), '2-2: 잠긴 동안 스크롤이 꺼진다');
  assert(c.options().handleScale.pinch === false, '2-3: 줌(pinch)도 꺼진다');

  lock.unlock();
  assert(!lock.isLocked(), '2-4: 해제 상태');
  assert(json(c.options().handleScroll) === before.scroll, '2-5: handleScroll이 원본과 동일');
  assert(json(c.options().handleScale) === before.scale,  '2-6: handleScale이 원본과 동일');
  assert(scrollAlive(c), '2-7: 스크롤이 되살아난다');
  // 원래 false였던 하위 플래그가 true로 뒤바뀌지 않아야 한다
  assert(c.options().handleScroll.vertTouchDrag === false, '2-8: 원래 false였던 값은 false로 복원');
  // 중첩 객체(axisPressedMouseMove)도 보존
  assert(json(c.options().handleScale.axisPressedMouseMove) === json({ time: true, price: true }),
    '2-9: 중첩 객체도 원형 그대로 복원');
}

// ── (3) 재진입 — 잠긴 상태에서 또 잠가도 원본이 오염되지 않는다 ──────
{
  const c = makeFakeChart();
  const before = json(c.options().handleScroll);
  const lock = createInteractionLock(c);

  lock.lock();
  lock.lock();   // 두 번째 손가락 등 — 이미 꺼진 상태를 '원본'으로 재캡처하면 영구 잠금이 된다
  lock.lock();
  lock.unlock();
  assert(json(c.options().handleScroll) === before, '3-1: 여러 번 잠가도 한 번의 해제로 원복');
  assert(scrollAlive(c), '3-2: 스크롤 정상');
}

// ── (4) 해제 단독 호출 / 중복 해제는 무해해야 한다 ───────────────────
{
  const c = makeFakeChart();
  const before = json(c.options().handleScroll);
  const lock = createInteractionLock(c);

  lock.unlock();  // 잠근 적 없음
  assert(json(c.options().handleScroll) === before, '4-1: 잠금 없이 해제해도 변화 없음');
  assert(c._applyCount() === 0, '4-2: 그때 applyOptions를 부르지 않는다');

  lock.lock();
  lock.unlock();
  lock.unlock();  // 중복 해제
  assert(json(c.options().handleScroll) === before, '4-3: 중복 해제해도 원복 상태 유지');
  assert(scrollAlive(c), '4-4: 스크롤 정상');
}

// ── (5) 잠금/해제를 반복해도 값이 누적 오염되지 않는다 ───────────────
{
  const c = makeFakeChart();
  const before = json(c.options().handleScroll);
  const lock = createInteractionLock(c);
  for (let i = 0; i < 20; i++) { lock.lock(); lock.unlock(); }
  assert(json(c.options().handleScroll) === before, '5-1: 20회 반복 후에도 원본과 동일');
  assert(scrollAlive(c), '5-2: 스크롤 정상');
}

// ── (6) 방어 — chart가 없어도 죽지 않는다 ────────────────────────────
{
  const lock = createInteractionLock(null);
  let threw = false;
  try { lock.lock(); lock.unlock(); } catch { threw = true; }
  assert(!threw, '6-1: chart가 null이어도 throw하지 않는다');
  assert(!lock.isLocked(), '6-2: 잠기지 않은 상태로 남는다');
}

console.log(fail === 0 ? `✓ 전체 통과 — pass ${pass}, fail ${fail}` : `✗ 실패 — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
