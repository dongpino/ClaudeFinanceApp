const CATS = ['전체', '지수', '환율', '크립토'];

export default function CategoryTabs({ activeCat, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {CATS.map(cat => (
        <button
          key={cat}
          className={`tab${cat === activeCat ? ' active' : ''}`}
          role="tab"
          aria-selected={cat === activeCat}
          onClick={() => onChange(cat)}
        >
          {cat}
        </button>
      ))}
    </div>
  );
}
