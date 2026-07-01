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
const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

export default function AnalysisPage({ activePage, onPageChange }) {
  const { items: homeItems } = useData();

  const [selectedId, setSelectedId] = useState(STOCKS[0].id);
  const [selectedTF, setSelectedTF] = useState('1d');
  const [detailItem, setDetailItem] = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState(null);

  const [showMA20,  setShowMA20]  = useState(true);
  const [showMA60,  setShowMA60]  = useState(true);
  const [showMA100, setShowMA100] = useState(true);
  const [showMA200, setShowMA200] = useState(true);
  const [showRSI,   setShowRSI]   = useState(true);

  // 종목 전환: tf를 항상 일봉으로 리셋.
  // 지원 tf 목록은 서버 응답(item.supported_tfs, getSupportedTimeframes 단일 소스)에서만 알 수 있어
  // 전환 시점엔 아직 새 종목의 목록을 모르므로 보수적으로 1d(모든 종목 공통 지원)로 초기화한다.
  function handleStockSelect(newId) {
    setSelectedTF('1d');
    setSelectedId(newId);
  }

  // 종목·타임프레임 전환 시 데이터 fetch
  useEffect(() => {
    let cancelled = false;
    setDetailItem(null);
    setLoading(true);
    setError(null);

    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), DETAIL_TIMEOUT);

    fetch(`/api/analysis?id=${selectedId}&tf=${selectedTF}`, { signal: ctrl.signal })
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
  }, [selectedId, selectedTF]);

  // analysis API 데이터가 오면 교체, 그 전엔 홈 데이터로 렌더
  // 단, 분봉/주봉 TF에는 홈 데이터(일봉 30일) fallback 사용 안 함
  const baseItem = selectedTF === '1d' ? homeItems.find(it => it.id === selectedId) : null;
  const item = detailItem ?? baseItem;
  const dir  = item?.direction ?? 'flat';

  // 확보 봉 수에 따라 MA 토글 비활성화 (일봉이면 일수, 분봉이면 봉 수 기준)
  const candleCount = item?.days_available
    ?? item?.history_long?.length
    ?? item?.history_90d?.length
    ?? item?.history?.length
    ?? 0;
  const ma100Disabled = candleCount > 0 && candleCount < 100;
  const ma200Disabled = candleCount > 0 && candleCount < 200;

  // 지원 tf 목록은 서버 응답이 단일 소스(getSupportedTimeframes) — 응답 도착 전엔
  // 전 종목 공통 지원(1d/1w)만 활성화해 미지원 tf 요청이 나가지 않게 한다.
  const supportedTFs = detailItem?.supported_tfs ?? ['1d', '1w'];

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
                onClick={() => handleStockSelect(id)}
              >
                {label}
              </button>
            ))}
          </div>

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
                  title={!supported ? 'BTC 전용 타임프레임' : undefined}
                  aria-disabled={!supported}
                >
                  {label}
                </button>
              );
            })}
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
              className={`ind-toggle${showRSI ? ' on rsi' : ''}`}
              onClick={() => setShowRSI(v => !v)}
            >
              <span className="ind-dot rsi" />RSI(14)
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
                tf={selectedTF}
                showMA20={showMA20}
                showMA60={showMA60}
                showMA100={showMA100}
                showMA200={showMA200}
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
