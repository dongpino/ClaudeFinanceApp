import { useNavigate } from 'react-router-dom';
import Sparkline from './Sparkline';

const ARROW = { up: '▲', down: '▼', flat: '-' };

const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fc   = n => (n > 0 ? '+' : '') + fp(n);
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

// unit==='percent'인 카드(미 10년물 금리 등): 값 자체가 %이므로 "4.25%"로,
// 등락은 %p로 표시해 다른 카드의 등락률(%)과 헷갈리지 않게 한다.
const fpUnit = (n, unit) => unit === 'percent' ? `${n.toFixed(2)}%` : fp(n);
const fcUnit = (n, unit) => unit === 'percent' ? `${n > 0 ? '+' : ''}${n.toFixed(2)}%p` : fc(n);

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
  const { direction: dir, name, category, price, change, change_pct, source, as_of, history, unit } = item;
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
        <div className="card-price">{fpUnit(price, unit)}</div>
        <div className={`card-change ${dir}`}>
          <span className="change-chip">{ARROW[dir]} {fcUnit(change, unit)}</span>
          {unit !== 'percent' && <span className="change-pct">{fpct(change_pct)}</span>}
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
