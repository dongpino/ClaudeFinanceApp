import { useState, useEffect, useRef } from 'react';
import { useData } from '../DataContext';
import useWatchlist from '../useWatchlist';
import { loadTopPanelCollapsed, saveTopPanelCollapsed } from '../analysisTopPanelStore';
import Header from './Header';
import BottomNav from './BottomNav';
import AnalysisChart from './AnalysisChart';

// 6종 지수 — 예전엔 상단 전용 칩 줄로 노출했지만 그 줄을 없애면서, 검색으로도
// 여전히 찾을 수 있도록 이 배열을 검색 카탈로그로 재사용한다(Finnhub/CoinGecko/Naver
// 검색은 개별 종목·코인만 다루고 지수 자체는 안 걸려서, 이 6종은 로컬 매칭이 유일한 경로).
const INDEX_ITEMS = [
  { type: 'index', id: 'nasdaq',  symbol: 'NASDAQ', name: '나스닥'  },
  { type: 'index', id: 'dow',     symbol: 'DOW',    name: '다우존스' },
  { type: 'index', id: 'kospi',   symbol: 'KOSPI',  name: '코스피'  },
  { type: 'index', id: 'btc',     symbol: 'BTC',    name: '비트코인' },
  { type: 'index', id: 'vix',     symbol: 'VIX',    name: 'VIX'    },
  { type: 'index', id: 'usdkrw',  symbol: 'KRW',    name: '원/달러' },
];

function matchesIndexQuery(item, q) {
  const norm = s => s.toLowerCase().replace(/[\s/]/g, '');
  const query = norm(q);
  return norm(item.name).includes(query) || norm(item.symbol).includes(query);
}

const TF_OPTIONS = [
  { value: '1m',  label: '1분'   },
  { value: '5m',  label: '5분'   },
  { value: '15m', label: '15분'  },
  { value: '30m', label: '30분'  },
  { value: '1h',  label: '1시간' },
  { value: '4h',  label: '4시간' },
  { value: '1d',  label: '일봉'  },
  { value: '1w',  label: '주봉'  },
];

const DETAIL_TIMEOUT = 20_000;
const DEBOUNCE_MS    = 350;

const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

// 서버 응답(item.supported_tfs) 도착 전 낙관적 기본값.
// crypto는 Binance 상장 여부를 알기 전이라 상장/미상장 공통 지원인 1h/4h/1d/1w로,
// index·stock은 항상 1d/1w만 지원(getSupportedTimeframes 단일 소스와 일치).
function optimisticTFs(type) {
  return type === 'crypto' ? ['1h', '4h', '1d', '1w'] : ['1d', '1w'];
}

function analysisUrl(item, tf) {
  if (item.type === 'crypto')
    return `/api/analysis?type=crypto&id=${encodeURIComponent(item.id)}&symbol=${encodeURIComponent(item.symbol)}&tf=${tf}`;
  if (item.type === 'stock') {
    const market = item.market ?? 'US';
    // name이 없는 구버전 워치리스트 항목: 파라미터 자체를 생략(encodeURIComponent(undefined)로
    // 문자열 "undefined"가 전송돼 서버 응답 이름이 깨지는 것을 방지) — 서버가 symbol로 폴백.
    const nameParam = item.name ? `&name=${encodeURIComponent(item.name)}` : '';
    return `/api/analysis?type=stock&symbol=${encodeURIComponent(item.symbol)}&market=${market}${nameParam}&tf=${tf}`;
  }
  return `/api/analysis?id=${item.id}&tf=${tf}`;   // index (기존 6종목, 하위 호환)
}

