import { createContext, useContext, useState, useEffect } from 'react';

const DataContext = createContext(null);

const API_TIMEOUT_MS  = 15_000;  // 서버리스 콜드 스타트 포함 최대 15초 허용
const JSON_TIMEOUT_MS =  5_000;  // 정적 JSON fallback 최대 5초

function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(tid));
}

export function DataProvider({ children }) {
  const [items,     setItems]     = useState([]);
  const [updatedAt, setUpdatedAt] = useState('데이터 로딩 중…');
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = (url, timeoutMs) =>
      fetchWithTimeout(url, timeoutMs)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(data => {
          if (!Array.isArray(data.items)) throw new Error('items 배열 없음');
          if (cancelled) return;
          setItems(data.items);
          setUpdatedAt('마지막 갱신 : ' + (data.updated_at ?? '알 수 없음'));
        });

    load('/api/market-data', API_TIMEOUT_MS)
      .catch(err => {
        console.warn('[DataContext] /api/market-data 실패:', err.name, err.message, '→ 정적 fallback 시도');
        if (cancelled) return;
        return load('/market_data.json', JSON_TIMEOUT_MS);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[DataContext] 정적 fallback도 실패:', err.message);
        setLoadError(err.message);
        setUpdatedAt('로드 실패');
      });

    return () => { cancelled = true; };
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
