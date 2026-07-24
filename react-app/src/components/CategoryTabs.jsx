import { CATEGORY_TABS } from '../itemCategories';

export default function CategoryTabs({ activeCat, onChange, onEditMajor, onEditAvgPrices }) {
  return (
    <div className="tabs" role="tablist">
      {CATEGORY_TABS.map(({ key, label }) => (
        <button
          key={key}
          className={`tab${key === activeCat ? ' active' : ''}`}
          role="tab"
          aria-selected={key === activeCat}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
      {activeCat === 'major' && onEditMajor && (
        <button className="major-edit-trigger" onClick={onEditMajor}>
          편집
        </button>
      )}
      {/* Preview 배포에서는 조건이 false로 접혀 '평단가 편집' 버튼(문자열 포함)이 제거된다.
          어차피 'umi' 탭 자체가 없어 표시될 일도 없지만, 빌드 상수로 정적 DCE까지 보장한다. */}
      {import.meta.env.VITE_HIDE_WATCHLIST !== '1' && activeCat === 'umi' && onEditAvgPrices && (
        <button className="major-edit-trigger" onClick={onEditAvgPrices}>
          평단가 편집
        </button>
      )}
    </div>
  );
}
