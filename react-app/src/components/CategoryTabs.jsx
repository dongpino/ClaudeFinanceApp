import { CATEGORY_TABS } from '../itemCategories';

export default function CategoryTabs({ activeCat, onChange }) {
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
    </div>
  );
}
