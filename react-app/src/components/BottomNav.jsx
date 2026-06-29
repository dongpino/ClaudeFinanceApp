const NAV_ITEMS = [
  {
    id: 'home', label: '홈',
    icon: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
    ),
  },
  {
    id: 'chart', label: '분석',
    icon: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <line x1="18" y1="20" x2="18" y2="10"/>
        <line x1="12" y1="20" x2="12" y2="4"/>
        <line x1="6"  y1="20" x2="6"  y2="14"/>
      </svg>
    ),
  },
  {
    id: 'search', label: '검색',
    icon: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
    ),
  },
  {
    id: 'briefing', label: '브리핑',
    icon: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v2"/>
        <path d="M4 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>
        <line x1="10" y1="8"  x2="20" y2="8"/>
        <line x1="10" y1="12" x2="20" y2="12"/>
        <line x1="10" y1="16" x2="20" y2="16"/>
      </svg>
    ),
  },
];

export default function BottomNav({ activePage, onPageChange }) {
  return (
    <nav className="bottom-nav">
      {NAV_ITEMS.map(({ id, label, icon }) => (
        <button
          key={id}
          className={`nav-item${id === activePage ? ' active' : ''}`}
          onClick={() => onPageChange(id)}
        >
          {icon}
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
