import { useRef } from 'react';

const COLOR = { up: '#e84040', down: '#3d82ef', flat: '#576880' };

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

export default function Sparkline({ history, dir }) {
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

  return (
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
    </svg>
  );
}
