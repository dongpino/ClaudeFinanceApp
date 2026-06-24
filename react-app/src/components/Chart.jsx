import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode } from 'lightweight-charts';

const UP   = '#e84040';
const DOWN = '#3d82ef';

export default function Chart({ item }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);

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
      handleScroll: true,
      handleScale:  true,
    });
    chartRef.current = chart;

    const h90 = item.history_90d || [];

    if (item.ohlc_available && h90.length && h90[0].open !== undefined) {
      const series = chart.addCandlestickSeries({
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
      series.setData(data);
    } else {
      const dir   = item.direction;
      const color = dir === 'up' ? UP : dir === 'down' ? DOWN : '#576880';
      const series = chart.addAreaSeries({
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
      series.setData(data);
    }

    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [item]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
