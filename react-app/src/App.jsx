import { useState } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import HomePage from './components/HomePage';
import DetailPage from './components/DetailPage';
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
    return (
      <ShellPage activePage={activePage} onPageChange={onPageChange}>
        <PlaceholderPage title="차트" sub="상세 차트 준비 중">
          <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5"
               strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6"  y1="20" x2="6"  y2="14"/>
          </svg>
        </PlaceholderPage>
      </ShellPage>
    );
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

  if (activePage === 'profile') {
    return (
      <ShellPage activePage={activePage} onPageChange={onPageChange}>
        <PlaceholderPage title="내 정보" sub="프로필 준비 중">
          <svg width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5"
               strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        </PlaceholderPage>
      </ShellPage>
    );
  }

  return <HomePage activePage={activePage} onPageChange={onPageChange} />;
}

export default function App() {
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
