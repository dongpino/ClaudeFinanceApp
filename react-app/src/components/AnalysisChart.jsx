import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts';
import { calcMA, calcRSIAligned } from '../indicators';

// 두 차트의 우측 축 폭을 createChart 시점부터 동일하게 고정 (BTC 등 큰 숫자 기준으로 여유있게)
const SCALE_WIDTH = 80;

const THEME = {
  layout:          { background: { color: 'transparent' }, textColor: '#7a8ba8' },
  grid:            { vertLines: { color: '#1a2540' }, horzLines: { color: '#1a2540' } },
  crosshair:       { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#1a2540', minimumWidth: SCALE_WIDTH },
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
        const priceRect   = el.getBoundingClientRect();
        const rsiRect     = rsiRef.current?.getBoundingClientRect();
        console.group('[CHART DIAG] price crosshair 첫 이동');
        console.log('── container getBoundingClientRect().left ──');
        console.log('  price left:', priceRect.left.toFixed(1), 'px');
        console.log('  RSI   left:', rsiRect?.left.toFixed(1),  'px');
        console.log('  차이:', rsiRect ? Math.abs(priceRect.left - rsiRect.left).toFixed(1) + 'px' : 'N/A',
          rsiRect && Math.abs(priceRect.left - rsiRect.left) < 1 ? '✅ 일치' : '❌ 컨테이너 위치 어긋남');
        console.log('── container clientWidth ──');
        console.log('  price:', el.clientWidth, '  RSI:', rsiRef.current?.clientWidth);
        console.log('── right priceScale.width() ──');
        console.log('  price right:', priceRightW, 'px  RSI right:', rsiRightW, 'px',
          priceRightW === rsiRightW ? '✅' : '❌ 불일치');
        console.log('── left priceScale.width() ──');
        console.log('  price left:', priceLeftW, 'px  RSI left:', rsiLeftW, 'px');
        console.log('── barSpacing / rightOffset ──');
        console.log('  price  barSpacing:', priceTsOpts.barSpacing?.toFixed(4), '  rightOffset:', priceTsOpts.rightOffset?.toFixed(2));
        console.log('  RSI    barSpacing:', rsiTsOpts.barSpacing?.toFixed(4),   '  rightOffset:', rsiTsOpts.rightOffset?.toFixed(2));
        console.log('  barSpacing 차이:', Math.abs((priceTsOpts.barSpacing ?? 0) - (rsiTsOpts.barSpacing ?? 0)).toFixed(4));
        console.log('── timeToCoordinate (t =', t, ') ──');
        console.log('  price x:', priceCoord?.toFixed(2), '  RSI x:', rsiCoord?.toFixed(2));
        console.log('  차이:', (priceCoord != null && rsiCoord != null)
          ? Math.abs(priceCoord - rsiCoord).toFixed(2) + 'px'
          : 'N/A');
        console.groupEnd();
      }
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

    // barSpacing 안전망 동기화 (SCALE_WIDTH 고정으로 같아야 하지만, 잔차 제거)
    requestAnimationFrame(() => {
      const price = priceChartRef.current;
      if (!price) return;

      // 가격 차트 barSpacing을 RSI에 명시적으로 복사
      const priceBs = price.timeScale().options().barSpacing;
      if (priceBs > 0) chart.timeScale().applyOptions({ barSpacing: priceBs });

      // [CHART DIAG] barSpacing · width · timeToCoordinate 최종 확인
      requestAnimationFrame(() => {
        const priceRW = price.priceScale('right').width();
        const rsiRW   = chart.priceScale('right').width();
        const pOpts   = price.timeScale().options();
        const rOpts   = chart.timeScale().options();
        const pLR     = price.timeScale().getVisibleLogicalRange();
        const rLR     = chart.timeScale().getVisibleLogicalRange();
        const t       = rLR?.from != null
          ? chart.timeScale().coordinateToTime(Math.round((chart.priceScale('right').width() || 100)))
          : null;
        const pCoord  = t ? price.timeScale().timeToCoordinate(t) : null;
        const rCoord  = t ? chart.timeScale().timeToCoordinate(t)  : null;

        console.group('[CHART DIAG] RSI 마운트 후 2프레임 — 최종 상태');
        console.log('── right scale width ──');
        console.log('  price:', priceRW, 'px  RSI:', rsiRW, 'px', priceRW === rsiRW ? '✅' : '❌ 불일치');
        console.log('── barSpacing ──');
        console.log('  price:', pOpts.barSpacing?.toFixed(4));
        console.log('  RSI  :', rOpts.barSpacing?.toFixed(4));
        console.log('  차이 :', Math.abs((pOpts.barSpacing ?? 0) - (rOpts.barSpacing ?? 0)).toFixed(4),
          pOpts.barSpacing === rOpts.barSpacing ? '✅' : '← 차이있음');
        console.log('── visibleLogicalRange ──');
        console.log('  price:', JSON.stringify(pLR));
        console.log('  RSI  :', JSON.stringify(rLR));
        if (pCoord != null && rCoord != null) {
          console.log('── timeToCoordinate(임의 t) ──');
          console.log('  price x:', pCoord.toFixed(1), '  RSI x:', rCoord.toFixed(1),
            '  차이:', Math.abs(pCoord - rCoord).toFixed(1) + 'px', Math.abs(pCoord - rCoord) < 1 ? '✅' : '❌');
        }
        console.groupEnd();
      });
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
