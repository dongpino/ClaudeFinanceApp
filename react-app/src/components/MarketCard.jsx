import { useNavigate } from 'react-router-dom';
import Sparkline from './Sparkline';

const ARROW = { up: '▲', down: '▼', flat: '-' };

// -0(음의 0)은 toFixed()에서 "-0.00"으로 찍히는 JS 특유의 표시 버그를 낳으므로
// 표시 직전에 항상 +0으로 정규화한다("n === 0"은 -0에도 true라 이 한 줄로 충분).
const nz = n => (n === 0 ? 0 : n);

const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fc   = n => { const v = nz(n); return (v > 0 ? '+' : '') + fp(v); };
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

// unit==='percent'인 카드(미 10년물 금리 등): 값 자체가 %이므로 "4.25%"로,
// 등락은 국채금리 관례상 bp(basis point, 1bp=0.01%p)로 표시한다 — %p 소수 2자리로는
// 0.01%p 미만의 실제 변동(예: +0.002%p)이 "0.00%p"로 뭉개져 계산 실패처럼 보였다(us10y 사례).
const fpUnit = (n, unit) => unit === 'percent' ? `${n.toFixed(2)}%` : fp(n);
const fcUnit = (n, unit) => {
  if (unit !== 'percent') return fc(n);
  const bp = nz(Math.round(n * 100 * 10) / 10); // %p → bp(소수 1자리)
  return `${bp > 0 ? '+' : ''}${bp.toFixed(1)}bp`;
};

export function detectIssues(item) {
  const issues = [];
  if (!item.price || item.price === 0)
    issues.push('가격 데이터 없음');
  if (!item.history || item.history.length < 5)
    issues.push(`차트 데이터 부족 (${item.history?.length ?? 0}포인트)`);
  // percent 단위(국채금리 등)는 하루 변동이 0.01%p 미만(=보합)인 날이 흔해 "0 == 실패"
  // 가정이 성립하지 않는다(us10y 사례) — 가격 없음/히스토리 부족 조건은 그대로 적용.
  if (item.unit !== 'percent' && item.change === 0 && item.change_pct === 0)
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
