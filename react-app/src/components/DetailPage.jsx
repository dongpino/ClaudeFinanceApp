import { useData } from '../DataContext';
import Chart from './Chart';
import BottomNav from './BottomNav';

const ARROW = { up: '▲', down: '▼', flat: '-' };

const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fc   = n => (n > 0 ? '+' : '') + fp(n);
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

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

  // derive id from URL
  const id = window.location.pathname.split('/').pop();
  const item = items.find(it => it.id === id);

  if (!item) {
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

  const { direction: dir, name, category, price, change, change_pct, source, as_of, history_90d } = item;
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
          <div className="detail-price">{fp(price)}</div>
          <div className={`detail-change ${dir}`}>
            <span className="detail-change-chip">
              {ARROW[dir]} {fc(change)}
            </span>
            <span className="detail-change-pct">{fpct(change_pct)}</span>
          </div>
        </div>

        {/* 차트 */}
        <div className="detail-chart-wrap">
          <Chart item={item} />
        </div>

        {/* 통계 패널 */}
        {s && (
          <div className="detail-stats">
            <div className="detail-stats-title">90일 통계</div>
            <div className="stat-grid">
              <div className="stat-item">
                <span className="stat-label">최고가</span>
                <span className="stat-value up">{fp(s.high)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">최저가</span>
                <span className="stat-value down">{fp(s.low)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">평균가</span>
                <span className="stat-value">{fp(s.avg)}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">현재위치</span>
                <span className="stat-value">{s.pos}%</span>
              </div>
            </div>

            {/* 범위 바 */}
            <div className="range-wrap">
              <span className="range-edge">{fp(s.low)}</span>
              <div className="range-track">
                <div className="range-fill" style={{ width: `${s.pos}%` }} />
                <div className="range-thumb" style={{ left: `${s.pos}%` }} />
              </div>
              <span className="range-edge">{fp(s.high)}</span>
            </div>
            <div className="range-label">
              90일 최저 &nbsp;·&nbsp; 현재 {s.pos}% 위치 &nbsp;·&nbsp; 90일 최고
            </div>
          </div>
        )}

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
