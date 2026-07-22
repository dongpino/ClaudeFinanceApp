import { useNavigate } from 'react-router-dom';
import Sparkline from './Sparkline';
import { getAvgPrice } from '../avgPriceStore';

const ARROW = { up: '▲', down: '▼', flat: '-' };

// -0(음의 0)은 toFixed()에서 "-0.00"으로 찍히는 JS 특유의 표시 버그를 낳으므로
// 표시 직전에 항상 +0으로 정규화한다("n === 0"은 -0에도 true라 이 한 줄로 충분).
const nz = n => (n === 0 ? 0 : n);

const fp   = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fc   = n => { const v = nz(n); return (v > 0 ? '+' : '') + fp(v); };
const fpct = n => (n > 0 ? '+' : '') + n.toFixed(2) + '%';

// item.currency는 opt-in 필드다(현재는 워치리스트 종목만 설정, api/_collectors/
// watchlist.js) — 기존 15종목은 이 필드가 없어 접두어 없이 그대로 렌더된다.
const CURRENCY_PREFIX = { usd: '$', krw: '₩' };

// 가격이 아니라 지수/점수 성격인 unit 3종 — 모두 detectIssues의 "등락 0 = 계산 실패"
// 휴리스틱에서 예외 처리한다(각자 하루 변동이 0에 가깝거나 정확히 0인 날이 정상적으로
// 존재하기 때문 — us10y에서 처음 발견된 문제의 일반화).
//   - percent : 국채금리 등, 값 "4.25%" / 등락 bp(1bp=0.01%p) — us10y
//   - pct_pt  : BTC 도미넌스 등, 값 "55.82%" / 등락 %p(퍼센트 포인트, bp 아님)
//   - score   : 공포탐욕지수 등, 값 "72"(단위 없는 0~100 점수) / 등락 포인트 차
const NON_PRICE_UNITS = new Set(['percent', 'pct_pt', 'score']);

// "이름 (심볼)" 구조 감지 — 이름 본문과 마지막 괄호 사이에 공백이 있어야만 분리
// 대상으로 본다. 공백 없이 붙은 괄호(예: "원/엔(100엔)")는 심볼이 아니라 이름
// 자체의 단위 표기라 분리하면 의미가 깨진다 — 이 구분이 핵심.
function splitNameSymbol(fullName) {
  const m = fullName.match(/^(.+) (\([^)]+\))$/);
  return m ? [m[1], m[2]] : [fullName, null];
}

// 장 시작 전(동시호가 포함) 상태값 — 이 구간에서는 Naver 개별종목 quote 자체가
// compareToPreviousClosePrice/fluctuationsRatio를 0으로 반환한다(오늘 실측 확인,
// 삼성전자로도 재현됨 — 우미 투자 3종목만의 문제가 아니라 이 엔드포인트의 정상 동작).
// 그래서 change===0 && change_pct===0을 "계산 실패"로 오판하면 안 된다. 실측으로
// 직접 확인된 값은 'PREOPEN' 하나뿐이다(확인 시점이 장 시작 전이라 'OPEN'/'CLOSE' 등
// 다른 상태에서 이 필드가 어떻게 나오는지는 못 봤다) — 다른 장전류 상태값이 발견되면
// 이 Set에 추가할 것. marketStatus가 없는 종목(대부분)은 항상 false라 기존 동작 그대로.
const PREOPEN_STATUSES = new Set(['PREOPEN']);

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

// 공포탐욕지수 등급 — 영문 원본(수집기가 저장)을 한글 라벨 + 색 톤으로 매핑.
// 한국 시장 관례에 맞춰 탐욕(과열)=빨강 계열, 공포(위축)=파랑 계열로 UP/DOWN과 방향을 맞춘다.
const GRADE_MAP = {
  'Extreme Fear':  { ko: '극단적 공포', tone: 'fear' },
  'Fear':          { ko: '공포',        tone: 'fear' },
  'Neutral':       { ko: '중립',        tone: 'neutral' },
  'Greed':         { ko: '탐욕',        tone: 'greed' },
  'Extreme Greed': { ko: '극단적 탐욕', tone: 'greed' },
};

