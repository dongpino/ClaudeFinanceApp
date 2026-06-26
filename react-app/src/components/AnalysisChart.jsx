import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts';
import { calcMA, calcRSI } from '../indicators';

const THEME = {
  layout:          { background: { color: 'transparent' }, textColor: '#7a8ba8' },
  grid:            { vertLines: { color: '#1a2540' }, horzLines: { color: '#1a2540' } },
  crosshair:       { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#1a2540' },
  timeScale:       { borderColor: '#1a2540', timeVisible: true, secondsVisible: false },
  handleScroll: true,
  handleScale:  true,
};

const UP    = '#e84040';
const DOWN  = '#3d82ef';
const MA20  = '#f97316';
const MA60  = '#a855f7';
const MA100 = '#10b981';
const MA200 = '#fbbf24';
const RSI_C = '#22d3ee';

// history_long (250d/intraday) > history_90d > history (30d) 우선순위
function getHistory(item) {
  if (item.history_long?.length) return item.history_long;
  if (item.history_90d?.length)  return item.history_90d;
  return item.history ?? [];
}

// 일봉/주봉: r.date (문자열), 분봉/시간봉: r.time (Unix seconds)
// lightweight-charts는 두 형식 모두 지원
function getTime(r) {
  return r.time ?? r.date;
}

export default function AnalysisChart({
  item, tf,
  showMA20, showMA60, showMA100, showMA200,
  showRSI,
}) {
  const priceRef  = useRef(null);
  const rsiRef    = useRef(null);
  const ma20Ref   = useRef(null);
  const ma60Ref   = useRef(null);
  const ma100Ref  = useRef(null);
  const ma200Ref  = useRef(null);

  // ── 가격 차트 + MA 오버레이 ─────────────────────────────
  useEffect(() => {
    if (!item || !priceRef.current) return;
    const el = priceRef.current;
    const h  = getHistory(item);

    const chart = createChart(el, { ...THEME, width: el.clientWidth, height: el.clientHeight });

    if (item.ohlc_available && h.length && (h[0]?.open !== undefined)) {
      const cs = chart.addCandlestickSeries({
        upColor: UP, downColor: DOWN,
        borderUpColor: UP, borderDownColor: DOWN,
        wickUpColor: UP, wickDownColor: DOWN,
      });
      cs.setData(h.filter(r => r.close > 0).map(r => ({
        time: getTime(r), open: r.open, high: r.high, low: r.low, close: r.close,
      })));
    } else {
      const color = item.direction === 'up' ? UP : item.direction === 'down' ? DOWN : '#576880';
      const as = chart.addAreaSeries({
        lineColor: color, topColor: color + '33', bottomColor: color + '00',
        lineWidth: 2, priceLineVisible: false,
      });
      as.setData(h.filter(r => r.close > 0).map(r => ({ time: getTime(r), value: r.close })));
    }

    const m20 = chart.addLineSeries({
      color: MA20, lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: false, visible: showMA20, title: 'MA20',
    });
    m20.setData(calcMA(h, 20));
    ma20Ref.current = m20;

    const m60 = chart.addLineSeries({
      color: MA60, lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: false, visible: showMA60, title: 'MA60',
    });
    m60.setData(calcMA(h, 60));
    ma60Ref.current = m60;

    const m100 = chart.addLineSeries({
      color: MA100, lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: false, visible: showMA100, title: 'MA100',
    });
    m100.setData(calcMA(h, 100));
    ma100Ref.current = m100;

    const m200 = chart.addLineSeries({
      color: MA200, lineWidth: 2,
      priceLineVisible: false, lastValueVisible: false, visible: showMA200, title: 'MA200',
    });
    m200.setData(calcMA(h, 200));
    ma200Ref.current = m200;

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() =>
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    );
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      ma20Ref.current  = null;
      ma60Ref.current  = null;
      ma100Ref.current = null;
      ma200Ref.current = null;
    };
  }, [item]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── RSI 차트 ────────────────────────────────────────────
  useEffect(() => {
    if (!showRSI || !item || !rsiRef.current) return;
    const el = rsiRef.current;
    const h  = getHistory(item);

    const chart = createChart(el, { ...THEME, width: el.clientWidth, height: el.clientHeight });

    const rsiSeries = chart.addLineSeries({
      color: RSI_C, lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: true,
    });
    rsiSeries.setData(calcRSI(h, 14));

    rsiSeries.createPriceLine({
      price: 70, color: '#ef4444bb', lineWidth: 1,
      lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '과매수',
    });
    rsiSeries.createPriceLine({
      price: 30, color: '#3b82f6bb', lineWidth: 1,
      lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '과매도',
    });

    chart.priceScale('right').applyOptions({ minimum: 0, maximum: 100 });
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() =>
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    );
    ro.observe(el);

    return () => { ro.disconnect(); chart.remove(); };
  }, [item, showRSI]);

  // ── MA 토글 (차트 재생성 없이 visibility만 변경) ─────────
  useEffect(() => { ma20Ref.current?.applyOptions({ visible: showMA20 });   }, [showMA20]);
  useEffect(() => { ma60Ref.current?.applyOptions({ visible: showMA60 });   }, [showMA60]);
  useEffect(() => { ma100Ref.current?.applyOptions({ visible: showMA100 }); }, [showMA100]);
  useEffect(() => { ma200Ref.current?.applyOptions({ visible: showMA200 }); }, [showMA200]);

  return (
    <div className="analysis-charts-wrap">
      <div ref={priceRef} className="analysis-price-chart" />
      {showRSI && (
        <div className="analysis-rsi-wrap">
          <div className="analysis-rsi-label">RSI(14)</div>
          <div ref={rsiRef} className="analysis-rsi-chart" />
        </div>
      )}
    </div>
  );
}