export default function AnalysisPage({ activePage, onPageChange }) {
  const { items: homeItems } = useData();
  const { watchlist, add, remove, isWatched, patchItem, MAX_WATCHLIST } = useWatchlist();

  // ── 분석 대상 선택 ───────────────────────────────────────────
  // 선택 없음이 기본 상태 — 페이지 진입만으로 분석 API를 호출하지 않는다.
  const [selected,   setSelected]   = useState(null);
  const [selectedTF, setSelectedTF] = useState('1d');
  const [detailItem, setDetailItem] = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);

  const [showMA20,   setShowMA20]   = useState(true);
  const [showMA60,   setShowMA60]   = useState(true);
  const [showMA100,  setShowMA100]  = useState(true);
  const [showMA200,  setShowMA200]  = useState(true);
  const [showBB,     setShowBB]     = useState(false); // 기본 OFF — 기본 화면이 복잡해지지 않게
  const [showRSI,    setShowRSI]    = useState(true);
  const [showVolume, setShowVolume] = useState(true);

  // 수동 지지/저항선 — 실제 상태는 AnalysisChart 내부(localStorage)에 있고,
  // 여기서는 "선 지우기" 버튼 노출 여부 판단용 개수만 미러링한다.
  const [srLineCount, setSrLineCount] = useState(0);
  const chartRef = useRef(null);

  // 모바일 전용 상단 패널(검색+칩 줄) 접기 — 데스크톱은 CSS 미디어쿼리로 항상 펼침 유지.
  const [topCollapsed, setTopCollapsedState] = useState(loadTopPanelCollapsed);
  function setTopCollapsed(v) {
    setTopCollapsedState(v);
    saveTopPanelCollapsed(v);
  }

  // 즐겨찾기 칩 클릭 → 하단 차트에 즉시 반영(검색 결과 클릭은 selectAndClose가 처리).
  // 이미 선택된 항목을 다시 클릭하면 선택 해제.
  // 지원 tf 목록은 응답 도착 전까진 알 수 없으므로 보수적으로 1d로 리셋.
  // market은 type==='stock'일 때만 의미 있음(US/KR) — 그 외 타입은 undefined로 취급.
  function handleSelect(item) {
    const isDeselect = isSelected(item.type, item.id, item.market);
    setSelectedTF('1d');
    setSelected(isDeselect ? null : { type: item.type, id: item.id, symbol: item.symbol, name: item.name, market: item.market });
  }

  function isSelected(type, id, market) {
    return selected != null && selected.type === type && selected.id === id
      && (selected.market ?? null) === (market ?? null);
  }

  // 검색 결과 클릭/즐겨찾기 추가 → 항상 선택(토글 아님) + 검색창 닫기(입력값·결과 비우고 포커스 해제).
  // 이미 선택된 항목이면 재조회를 건너뛰되 검색창은 그대로 닫는다.
  function selectAndClose(item) {
    if (!isSelected(item.type, item.id, item.market)) {
      setSelectedTF('1d');
      setSelected({ type: item.type, id: item.id, symbol: item.symbol, name: item.name, market: item.market });
    }
    clearQuery();
    searchInputRef.current?.blur();
  }

  // 종목 전환 시 "선 지우기" 버튼 상태 리셋 — 새 종목의 실제 개수는
  // AnalysisChart 복원 완료 후 onLinesChange로 다시 채워진다.
  useEffect(() => { setSrLineCount(0); }, [selected]);

  // 종목·타임프레임 전환 시 데이터 fetch — 선택된 종목이 없으면 호출하지 않는다.
  useEffect(() => {
    if (!selected) {
      setDetailItem(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setDetailItem(null);
    setLoading(true);
    setError(null);

    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), DETAIL_TIMEOUT);

    fetch(analysisUrl(selected, selectedTF), { signal: ctrl.signal })
      .finally(() => clearTimeout(tid))
      .then(async r => {
        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try { const j = await r.json(); msg = j.details || j.error || msg; } catch (_) {}
          throw new Error(msg);
        }
        return r.json();
      })
      .then(data => {
        if (cancelled) return;
        setDetailItem(data.item);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        if (err.name !== 'AbortError') { setError(err.message); setLoading(false); }
      });

    return () => { cancelled = true; ctrl.abort(); };
  }, [selected, selectedTF]);

  // analysis API 데이터가 오면 교체, 그 전엔 홈 데이터로 렌더 (index 일봉만 fallback 대상)
  const baseItem = (selected?.type === 'index' && selectedTF === '1d')
    ? homeItems.find(it => it.id === selected.id)
    : null;
  const item = detailItem ?? baseItem;
  const dir  = item?.direction ?? 'flat';

  // 수동 지지/저항선 localStorage 키 — 가격 기준 저장이라 tf는 포함하지 않는다.
  const symbolKey = selected
    ? `${selected.type}:${selected.market ?? ''}:${selected.symbol ?? selected.id}`
    : null;

  // 확보 봉 수에 따라 MA 토글 비활성화
  const candleCount = item?.days_available
    ?? item?.history_long?.length
    ?? item?.history_90d?.length
    ?? item?.history?.length
    ?? 0;
  const ma100Disabled = candleCount > 0 && candleCount < 100;
  const ma200Disabled = candleCount > 0 && candleCount < 200;
  // 어댑터가 volume을 안 주는 종목(지수 등)은 토글 비활성화
  const volumeDisabled = !item?.volume_available;

  const supportedTFs = detailItem?.supported_tfs ?? (selected ? optimisticTFs(selected.type) : []);

  // ── 검색 ─────────────────────────────────────────────────────
  const [query,         setQuery]        = useState('');
  const [coinResults,   setCoinResults]  = useState([]);
  const [stockResults,  setStockResults] = useState([]);   // 미국주식 (Finnhub)
  const [krResults,     setKrResults]    = useState([]);   // 한국주식 (Naver)
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError,   setSearchError]  = useState(null);
  const debounceRef    = useRef(null);
  const searchIdRef    = useRef(0);     // stale-fetch 방지
  const searchInputRef = useRef(null);  // 선택 직후 검색창 포커스 해제용

  function handleQuery(e) {
    const q = e.target.value;
    setQuery(q);
    setCoinResults([]);
    setStockResults([]);
    setKrResults([]);
    setSearchError(null);
    clearTimeout(debounceRef.current);

    if (!q.trim()) { setSearchLoading(false); return; }

    setSearchLoading(true);
    debounceRef.current = setTimeout(async () => {
      const id = ++searchIdRef.current;
      try {
        const [coinRes, stockRes, krRes] = await Promise.allSettled([
          fetch(`/api/coin-search?q=${encodeURIComponent(q.trim())}`).then(r => r.json()),
          fetch(`/api/stock-search?q=${encodeURIComponent(q.trim())}`).then(r => r.json()),
          fetch(`/api/stock-search?q=${encodeURIComponent(q.trim())}&market=kr`).then(r => r.json()),
        ]);
        if (id !== searchIdRef.current) return;
        setCoinResults(coinRes.status  === 'fulfilled' ? (coinRes.value.results  ?? []) : []);
        setStockResults(stockRes.status === 'fulfilled' ? (stockRes.value.results ?? []) : []);
        setKrResults(krRes.status       === 'fulfilled' ? (krRes.value.results   ?? []) : []);
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
    setKrResults([]);
    setSearchLoading(false);
    setSearchError(null);
    clearTimeout(debounceRef.current);
  }

  // ── 코인 시세 (즐겨찾기 카드용) ─────────────────────────────
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
      .catch(err => console.error('[AnalysisPage] coin-price:', err.message));
    return () => { cancelled = true; };
  }, [cryptoKey]);

  // ── 미국 주식 시세 (즐겨찾기 카드용) ────────────────────────
  const [stockPrices,    setStockPrices]    = useState({});
  const [stockFetchedAt, setStockFetchedAt] = useState(null);

  const stockKey = watchlist
    .filter(it => it.type === 'stock' && (it.market ?? 'US') === 'US')
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
      .catch(err => console.error('[AnalysisPage] stock-quote:', err.message));
    return () => { cancelled = true; };
  }, [stockKey]);

  // ── 한국 주식 시세 (즐겨찾기 카드용) ────────────────────────
  const [krStockPrices,    setKrStockPrices]    = useState({});
  const [krStockFetchedAt, setKrStockFetchedAt] = useState(null);

  const krStockKey = watchlist
    .filter(it => it.type === 'stock' && it.market === 'KR')
    .map(it => it.id)
    .sort()
    .join(',');

  useEffect(() => {
    if (!krStockKey) { setKrStockPrices({}); return; }
    let cancelled = false;
    fetch(`/api/stock-quote?symbols=${krStockKey}&market=kr`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        const map = {};
        for (const it of data.items ?? []) map[it.id] = it;
        setKrStockPrices(map);
        setKrStockFetchedAt(data.fetched_at ?? null);
      })
      .catch(err => console.error('[AnalysisPage] stock-quote(kr):', err.message));
    return () => { cancelled = true; };
  }, [krStockKey]);

  // ── 구버전 워치리스트 항목 name 백필 ────────────────────────
  // market 필드 도입 이전에 담긴 항목은 name도 없어 코드만 표시됨.
  // 시세 조회가 처음 성공하면 응답의 종목명으로 채워 localStorage에 반영한다.
  // (US/Finnhub 경로는 name을 의도적으로 symbol과 동일하게 반환하므로 실질적으로 KR에만 적용됨.)
  useEffect(() => {
    for (const wlItem of watchlist) {
      if (wlItem.type !== 'stock' || wlItem.name) continue;
      const sd = (wlItem.market === 'KR' ? krStockPrices : stockPrices)[wlItem.id];
      if (sd?.name && sd.name !== wlItem.symbol) {
        patchItem(wlItem.id, { name: sd.name });
      }
    }
  }, [watchlist, krStockPrices, stockPrices, patchItem]);

  // ── 라이브 데이터 병합 (즐겨찾기 카드용) ───────────────────
  function getLiveItem(wlItem) {
    if (wlItem.type === 'index') {
      const live = homeItems.find(it => it.id === wlItem.id);
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
      const isKR = wlItem.market === 'KR';
      const sd = (isKR ? krStockPrices : stockPrices)[wlItem.id];
      if (!sd) return null;
      const fetchedAt = isKR ? krStockFetchedAt : stockFetchedAt;
      const asOf = fetchedAt
        ? new Date(fetchedAt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '-';
      return { ...sd, name: wlItem.name, type: 'stock', history: [], as_of: asOf };
    }
    return null;
  }

  // ── 이벤트 핸들러 ────────────────────────────────────────────
  function handleAddCoin(coin) {
    add({ type: 'crypto', id: coin.id, symbol: coin.symbol, name: coin.name });
  }

  function handleAddStock(stock, market = 'US') {
    add({ type: 'stock', market, id: stock.symbol, symbol: stock.symbol, name: stock.name });
  }

  const isFull = watchlist.length >= MAX_WATCHLIST;

  // 지수 6종(로컬 매칭) + 코인 최대 5 + 미국주식 최대 5 + 한국주식 최대 5 병합 (지수 우선 —
  // 검색·API 응답 없이 즉시 뜨는 데다, 예전 칩 줄을 대체하는 접근 경로라 눈에 잘 띄어야 함)
  const matchedIndexItems = query.trim()
    ? INDEX_ITEMS.filter(it => matchesIndexQuery(it, query.trim()))
    : [];

  const mergedResults = [
    ...matchedIndexItems.map(it => ({ ...it, _kind: 'index' })),
    ...coinResults.slice(0, 5).map(c => ({ ...c, _kind: 'coin' })),
    ...stockResults.slice(0, 5).map(s => ({ ...s, id: s.symbol, _kind: 'us-stock' })),
    ...krResults.slice(0, 5).map(s => ({ ...s, id: s.symbol, _kind: 'kr-stock' })),
  ];

  return (
    <>
      <Header />
      <div className="page active">
        <div className="analysis-content">

          {/* ── 모바일 전용 압축 바 — 상단 패널이 접혔을 때만 노출(데스크톱은 CSS로 항상 숨김) ── */}
          <div className={`as-compact-bar${topCollapsed ? ' is-collapsed' : ''}`}>
            <span className="as-compact-name">{selected?.name ?? '종목 미선택'}</span>
            <button
              type="button"
              className="as-top-toggle"
              onClick={() => setTopCollapsed(false)}
              aria-label="검색·즐겨찾기 패널 펼치기"
            >
              펼치기 ▾
            </button>
          </div>

          {/* ── 검색 + 즐겨찾기 (상단 스크롤 패널) ────────────── */}
          <div className={`as-top-panel${topCollapsed ? ' is-collapsed' : ''}`}>

            <button
              type="button"
              className="as-top-toggle as-top-toggle-collapse"
              onClick={() => setTopCollapsed(true)}
              aria-label="검색·즐겨찾기 패널 접기"
            >
              접기 ▴
            </button>

            <section className="wl-search-wrap">
              <div className="wl-search-bar">
                <svg className="wl-search-icon" width="15" height="15" fill="none" stroke="currentColor"
                     strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="8"/>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                  ref={searchInputRef}
                  className="wl-search-input"
                  type="text"
                  placeholder="코인·미국주식·한국주식 검색... (BTC, Apple, 삼성전자...)"
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
                    const watched  = isWatched(item.id);
                    const isCoin   = item._kind === 'coin';
                    const isKR     = item._kind === 'kr-stock';
                    const isIndex  = item._kind === 'index';
                    const kind     = isIndex ? 'index' : isCoin ? 'crypto' : 'stock';
                    const market   = (isIndex || isCoin) ? undefined : (isKR ? 'KR' : 'US');
                    const badgeCls = isIndex ? 'wl-ac-badge-index' : isCoin ? 'wl-ac-badge-coin' : isKR ? 'wl-ac-badge-kr' : 'wl-ac-badge-stock';
                    const badgeTxt = isIndex ? '지수' : isCoin ? '코인' : isKR ? '한국' : '미국';
                    return (
                      <div
                        key={`${item._kind}-${item.id}`}
                        className={`wl-ac-item${isSelected(kind, item.id, market) ? ' selected' : ''}`}
                        onClick={() => selectAndClose({ type: kind, id: item.id, symbol: item.symbol, name: item.name, market })}
                      >
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
                        <span className={`wl-ac-badge ${badgeCls}`}>{badgeTxt}</span>
                        <button
                          className={`wl-ac-add-btn${watched ? ' added' : ''}`}
                          disabled={!watched && isFull}
                          onClick={e => {
                            e.stopPropagation();   // 행 클릭(선택)과 중복 트리거 방지
                            if (!watched) {
                              if (isIndex) add(item);
                              else isCoin ? handleAddCoin(item) : handleAddStock(item, market);
                            }
                            selectAndClose({ type: kind, id: item.id, symbol: item.symbol, name: item.name, market });
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

            {/* 즐겨찾기 — 항상 표시되는 한 줄 가로 스크롤 미니 칩 (큰 카드 그리드는 이 화면에선 안 씀) */}
            <div className="as-chip-row">
              <span className="as-chip-row-label">즐겨찾기</span>
              <div className="as-chip-scroll">
                {watchlist.length === 0 ? (
                  <span className="as-chip-empty-hint">검색하거나 ☆를 눌러 관심 종목 추가</span>
                ) : (
                  watchlist.map(wlItem => {
                    const live = getLiveItem(wlItem);
                    const dir  = live?.direction ?? 'flat';
                    return (
                      <div
                        key={wlItem.id}
                        className={`as-fav-chip${isSelected(wlItem.type, wlItem.id, wlItem.market) ? ' selected' : ''}${!live ? ' skeleton' : ''}`}
                        onClick={() => handleSelect(wlItem)}
                      >
                        <span className="as-fav-name">{wlItem.name || wlItem.symbol}</span>
                        {live && <span className={`as-fav-pct ${dir}`}>{fpct(live.change_pct)}</span>}
                        <button
                          className="as-fav-remove"
                          onClick={e => { e.stopPropagation(); remove(wlItem.id); }}
                          aria-label={`${wlItem.name || wlItem.symbol} 즐겨찾기 해제`}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

          </div>

          {selected ? (
            <>
              {/* 타임프레임 선택기 */}
              <div className="tf-selector">
                {TF_OPTIONS.map(({ value, label }) => {
                  const supported = supportedTFs.includes(value);
                  const active    = value === selectedTF;
                  return (
                    <button
                      key={value}
                      className={`tf-chip${active ? ' active' : ''}${!supported ? ' tf-chip-disabled' : ''}`}
                      onClick={() => supported && setSelectedTF(value)}
                      title={!supported ? '이 종목은 지원하지 않는 타임프레임' : undefined}
                      aria-disabled={!supported}
                    >
                      {label}
                    </button>
                  );
                })}
                <button
                  className="tf-chip tf-chip-clear"
                  onClick={() => setSelected(null)}
                  title="선택 해제"
                  aria-label="종목 선택 해제"
                >
                  ✕
                </button>
              </div>

              {/* 현재가 요약 바 */}
              {item && (
                <div className={`analysis-price-bar ${dir}`}>
                  <span className="apb-name">{item.name}</span>
                  <span className="apb-price">{fp(item.price)}</span>
                  <span className={`apb-pct ${dir}`}>{fpct(item.change_pct)}</span>
                  {loading && <span className="apb-loading-dot" />}
                </div>
              )}

              {/* 지표 토글 */}
              <div className="analysis-toggles">
                <button
                  className={`ind-toggle${showMA20 ? ' on ma20' : ''}`}
                  onClick={() => setShowMA20(v => !v)}
                >
                  <span className="ind-dot ma20" />MA20
                </button>
                <button
                  className={`ind-toggle${showMA60 ? ' on ma60' : ''}`}
                  onClick={() => setShowMA60(v => !v)}
                >
                  <span className="ind-dot ma60" />MA60
                </button>
                <button
                  className={`ind-toggle${showMA100 ? ' on ma100' : ''}${ma100Disabled ? ' disabled' : ''}`}
                  onClick={() => !ma100Disabled && setShowMA100(v => !v)}
                  title={ma100Disabled ? `데이터 부족 (${candleCount}봉)` : undefined}
                >
                  <span className="ind-dot ma100" />MA100
                </button>
                <button
                  className={`ind-toggle${showMA200 ? ' on ma200' : ''}${ma200Disabled ? ' disabled' : ''}`}
                  onClick={() => !ma200Disabled && setShowMA200(v => !v)}
                  title={ma200Disabled ? `데이터 부족 (${candleCount}봉)` : undefined}
                >
                  <span className="ind-dot ma200" />MA200
                </button>
                <button
                  className={`ind-toggle${showBB ? ' on bb' : ''}`}
                  onClick={() => setShowBB(v => !v)}
                >
                  <span className="ind-dot bb" />BB(20,2)
                </button>
                <button
                  className={`ind-toggle${showRSI ? ' on rsi' : ''}`}
                  onClick={() => setShowRSI(v => !v)}
                >
                  <span className="ind-dot rsi" />RSI(14)
                </button>
                <button
                  className={`ind-toggle${showVolume ? ' on vol' : ''}${volumeDisabled ? ' disabled' : ''}`}
                  onClick={() => !volumeDisabled && setShowVolume(v => !v)}
                  title={volumeDisabled ? '이 종목은 거래량 데이터를 제공하지 않습니다' : undefined}
                >
                  <span className="ind-dot vol" />거래량
                </button>
                {srLineCount > 0 && (
                  <button
                    className="ind-toggle ind-toggle-clear-lines"
                    onClick={() => chartRef.current?.clearAllLines()}
                    title="그려진 지지/저항선을 모두 삭제합니다"
                  >
                    선 지우기
                  </button>
                )}
              </div>

              {/* 차트 영역 */}
              <div className="analysis-main">
                {error && (
                  <div className="analysis-state error">
                    <p>데이터 로드 실패</p>
                    <small>{error}</small>
                  </div>
                )}
                {!item && !error && (
                  <div className="analysis-state">
                    <div className="pulse-dot" />
                    <p>데이터 불러오는 중…</p>
                  </div>
                )}
                {item && (
                  <AnalysisChart
                    ref={chartRef}
                    item={item}
                    tf={selectedTF}
                    showMA20={showMA20}
                    showMA60={showMA60}
                    showMA100={showMA100}
                    showMA200={showMA200}
                    showBB={showBB}
                    showRSI={showRSI}
                    showVolume={showVolume && !volumeDisabled}
                    symbolKey={symbolKey}
                    onLinesChange={setSrLineCount}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="analysis-main">
              <div className="analysis-state empty">
                <div className="as-empty-icon">📊</div>
                <p>종목을 선택하면 분석 차트가 표시됩니다</p>
                <small>위 검색 또는 즐겨찾기에서 클릭해서 선택하세요</small>
              </div>
            </div>
          )}

        </div>
      </div>
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </>
  );
}
