import { useState } from 'react';
import Header from './Header';
import CategoryTabs from './CategoryTabs';
import MarketCard from './MarketCard';
import BottomNav from './BottomNav';
import { useData } from '../DataContext';

export default function HomePage({ activePage, onPageChange }) {
  const { items, updatedAt, loadError } = useData();
  const [activeCat, setActiveCat] = useState('전체');

  const list      = activeCat === '전체' ? items : items.filter(it => it.category === activeCat);
  const isSolo    = list.length === 1;
  const cols      = isSolo ? 1 : 2;
  const rowCount  = list.length ? Math.ceil(list.length / cols) : 1;
  const gridStyle = { gridTemplateRows: Array(rowCount).fill('1fr').join(' ') };

  return (
    <>
      <Header />
      <div className="page active">
        <div className="refresh-bar">
          <div className="pulse-dot" />
          <span>{updatedAt}</span>
        </div>
        <CategoryTabs activeCat={activeCat} onChange={setActiveCat} />
        <main
          className={`grid${isSolo ? ' solo' : ''}`}
          style={gridStyle}
          aria-live="polite"
        >
          {loadError ? (
            <div className="state-wrap error">
              <p>데이터 로드 실패: {loadError}</p>
              <small>public/market_data.json 파일을 확인하세요.</small>
            </div>
          ) : !items.length ? (
            <div className="state-wrap">
              <p>데이터 불러오는 중…</p>
            </div>
          ) : !list.length ? (
            <div className="state-wrap">
              <p>해당 카테고리에 데이터가 없습니다</p>
            </div>
          ) : (
            list.map(item => <MarketCard key={item.id} item={item} />)
          )}
        </main>
      </div>
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </>
  );
}
