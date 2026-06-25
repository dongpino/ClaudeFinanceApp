import { useState } from 'react';
import Header from './Header';
import CategoryTabs from './CategoryTabs';
import MarketCard, { detectIssues } from './MarketCard';
import BottomNav from './BottomNav';
import { useData } from '../DataContext';

const EXPECTED_IDS = ['nasdaq', 'dow', 'kospi', 'btc', 'vix', 'usdkrw'];

export default function HomePage({ activePage, onPageChange }) {
  const { items, updatedAt, loadError, source } = useData();
  const [activeCat, setActiveCat] = useState('전체');

  const list      = activeCat === '전체' ? items : items.filter(it => it.category === activeCat);
  const isSolo    = list.length === 1;
  const cols      = isSolo ? 1 : 2;
  const rowCount  = list.length ? Math.ceil(list.length / cols) : 1;
  const gridStyle = { gridTemplateRows: Array(rowCount).fill('1fr').join(' ') };

  // 이상 종목 집계 (데이터가 있는 경우에만 검사)
  const itemsWithIssues = items.filter(it => detectIssues(it).length > 0);
  const missingIds = items.length > 0
    ? EXPECTED_IDS.filter(id => !items.some(it => it.id === id))
    : [];
  const totalWarnings = itemsWithIssues.length + missingIds.length;

  const isStatic = source === 'static';

  return (
    <>
      <Header />
      <div className="page active">

        {/* 갱신 바 — 정적 소스일 때 점 색상을 amber로 변경 */}
        <div className="refresh-bar">
          <div className={`pulse-dot${isStatic ? ' static' : ''}`} />
          <span>{updatedAt}</span>
          {isStatic && <span className="static-chip">정적 데이터</span>}
        </div>

        {/* 이상 종목 요약 바 — 이상이 있을 때만 표시 */}
        {totalWarnings > 0 && (
          <div className="warn-bar">
            <span>⚠</span>
            <span>
              {itemsWithIssues.length > 0 && `${itemsWithIssues.length}개 종목 데이터 이상`}
              {itemsWithIssues.length > 0 && missingIds.length > 0 && ' · '}
              {missingIds.length > 0 && `${missingIds.join(', ')} 누락`}
              &nbsp;— 카드 ⚠ 배지 확인
            </span>
          </div>
        )}

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
