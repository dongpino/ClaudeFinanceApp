import { createContext, useContext, useState, useEffect } from 'react';

const DataContext = createContext(null);

export function DataProvider({ children }) {
  const [items, setItems]         = useState([]);
  const [updatedAt, setUpdatedAt] = useState('데이터 로딩 중…');
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    // vercel dev / 배포: /api/market-data (서버리스 함수)
    // npm run dev (Vite 단독): /market_data.json (정적 파일 fallback)
    const load = (url) =>
      fetch(url)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(data => {
          if (!Array.isArray(data.items)) throw new Error('items 배열 없음');
          setItems(data.items);
          setUpdatedAt('마지막 갱신 : ' + (data.updated_at ?? '알 수 없음'));
        });

    load('/api/market-data')
      .catch(() => load('/market_data.json'))
      .catch(err => {
        setLoadError(err.message);
        setUpdatedAt('로드 실패');
      });
  }, []);

  return (
    <DataContext.Provider value={{ items, updatedAt, loadError }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  return useContext(DataContext);
}
