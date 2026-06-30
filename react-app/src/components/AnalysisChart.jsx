import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts';
import { calcMA, calcRSIAligned } from '../indicators';

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

function getHistory(item) {
  if (item.history_long?.length) return item.history_long;
  if (item.history_90d?.length)  return item.history_90d;
  return item.history ?? [];
}

function getTime(r) {
  return r.time ?? r.date;
}

export default function AnalysisChart({
  item, tf,
  showMA20, showMA60, showMA100, showMA200,
  showRSI,
}) {
  const priceRef = useRef(null);
  const rsiRef   = useRef(null);

  // MA series refs (visibility 토글용)
  const ma20Ref  = useRef(null);
  const ma60Ref  = useRef(null);
  const ma100Ref = useRef(null);
  const ma200Ref = useRef(null);

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

    const chart = createChart(el, { ...THEME, width: el.clientWidth, height: el.clientHeight });
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
    // [CHART DIAG] price series 범위
    console.log('[CHART DIAG] price data:', priceData.length, 'pts |', priceData[0]?.time, '~', priceData[priceData.length - 1]?.time);

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
    let diagLogged = false;
    chart.subscribeCrosshairMove(param => {
      const rsi = rsiChartRef.current;
      const rs  = rsiSeriesRef.current;
      if (!rsi || !rs) return;
      if (!param.point) { rsi.clearCrosshairPosition(); return; }
      if (param.time) rsi.setCrosshairPosition(0, param.time, rs);

      // ── [CHART DIAG] crosshair 첫 이동 시 한 번만 ──────────
      if (!diagLogged && param.time) {
        diagLogged = true;
        const priceRightW = chart.priceScale('right').width();
        const rsiRightW   = rsi.priceScale('right').width();
        const priceLeftW  = chart.priceScale('left').width();
        const rsiLeftW    = rsi.priceScale('left').width();
        const priceTsOpts = chart.timeScale().options();
        const rsiTsOpts   = rsi.timeScale().options();
        const t           = param.time;
        const priceCoord  = chart.timeScale().timeToCoordinate(t);
        const rsiCoord    = rsi.timeScale().timeToCoordinate(t);
        console.group('[CHART DIAG] price crosshair 첫 이동');
        console.log('── container clientWidth ──');
        console.log('  price:', el.clientWidth, '  RSI:', rsiRef.current?.clientWidth);
        console.log('── right priceScale.width() ──');
        console.log('  price right:', priceRightW, 'px');
        console.log('  RSI   right:', rsiRightW,   'px');
        console.log('  차이:', Math.abs(priceRightW - rsiRightW), 'px ', priceRightW === rsiRightW ? '✅ 일치' : '❌ 불일치');
        console.log('── left priceScale.width() ──');
        console.log('  price left:', priceLeftW, 'px');
        console.log('  RSI   left:', rsiLeftW,   'px');
        console.log('── timeScale options ──');
        console.log('  price  barSpacing:', priceTsOpts.barSpacing?.toFixed(2), '  rightOffset:', priceTsOpts.rightOffset?.toFixed(2));
        console.log('  RSI    barSpacing:', rsiTsOpts.barSpacing?.toFixed(2),   '  rightOffset:', rsiTsOpts.rightOffset?.toFixed(2));
        console.log('── timeToCoordinate (t =', t, ') ──');
        console.log('  price x:', priceCoord?.toFixed(1));
        console.log('  RSI   x:', rsiCoord?.toFixed(1));
        console.log('  차이:', (priceCoord != null && rsiCoord != null)
          ? Math.abs(priceCoord - rsiCoord).toFixed(1) + 'px  ← 0이어야 정렬됨'
          : 'N/A');
        console.groupEnd();
      }
    });

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      requestAnimationFrame(() => {
        const rsi = rsiChartRef.current;
        if (!rsi) return;
        const priceW  = chart.priceScale('right').width();
        const rsiW    = rsi.priceScale('right').width();
        const targetW = Math.max(priceW, rsiW);
        if (targetW > 0) {
          chart.applyOptions({ rightPriceScale: { minimumWidth: targetW } });
          rsi.applyOptions({ rightPriceScale: { minimumWidth: targetW } });
        }
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
    };
  }, [item]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── RSI 차트 ────────────────────────────────────────────────
  useEffect(() => {
    if (!showRSI || !item || !rsiRef.current) return;
    const el = rsiRef.current;
    const h  = getHistory(item);
    if (!h.length) return;

    const chart = createChart(el, { ...THEME, width: el.clientWidth, height: el.clientHeight });
    rsiChartRef.current = chart;

    const rsiSeries = chart.addLineSeries({
      color: RSI_C, lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: true,
    });
    const rsiData = calcRSIAligned(h, 14);
    rsiSeries.setData(rsiData);
    // [CHART DIAG] RSI series 범위 (whitespace 포함, price와 동일해야 함)
    console.log('[CHART DIAG] RSI  data:', rsiData.length, 'pts |', rsiData[0]?.time, '~', rsiData[rsiData.length - 1]?.time);
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

    // scale 폭 동기화 — 양쪽 차트 모두 max(priceW, rsiW)로 맞춤
    requestAnimationFrame(() => {
      const price = priceChartRef.current;
      if (!price) return;

      // [CHART DIAG] visible range 비교
      const priceLR = price.timeScale().getVisibleLogicalRange();
      const rsiLR   = chart.timeScale().getVisibleLogicalRange();
      const priceVR = price.timeScale().getVisibleRange();
      const rsiVR   = chart.timeScale().getVisibleRange();
      console.group('[CHART DIAG] visible range (RSI 마운트 후 1프레임)');
      console.log('price logicalRange:', JSON.stringify(priceLR));
      console.log('RSI   logicalRange:', JSON.stringify(rsiLR));
      console.log('price visibleRange:', JSON.stringify(priceVR));
      console.log('RSI   visibleRange:', JSON.stringify(rsiVR));
      const lrMatch = priceLR && rsiLR
        && Math.abs(priceLR.from - rsiLR.from) < 0.1
        && Math.abs(priceLR.to   - rsiLR.to)   < 0.1;
      console.log('logicalRange 일치?', lrMatch ? '✅ 일치' : '❌ 불일치 ← 원인 후보');
      console.groupEnd();

      // scale 폭 동기화
      const priceW = price.priceScale('right').width();
      const rsiW   = chart.priceScale('right').width();
      const targetW = Math.max(priceW, rsiW);
      if (targetW > 0) {
        price.applyOptions({ rightPriceScale: { minimumWidth: targetW } });
        chart.applyOptions({ rightPriceScale: { minimumWidth: targetW } });
      }
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

    const ro = new ResizeObserver(() =>
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    );
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      rsiChartRef.current  = null;
      rsiSeriesRef.current = null;
    };
  }, [item, showRSI]);

  // ── MA 토글 (차트 재생성 없이 visibility만 변경) ─────────────
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
