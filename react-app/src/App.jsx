import { useState } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import HomePage from './components/HomePage';
import DetailPage from './components/DetailPage';
import AnalysisPage from './components/AnalysisPage';
import BriefingPage from './components/BriefingPage';
import SearchPage from './components/SearchPage';


function MainContent({ activePage, onPageChange }) {
  if (activePage === 'home') {
    return <HomePage activePage={activePage} onPageChange={onPageChange} />;
  }

  if (activePage === 'chart') {
    return <AnalysisPage activePage={activePage} onPageChange={onPageChange} />;
  }

  if (activePage === 'search') {
    return <SearchPage activePage={activePage} onPageChange={onPageChange} />;
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
