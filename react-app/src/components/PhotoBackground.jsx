/**
 * PhotoBackground.jsx — 탭 배경으로 쓰는 고정 사진 레이어
 *
 * position:fixed + z-index:-1로 뷰포트 전체를 덮는 배경 이미지를 렌더링한다.
 * #root에 준 isolation:isolate(index.css)가 이 레이어를 body/html의 불투명
 * 배경(둘 다 var(--bg))과 별개의 스태킹 컨텍스트로 격리해준다 — 그게 없으면
 * html의 background가 이미 불투명이라 캔버스 배경 전파가 일어나지 않고, body
 * 자신의 배경이 그대로 페인트돼 z-index:-1인 이 레이어를 가려버린다.
 *
 * src는 절대 경로(예: '/bg/forest-calendar.webp')로 전달 — public/ 밑에 두면
 * 그대로 서빙되므로 별도 import 없이 바로 쓸 수 있다. 어느 탭에서 쓸지는
 * 이 컴포넌트가 알 필요 없이, 해당 페이지 컴포넌트가 조건부로 렌더링하면 된다.
 */
export default function PhotoBackground({ src }) {
  return (
    <div
      className="photo-background"
      style={{ backgroundImage: `url(${src})` }}
      aria-hidden="true"
    />
  );
}
