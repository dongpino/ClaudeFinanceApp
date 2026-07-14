import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useData } from '../DataContext';
import Chart from './Chart';
import BottomNav from './BottomNav';
import { getAnalysisSelection } from '../analysisLink';

const ARROW = { up: '▲', down: '▼', flat: '-' };
const DETAIL_TIMEOUT_MS = 20_000;

// -0(음의 0)은 toFixed()에서 "-0.00"으로 찍히는 JS 특유의 표시 버그를 낳으므로
// 표시 직전에 항상 +0으로 정규화한다("n === 0"은 -0에도 true라 이 한 줄로 충분).
const nz = n => (n === 0 ? 0 : n);

const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fc   = n => { const v = nz(n); return (v > 0 ? '+' : '') + fp(v); };
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

// MarketCard.jsx와 동일 — item.currency는 opt-in 필드(워치리스트 종목만 설정).
const CURRENCY_PREFIX = { usd: '$', krw: '₩' };

// 가격이 아니라 지수/점수 성격인 unit 3종 — MarketCard.jsx와 동일 규칙(그쪽 주석 참고).
const NON_PRICE_UNITS = new Set(['percent', 'pct_pt', 'score']);

const fpUnit = (n, unit) => {
  if (unit === 'percent' || unit === 'pct_pt') return `${n.toFixed(2)}%`;
  if (unit === 'score') return n.toFixed(0);
  return fp(n);
};
const fcUnit = (n, unit) => {
  const v = nz(n);
  if (unit === 'percent') {
    const bp = nz(Math.round(v * 100 * 10) / 10); // %p → bp(소수 1자리)
    return `${bp > 0 ? '+' : ''}${bp.toFixed(1)}bp`;
  }
  if (unit === 'pct_pt') return `${v > 0 ? '+' : ''}${v.toFixed(2)}%p`;
  if (unit === 'score')  return `${v > 0 ? '+' : ''}${v.toFixed(0)}`;
  return fc(v);
};

// 공포탐욕지수 등급 — MarketCard.jsx GRADE_MAP과 동일 매핑(한국 관례: 탐욕=빨강, 공포=파랑).
const GRADE_MAP = {
  'Extreme Fear':  { ko: '극단적 공포', tone: 'fear' },
  'Fear':          { ko: '공포',        tone: 'fear' },
  'Neutral':       { ko: '중립',        tone: 'neutral' },
  'Greed':         { ko: '탐욕',        tone: 'greed' },
  'Extreme Greed': { ko: '극단적 탐욕', tone: 'greed' },
};

function stats90(h90) {
  if (!h90 || !h90.length) return null;
  const closes = h90.map(r => r.close).filter(v => v > 0);
  if (!closes.length) return null;
  const high  = Math.max(...(h90.map(r => r.high ?? r.close)));
  const low   = Math.min(...(h90.map(r => r.low  ?? r.close)));
  const avg   = closes.reduce((a, b) => a + b, 0) / closes.length;
  const last  = closes[closes.length - 1];
  const pos   = low === high ? 50 : Math.round(((last - low) / (high - low)) * 100);
  return { high, low, avg, last, pos };
}

