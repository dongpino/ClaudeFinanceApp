import { useState } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
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
