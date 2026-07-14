import { createContext, useContext, useState, useLayoutEffect, useRef } from 'react';
import { withViewTransition } from './viewTransition';

const Ctx = createContext({ theme: 'dark', toggle: () => {} });

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('theme');
    const resolved = (saved === 'light' || saved === 'dark')
      ? saved
      : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = resolved;
    return resolved;
  });

  // useLayoutEffect(useEffect 아님) — toggle()의 View Transition 크로스페이드 중
  // withViewTransition이 flushSync로 감싸는데, flushSync는 레이아웃 이펙트만 동기
  // 실행을 보장하고 패시브 이펙트(useEffect)는 보장하지 않는다. data-theme가 이
  // 시점에 이미 반영돼 있어야 뷰 트랜지션이 찍는 "전/후" 스크린샷에 CSS 기반
  // 배경/카드 변경이 온전히 잡힌다.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  // 진행 중인 뷰 전환 인스턴스 — 연타 가드용(테마는 값이 dark/light 둘뿐이라
  // 재클릭을 "마지막 클릭 우선"으로 처리해봐야 결국 원래 값으로 되돌아가는
  // 깜빡임일 뿐이다 — 진행 중이면 재클릭 자체를 무시하는 단순한 정책을 쓴다).
  const activeTransitionRef = useRef(null);

  function toggle() {
    if (activeTransitionRef.current) return; // 전환 진행 중 재클릭 무시

    const next = theme === 'dark' ? 'light' : 'dark';
    const transition = withViewTransition(() => setTheme(next));
    if (!transition) return; // 기능 미지원/reduced-motion — 이미 즉시 적용됨

    activeTransitionRef.current = transition;
    transition.finished.finally(() => {
      activeTransitionRef.current = null;
    });
  }

  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
