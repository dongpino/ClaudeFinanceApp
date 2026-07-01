import { useState, useEffect, useRef } from 'react';
import Header from './Header';
import BottomNav from './BottomNav';
import WatchlistCard from './WatchlistCard';
import { useData } from '../DataContext';
import useWatchlist from '../useWatchlist';

const INDEX_ITEMS = [
  { type: 'index', id: 'nasdaq',  symbol: 'NASDAQ', name: '나스닥'  },
  { type: 'index', id: 'dow',     symbol: 'DOW',    name: '다우존스' },
  { type: 'index', id: 'kospi',   symbol: 'KOSPI',  name: '코스피'  },
  { type: 'index', id: 'btc',     symbol: 'BTC',    name: '비트코인' },
  { type: 'index', id: 'vix',     symbol: 'VIX',    name: 'VIX'    },
  { type: 'index', id: 'usdkrw',  symbol: 'KRW',    name: '원/달러' },
];

const DEBOUNCE_MS = 350;

export default function SearchPage({ activePage, onPageChange }) {
  const { watchlist, add, remove, isWatched, MAX_WATCHLIST } = useWatchlist();
  const { items: indexItems } = useData();

  // ── 검색 상태 ────────────────────────────────────────────────
  const [query,         setQuery]        = useState('');
  const [coinResults,   setCoinResults]  = useState([]);
  const [stockResults,  setStockResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError,   setSearchError]  = useState(null);
  const debounceRef = useRef(null);
  const searchIdRef = useRef(0);   // stale-fetch 방지

  function handleQuery(e) {
    const q = e.target.value;
    setQuery(q);
    setCoinResults([]);
    setStockResults([]);
    setSearchError(null);
    clearTimeout(debounceRef.current);

    if (!q.trim()) { setSearchLoading(false); return; }

    setSearchLoading(true);
    debounceRef.current = setTimeout(async () => {
      const id = ++searchIdRef.current;
      try {
        const [coinRes, stockRes] = await Promise.allSettled([
          fetch(`/api/coin-search?q=${encodeURIComponent(q.trim())}`).then(r => r.json()),
          fetch(`/api/stock-search?q=${encodeURIComponent(q.trim())}`).then(r => r.json()),
        ]);
        if (id !== searchIdRef.current) return;
        setCoinResults(coinRes.status  === 'fulfilled' ? (coinRes.value.results  ?? []) : []);
        setStockResults(stockRes.status === 'fulfilled' ? (stockRes.value.results ?? []) : []);
      } catch (err) {
        if (id !== searchIdRef.current) return;
        setSearchError(err.message);
      } finally {
        if (id === searchIdRef.current) setSearchLoading(false);
      }
    }, DEBOUNCE_MS);
  }

  function clearQuery() {
    setQuery('');
    setCoinResults([]);
    setStockResults([]);
    setSearchLoading(false);
    setSearchError(null);
    clearTimeout(debounceRef.current);
  }

  // ── 코인 시세 ────────────────────────────────────────────────
  const [cryptoPrices,    setCryptoPrices]    = useState({});
  const [cryptoFetchedAt, setCryptoFetchedAt] = useState(null);

  const cryptoKey = watchlist
    .filter(it => it.type === 'crypto')
    .map(it => it.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!cryptoKey) { setCryptoPrices({}); return; }
    let cancelled = false;
    fetch(`/api/coin-price?ids=${cryptoKey}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        const map = {};
        for (const it of data.items ?? []) map[it.id] = it;
        setCryptoPrices(map);
        setCryptoFetchedAt(data.fetched_at ?? null);
      })
      .catch(err => console.error('[SearchPage] coin-price:', err.message));
    return () => { cancelled = true; };
  }, [cryptoKey]);

  // ── 미국 주식 시세 ───────────────────────────────────────────
  const [stockPrices,    setStockPrices]    = useState({});
  const [stockFetchedAt, setStockFetchedAt] = useState(null);

  const stockKey = watchlist
    .filter(it => it.type === 'stock')
    .map(it => it.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!stockKey) { setStockPrices({}); return; }
    let cancelled = false;
    fetch(`/api/stock-quote?symbols=${stockKey}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        const map = {};
        for (const it of data.items ?? []) map[it.id] = it;
        setStockPrices(map);
        setStockFetchedAt(data.fetched_at ?? null);
      })
      .catch(err => console.error('[SearchPage] stock-quote:', err.message));
    return () => { cancelled = true; };
  }, [stockKey]);

  // ── 라이브 데이터 병합 ───────────────────────────────────────
  function getLiveItem(wlItem) {
    if (wlItem.type === 'index') {
      const live = indexItems.find(it => it.id === wlItem.id);
      return live ? { ...live, type: 'index' } : null;
    }
    if (wlItem.type === 'crypto') {
      const cd = cryptoPrices[wlItem.id];
      if (!cd) return null;
      const asOf = cryptoFetchedAt
        ? new Date(cryptoFetchedAt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '-';
      return { ...cd, type: 'crypto', history: (cd.sparkline ?? []).map(v => ({ close: v })), as_of: asOf };
    }
    if (wlItem.type === 'stock') {
      const sd = stockPrices[wlItem.id];
      if (!sd) return null;
      const asOf = stockFetchedAt
        ? new Date(stockFetchedAt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '-';
      return { ...sd, name: wlItem.name, type: 'stock', history: [], as_of: asOf };
    }
    return null;
  }

  // ── 이벤트 핸들러 ────────────────────────────────────────────
  function handleAddCoin(coin) {
    add({ type: 'crypto', id: coin.id, symbol: coin.symbol, name: coin.name });
  }

  function handleAddStock(stock) {
    add({ type: 'stock', id: stock.symbol, symbol: stock.symbol, name: stock.name });
  }

  function toggleIndex(item) {
    if (isWatched(item.id)) remove(item.id);
    else add(item);
  }

  const isFull = watchlist.length >= MAX_WATCHLIST;

  // 코인 최대 5 + 주식 최대 5 병합 (코인 우선)
  const mergedResults = [
    ...coinResults.slice(0, 5).map(c => ({ ...c, _kind: 'coin' })),
    ...stockResults.slice(0, 5).map(s => ({ ...s, id: s.symbol, _kind: 'stock' })),
  ];

  return (
    <>
      <Header />
      <div className="page active">
        <div className="search-scroll">

          {/* ── 코인 + 미국주식 통합 검색 ─────────────────────── */}
          <section className="wl-search-wrap">
            <div className="wl-search-bar">
              <svg className="wl-search-icon" width="15" height="15" fill="none" stroke="currentColor"
                   strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                className="wl-search-input"
                type="text"
                placeholder="코인·미국주식 검색... (BTC, Apple, AAPL...)"
                value={query}
                onChange={handleQuery}
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button className="wl-search-clear" onClick={clearQuery} aria-label="검색어 지우기">×</button>
              )}
            </div>

            {query.trim() && (
              <div className="wl-autocomplete">
                {searchLoading && <p className="wl-ac-state">검색 중…</p>}
                {!searchLoading && searchError && <p className="wl-ac-state">오류: {searchError}</p>}
                {!searchLoading && !searchError && mergedResults.length === 0 && (
                  <p className="wl-ac-state">"{query}" 검색 결과 없음</p>
                )}
                {mergedResults.map(item => {
                  const watched = isWatched(item.id);
                  const isCoin  = item._kind === 'coin';
                  return (
                    <div key={`${item._kind}-${item.id}`} className="wl-ac-item">
                      {isCoin && item.thumb
                        ? <img src={item.thumb} alt={item.symbol} className="wl-ac-thumb" />
                        : <div className="wl-ac-thumb-placeholder">{(item.symbol ?? '').slice(0, 2)}</div>
                      }
                      <div className="wl-ac-info">
                        <span className="wl-ac-name">{item.name}</span>
                        <span className="wl-ac-symbol">{item.symbol}</span>
                      </div>
                      {isCoin && item.market_cap_rank && (
                        <span className="wl-ac-rank">#{item.market_cap_rank}</span>
                      )}
                      <span className={`wl-ac-badge ${isCoin ? 'wl-ac-badge-coin' : 'wl-ac-badge-stock'}`}>
                        {isCoin ? '코인' : '주식'}
                      </span>
                      <button
                        className={`wl-ac-add-btn${watched ? ' added' : ''}`}
                        disabled={!watched && isFull}
                        onClick={() => {
                          if (watched || isFull) return;
                          isCoin ? handleAddCoin(item) : handleAddStock(item);
                        }}
                        title={watched ? '이미 추가됨' : isFull ? `상한 ${MAX_WATCHLIST}개 초과` : '즐겨찾기 추가'}
                      >
                        {watched ? '★' : '+'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── 기존 6종목 칩 ──────────────────────────────────── */}
          <section className="wl-section">
            <div className="wl-section-head">
              <span className="wl-section-title">기존 종목</span>
              <span className="wl-section-count">별표로 즐겨찾기 추가</span>
            </div>
            <div className="wl-index-chips">
              {INDEX_ITEMS.map(item => {
                const watched = isWatched(item.id);
                return (
                  <div key={item.id} className={`wl-index-chip${watched ? ' watched' : ''}`}>
                    <span className="wl-chip-label">{item.name}</span>
                    <button
                      className="wl-chip-star"
                      onClick={() => toggleIndex(item)}
                      aria-label={watched ? `${item.name} 즐겨찾기 해제` : `${item.name} 즐겨찾기 추가`}
                    >
                      {watched ? '★' : '☆'}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          {/* ── 즐겨찾기 카드 그리드 ───────────────────────────── */}
          <section className="wl-section">
            <div className="wl-section-head">
              <span className="wl-section-title">즐겨찾기</span>
              <span className={isFull ? 'wl-section-limit' : 'wl-section-count'}>
                {watchlist.length} / {MAX_WATCHLIST}
                {isFull && ' (상한)'}
              </span>
            </div>

            {watchlist.length === 0 ? (
              <div className="wl-empty">
                <div className="wl-empty-icon">☆</div>
                <p className="wl-empty-msg">관심 종목을 추가해보세요</p>
                <p className="wl-empty-hint">
                  위 검색창으로 코인·미국주식을 찾거나<br />
                  기존 6종목의 별표를 눌러 추가하세요
                </p>
              </div>
            ) : (
              <div className={`wl-cards-grid${watchlist.length === 1 ? ' solo' : ''}`}>
                {watchlist.map(wlItem => {
                  const live = getLiveItem(wlItem);
                  return live ? (
                    <WatchlistCard key={wlItem.id} item={live} onRemove={remove} />
                  ) : (
                    <div key={wlItem.id} className="wl-card-skeleton">
                      <span>{wlItem.symbol}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

        </div>
      </div>
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </>
  );
}
