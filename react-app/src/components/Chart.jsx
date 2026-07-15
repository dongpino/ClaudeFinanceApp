import { useEffect, useRef, useState } from 'react';
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts';
import { getAvgPrice, avgPriceRangeStatus } from '../avgPriceStore';

const UP   = '#e84040';
const DOWN = '#3d82ef';
// Chart.jsx는 원래 테마 대응이 없는(항상 다크 팔레트 고정) 파일이라 평단선도 같은
// 관례로 다크 --gold 값을 그대로 하드코딩한다(AnalysisChart.jsx의 srLine과 동일 색).
const AVG_LINE_COLOR = '#e09500';

// KRW는 정수(원 단위), 그 외는 소수 2자리 — MarketCard/Sparkline과 동일 규칙.
function fmtAvgHint(n, currency) {
  const opts = currency === 'krw'
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return n.toLocaleString('ko-KR', opts);
}

export default function Chart({ item }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  // avgPrice는 item.id로부터 매 렌더마다 동기적으로 결정되는 값이라(효과 안의 비동기
  // 상태가 아님) 이 값을 기준으로 래퍼 구조 자체를 켜고 끈다 — avgHint(범위 밖 힌트
  // 표시 여부)는 그 안에서만 토글되는 하위 상태다. 이렇게 나누는 이유: containerRef가
  // 붙는 DOM 노드의 "깊이"가 상태 변화마다 흔들리면(예: hint 유무로 래퍼를 껐다 켰다)
  // React가 그 노드를 통째로 재마운트해 안에 명령형으로 붙여둔 lightweight-charts
  // 캔버스가 통째로 날아간다 — avgPrice는 item이 바뀔 때만 바뀌므로 effect의
  // [item] 의존성과 항상 같은 타이밍에 구조가 바뀌어 안전하다.
  const avgPrice = getAvgPrice(item.id);
  const [avgHint, setAvgHint] = useState(null); // { pos: 'above'|'below' } | null

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;

    const chart = createChart(el, {
      width:  el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { color: 'transparent' },
        textColor:  '#7a8ba8',
      },
      grid: {
        vertLines: { color: '#1a2540' },
        horzLines: { color: '#1a2540' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1a2540' },
      timeScale: {
        borderColor:     '#1a2540',
        timeVisible:     true,
        secondsVisible:  false,
      },
      handleScroll: {
        vertTouchDrag: false,
      },
      handleScale: {
        pinch: true,
      },
    });
    chartRef.current = chart;

    const h90 = item.history_90d || [];
    let mainSeries, lo, hi;

    if (item.ohlc_available && h90.length && h90[0].open !== undefined) {
      mainSeries = chart.addCandlestickSeries({
        upColor:        UP,
        downColor:      DOWN,
        borderUpColor:  UP,
        borderDownColor: DOWN,
        wickUpColor:    UP,
        wickDownColor:  DOWN,
      });
      const data = h90
        .filter(r => r.open > 0 && r.high > 0 && r.low > 0 && r.close > 0)
        .map(r => ({ time: r.date, open: r.open, high: r.high, low: r.low, close: r.close }));
      mainSeries.setData(data);
      if (data.length) {
        lo = Math.min(...data.map(d => d.low));
        hi = Math.max(...data.map(d => d.high));
      }
    } else {
      const dir   = item.direction;
      const color = dir === 'up' ? UP : dir === 'down' ? DOWN : '#576880';
      mainSeries = chart.addAreaSeries({
        lineColor:   color,
        topColor:    color + '33',
        bottomColor: color + '00',
        lineWidth:   2,
        priceLineVisible: false,
      });
      const closes = (h90.length ? h90 : (item.history || []));
      const data = closes
        .filter(r => r.close > 0)
        .map(r => ({ time: r.date, value: r.close }));
      mainSeries.setData(data);
      if (data.length) {
        lo = Math.min(...data.map(d => d.value));
        hi = Math.max(...data.map(d => d.value));
      }
    }

    chart.timeScale().fitContent();

    // 평단선/힌트 — avgPrice가 없으면(현재 커밋 상태는 항상 없음) 아무것도 안 한다.
    // 판정 규칙(±5% 여유)은 avgPriceStore.js에 단일화해 Sparkline.jsx와 공유한다.
    // createPriceLine은 lightweight-charts 자체 가격축 스케일에 영향을 주지 않는
    // 주석용 라인이라 "y축 왜곡 금지" 제약을 그대로 지킨다 — 범위 밖이면 라인 대신
    // 커스텀 HTML 힌트(아래 return)로 대체한다(createPriceLine은 클리핑/힌트 기능이 없음).
    if (avgPrice != null && lo != null && hi != null) {
      const status = avgPriceRangeStatus(avgPrice, lo, hi);
      if (status === 'in') {
        mainSeries.createPriceLine({
          price: avgPrice,
          color: AVG_LINE_COLOR,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '평단',
        });
        setAvgHint(null);
      } else {
        setAvgHint({ pos: status });
      }
    } else {
      setAvgHint(null);
    }

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [item]);

  // avgPrice가 없으면(현재 커밋 상태는 항상 없음) 기존과 완전히 동일한 단일 div만
  // 반환한다 — 래퍼는 avgPrice가 있을 때만 등장(위 주석 참고, containerRef 재마운트
  // 방지를 위해 avgHint가 아니라 avgPrice로 게이팅).
  if (avgPrice == null) {
    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {avgHint && (
        <div className={`chart-avg-hint chart-avg-hint-${avgHint.pos}`}>
          {avgHint.pos === 'above' ? '▲' : '▼'} 평단 {fmtAvgHint(avgPrice, item.currency)}
        </div>
      )}
    </div>
  );
}
