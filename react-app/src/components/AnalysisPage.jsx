import { useState, useEffect } from 'react';
import { useData } from '../DataContext';
import Header from './Header';
import BottomNav from './BottomNav';
import AnalysisChart from './AnalysisChart';

const STOCKS = [
  { id: 'nasdaq',  label: '나스닥' },
  { id: 'dow',     label: '다우'   },
  { id: 'kospi',   label: '코스피' },
  { id: 'btc',     label: 'BTC'    },
  { id: 'vix',     label: 'VIX'    },
  { id: 'usdkrw',  label: '원달러' },
];

const DETAIL_TIMEOUT = 20_000;
const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

export default function AnalysisPage({ activePage, onPageChange }) {
  const { items: homeItems } = useData();

  const [selectedId, setSelectedId] = useState(STOCKS[0].id);
  const [detailItem, setDetailItem] = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);

  const [showMA20, setShowMA20] = useState(true);
  const [showMA60, setShowMA60] = useState(true);
  const [showRSI,  setShowRSI]  = useState(true);

  // 종목 전환 시 90일 데이터 fetch
  useEffect(() => {
    let cancelled = false;
    setDetailItem(null);
    setLoading(true);
    setError(null);

    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), DETAIL_TIMEOUT);

    fetch(`/api/market-data?id=${selectedId}`, { signal: ctrl.signal })
      .finally(() => clearTimeout(tid))
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
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
  }, [selectedId]);

  // 90일 데이터가 오면 교체, 그 전엔 홈 30일 데이터로 렌더
  const baseItem = homeItems.find(it => it.id === selectedId);
  const item = detailItem ?? baseItem;
  const dir  = item?.direction ?? 'flat';

  return (
    <>
      <Header />
      <div className="page active">
        <div className="analysis-content">

          {/* 종목 선택 칩 */}
          <div className="analysis-selector">
            {STOCKS.map(({ id, label }) => (
              <button
                key={id}
                className={`analysis-chip${id === selectedId ? ' active' : ''}`}
                onClick={() => setSelectedId(id)}
              >
                {label}
              </button>
            ))}
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
              <span className="ind-dot ma20" />
              MA20
            </button>
            <button
              className={`ind-toggle${showMA60 ? ' on ma60' : ''}`}
              onClick={() => setShowMA60(v => !v)}
            >
              <span className="ind-dot ma60" />
              MA60
            </button>
            <button
              className={`ind-toggle${showRSI ? ' on rsi' : ''}`}
              onClick={() => setShowRSI(v => !v)}
            >
              <span className="ind-dot rsi" />
              RSI(14)
            </button>
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
                item={item}
                showMA20={showMA20}
                showMA60={showMA60}
                showRSI={showRSI}
              />
            )}
          </div>

        </div>
      </div>
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </>
  );
}
