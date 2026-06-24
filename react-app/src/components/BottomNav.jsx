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
    id: 'chart', label: '차트',
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
    id: 'profile', label: '내 정보',
    icon: (
      <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
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
