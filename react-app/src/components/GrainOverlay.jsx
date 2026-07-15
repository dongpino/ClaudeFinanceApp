/**
 * GrainOverlay.jsx — 배경 그레인 노이즈 실험 레이어 (?bgTheme=warm-grain-2/4 전용)
 *
 * 실제 노이즈 텍스처/위치(fixed, z-index:-1)/타일링은 index.css .grain-overlay가
 * 전부 담당한다(feTurbulence SVG data URI) — 이 컴포넌트는 App.jsx가 결정한
 * opacity 값을 --grain-opacity CSS 변수로 실어 나르는 얇은 래퍼일 뿐이다.
 * PhotoBackground.jsx와 마찬가지로 #root의 isolation:isolate 안에서 렌더되는 한
 * 어느 깊이에 있어도 z-index:-1이 올바르게 격리된다.
 */
export default function GrainOverlay({ opacity }) {
  return <div className="grain-overlay" style={{ '--grain-opacity': opacity }} aria-hidden="true" />;
}
