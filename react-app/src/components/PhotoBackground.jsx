import { useEffect, useRef } from 'react';
import { useTheme } from '../ThemeContext';

// 콘텐츠 스크롤 속도 대비 배경 이동 속도 비율 — 0.3 = 콘텐츠가 100px 내려가면
// 배경은 30px만 위로 흘러, 배경이 콘텐츠보다 "느리게" 움직이는 패럴랙스가 생긴다.
const PARALLAX_FACTOR = 0.3;

/**
 * PhotoBackground.jsx — 탭 배경으로 쓰는 사진 레이어(다크 테마 전용), 패럴랙스 적용
 *
 * position:fixed + z-index:-1로 뷰포트 전체를 덮는 배경 이미지를 렌더링한다.
 * height:130%(index.css)로 뷰포트보다 위아래 30%만큼 여유를 둬서, 아래의 스크롤
 * 연동 transform으로 위로 밀어 올려도 바닥에 빈 공간이 드러나지 않는다.
 *
 * 패럴랙스: scrollContainerRef가 가리키는 스크롤 컨테이너(현재는 .cal-scroll)의
 * scroll 이벤트를 passive로 구독하고, requestAnimationFrame으로 스로틀해서
 * transform: translate3d(0, -scrollTop*PARALLAX_FACTOR, 0)만 갱신한다 — top/margin
 * 대신 transform만 건드리는 이유는 GPU 합성(레이아웃/페인트 재계산 없음)을 타서
 * 모바일 스크롤 성능을 지키기 위함. offset은 배경의 실제 높이(130%)를 넘지 않도록
 * clamp해서, 아주 긴 콘텐츠(이벤트가 많은 달 + 다가오는 이벤트 리스트)에서도
 * 바닥이 드러나지 않게 방어한다.
 *
 * #root에 준 isolation:isolate(index.css)가 이 레이어를 body/html의 불투명
 * 배경(둘 다 var(--bg))과 별개의 스태킹 컨텍스트로 격리해준다 — 그게 없으면
 * html의 background가 이미 불투명이라 캔버스 배경 전파가 일어나지 않고, body
 * 자신의 배경이 그대로 페인트돼 z-index:-1인 이 레이어를 가려버린다. PhotoBackground가
 * #root의 자식 트리 안에 있는 한(어느 깊이든) 이 격리는 계속 유효하다.
 *
 * 라이트 테마에서는 렌더링하지 않는다 — 사진 위 반투명 유리 카드(index.css의
 * [data-theme="dark"] .cal-fold 등)와 짝을 이루는 다크 전용 장식이라, 라이트
 * 테마 텍스트 색(어두운 네이비 계열)과 겹치면 대비가 무너져 판독이 안 된다.
 *
 * src는 절대 경로(예: '/bg/forest-calendar.webp')로 전달 — public/ 밑에 두면
 * 그대로 서빙되므로 별도 import 없이 바로 쓸 수 있다. scrollContainerRef는 패럴랙스
 * 기준이 될 스크롤 컨테이너의 ref — 어느 탭에서 쓸지, 그 탭의 스크롤 구조가
 * 어떤지는 이 컴포넌트가 알 필요 없이 호출하는 페이지 컴포넌트가 넘겨주면 된다.
 */
export default function PhotoBackground({ src, scrollContainerRef }) {
  const { theme } = useTheme();
  const elRef = useRef(null);

  useEffect(() => {
    if (theme !== 'dark') return undefined;
    const scrollEl = scrollContainerRef?.current;
    const bgEl = elRef.current;
    if (!scrollEl || !bgEl) return undefined;

    let rafId = null;

    function applyParallax() {
      rafId = null;
      const maxUpShift = -(bgEl.offsetHeight - window.innerHeight); // 130% 높이가 주는 여유의 바닥
      const offset = Math.max(-scrollEl.scrollTop * PARALLAX_FACTOR, maxUpShift);
      bgEl.style.transform = `translate3d(0, ${offset}px, 0)`;
    }

    function onScroll() {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(applyParallax);
    }

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    applyParallax(); // 탭 재진입 등으로 scrollTop이 이미 0이 아닐 때 초기 위치 동기화

    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [theme, scrollContainerRef]);

  if (theme !== 'dark') return null;

  return (
    <div
      ref={elRef}
      className="photo-background"
      style={{ backgroundImage: `url(${src})` }}
      aria-hidden="true"
    />
  );
}
