/**
 * blockPinchZoom.js — iOS Safari 핀치줌·더블탭줌 JS 레벨 차단
 *
 * viewport meta(user-scalable=no)와 CSS touch-action만으로는 iOS Safari에서
 * 페이지 핀치줌을 완전히 막지 못한다(user-scalable=no를 무시하는 알려진 동작).
 * 이 모듈은 document 레벨에서 제스처를 가로채 보강한다.
 *
 * 차트 컨테이너(.detail-chart-wrap / .analysis-price-chart / .analysis-rsi-chart)
 * 내부에서 시작된 터치는 lightweight-charts 자체 핀치줌·더블탭 처리를 위해 통과시킨다.
 * gesturestart/change/end(iOS 전용 네이티브 페이지 확대 제스처)는 차트 라이브러리가
 * 쓰지 않는 별도 API라 예외 없이 전역 차단해도 차트 핀치줌엔 영향 없다.
 */

const CHART_SELECTOR = '.detail-chart-wrap, .analysis-price-chart, .analysis-rsi-chart';
const DOUBLE_TAP_MS  = 300;

function isInsideChart(target) {
  return target instanceof Element && target.closest(CHART_SELECTOR) !== null;
}

/**
 * 리스너 등록. 반환값(cleanup 함수)을 useEffect에서 그대로 반환하면 됨.
 */
export function installPinchZoomBlock() {
  let lastTouchEnd = 0;

  const onGesture = e => e.preventDefault();

  const onTouchMove = e => {
    if (e.touches.length > 1 && !isInsideChart(e.target)) {
      e.preventDefault();
    }
  };

  const onTouchEnd = e => {
    const now = Date.now();
    if (!isInsideChart(e.target) && now - lastTouchEnd <= DOUBLE_TAP_MS) {
      e.preventDefault();
    }
    lastTouchEnd = now;
  };

  document.addEventListener('gesturestart',  onGesture,   { passive: false });
  document.addEventListener('gesturechange', onGesture,   { passive: false });
  document.addEventListener('gestureend',    onGesture,   { passive: false });
  document.addEventListener('touchmove',     onTouchMove, { passive: false });
  document.addEventListener('touchend',      onTouchEnd,  { passive: false });

  return () => {
    document.removeEventListener('gesturestart',  onGesture);
    document.removeEventListener('gesturechange', onGesture);
    document.removeEventListener('gestureend',    onGesture);
    document.removeEventListener('touchmove',     onTouchMove);
    document.removeEventListener('touchend',      onTouchEnd);
  };
}
