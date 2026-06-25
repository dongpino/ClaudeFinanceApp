import { useNavigate } from 'react-router-dom';
import Sparkline from './Sparkline';

const ARROW = { up: '▲', down: '▼', flat: '-' };

const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fc   = n => (n > 0 ? '+' : '') + fp(n);
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

export function detectIssues(item) {
  const issues = [];
  if (!item.price || item.price === 0)
    issues.push('가격 데이터 없음');
  if (!item.history || item.history.length < 5)
    issues.push(`차트 데이터 부족 (${item.history?.length ?? 0}포인트)`);
  if (item.change === 0 && item.change_pct === 0)
    issues.push('전일대비 계산 실패 의심');
  return issues;
}

export default function MarketCard({ item }) {
  const navigate = useNavigate();
  const { direction: dir, name, category, price, change, change_pct, source, as_of, history } = item;
  const issues = detectIssues(item);

  return (
    <article
      className={`card ${dir}`}
      style={{ cursor: 'pointer' }}
      onClick={() => navigate(`/detail/${item.id}`)}
    >
      <div className="card-top">
        <div className="card-name-row">
          <span className="card-name">{name}</span>
          <div className="card-top-right">
            {issues.length > 0 && (
              <span
                className="card-warn"
                title={issues.join('\n')}
                onClick={e => e.stopPropagation()}
              >
                ⚠
              </span>
            )}
            <span className="card-cat">{category}</span>
          </div>
        </div>
        <div className="card-price">{fp(price)}</div>
        <div className={`card-change ${dir}`}>
          <span className="change-chip">{ARROW[dir]} {fc(change)}</span>
          <span className="change-pct">{fpct(change_pct)}</span>
        </div>
      </div>

      <div className="card-spark">
        <Sparkline history={history || []} dir={dir} />
      </div>

      <div className="card-bottom">
        <div className="card-meta-row">
          <span className="meta-label">출처</span>
          <span className="source-tag">{source}</span>
        </div>
        <div className="card-meta-row">
          <span className="meta-label">기준</span>
          <span className="meta-time">{as_of}</span>
        </div>
      </div>
    </article>
  );
}
