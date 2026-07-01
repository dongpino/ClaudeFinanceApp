import { useState, useEffect } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import * as wlStore from './watchlistStore.js'; // ← TEMP: 검증용, 3단계 전 제거
import HomePage from './components/HomePage';
import DetailPage from './components/DetailPage';
import AnalysisPage from './components/AnalysisPage';
import BriefingPage from './components/BriefingPage';
import BottomNav from './components/BottomNav';
import Header from './components/Header';

function PlaceholderPage({ title, sub, children }) {
  return (
    <div className="ph-wrap">
      <div className="ph-icon">{children}</div>
      <div className="ph-title">{title}</div>
      <p className="ph-sub">{sub}</p>
    </div>
  );
}

function ShellPage({ activePage, onPageChange, children }) {
  return (
    <>
      <Header />
      <div className="page active">{children}</div>
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </>
  );
}

function MainContent({ activePage, onPageChange }) {
  if (activePage === 'home') {
    return <HomePage activePage={activePage} onPageChange={onPageChange} />;
  }

  if (activePage === 'chart') {
    return <AnalysisPage activePage={activePage} onPageChange={onPageChange} />;
  }

  if (activePage === 'search') {
    return (
      <ShellPage activePage={activePage} onPageChange={onPageChange}>
        <PlaceholderPage title="검색" sub="종목 검색 준비 중">
          <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5"
               strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </PlaceholderPage>
      </ShellPage>
    );
  }

  if (activePage === 'briefing') {
    return <BriefingPage activePage={activePage} onPageChange={onPageChange} />;
  }

  return <HomePage activePage={activePage} onPageChange={onPageChange} />;
}

// ── TEMP: watchlist 2단계 콘솔 검증 (3단계 전 제거) ───────────────
function useWatchlistVerify() {
  useEffect(() => {
    const T = '[WL VERIFY]';
    wlStore.clear();

    // 1. 추가
    wlStore.add({ type: 'index',  id: 'btc',      symbol: 'BTC',    name: '비트코인' });
    wlStore.add({ type: 'index',  id: 'nasdaq',   symbol: 'NASDAQ', name: '나스닥'  });
    wlStore.add({ type: 'crypto', id: 'ethereum', symbol: 'ETH',    name: 'Ethereum' });
    console.log(T, '① 추가 3개:', wlStore.load().map(it => `${it.id}(${it.type})`));

    // 2. 중복 추가 거부
    const dup = wlStore.add({ type: 'index', id: 'btc', symbol: 'BTC', name: '비트코인' });
    console.log(T, '② BTC 중복 추가 →', dup === null ? 'null (거부) ✅' : '추가됨 ❌');

    // 3. 삭제
    wlStore.remove('nasdaq');
    console.log(T, '③ nasdaq 삭제 후:', wlStore.load().map(it => it.id));

    // 4. 순서 변경 (btc:0, ethereum:1) → (ethereum:0, btc:1)
    wlStore.reorder(0, 1);
    console.log(T, '④ reorder(0→1) 후:', wlStore.load().map(it => it.id));

    // 5. localStorage 영속성 확인
    const raw = JSON.parse(localStorage.getItem(wlStore.STORAGE_KEY) ?? '[]');
    console.log(T, '⑤ localStorage 영속:', raw.length, '개 ✅', raw.map(it => it.id));

    // 6. has() 확인
    console.log(T, '⑥ has("ethereum"):', wlStore.has('ethereum') ? 'true ✅' : 'false ❌');
    console.log(T, '   has("nasdaq"):', wlStore.has('nasdaq')   ? 'true ❌' : 'false ✅');

    // 7. addedAt 필드 확인
    const first = wlStore.load()[0];
    console.log(T, '⑦ addedAt 포함:', first?.addedAt ? `${first.addedAt} ✅` : '없음 ❌');

    // 8. window 노출 (콘솔 직접 조작)
    window.__wl = wlStore;
    console.log(T, '⑧ window.__wl 등록 — 콘솔에서 직접 호출 가능');
    console.log(T, '   예) __wl.add({ type:"crypto", id:"solana", symbol:"SOL", name:"Solana" })');
    console.log(T, '   예) __wl.load()');
    console.log(T, '   예) __wl.clear()');
  }, []);
}
// ────────────────────────────────────────────────────────────────

export default function App() {
  useWatchlistVerify(); // ← TEMP: 3단계 전 제거
  const [activePage, setActivePage] = useState('home');
  const navigate = useNavigate();

  function handlePageChange(page) {
    setActivePage(page);
    navigate('/');
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
          />
        }
      />
      <Route
        path="*"
        element={<MainContent activePage={activePage} onPageChange={setActivePage} />}
      />
    </Routes>
  );
}
