import { useState, useEffect } from 'react';
import Header from './Header';
import CategoryTabs from './CategoryTabs';
import MajorEditPanel from './MajorEditPanel';
import MarketCard, { detectIssues } from './MarketCard';
import BottomNav from './BottomNav';
import { useData } from '../DataContext';
import { itemsInCategory, DEFAULT_CATEGORY, ITEM_CATEGORIES } from '../itemCategories';
import { loadMajorIds, saveMajorIds } from '../homeMajorStore';

// 경고 배지 시스템이 검사할 전체 종목 — itemCategories.js가 단일 정의 소스이므로
// 여기서 별도로 유지하지 않고 그대로 파생시킨다(새 종목 추가 시 이 목록도 자동 반영).
const EXPECTED_IDS = ITEM_CATEGORIES.map(c => c.id);

// 브리핑 탭 "주요 이슈"와 동일한 카테고리 아이콘 — 홈 스트립은 importance 2 이상만 노출.
const ISSUE_ICON = { regulation: '⚖️', exchange: '🏦', listing: '🆕', earnings: '📈', macro_shock: '💥', other_major: '🔔' };

// 홈 상단 돌발 이슈 스트립 — 실패/로딩/이슈 없음이면 조용히 숨긴다(홈 본 기능과 완전 분리).
function IssueStrip({ issues, onClick }) {
  const majorIssues = issues.filter(it => it.importance >= 2);
  if (majorIssues.length === 0) return null;

  return (
    <div className="home-issue-strip" onClick={onClick} role="button" tabIndex={0}>
      {majorIssues.map((it, i) => (
        <span key={i} className="home-issue-chip">
          {ISSUE_ICON[it.category] ?? '🔔'} {it.title_ko}
        </span>
      ))}
    </div>
  );
}

export default function HomePage({ activePage, onPageChange }) {
  const { items, updatedAt, loadError, source } = useData();
  const [activeCat, setActiveCat] = useState(DEFAULT_CATEGORY);

  // "주요" 탭 사용자 선택(최대 4개) — 없으면 loadMajorIds()가 기본값으로 폴백.
  const [majorIds, setMajorIds]         = useState(loadMajorIds);
  const [editingMajor, setEditingMajor] = useState(false);

  // 돌발 이슈 스트립 — 실패해도 조용히 숨길 뿐 홈 본 기능에는 영향 없음.
  const [issues, setIssues] = useState([]);
  useEffect(() => {
    fetch('/api/issues')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => setIssues(Array.isArray(data.issues) ? data.issues : []))
      .catch(() => setIssues([]));
  }, []);

  function handleSaveMajor(ids) {
    setMajorIds(ids);
    saveMajorIds(ids);
    setEditingMajor(false);
  }

  const list      = itemsInCategory(items, activeCat, majorIds);
  const isSolo    = list.length === 1;

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

        <IssueStrip issues={issues} onClick={() => onPageChange('briefing')} />

        <CategoryTabs
          activeCat={activeCat}
          onChange={setActiveCat}
          onEditMajor={() => setEditingMajor(true)}
        />
        <main
          className={`grid${isSolo ? ' solo' : ''}`}
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
      {editingMajor && (
        <MajorEditPanel selectedIds={majorIds} onSave={handleSaveMajor} />
      )}
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </>
  );
}
