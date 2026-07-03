import { CATEGORY_TABS } from '../itemCategories';

export default function CategoryTabs({ activeCat, onChange, onEditMajor }) {
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
    </div>
  );
}