export function detectIssues(item) {
  const issues = [];
  // stale(마지막 성공본 폴백 서빙 중)은 "데이터 이상(누락)"이 아니라 별도 상태다 —
  // 2단계 UI가 stale 배지로 따로 표시하므로 여기서 누락/계산실패 경고로 이중 집계하지
  // 않는다(요구사항 5). lastGood은 저장 전 price/history 검증을 통과한 완전한 스냅샷이라
  // 아래 검사도 통상 통과하지만, 폴백본이 경계에 걸려 오탐하는 것을 원천 차단한다.
  if (item.stale) return issues;
  if (!item.price || item.price === 0)
    issues.push('가격 데이터 없음');
  // history_bootstrapping(예: BTC 도미넌스)은 짧은 history가 "장애"가 아니라 매일
  // 자체 축적 중인 정상 상태라서 이 경고에서 제외한다(카드에는 대신 "수집 중" 안내가 뜬다).
  if (!item.history_bootstrapping && (!item.history || item.history.length < 5))
    issues.push(`차트 데이터 부족 (${item.history?.length ?? 0}포인트)`);
  // 가격이 아닌 지표(NON_PRICE_UNITS)는 하루 변동이 0(에 가까움)인 날이 정상적으로
  // 존재해 "0 == 계산 실패" 가정이 성립하지 않는다(us10y에서 처음 발견) — 가격 없음/
  // 히스토리 부족 조건은 이 종목들에도 그대로 적용한다.
  if (!PREOPEN_STATUSES.has(item.marketStatus) && !NON_PRICE_UNITS.has(item.unit) && item.change === 0 && item.change_pct === 0)
    issues.push('전일대비 계산 실패 의심');
  return issues;
}

export default function MarketCard({ item }) {
  const navigate = useNavigate();
  const {
    direction: dir, name, category, price, change, change_pct, source, as_of, history, unit, grade,
    history_bootstrapping, change_unavailable, currency, stale,
  } = item;
  const issues = detectIssues(item);
  const gradeInfo = grade ? GRADE_MAP[grade] : null;
  const isCollecting = history_bootstrapping && (!history || history.length < 5);

  // 평단가 수익률 배지 — 우미 투자 종목만 avgPrice가 붙는다(그 외는 getAvgPrice가
  // 항상 null). null이면 아래 JSX가 완전히 건너뛰어 기존 렌더와 동일하다.
  const avgPrice = getAvgPrice(item.id);
  const avgPct = avgPrice != null ? ((price - avgPrice) / avgPrice) * 100 : null;
  const avgDir = avgPct == null ? null : (avgPct > 0 ? 'up' : avgPct < 0 ? 'down' : 'flat');
  const [nameMain, nameSymbol] = splitNameSymbol(name);

  return (
    <article
      className={`card ${dir}`}
      style={{ cursor: 'pointer' }}
      onClick={() => navigate(`/detail/${item.id}`)}
    >
      <div className="card-top">
        <div className="card-name-row">
          <span className="card-name">
            <span className="card-name-main">{nameMain}</span>
            {nameSymbol && <span className="card-name-symbol"> {nameSymbol}</span>}
          </span>
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
        <div className="card-price">
          {CURRENCY_PREFIX[currency] ?? ''}{fpUnit(price, unit)}
          {gradeInfo && <span className={`card-grade ${gradeInfo.tone}`}> · {gradeInfo.ko}</span>}
        </div>
        <div className={`card-change ${dir}`}>
          <span className="change-chip">
            {change_unavailable ? '—' : <>{ARROW[dir]} {fcUnit(change, unit)}</>}
          </span>
          {!NON_PRICE_UNITS.has(unit) && !change_unavailable && <span className="change-pct">{fpct(change_pct)}</span>}
          {avgPct != null && (
            <span className={`avg-badge ${avgDir}`}>
              평단 {avgPct > 0 ? '+' : ''}{avgPct.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      <div className="card-spark">
        {isCollecting
          ? <div className="spark-collecting">차트 데이터 수집 중 · {history?.length ?? 0}/5일</div>
          : <Sparkline history={history || []} dir={dir} avgPrice={avgPrice} currency={currency} />}
      </div>

      <div className="card-bottom">
        <div className="card-meta-row">
          <span className="meta-label">출처</span>
          <span className="source-tag">{source}</span>
        </div>
        <div className="card-meta-row">
          <span className="meta-label">기준</span>
          {/* stale(마지막 성공본 폴백 서빙 중)일 때만 '지연' 칩을 시각 옆에 붙인다.
              비-stale은 아래 else로 기존 DOM(meta-time 단독)을 그대로 렌더 → 레이아웃
              시프트 0. 색은 상태판 '지연'과 동일 톤(.stale-chip이 var(--stale) 공유). */}
          {stale ? (
            <span className="meta-right">
              <span className="stale-chip" title="소스 일시 장애 — 마지막 성공 데이터 표시 중">지연</span>
              <span className="meta-time">{as_of}</span>
            </span>
          ) : (
            <span className="meta-time">{as_of}</span>
          )}
        </div>
      </div>
    </article>
  );
}
