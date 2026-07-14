import { useState, useEffect, useRef } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import HomePage from './components/HomePage';
import DetailPage from './components/DetailPage';
import AnalysisPage from './components/AnalysisPage';
import CalendarPage from './components/CalendarPage';
import BriefingPage from './components/BriefingPage';
import { installPinchZoomBlock } from './blockPinchZoom';
import { withViewTransition } from './viewTransition';


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

  // 모바일 핀치줌·더블탭줌 차단 (iOS Safari user-scalable=no 무시 보강) — 앱 루트 1회 등록
  useEffect(() => installPinchZoomBlock(), []);

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
  );
}
