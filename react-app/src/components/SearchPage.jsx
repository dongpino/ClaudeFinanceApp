import { useState, useEffect, useRef } from 'react';
import Header from './Header';
import BottomNav from './BottomNav';
import WatchlistCard from './WatchlistCard';
import { useData } from '../DataContext';
import useWatchlist from '../useWatchlist';

// 분석 탭과 동일한 6종목 식별자
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
  const [query,         setQuery]         = useState('');
  const [results,       setResults]       = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError,   setSearchError]   = useState(null);
  const debounceRef = useRef(null);

  function handleQuery(e) {
    const q = e.target.value;
    setQuery(q);
    setResults([]);
    setSearchError(null);
    clearTimeout(debounceRef.current);

    if (!q.trim()) { setSearchLoading(false); return; }

    setSearchLoading(true);
    debounceRef.current = setTimeout(() => {
      fetch(`/api/coin-search?q=${encodeURIComponent(q.trim())}`)
        .then(r => r.json())
        .then(data => { setResults(data.results ?? []); setSearchLoading(false); })
        .catch(err  => { setSearchError(err.message);   setSearchLoading(false); });
    }, DEBOUNCE_MS);
  }

  function clearQuery() {
    setQuery('');
    setResults([]);
    setSearchLoading(false);
    setSearchError(null);
    clearTimeout(debounceRef.current);
  }

  // ── 워치리스트 crypto 아이템 시세 ──────────────────────────────
  const [cryptoPrices,   setCryptoPrices]   = useState({});
  const [cryptoFetchedAt, setCryptoFetchedAt] = useState(null);

  // crypto ids를 정렬된 문자열로 만들어 effect 의존성에 활용
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

  // ── 라이브 데이터 병합 ──────────────────────────────────────
  // index: DataContext 데이터 활용
  // crypto: /api/coin-price 응답 + sparkline → history 변환
  function getLiveItem(wlItem) {
    if (wlItem.type === 'index') {
      const live = indexItems.find(it => it.id === wlItem.id);
      return live ? { ...live, type: 'index' } : null;
    }
    const cd = cryptoPrices[wlItem.id];
    if (!cd) return null;
    const asOf = cryptoFetchedAt
      ? new Date(cryptoFetchedAt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '-';
    return {
      ...cd,
      type:    'crypto',
      history: (cd.sparkline ?? []).map(v => ({ close: v })),
      as_of:   asOf,
    };
  }

  // ── 이벤트 핸들러 ────────────────────────────────────────────
  function handleAddCoin(coin) {
    add({ type: 'crypto', id: coin.id, symbol: coin.symbol, name: coin.name });
  }

  function toggleIndex(item) {
    if (isWatched(item.id)) remove(item.id);
    else add(item);
  }

  const isFull = watchlist.length >= MAX_WATCHLIST;

  return (
    <>
      <Header />
      <div className="page active">
        <div className="search-scroll">

          {/* ── 코인 검색 ─────────────────────────────────── */}
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
                placeholder="코인 검색... (Bitcoin, ETH, Solana...)"
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
                {searchLoading && (
                  <p className="wl-ac-state">검색 중…</p>
                )}
                {!searchLoading && searchError && (
                  <p className="wl-ac-state">오류: {searchError}</p>
                )}
                {!searchLoading && !searchError && results.length === 0 && (
                  <p className="wl-ac-state">"{query}" 검색 결과 없음</p>
                )}
                {results.map(coin => {
                  const watched = isWatched(coin.id);
                  return (
                    <div key={coin.id} className="wl-ac-item">
                      {coin.thumb
                        ? <img src={coin.thumb} alt={coin.symbol} className="wl-ac-thumb" />
                        : (
                          <div className="wl-ac-thumb-placeholder">
                            {coin.symbol.slice(0, 2)}
                          </div>
                        )
                      }
                      <div className="wl-ac-info">
                        <span className="wl-ac-name">{coin.name}</span>
                        <span className="wl-ac-symbol">{coin.symbol}</span>
                      </div>
                      {coin.market_cap_rank && (
                        <span className="wl-ac-rank">#{coin.market_cap_rank}</span>
                      )}
                      <button
                        className={`wl-ac-add-btn${watched ? ' added' : ''}`}
                        disabled={!watched && isFull}
                        onClick={() => !watched && !isFull && handleAddCoin(coin)}
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

          {/* ── 기존 6종목 ─────────────────────────────────── */}
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

          {/* ── 즐겨찾기 카드 ──────────────────────────────── */}
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
                  위 검색창으로 코인을 찾거나<br />
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
