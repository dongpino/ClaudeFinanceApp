/**
 * chartInteractionLock.js — 차트의 스크롤·줌을 잠깐 끄고 **원상 복구**하는 단일 창구
 *
 * 끝점 드래그처럼 "그 동안 차트가 움직이면 안 되는" 조작이 handleScroll/handleScale을
 * 껐다 켠다. 이 파일이 그 유일한 지점이다 — 여러 군데에서 각자 껐다 켜면 복원 규약이
 * 갈라지고, 한 곳만 틀려도 차트 조작이 영구히 죽는다(2026-08-04 회귀).
 *
 * ── ⚠️ 왜 원본을 반드시 **깊은 복사**해야 하는가 (실측) ──────────────────
 * lightweight-charts 4.2.3의 `chart.options()`는 **내부 옵션 객체를 참조로** 돌려주고,
 * `applyOptions`는 그 객체를 **제자리에서 변조**한다. 헤드리스 실측(2026-08-04, 설치본 4.2.3):
 *
 *   const captured = chart.options().handleScroll;
 *   // {"mouseWheel":true,"pressedMouseMove":true,"horzTouchDrag":true,"vertTouchDrag":false}
 *   chart.options().handleScroll === chart.options().handleScroll   // true (같은 객체)
 *   chart.applyOptions({ handleScroll: false });
 *   captured // → {"mouseWheel":false,"pressedMouseMove":false,"horzTouchDrag":false,"vertTouchDrag":false}
 *   chart.applyOptions({ handleScroll: captured });                 // all-false를 다시 적용
 *   // 원복 성공? false  ← 드래그 한 번으로 스크롤·줌이 영구히 죽는다
 *
 * 즉 `chart.options()`의 반환값을 그대로 들고 있는 것은 스냅샷이 아니라 **곧 변조될 값에
 * 대한 참조**다. 복사해 두어야 비로소 원본이 된다.
 * (같은 실측에서 `applyOptions({handleScroll:false})`는 boolean을 하위 플래그 전부 false인
 *  객체로 정규화하며, **깊은 복사본**으로 복원하면 정확히 원복된다 — 그래서 끄는 쪽은
 *  boolean 그대로 두고 복원 쪽만 복사본을 쓴다.)
 *
 * ── 재진입 ──────────────────────────────────────────────────────────
 * lock()은 **멱등**이다. 이미 잠긴 상태에서 다시 부르면 아무 일도 하지 않는다 — 두 번째
 * 호출이 이미 꺼진 상태를 '원본'으로 다시 캡처하면 그것도 영구 잠금이 된다.
 * 참조 카운트를 쓰지 않는 이유: 이 앱에는 동시 드래그가 없고, 카운트가 한 번 새면
 * (pointerup 유실 등) 영구 잠금이 되는데 그건 이 파일이 막으려는 바로 그 사고다.
 */

/** 옵션은 boolean·number 같은 순수 데이터라 JSON 왕복으로 충분하다(함수·순환 없음). */
function deepCopy(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * @param {{options: () => object, applyOptions: (o: object) => void}} chart
 * @returns {{lock: () => void, unlock: () => void, isLocked: () => boolean}}
 */
export function createInteractionLock(chart) {
  let saved = null; // 잠금 전 원본의 **복사본**. null이면 잠기지 않은 상태.

  return {
    /** 스크롤·줌을 끈다. 이미 잠겨 있으면 아무 일도 하지 않는다(멱등). */
    lock() {
      if (saved || !chart) return;
      const o = chart.options();
      saved = {
        handleScroll: deepCopy(o?.handleScroll),
        handleScale:  deepCopy(o?.handleScale),
      };
      chart.applyOptions({ handleScroll: false, handleScale: false });
    },

    /** 잠금 전 값으로 되돌린다. 잠기지 않았으면 아무 일도 하지 않는다. */
    unlock() {
      if (!saved || !chart) { saved = null; return; }
      const restore = saved;
      saved = null;
      chart.applyOptions(restore);
    },

    isLocked() { return saved !== null; },
  };
}