export default function DetailPage({ onBack, activePage, onPageChange, onOpenAnalysis }) {
  const { items } = useData();
  const { id }    = useParams();

  // 홈 데이터(30일)에서 가져온 기본 아이템
  const baseItem = items.find(it => it.id === id);

  // 상세 데이터(90일 포함) — 별도 fetch
  const [detailItem,    setDetailItem]    = useState(null);
  const [detailLoading, setDetailLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setDetailItem(null);
    setDetailLoading(true);

    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), DETAIL_TIMEOUT_MS);

    fetch(`/api/market-data?id=${id}`, { signal: ctrl.signal })
      .finally(() => clearTimeout(tid))
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        setDetailItem(data.item);
        setDetailLoading(false);
      })
      .catch(err => {
        console.warn(`[DetailPage] 상세 데이터 실패(${id}): ${err.message}`);
        setDetailLoading(false);
      });

    return () => ctrl.abort();
  }, [id]);

  // 홈 데이터도, 상세 데이터도 아직 없으면 로딩 화면
  if (!baseItem && !detailItem) {
    return (
      <div className="detail-page">
        <div className="detail-scroll">
          <div className="detail-header">
            <button className="detail-back" onClick={onBack}>← 뒤로</button>
            <span className="detail-title">로딩 중…</span>
          </div>
        </div>
        <BottomNav activePage={activePage} onPageChange={onPageChange} />
      </div>
    );
  }

  // 상세 데이터가 오면 교체 (90일 포함), 없으면 홈 데이터(30일)로 렌더
  const item = detailItem ?? baseItem;
  const {
    direction: dir, name, category, price, change, change_pct, source, as_of, history_90d, unit, grade,
    change_unavailable, currency,
  } = item;
  const s = stats90(history_90d);
  const gradeInfo = grade ? GRADE_MAP[grade] : null;
  // 분석 탭이 이 종목을 지원할 때만 버튼을 보인다 — 지원 대상은 analysisLink.js에
  // 명시적으로 등록된 것만(index 6종/eth/우미 워치리스트 4종). 대상이 아니면 null이라
  // 버튼 자체가 렌더되지 않는다("눌리는데 실패하는 버튼 금지").
  const analysisSelection = getAnalysisSelection(item);

  return (
    <div className="detail-page">
      <div className="detail-scroll">

        {/* 헤더 */}
        <div className="detail-header">
          <button className="detail-back" onClick={onBack}>← 뒤로</button>
          <div className="detail-header-center">
            <span className="detail-title">{name}</span>
            <span className="detail-cat-badge">{category}</span>
          </div>
          <div style={{ width: 56 }} />
        </div>

        {/* 현재가 & 변동 */}
        <div className="detail-price-section">
          <div className="detail-price">
            {CURRENCY_PREFIX[currency] ?? ''}{fpUnit(price, unit)}
            {gradeInfo && <span className={`detail-grade ${gradeInfo.tone}`}> · {gradeInfo.ko}</span>}
          </div>
          <div className={`detail-change ${dir}`}>
            <span className="detail-change-chip">
              {change_unavailable ? '—' : <>{ARROW[dir]} {fcUnit(change, unit)}</>}
            </span>
            {!NON_PRICE_UNITS.has(unit) && !change_unavailable && <span className="detail-change-pct">{fpct(change_pct)}</span>}
          </div>
        </div>

        {/* 차트 — 30일 먼저 렌더, 90일 로드되면 교체 */}
        <div className="detail-chart-wrap">
          <Chart item={item} />
        </div>

        {analysisSelection && (
          <div className="detail-analysis-link-row">
            <button
              type="button"
              className="detail-analysis-link-btn"
              onClick={() => onOpenAnalysis(analysisSelection)}
            >
              분석 탭에서 열기 →
            </button>
          </div>
        )}

        {/* 90일 통계 — 로딩 중 표시 또는 데이터 표시 */}
        {detailLoading ? (
          <div className="detail-stats-loading">
            <div className="pulse-dot" />
            <span>90일 데이터 로딩 중…</span>
          </div>
        ) : s ? (
          <div className="detail-stats">
            <div className="detail-stats-title">90일 통계</div>
            <div className="stat-grid">
              <div className="stat-item">
                <span className="stat-label">최고가</span>
                <span className="stat-value up">{fpUnit(s.high, unit)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">최저가</span>
                <span className="stat-value down">{fpUnit(s.low, unit)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">평균가</span>
                <span className="stat-value">{fpUnit(s.avg, unit)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">현재위치</span>
                <span className="stat-value">{s.pos}%</span>
              </div>
            </div>

            {/* 범위 바 */}
            <div className="range-wrap">
              <span className="range-edge">{fpUnit(s.low, unit)}</span>
              <div className="range-track">
                <div className="range-fill" style={{ width: `${s.pos}%` }} />
                <div className="range-thumb" style={{ left: `${s.pos}%` }} />
              </div>
              <span className="range-edge">{fpUnit(s.high, unit)}</span>
            </div>
            <div className="range-label">
              90일 최저 &nbsp;·&nbsp; 현재 {s.pos}% 위치 &nbsp;·&nbsp; 90일 최고
            </div>
          </div>
        ) : null}

        {/* 출처 */}
        <div className="detail-footer">
          <span className="detail-footer-source">출처: {source}</span>
          <span className="detail-footer-time">{as_of}</span>
        </div>

      </div>
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </div>
  );
}
