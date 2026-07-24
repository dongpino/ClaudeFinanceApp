/**
 * avgPriceRange.js — 평단선 표시 범위 판정(순수 기하 헬퍼)
 *
 * avgPriceStore.js에서 분리해 여기 둔다. 이 함수는 평단가 '데이터'(getAvgPrice·워치리스트
 * 종목·서버 연동)와 전혀 무관한 순수 계산이라, Sparkline/Chart가 이 모듈만 import하면
 * Preview 배포(VITE_HIDE_WATCHLIST=1)에서 avgPriceStore.js 자체가 어디서도 import되지
 * 않아 통째로 트리셰이킹된다(그 모듈의 WATCHLIST_IDS·인메모리 캐시까지 번들에서 제거).
 */

/**
 * avgPrice가 차트에 실제로 그려지는 가격 범위 [lo,hi] ±5% 여유 안에 있는지 판정 —
 * 카드 스파크라인(Sparkline.jsx)과 상세 캔들차트(Chart.jsx)가 공통으로 쓰는 규칙이라
 * 여기 한 곳에만 둔다(두 곳에 각자 구현하면 여유값이 어긋날 위험). 이 함수는 판정만
 * 하고 y축 스케일에는 관여하지 않는다 — "범위 안 = 라인 / 밖 = 가장자리 힌트"를
 * 나누는 것은 호출부 몫이다(y축 왜곡 금지는 호출부가 지켜야 할 제약).
 * @returns {'in'|'above'|'below'}
 */
export function avgPriceRangeStatus(avgPrice, lo, hi) {
  const rng = (hi - lo) || (hi * 0.005) || 1; // lo===hi(플랫) 폴백 — Sparkline.jsx 자체 rng 계산과 동일 규칙
  const margin = rng * 0.05;
  if (avgPrice > hi + margin) return 'above';
  if (avgPrice < lo - margin) return 'below';
  return 'in';
}
