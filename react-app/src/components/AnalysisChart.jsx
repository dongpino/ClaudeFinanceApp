import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts';
import { calcMA, calcRSIAligned } from '../indicators';
import { useTheme } from '../ThemeContext';

// 두 차트의 우측 축 폭을 createChart 시점부터 동일하게 고정 (BTC 등 큰 숫자 기준으로 여유있게)
const SCALE_WIDTH = 80;

const CHART_COLORS = {
  dark:  { text: '#9a9aa2', grid: '#26262a', border: '#26262a' },
  light: { text: '#3d5070', grid: '#dde1ed', border: '#dde1ed' },
};

function buildChartOpts(theme, width, height) {
  const c = CHART_COLORS[theme] ?? CHART_COLORS.dark;
  return {
    width, height,
    layout:          { background: { color: 'transparent' }, textColor: c.text },
    grid:            { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    crosshair:       { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: c.border, minimumWidth: SCALE_WIDTH },
    timeScale:       { borderColor: c.border, timeVisible: true, secondsVisible: false },
    handleScroll:    { vertTouchDrag: false },
    handleScale:     { pinch: true },
  };
}

function chartColorOpts(theme) {
  const c = CHART_COLORS[theme] ?? CHART_COLORS.dark;
  return {
    layout:          { background: { color: 'transparent' }, textColor: c.text },
    grid:            { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.border },
    timeScale:       { borderColor: c.border },
  };
}

const UP    = '#e84040';
const DOWN  = '#3d82ef';
const MA20  = '#f97316';
const MA60  = '#a855f7';
const MA100 = '#10b981';
const MA200 = '#fbbf24';
const RSI_C = '#22d3ee';

// 거래량 히스토그램 — 캔들 상승/하락색을 반투명으로 재사용(고정 색상이라 다크/라이트 모두 대응).
// 히스토그램 하단 배치 비율(가격 스케일의 아래 20~25% 영역).
const VOL_UP        = UP   + '80';
const VOL_DOWN      = DOWN + '80';
const VOL_TOP_MARGIN = 0.78;   // 볼륨 자체 스케일: 위 78% 여백 → 아래 22% 영역에 그림
const MAIN_BOTTOM_MARGIN = 0.24;   // 메인 가격 스케일: 아래 24% 비워 볼륨 영역과 겹치지 않게

function getHistory(item) {
  if (item.history_long?.length) return item.history_long;
  if (item.history_90d?.length)  return item.history_90d;
  return item.history ?? [];
}

function getTime(r) {
  return r.time ?? r.date;
}

// 캔들 OHLC가 있는 봉만 거래량 표시 — 상승/하락 판정에 open이 필요.
function buildVolumeData(h) {
  return h
    .filter(r => typeof r.volume === 'number' && r.volume >= 0 && r.open !== undefined && r.close !== undefined)
    .map(r => ({
      time:  getTime(r),
      value: r.volume,
      color: r.close >= r.open ? VOL_UP : VOL_DOWN,
    }));
}

export default function AnalysisChart({
  item, tf,
  showMA20, showMA60, showMA100, showMA200,
  showRSI, showVolume,
}) {
  const { theme } = useTheme();
  const priceRef = useRef(null);
  const rsiRef   = useRef(null);

  // MA series refs (visibility 토글용)
  const ma20Ref  = useRef(null);
  const ma60Ref  = useRef(null);
  const ma100Ref = useRef(null);
  const ma200Ref = useRef(null);
  const volumeRef = useRef(null);

  // 동기화용 refs — 콜백 실행 시점에 lazy하게 읽음
  const priceChartRef = useRef(null);
  const rsiChartRef   = useRef(null);
  const mainSeriesRef = useRef(null); // crosshair sync: setCrosshairPosition 3번째 인자
  const rsiSeriesRef  = useRef(null); // crosshair sync: setCrosshairPosition 3번째 인자
  const syncingRef    = useRef(false); // 무한 루프 방지 플래그

  // ── 가격 차트 + MA 오버레이 ─────────────────────────────────
  useEffect(() => {
    if (!item || !priceRef.current) return;
    const el = priceRef.current;
    const h  = getHistory(item);
    if (!h.length) return;

    const chart = createChart(el, buildChartOpts(theme, el.clientWidth, el.clientHeight));
    priceChartRef.current = chart;

    // 메인 시리즈 (캔들 or 영역)
    let mainSeries;
    let priceData;
    if (item.ohlc_available && h.length && h[0]?.open !== undefined) {
      const cs = chart.addCandlestickSeries({
        upColor: UP, downColor: DOWN,
        borderUpColor: UP, borderDownColor: DOWN,
        wickUpColor: UP, wickDownColor: DOWN,
      });
      priceData = h.filter(r => r.close > 0).map(r => ({
        time: getTime(r), open: r.open, high: r.high, low: r.low, close: r.close,
      }));
      cs.setData(priceData);
      mainSeries = cs;
    } else {
      const color = item.direction === 'up' ? UP : item.direction === 'down' ? DOWN : '#576880';
      const as = chart.addAreaSeries({
        lineColor: color, topColor: color + '33', bottomColor: color + '00',
        lineWidth: 2, priceLineVisible: false,
      });
      priceData = h.filter(r => r.close > 0).map(r => ({ time: getTime(r), value: r.close }));
      as.setData(priceData);
      mainSeries = as;
    }
    mainSeriesRef.current = mainSeries;

    // ── 거래량 히스토그램 (별도 priceScaleId로 캔들 가격축과 분리, 하단 오버레이) ──
    const volumeData = buildVolumeData(h);
    if (volumeData.length) {
      const vs = chart.addHistogramSeries({
        priceFormat:      { type: 'volume' },
        priceScaleId:     '',   // 오버레이 스케일 — 우측 캔들 가격축과 별개
        priceLineVisible: false,
        lastValueVisible: false,
        visible:          showVolume,
      });
      vs.priceScale().applyOptions({ scaleMargins: { top: VOL_TOP_MARGIN, bottom: 0 } });
      vs.setData(volumeData);
      mainSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: MAIN_BOTTOM_MARGIN } });
      volumeRef.current = vs;
    } else {
      volumeRef.current = null;
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

    // ── 시간축 동기화 → RSI 차트 ──────────────────────────────
    chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncingRef.current || !range) return;
      const rsi = rsiChartRef.current;
      if (!rsi) return;
      syncingRef.current = true;
      rsi.timeScale().setVisibleLogicalRange(range);
      syncingRef.current = false;
    });

    // ── Crosshair 동기화 → RSI 차트 ──────────────────────────
    chart.subscribeCrosshairMove(param => {
      const rsi = rsiChartRef.current;
      const rs  = rsiSeriesRef.current;
      if (!rsi || !rs) return;
      if (!param.point) { rsi.clearCrosshairPosition(); return; }
      if (param.time) rsi.setCrosshairPosition(0, param.time, rs);
    });

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      requestAnimationFrame(() => {
        const rsi = rsiChartRef.current;
        if (!rsi) return;
        // 리사이즈 후 barSpacing 재동기화 (SCALE_WIDTH 고정이므로 폭은 맞춰져 있음)
        const bs = chart.timeScale().options().barSpacing;
        if (bs > 0) rsi.timeScale().applyOptions({ barSpacing: bs });
      });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      priceChartRef.current = null;
      mainSeriesRef.current = null;
      ma20Ref.current  = null;
      ma60Ref.current  = null;
      ma100Ref.current = null;
      ma200Ref.current = null;
      volumeRef.current = null;
    };
  }, [item]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── RSI 차트 ────────────────────────────────────────────────
  useEffect(() => {
    if (!showRSI || !item || !rsiRef.current) return;
    const el = rsiRef.current;
    const h  = getHistory(item);
    if (!h.length) return;

    const chart = createChart(el, buildChartOpts(theme, el.clientWidth, el.clientHeight));
    rsiChartRef.current = chart;

    const rsiSeries = chart.addLineSeries({
      color: RSI_C, lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: true,
    });
    const rsiData = calcRSIAligned(h, 14);
    rsiSeries.setData(rsiData);
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
    rsiSeriesRef.current = rsiSeries;

    // barSpacing 안전망 동기화 (SCALE_WIDTH 고정으로 같아야 하지만, 잔차 제거)
    requestAnimationFrame(() => {
      const price = priceChartRef.current;
      if (!price) return;

      // 가격 차트 barSpacing을 RSI에 명시적으로 복사
      const priceBs = price.timeScale().options().barSpacing;
      if (priceBs > 0) chart.timeScale().applyOptions({ barSpacing: priceBs });
    });

    // ── 시간축 동기화 → 가격 차트 ────────────────────────────
    chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncingRef.current || !range) return;
      const price = priceChartRef.current;
      if (!price) return;
      syncingRef.current = true;
      price.timeScale().setVisibleLogicalRange(range);
      syncingRef.current = false;
    });

    // ── Crosshair 동기화 → 가격 차트 ────────────────────────
    chart.subscribeCrosshairMove(param => {
      const price = priceChartRef.current;
      const ms    = mainSeriesRef.current;
      if (!price || !ms) return;
      if (!param.point) { price.clearCrosshairPosition(); return; }
      if (param.time) price.setCrosshairPosition(0, param.time, ms);
    });

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      requestAnimationFrame(() => {
        const price = priceChartRef.current;
        if (!price) return;
        const bs = price.timeScale().options().barSpacing;
        if (bs > 0) chart.timeScale().applyOptions({ barSpacing: bs });
      });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      rsiChartRef.current  = null;
      rsiSeriesRef.current = null;
    };
  }, [item, showRSI]);

  // ── 테마 변경 시 차트 색상만 재적용 (barSpacing·minimumWidth 불변) ──
  useEffect(() => {
    const opts = chartColorOpts(theme);
    priceChartRef.current?.applyOptions(opts);
    rsiChartRef.current?.applyOptions(opts);
  }, [theme]);

  // ── MA·거래량 토글 (차트 재생성 없이 visibility만 변경) ──────
  useEffect(() => { ma20Ref.current?.applyOptions({ visible: showMA20 });   }, [showMA20]);
  useEffect(() => { ma60Ref.current?.applyOptions({ visible: showMA60 });   }, [showMA60]);
  useEffect(() => { ma100Ref.current?.applyOptions({ visible: showMA100 }); }, [showMA100]);
  useEffect(() => { ma200Ref.current?.applyOptions({ visible: showMA200 }); }, [showMA200]);
  useEffect(() => { volumeRef.current?.applyOptions({ visible: showVolume }); }, [showVolume]);

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
