import { useNavigate } from 'react-router-dom';
import Sparkline from './Sparkline';

const ARROW = { up: '▲', down: '▼', flat: '-' };
const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fc   = n => (n > 0 ? '+' : '') + fp(n);
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

export default function WatchlistCard({ item, onRemove }) {
  const navigate = useNavigate();
  const {
    id, type, direction: dir, name, category,
    price, change, change_pct, source, as_of, history,
  } = item;

  const isStock = type === 'stock';

  return (
    <article
      className={`card ${dir}`}
      style={{ cursor: type === 'index' ? 'pointer' : 'default' }}
      onClick={() => type === 'index' && navigate(`/detail/${id}`)}
    >
      <div className="card-top">
        <div className="card-name-row">
          <span className="card-name">{name}</span>
          <div className="card-top-right">
            <span className="card-cat">{category ?? (isStock ? '미국주식' : '')}</span>
            <button
              className="wl-card-remove"
              title="즐겨찾기 해제"
              onClick={e => { e.stopPropagation(); onRemove(id); }}
            >×</button>
          </div>
        </div>
        <div className="card-price">{fp(price)}</div>
        <div className={`card-change ${dir}`}>
          <span className="change-chip">{ARROW[dir]} {fc(change)}</span>
          <span className="change-pct">{fpct(change_pct)}</span>
        </div>
      </div>

      {/* 주식: sparkline 없으므로 큰 등락률 표시 / 나머지: Sparkline */}
      <div className="card-spark">
        {isStock ? (
          <div className={`stock-pct-display ${dir}`}>{fpct(change_pct)}</div>
        ) : (
          <Sparkline history={history || []} dir={dir} />
        )}
      </div>

      <div className="card-bottom">
        <div className="card-meta-row">
          <span className="meta-label">출처</span>
          <span className="source-tag">{source}</span>
        </div>
        <div className="card-meta-row">
          <span className="meta-label">기준</span>
          <span className="meta-time">{as_of ?? '-'}</span>
        </div>
      </div>
    </article>
  );
}
