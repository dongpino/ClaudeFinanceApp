import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts';
import { calcMA, calcRSIAligned } from '../indicators';
import { useTheme } from '../ThemeContext';
import { loadLines as loadSRLines, saveLines as saveSRLines } from '../srLinesStore';

// 두 차트의 우측 축 폭을 createChart 시점부터 동일하게 고정 (BTC 등 큰 숫자 기준으로 여유있게)
const SCALE_WIDTH = 80;

const CHART_COLORS = {
  dark:  { text: '#9a9aa2', grid: '#26262a', border: '#26262a', srLine: '#e09500' },
  light: { text: '#3d5070', grid: '#dde1ed', border: '#dde1ed', srLine: '#b87200' },
};

// 수동 지지/저항선 — 더블클릭 시 기존 선과 너무 가까우면 중복 생성 방지(px)
const SR_DEDUPE_TOLERANCE_PX = 6;
// 커서/탭 위치가 선에서 이 거리(px) 이내면 삭제용 X 버튼을 표시
const SR_HOVER_TOLERANCE_PX = 8;
const fp = n => n.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const roundPrice = n => Math.round(n * 100) / 100;

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

const AnalysisChart = forwardRef(function AnalysisChart({
  item, tf,
  showMA20, showMA60, showMA100, showMA200,
  showRSI, showVolume,
  symbolKey, onLinesChange,
}, ref) {
  const { theme } = useTheme();
  const priceRef = useRef(null);
  const rsiRef   = useRef(null);

  // 지지/저항선 hover/탭 상태 — X 삭제 버튼 표시용 (price와 현재 y좌표)
  const [hoverLine, setHoverLine] = useState(null);

  // 수동 지지/저항선 — 최신 props를 ref에 미러링해 effect/이벤트 콜백에서 항상
  // 최신 값을 읽는다(콜백은 chart 생성 시점 클로저라 stale closure 위험이 있음).
  const srPropsRef    = useRef({ symbolKey, onLinesChange, theme });
  srPropsRef.current = { symbolKey, onLinesChange, theme };
  const srPricesRef   = useRef([]);            // 현재 차트에 그려진 가격 목록
  const srLineObjsRef = useRef(new Map());      // price → IPriceLine (현재 mainSeries 소속)

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

  // ── 수동 지지/저항선 헬퍼 ────────────────────────────────────
  // ref만 참조하므로 어느 렌더에서 만들어진 함수든 항상 최신 상태를 반영한다.
  function notifySRCount() {
    srPropsRef.current.onLinesChange?.(srPricesRef.current.length);
  }

  function persistSRLines() {
    saveSRLines(srPropsRef.current.symbolKey, srPricesRef.current);
    notifySRCount();
  }

  function createSRLineObj(price) {
    const ms = mainSeriesRef.current;
    if (!ms) return;
    const c = CHART_COLORS[srPropsRef.current.theme] ?? CHART_COLORS.dark;
    const line = ms.createPriceLine({
      price,
      color:            c.srLine,
      lineWidth:        2,
      lineStyle:        LineStyle.Dashed,
      axisLabelVisible: true,
      title:            fp(price),
    });
    srLineObjsRef.current.set(price, line);
  }

  function addSRLine(price) {
    if (srLineObjsRef.current.has(price)) return;
    createSRLineObj(price);
    srPricesRef.current = [...srPricesRef.current, price];
    persistSRLines();
  }

  function removeSRLine(price) {
    const line = srLineObjsRef.current.get(price);
    const ms   = mainSeriesRef.current;
    if (line && ms) ms.removePriceLine(line);
    srLineObjsRef.current.delete(price);
    srPricesRef.current = srPricesRef.current.filter(p => p !== price);
    persistSRLines();
    setHoverLine(null);
  }

  function clearAllSRLines() {
    const ms = mainSeriesRef.current;
    if (!ms || srPricesRef.current.length === 0) return;
    for (const line of srLineObjsRef.current.values()) ms.removePriceLine(line);
    srLineObjsRef.current.clear();
    srPricesRef.current = [];
    persistSRLines();
    setHoverLine(null);
  }

  useImperativeHandle(ref, () => ({ clearAllLines: clearAllSRLines }));

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

    // ── 수동 지지/저항선 복원 (symbol 기준으로 저장 — tf 변경/차트 재생성에 영향 없음) ──
    srLineObjsRef.current.clear();
    const restoredPrices = loadSRLines(symbolKey);
    for (const price of restoredPrices) createSRLineObj(price);
    srPricesRef.current = restoredPrices;
    notifySRCount();

    // ── 더블클릭: 생성 전용 — 기존 선과 너무 가까우면(±6px) 중복 생성만 방지 ──
    chart.subscribeDblClick(param => {
      const ms = mainSeriesRef.current;
      if (!ms || !param.point) return;
      const clickedPrice = ms.coordinateToPrice(param.point.y);
      if (clickedPrice === null || clickedPrice === undefined) return;

      const tooClose = srPricesRef.current.some(p => {
        const coord = ms.priceToCoordinate(p);
        return coord !== null && Math.abs(coord - param.point.y) <= SR_DEDUPE_TOLERANCE_PX;
      });
      if (tooClose) return;

      addSRLine(roundPrice(clickedPrice));
    });

    // ── hover/탭 위치가 선(±8px) 근처면 삭제용 X 버튼 표시 ──
    // 데스크톱: mousemove 기반 crosshairMove로 계속 갱신, 벗어나면 숨김.
    // 모바일: 단순 탭은 touchmove가 없어 crosshairMove가 갱신되지 않으므로,
    // 클릭/탭 모두에서 발생하는 subscribeClick도 같은 로직으로 병행 구독한다
    // (탭 → 표시, 다른 곳 탭 → 갱신/숨김).
    function updateHoverLine(param) {
      const ms = mainSeriesRef.current;
      if (!ms || !param.point) { setHoverLine(null); return; }
      let hit = null;
      for (const p of srPricesRef.current) {
        const coord = ms.priceToCoordinate(p);
        if (coord !== null && Math.abs(coord - param.point.y) <= SR_HOVER_TOLERANCE_PX) {
          hit = { price: p, y: coord };
          break;
        }
      }
      setHoverLine(hit);
    }
    chart.subscribeCrosshairMove(updateHoverLine);
    chart.subscribeClick(updateHoverLine);

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

    const srLineObjs = srLineObjsRef.current; // cleanup에서 참조할 안정적인 스냅샷
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
      srLineObjs.clear(); // chart.remove()로 이미 소멸된 IPriceLine 참조 정리
      setHoverLine(null);
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
    const c = CHART_COLORS[theme] ?? CHART_COLORS.dark;
    for (const line of srLineObjsRef.current.values()) line.applyOptions({ color: c.srLine });
  }, [theme]);

  // ── MA·거래량 토글 (차트 재생성 없이 visibility만 변경) ──────
  useEffect(() => { ma20Ref.current?.applyOptions({ visible: showMA20 });   }, [showMA20]);
  useEffect(() => { ma60Ref.current?.applyOptions({ visible: showMA60 });   }, [showMA60]);
  useEffect(() => { ma100Ref.current?.applyOptions({ visible: showMA100 }); }, [showMA100]);
  useEffect(() => { ma200Ref.current?.applyOptions({ visible: showMA200 }); }, [showMA200]);
  useEffect(() => { volumeRef.current?.applyOptions({ visible: showVolume }); }, [showVolume]);

  return (
    <div className="analysis-charts-wrap">
      <div className="analysis-price-chart-wrap">
        <div ref={priceRef} className="analysis-price-chart" />
        {hoverLine && (
          <button
            type="button"
            className="sr-line-del-btn"
            style={{ top: hoverLine.y }}
            onClick={e => { e.stopPropagation(); removeSRLine(hoverLine.price); }}
            onMouseDown={e => e.stopPropagation()}
            onTouchStart={e => e.stopPropagation()}
            aria-label={`지지/저항선 ${fp(hoverLine.price)} 삭제`}
          >
            ×
          </button>
        )}
      </div>
      {showRSI && (
        <div className="analysis-rsi-wrap">
          <div className="analysis-rsi-label">RSI(14)</div>
          <div ref={rsiRef} className="analysis-rsi-chart" />
        </div>
      )}
    </div>
  );
});

export default AnalysisChart;
