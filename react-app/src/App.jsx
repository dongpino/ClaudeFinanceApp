import { useState, useEffect, useRef } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import HomePage from './components/HomePage';
import DetailPage from './components/DetailPage';
import AnalysisPage from './components/AnalysisPage';
import CalendarPage from './components/CalendarPage';
import BriefingPage from './components/BriefingPage';
import GrainOverlay from './components/GrainOverlay';
import { installPinchZoomBlock } from './blockPinchZoom';
import { withViewTransition } from './viewTransition';

// 배경 색조/그레인 실험(?bgTheme=) — staging 전용 비교 스위치. HomePage.jsx의
// ?debugSwipe=1과 같은 패턴(쿼리 1회 판독 후 값으로 굳힘, 없거나 모르는 값이면
// 기본값). 색조 자체는 index.css가 html[data-bg-theme="..."] 정확 일치 선택자로
// 전담하고(1x/2x/3x 세 단), 여기서는 그 값 판독과 "그레인을 렌더할지·얼마나
// 진하게"만 결정한다.
//   - current       : 기본, 무변경
//   - warm          : 색조 1x
//   - warm-grain-2/4: 색조 1x + 그레인 2%/4%
//   - warm2         : 색조 2x
//   - warm2-grain-6/8: 색조 2x + 그레인 6%/8%(기존 2/4%가 "안 보인다"는 피드백 반영)
//   - warm3         : 색조 3x — 대놓고 보이는 상한선 용도, 그레인 조합 없음
const BG_THEME_FLAGS = new Set([
  'current',
  'warm', 'warm-grain-2', 'warm-grain-4',
  'warm2', 'warm2-grain-6', 'warm2-grain-8',
  'warm3',
]);
const GRAIN_OPACITY = {
  'warm-grain-2': 0.02, 'warm-grain-4': 0.04,
  'warm2-grain-6': 0.06, 'warm2-grain-8': 0.08,
};

function readBgThemeFlag() {
  const raw = new URLSearchParams(window.location.search).get('bgTheme');
  return BG_THEME_FLAGS.has(raw) ? raw : 'current';
}


function MainContent({ activePage, onPageChange, pendingAnalysisSelection, onConsumePendingAnalysisSelection }) {
  if (activePage === 'home') {
    return <HomePage activePage={activePage} onPageChange={onPageChange} />;
  }

  if (activePage === 'chart') {
    return (
      <AnalysisPage
        activePage={activePage}
        onPageChange={onPageChange}
        pendingSelection={pendingAnalysisSelection}
        onConsumePendingSelection={onConsumePendingAnalysisSelection}
      />
    );
  }

  if (activePage === 'calendar') {
    return <CalendarPage activePage={activePage} onPageChange={onPageChange} />;
  }

  if (activePage === 'briefing') {
    return <BriefingPage activePage={activePage} onPageChange={onPageChange} />;
  }

  return <HomePage activePage={activePage} onPageChange={onPageChange} />;
}

export default function App() {
  const [activePage, setActivePage] = useState('home');
  const navigate = useNavigate();
  const location = useLocation();

  // 모바일 핀치줌·더블탭줌 차단 (iOS Safari user-scalable=no 무시 보강) — 앱 루트 1회 등록
  useEffect(() => installPinchZoomBlock(), []);

  // ThemeContext.jsx의 data-theme 설정과 동일한 패턴 — state 초기화 시점에 바로
  // html 속성을 반영해, 첫 페인트부터 색조가 맞게 나오게 한다(별도 effect로 나중에
  // 적용하면 무테마 배경이 한 프레임 깜빡일 수 있음).
  const [bgTheme] = useState(() => {
    const flag = readBgThemeFlag();
    document.documentElement.dataset.bgTheme = flag;
    return flag;
  });
  // 캘린더 탭은 이미 사진 배경(PhotoBackground.jsx)이 있어 그레인을 겹치지 않는다
  // (요구사항) — activePage만으로는 상세화면(/detail/:id)에서도 activePage가
  // 'calendar'로 남아있을 수 있어(라우트 전환 시 activePage를 안 건드림) 그레인이
  // 잘못 꺼질 수 있으므로, 실제로 캘린더 화면이 보이는 루트 경로(pathname==='/')
  // 일 때만 제외 조건으로 친다.
  const isCalendarScreen = activePage === 'calendar' && location.pathname === '/';
  const showGrain = GRAIN_OPACITY[bgTheme] != null && !isCalendarScreen;

  // 진행 중인 탭 전환 뷰 트랜지션 — 테마(ThemeContext.jsx)와 달리 탭은 값이 4개라
  // "연속 이동이 자연스러운 동선"이므로 재클릭을 무시하지 않고 "마지막 클릭
  // 우선"으로 처리한다: 진행 중인 전환이 있으면 skipTransition()으로 즉시
  // 끝내고(애니메이션만 스킵, 실제 페이지는 그 시점 상태로 바로 반영됨) 새 전환을
  // 그 상태에서부터 다시 시작한다.
  const activeTabTransitionRef = useRef(null);

  function changeTab(page) {
    if (page === activePage) return; // 같은 탭 재클릭은 전환 없이 무동작(요구사항4)

    if (activeTabTransitionRef.current) {
      activeTabTransitionRef.current.skipTransition();
    }

    const transition = withViewTransition(() => setActivePage(page), { kind: 'tab' });
    activeTabTransitionRef.current = transition; // 폴백 경로(기능 미지원/reduced-motion)면 null — 다음 클릭이 자연히 새로 시작
    transition?.finished.finally(() => {
      if (activeTabTransitionRef.current === transition) activeTabTransitionRef.current = null;
    });
  }

  function handlePageChange(page) {
    changeTab(page);
    navigate('/');
  }

  // 상세화면 "분석 탭에서 열기" — 새 내비게이션 경로를 만들지 않고 기존
  // handlePageChange(=changeTab 재사용 + navigate('/'))를 그대로 타되, 탭 전환과
  // 함께 "분석 탭이 열리면 이 종목을 선택해라"는 페이로드만 하나 더 실어 보낸다.
  // AnalysisPage가 마운트(또는 이미 마운트된 채 이 값이 바뀌면) 시점에 소비하고
  // 스스로 null로 되돌린다(onConsumePendingAnalysisSelection).
  const [pendingAnalysisSelection, setPendingAnalysisSelection] = useState(null);

  function openInAnalysis(selection) {
    setPendingAnalysisSelection(selection);
    handlePageChange('chart');
  }

  return (
    <>
      {showGrain && <GrainOverlay opacity={GRAIN_OPACITY[bgTheme]} />}
      <Routes>
        <Route
          path="/detail/:id"
          element={
            <DetailPage
              onBack={() => navigate('/')}
              activePage={activePage}
              onPageChange={handlePageChange}
              onOpenAnalysis={openInAnalysis}
            />
          }
        />
        <Route
          path="*"
          element={
            <MainContent
              activePage={activePage}
              onPageChange={changeTab}
              pendingAnalysisSelection={pendingAnalysisSelection}
              onConsumePendingAnalysisSelection={() => setPendingAnalysisSelection(null)}
            />
          }
        />
      </Routes>
    </>
  );
}
