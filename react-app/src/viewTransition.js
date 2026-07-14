/**
 * viewTransition.js — View Transitions API 공용 래퍼.
 *
 * 테마 전환(ThemeContext.jsx)과 하단 탭 전환(App.jsx)이 똑같은 3가지 처리를
 * 반복하지 않도록 여기 한 곳에 모았다: 기능 감지(document.startViewTransition
 * 없는 브라우저는 즉시 적용), prefers-reduced-motion(즉시 적용), flushSync로
 * 감싸 상태 변경 커밋을 콜백이 끝나기 전에 동기적으로 강제(그래야 뷰 트랜지션이
 * 찍는 "전/후" 스크린샷에 실제 변경 결과가 반영된다 — layout effect까지 포함해서
 * 동기 실행되려면 호출부가 관련 effect를 useLayoutEffect로 둬야 한다는 전제는
 * 그대로 유지된다, ThemeContext.jsx/AnalysisChart.jsx 참고).
 *
 * kind로 index.css의 html[data-vt="{kind}"] 스코프 규칙을 잠깐 세워, 전환
 * 종류별로 다른 지속시간/이징을 줄 수 있게 한다(예: 'tab' → 180ms, 테마는
 * kind 없이 기본값 300ms). 전환이 끝나면(성공/스킵 무관) 속성을 지운다.
 *
 * 연타 정책(무시 vs 마지막 클릭 우선)은 여기서 강제하지 않는다 — 반환하는
 * ViewTransition 객체를 호출부가 직접 들고 있다가 정책에 맞게 처리한다
 * (테마: 진행 중이면 재클릭 자체를 무시. 탭: 새 클릭이 오면 이전 걸
 * transition.skipTransition()으로 즉시 끝내고 새로 시작 — "마지막 클릭 우선").
 */
import { flushSync } from 'react-dom';

/**
 * @param {() => void} applyChange - flushSync로 감쌀 상태 변경 함수(예: setState 호출)
 * @param {{ kind?: string }} [opts] - kind: html[data-vt="{kind}"] 스코프 이름(생략 시 기본 지속시간)
 * @returns {ViewTransition | null} 실제로 뷰 트랜지션을 탔으면 그 객체, 즉시 적용했으면 null
 */
export function withViewTransition(applyChange, { kind } = {}) {
  const supportsViewTransition = typeof document.startViewTransition === 'function';
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!supportsViewTransition || prefersReducedMotion) {
    applyChange();
    return null;
  }

  if (kind) document.documentElement.dataset.vt = kind;

  const transition = document.startViewTransition(() => {
    flushSync(applyChange);
  });

  transition.finished.finally(() => {
    if (kind) delete document.documentElement.dataset.vt;
  });

  return transition;
}
