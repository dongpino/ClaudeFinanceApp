import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useData } from '../DataContext';
import Chart from './Chart';
import BottomNav from './BottomNav';

const ARROW = { up: '▲', down: '▼', flat: '-' };
const DETAIL_TIMEOUT_MS = 20_000;

// -0(음의 0)은 toFixed()에서 "-0.00"으로 찍히는 JS 특유의 표시 버그를 낳으므로
// 표시 직전에 항상 +0으로 정규화한다("n === 0"은 -0에도 true라 이 한 줄로 충분).
const nz = n => (n === 0 ? 0 : n);

const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fc   = n => { const v = nz(n); return (v > 0 ? '+' : '') + fp(v); };
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

// unit==='percent'인 종목(미 10년물 금리 등): 값 자체가 %이므로 "4.25%"로,
// 등락은 국채금리 관례상 bp(basis point, 1bp=0.01%p)로 표시한다(MarketCard와 동일 규칙 —
// %p 소수 2자리로는 0.01%p 미만의 실제 변동이 "0.00%p"로 뭉개져 계산 실패처럼 보였다).
const fpUnit = (n, unit) => unit === 'percent' ? `${n.toFixed(2)}%` : fp(n);
const fcUnit = (n, unit) => {
  if (unit !== 'percent') return fc(n);
  const bp = nz(Math.round(n * 100 * 10) / 10); // %p → bp(소수 1자리)
  return `${bp > 0 ? '+' : ''}${bp.toFixed(1)}bp`;
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

export default function DetailPage({ onBack, activePage, onPageChange }) {
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
  const { direction: dir, name, category, price, change, change_pct, source, as_of, history_90d, unit } = item;
  const s = stats90(history_90d);

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
          <div className="detail-price">{fpUnit(price, unit)}</div>
          <div className={`detail-change ${dir}`}>
            <span className="detail-change-chip">
              {ARROW[dir]} {fcUnit(change, unit)}
            </span>
            {unit !== 'percent' && <span className="detail-change-pct">{fpct(change_pct)}</span>}
          </div>
        </div>

        {/* 차트 — 30일 먼저 렌더, 90일 로드되면 교체 */}
        <div className="detail-chart-wrap">
          <Chart item={item} />
        </div>

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
