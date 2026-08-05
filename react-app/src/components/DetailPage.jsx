import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useData } from '../DataContext';
import Chart from './Chart';
import BottomNav from './BottomNav';
import { getAnalysisSelection } from '../analysisLink';
import { getAvgPrice } from '../avgPriceStore';
import { parityPercent, parityDirection } from '../parity';

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
    change_unavailable, currency, stale,
  } = item;
  const s = stats90(history_90d);
  const gradeInfo = grade ? GRADE_MAP[grade] : null;
  // 분석 탭이 이 종목을 지원할 때만 버튼을 보인다 — 지원 대상은 analysisLink.js에
  // 명시적으로 등록된 것만(index 6종/eth/우미 워치리스트 4종). 대상이 아니면 null이라
  // 버튼 자체가 렌더되지 않는다("눌리는데 실패하는 버튼 금지").
  const analysisSelection = getAnalysisSelection(item);

  // ── 주가 패리티 — 현재가가 평단가의 몇 %인가 ────────────────────────
  // ⚠️ Preview 배포(VITE_HIDE_WATCHLIST=1)에서는 삼항이 null로 접혀 getAvgPrice 호출이
  //    dead가 된다. MarketCard.jsx·Chart.jsx와 **같은 패턴을 그대로** 쓴다 — 한 곳이라도
  //    빠지면 avgPriceStore가 번들에 남아 워치리스트 심볼이 노출된다(그 모듈 주석 참조).
  // ⚠️ 평단가 미입력이면 parity가 null이고 아래 JSX가 통째로 건너뛴다. 0%로 적지 않는다 —
  //    0%는 "전액 손실"과 구분되지 않는다.
  // 갱신 경로: 편집 저장 → saveAvgPrices → 캐시 반영 → subscribeAvgPrices 통지 →
  //   DataContext가 tick을 올려 리렌더 → useData 소비자인 이 화면이 다시 계산한다.
  //   (getAvgPrice는 순수 동기 함수라 구독을 여기서 따로 걸지 않는다.)
  const avgPrice = import.meta.env.VITE_HIDE_WATCHLIST === '1' ? null : getAvgPrice(item.id);
  const parity = parityPercent(price, avgPrice);
  const parityDir = parityDirection(parity);

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

        {/* 주가 패리티 — 평단가가 있는 종목(우미 워치리스트)에서만 렌더된다.
            자리를 현재가 섹션이 아니라 **90일 통계 바로 위**로 잡은 이유: 현재가 옆에 두면
            등락률(오늘의 변동)과 같은 시야에 들어와 "180%"가 오늘 등락으로 읽힐 여지가 있다.
            여기는 이미 '기간 요약' 성격의 구역이라 문맥이 맞고, 라벨과 카드 경계가 함께 붙어
            다른 축의 수라는 것이 형태로 드러난다. */}
        {/* ⚠️ 환경 상수를 **조건 맨 앞**에 둔다(HomePage.jsx:728과 같은 형태). 이래야 Preview
            배포에서 이 표현식 전체가 false로 접혀 라벨 문자열·클래스명까지 번들에서 사라진다.
            avgPrice 삼항만으로는 parity가 런타임 null이 될 뿐 JSX는 번들에 남는다(실측). */}
        {import.meta.env.VITE_HIDE_WATCHLIST !== '1' && parity != null && (
          <div className="detail-parity">
            <span className="detail-parity-label">평단가 대비</span>
            <span className={`detail-parity-value ${parityDir}`}>{parity}%</span>
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
          {/* 카드와 동일 규칙 — stale일 때만 '지연' 칩, 비-stale은 기존 DOM 그대로. */}
          {stale ? (
            <span className="detail-footer-right">
              <span className="stale-chip" title="소스 일시 장애 — 마지막 성공 데이터 표시 중">지연</span>
              <span className="detail-footer-time">{as_of}</span>
            </span>
          ) : (
            <span className="detail-footer-time">{as_of}</span>
          )}
        </div>

      </div>
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </div>
  );
}
