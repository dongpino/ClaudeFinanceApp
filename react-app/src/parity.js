/**
 * parity.js — 주가 패리티(현재가 ÷ 평단가) 순수 계산
 *
 * avgPriceRange.js와 같은 이유로 **데이터 계층과 분리한다.** 이 함수는 평단가가 어디서
 * 오는지(getAvgPrice·Redis·워치리스트 심볼 목록)를 전혀 모르고 숫자 둘만 받는다. 그래서
 * 브라우저 없이 테스트되고, Preview 배포(VITE_HIDE_WATCHLIST=1)에서 이 모듈이 남아도
 * 워치리스트 흔적(심볼·캐시)을 번들에 끌고 오지 않는다.
 *
 * ⚠️ 통화 환산을 하지 않는다. 평단가는 그 종목 자신의 통화로 입력받으므로(편집 패널이
 *    item.currency로 $/₩ 접두어와 step을 정한다) 현재가와 같은 통화다. 저장값(Redis)에는
 *    통화 태그가 없어 "USD 종목에 원화 금액"이 들어와도 검출할 수단이 없다 — 카드의 평단
 *    배지도 같은 가정 위에 서 있고, 이 모듈이 새로 만든 위험이 아니다.
 */

/**
 * 패리티(%) — 현재가가 평단가의 몇 %인가. 정수로 반올림한다.
 *
 * ⚠️ **평단가가 없으면 0이 아니라 null이다.** 0%는 "전액 손실"과 구분되지 않으므로
 *    미입력을 0으로 표기하면 안 된다 — 호출부는 null일 때 표시 자체를 숨긴다.
 *
 * @param {number} price     현재가
 * @param {number|null} avgPrice  평단가(없으면 null)
 * @returns {number|null} 정수 % (예: 180), 계산이 성립하지 않으면 null
 */
export function parityPercent(price, avgPrice) {
  if (!Number.isFinite(price)) return null;
  // avgPrice <= 0이면 나눗셈이 성립하지 않는다. 서버 검증이 이미 양수만 통과시키지만
  // (api/user-prefs.js) 여기서도 막는다 — 표시 계층이 서버 검증에 의존하지 않게 한다.
  if (!Number.isFinite(avgPrice) || avgPrice <= 0) return null;
  return Math.round((price / avgPrice) * 100);
}

/**
 * 패리티의 손익 방향. 색 규칙은 호출부(CSS)가 정하고 여기서는 분류만 한다.
 * ⚠️ 기준은 100%다(0%가 아니다) — 평단가와 같으면 본전이라 'flat'이다.
 * @returns {'up'|'down'|'flat'|null}
 */
export function parityDirection(parity) {
  if (!Number.isFinite(parity)) return null;
  return parity > 100 ? 'up' : parity < 100 ? 'down' : 'flat';
}
