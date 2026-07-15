/**
 * avgPriceStore.js — 우미 투자 평단가 읽기 추상화 (1차: 렌더링 계층만)
 *
 * getAvgPrice(symbol) 하나로 읽기를 모은다 — 2차에서 Redis(+토큰 인증) 조회로
 * 내부만 교체할 수 있도록, 렌더링 코드(MarketCard.jsx/Sparkline.jsx/Chart.jsx)는
 * 이 함수의 시그니처(symbol → number|null)만 알면 된다. 지금은 별도 저장소가
 * 없어 항상 아래 하드코딩 맵을 반환한다 — 커밋 상태는 항상 전부 null(평단가
 * 미설정)이어야 한다. 렌더링 검증 때만 로컬에서 임시로 값을 채워보고, 커밋
 * 전에 반드시 전부 null로 되돌릴 것.
 */

const AVG_PRICES = {
  HYPR:     null,
  '419530': null,
  '028300': null,
  '080220': null,
};

/** @returns {number|null} symbol(=워치리스트 item.id)의 평단가, 없으면 null */
export function getAvgPrice(symbol) {
  return AVG_PRICES[symbol] ?? null;
}

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
