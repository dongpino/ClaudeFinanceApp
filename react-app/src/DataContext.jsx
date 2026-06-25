import { createContext, useContext, useState, useEffect } from 'react';

const DataContext = createContext(null);

const API_TIMEOUT_MS  = 15_000;  // 서버리스 콜드 스타트 포함 최대 15초
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

    // ── 1순위: 서버리스 API ────────────────────────────
    fetchWithTimeout('/api/market-data', API_TIMEOUT_MS)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        if (!Array.isArray(data.items)) throw new Error('items 배열 없음');
        if (cancelled) return;
        console.info('[DataContext] ✅ 서버리스 API:', data.updated_at, `(${data.items.length}종목)`);
        setItems(data.items);
        setUpdatedAt('마지막 갱신 : ' + (data.updated_at ?? '알 수 없음'));
      })
      .catch(apiErr => {
        // ── 2순위: 정적 JSON fallback (API 실패 시에만) ──
        console.warn('[DataContext] ⚠ API 실패:', apiErr.name, apiErr.message, '→ 정적 fallback 시도');
        if (cancelled) return;

        fetchWithTimeout('/market_data.json', JSON_TIMEOUT_MS)
          .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
          .then(data => {
            if (!Array.isArray(data.items)) throw new Error('items 배열 없음');
            if (cancelled) return;
            console.info('[DataContext] 📄 정적 fallback:', data.updated_at, `(${data.items.length}종목)`);
            setItems(data.items);
            // [정적] 표시로 어느 소스인지 화면에서 구분 가능
            setUpdatedAt('마지막 갱신 : ' + (data.updated_at ?? '알 수 없음') + ' [정적]');
          })
          .catch(jsonErr => {
            if (cancelled) return;
            console.error('[DataContext] 정적 fallback도 실패:', jsonErr.message);
            setLoadError(jsonErr.message);
            setUpdatedAt('로드 실패');
          });
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
