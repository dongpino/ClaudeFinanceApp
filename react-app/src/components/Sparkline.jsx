import { useRef } from 'react';
import { avgPriceRangeStatus } from '../avgPriceStore';

const COLOR = { up: '#e84040', down: '#3d82ef', flat: '#576880' };

// 평단가 절대값 힌트 표기 — KRW는 정수(원 단위에 소수 없음), 그 외(USD 등)는 기존
// 카드 표기와 동일하게 소수 2자리. MarketCard.jsx의 fp()와 별도로 두는 이유: fp()는
// 통화 구분 없이 항상 소수 2자리라(카드 가격 표기 자체의 기존 관례) 평단가 힌트에는
// 안 맞음 — 여기서만 쓰는 표기라 이 파일에 둔다.
function fmtAvgHint(n, currency) {
  const opts = currency === 'krw'
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return n.toLocaleString('ko-KR', opts);
}

function smoothPath(pts) {
  if (pts.length < 2) return `M${pts[0][0]},${pts[0][1]}`;
  const d = [`M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d.push(
      `C${cp1x.toFixed(2)},${cp1y.toFixed(2)},` +
      `${cp2x.toFixed(2)},${cp2y.toFixed(2)},` +
      `${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
    );
  }
  return d.join('');
}

export default function Sparkline({ history, dir, avgPrice, currency }) {
  // 컴포넌트 인스턴스마다 고정된 gradient ID 생성
  const gid = useRef('g' + Math.random().toString(36).slice(2, 9)).current;
  const color = COLOR[dir] || COLOR.flat;

  if (!Array.isArray(history) || history.length < 2) {
    return <div className="spark-empty">데이터 없음</div>;
  }

  const W = 200, H = 54, padY = 4;
  const prices = history.map(h => h.close);
  const lo  = Math.min(...prices);
  const hi  = Math.max(...prices);
  const rng = hi - lo || hi * 0.005 || 1;
  const n   = prices.length;

  const pts = prices.map((p, i) => [
    (i / (n - 1)) * W,
    (H - padY) - ((p - lo) / rng) * (H - 2 * padY),
  ]);

  const linePath = smoothPath(pts);
  const last     = pts[pts.length - 1];
  const areaPath = `${linePath}L${last[0].toFixed(2)},${H}L0,${H}Z`;

  // 평단선/힌트 — avgPrice가 없으면 완전히 건너뛴다(요구사항: null이면 미표시,
  // 기존 렌더 경로와 바이트 단위로 동일해야 함). 판정 규칙(±5% 여유)은
  // avgPriceStore.js에 단일화해 상세화면(Chart.jsx)과 공유한다. lo/hi/rng(위 y축
  // 계산)는 절대 건드리지 않고 — 평단선을 그릴 y좌표만 시각 영역 안으로 클램프한다
  // (축 자체를 넓히는 게 아니라 "이미 계산된 축 위에서 선의 위치만 클램프"라 왜곡이 아님).
  let avgLine = null;
  if (avgPrice != null) {
    const status = avgPriceRangeStatus(avgPrice, lo, hi);
    avgLine = status === 'in'
      ? { mode: 'line', y: Math.min(H - padY, Math.max(padY, (H - padY) - ((avgPrice - lo) / rng) * (H - 2 * padY))) }
      : { mode: 'hint', pos: status };
  }

  const svg = (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gid})`} />
      <path
        d={linePath}
        stroke={color}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {avgLine?.mode === 'line' && (
        <line
          x1="0" x2={W} y1={avgLine.y} y2={avgLine.y}
          style={{ stroke: 'var(--gold)' }}
          strokeWidth="1.5"
          strokeDasharray="4 3"
        />
      )}
    </svg>
  );

  // 힌트 텍스트는 SVG 밖(일반 HTML)에 얹는다 — 이 svg는 preserveAspectRatio="none"로
  // 비균등 스케일되므로 SVG <text>를 쓰면 카드 실제 가로세로비에 따라 글자가
  // 눌리거나 늘어난다(선은 수평이라 두께만 바뀔 뿐 형태는 안 깨져 SVG 안에 둬도 무방).
  if (avgLine?.mode !== 'hint') return svg;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {svg}
      <span className={`spark-avg-hint spark-avg-hint-${avgLine.pos}`}>
        {avgLine.pos === 'above' ? '▲' : '▼'} 평단 {fmtAvgHint(avgPrice, currency)}
      </span>
    </div>
  );
}
