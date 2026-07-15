import { createContext, useContext, useState, useEffect } from 'react';
import { loadAvgPrices, subscribeAvgPrices } from './avgPriceStore';

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
  // 'loading' | 'api' | 'static' | 'error'
  const [source,    setSource]    = useState('loading');
  // avgPriceStore.js 캐시 자체를 여기서 들고 있지 않는다(그 파일이 진실 소스) —
  // 이 카운터는 오직 "캐시가 바뀌었으니 컨텍스트 값을 새로 만들어서 소비자(HomePage
  // → MarketCard)를 리렌더시켜라"라는 신호로만 쓴다. MarketCard 등은 여전히
  // getAvgPrice()를 직접 호출하는 순수 함수라 이 카운터 자체를 몰라도 된다.
  const [, bumpAvgPricesTick] = useState(0);

  useEffect(() => {
    // 평단가 로딩은 market-data 로딩과 완전히 독립 — 실패해도(토큰 없음/네트워크/401)
    // 카드 기본 렌더에는 아무 영향 없이 평단 표시만 계속 비어있는다(avgPriceStore.js
    // 자체가 실패를 조용히 삼킴). 편집 패널에서 저장에 성공했을 때도 이 구독을 통해
    // 홈 화면이 곧바로 갱신된다.
    loadAvgPrices();
    return subscribeAvgPrices(() => bumpAvgPricesTick(t => t + 1));
  }, []);

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
        setSource('api');
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
            setUpdatedAt('마지막 갱신 : ' + (data.updated_at ?? '알 수 없음'));
            setSource('static');
          })
          .catch(jsonErr => {
            if (cancelled) return;
            console.error('[DataContext] 정적 fallback도 실패:', jsonErr.message);
            setLoadError(jsonErr.message);
            setUpdatedAt('로드 실패');
            setSource('error');
          });
      });

    return () => { cancelled = true; };
  }, []);

  return (
    <DataContext.Provider value={{ items, updatedAt, loadError, source }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  return useContext(DataContext);
}
