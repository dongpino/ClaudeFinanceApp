import { forwardRef, useEffect, useLayoutEffect, useImperativeHandle, useRef, useState } from 'react';
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts';
import { calcMA, calcBB, calcRSIAligned } from '../indicators';
import { useTheme } from '../ThemeContext';
import { loadLines as loadSRLines, saveLines as saveSRLines } from '../srLinesStore';
import { saveDrawings, makeShape, DRAWING_TYPE } from '../drawingsStore';
import { DrawingPrimitive } from '../drawingPrimitive';
import { hitTest, movePointsParallel } from '../drawingGeometry';
import { createInteractionLock } from '../chartInteractionLock';

// 두 차트의 우측 축 폭을 createChart 시점부터 동일하게 고정 (BTC 등 큰 숫자 기준으로 여유있게)
const SCALE_WIDTH = 80;

const CHART_COLORS = {
  dark:  { text: '#9a9aa2', grid: '#26262a', border: '#26262a', srLine: '#e09500',
           drawLine: '#a3e635', drawPreview: '#a3e635aa' },
  light: { text: '#3d5070', grid: '#dde1ed', border: '#dde1ed', srLine: '#b87200',
           drawLine: '#4d7c0f', drawPreview: '#4d7c0faa' },
};

// 그리기 색 — 툴바 '그리기' 칩과 같은 라임 계열(라이트 테마는 흰 배경에서 읽히도록 진하게).
function drawStyleFor(theme) {
  const c = CHART_COLORS[theme] ?? CHART_COLORS.dark;
  return { color: c.drawLine, previewColor: c.drawPreview };
}

// 수동 지지/저항선 — 더블클릭 시 기존 선과 너무 가까우면 중복 생성 방지(px)
const SR_DEDUPE_TOLERANCE_PX = 6;
// 커서/탭 위치가 선에서 이 거리(px) 이내면 삭제용 X 버튼을 표시
const SR_HOVER_TOLERANCE_PX = 12;
// 선에서 벗어나도 즉시 숨기지 않고 이 시간(ms) 동안 대기 — 그 사이 X 버튼에 도달하면 유지되어
// hover 판정이 버튼 표시/숨김을 빠르게 반복하는 깜빡임을 막는다.
const SR_HOVER_HIDE_DELAY_MS = 180;
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
const BB_C  = '#ec4899'; // MA 4색·RSI 시안과 겹치지 않는 핑크 계열

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
  showBB,
  showRSI, showVolume,
  symbolKey, onLinesChange,
  drawMode, onDrawModeChange, shapes, onShapesChange,
}, ref) {
  const { theme } = useTheme();
  const priceRef = useRef(null);
  const rsiRef   = useRef(null);

  // 지지/저항선 hover/탭 상태 — X 삭제 버튼 표시용 (price와 현재 y좌표)
  const [hoverLine, setHoverLine] = useState(null);
  // X 버튼(차트 캔버스 밖의 HTML 오버레이) 위에 마우스가 있는 동안은 hit-test 결과와
  // 무관하게 숨기지 않는다 — 버튼으로 이동하는 순간 차트 쪽 hover가 벗어난 것으로 판정돼
  // 표시/숨김이 반복되는 깜빡임을 막기 위함.
  const isHoveringDelBtnRef = useRef(false);
  const hoverHideTimerRef   = useRef(null);

  // 수동 지지/저항선 — 최신 props를 ref에 미러링해 effect/이벤트 콜백에서 항상
  // 최신 값을 읽는다(콜백은 chart 생성 시점 클로저라 stale closure 위험이 있음).
  const srPropsRef    = useRef({ symbolKey, onLinesChange, theme });
  srPropsRef.current = { symbolKey, onLinesChange, theme };
  const srPricesRef   = useRef([]);            // 현재 차트에 그려진 가격 목록
  const srLineObjsRef = useRef(new Map());      // price → IPriceLine (현재 mainSeries 소속)

  // ── 그리기 도구 — 추세선·피보나치가 공유하는 인터랙션 층 ──────────────────
  // ⚠️ **도형 목록의 소유자는 AnalysisPage다(2026-08-04 수정).** 종전에는 이 컴포넌트가
  //    ref로 목록을 들고 개수만 부모에 통지했는데, 이 컴포넌트는 `item && <AnalysisChart/>`
  //    로 **조건부 마운트**라 종목 전환 중(그리고 로드 실패 시 영구히) 언마운트되어
  //    통지할 주체가 사라졌다 — 그동안 툴바에는 이전 종목의 개수가 남았다.
  //    이제 목록은 부모 state이고 여기서는 prop으로 받아 ref에 미러링만 한다.
  // 최신 props를 ref에 미러링하는 이유는 srPropsRef와 같다 — 차트 생성 시점 클로저에서
  // 만들어진 구독 콜백이 stale prop을 읽으면 모드 토글이 먹히지 않는다.
  const drawPropsRef = useRef({ drawMode, onDrawModeChange, onShapesChange, symbolKey });
  drawPropsRef.current = { drawMode, onDrawModeChange, onShapesChange, symbolKey };
  const shapesRef       = useRef(shapes ?? []); // prop 미러 — 구독 콜백이 최신 목록을 읽는 통로
  shapesRef.current     = shapes ?? [];
  const pendingPointRef = useRef(null); // 첫 클릭으로 찍힌 시작점(두 번째 클릭 전까지)
  const drawPrimRef     = useRef(null); // 차트에 붙은 DrawingPrimitive(차트 수명과 같이 간다)
  const dragRef         = useRef(null); // 도형 드래그 진행 상태(없으면 null). mode: 'endpoint'|'body'
  // 봉 인덱스 ↔ 시각 표 — 몸통 평행 이동이 **인덱스 공간**에서 델타를 계산하는 데 쓴다.
  // 차트에 넣은 데이터(priceData) 순서 그대로이므로 라이브러리의 logical 인덱스와 같은 축이다.
  const barTimesRef     = useRef([]);   // index → time
  const barIndexRef     = useRef(null); // String(time) → index

  // 도형 hover/선택 — × 삭제 버튼 표시용. sticky는 **터치 탭 선택**이라 자동으로 사라지지 않는다
  // (터치에는 hover가 없어 "벗어남"이라는 사건 자체가 없다 — 다른 곳을 탭해야 풀린다).
  const [shapeHover, setShapeHover] = useState(null); // { id, x, y, sticky }
  const shapeHoverRef        = useRef(null);          // 구독 콜백이 최신 상태를 읽는 통로
  shapeHoverRef.current      = shapeHover;
  const isHoveringShapeDelRef = useRef(false);
  const shapeHoverTimerRef    = useRef(null);

  // MA series refs (visibility 토글용)
  const ma20Ref  = useRef(null);
  const ma60Ref  = useRef(null);
  const ma100Ref = useRef(null);
  const ma200Ref = useRef(null);
  const bbUpperRef = useRef(null);
  const bbBasisRef = useRef(null);
  const bbLowerRef = useRef(null);
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
    forceHideHoverLine();
  }

  function clearAllSRLines() {
    const ms = mainSeriesRef.current;
    if (!ms || srPricesRef.current.length === 0) return;
    for (const line of srLineObjsRef.current.values()) ms.removePriceLine(line);
    srLineObjsRef.current.clear();
    srPricesRef.current = [];
    persistSRLines();
    forceHideHoverLine();
  }

  useImperativeHandle(ref, () => ({ clearAllLines: clearAllSRLines }));

  // ── 그리기 도구 헬퍼 ─────────────────────────────────────────
  // ref만 참조하므로 어느 렌더에서 만들어진 함수든 항상 최신 상태를 반영한다(SR 헬퍼와 동일).

  /**
   * 클릭 지점 → { time, price }.
   *
   * ⚠️ **시간축은 param.time을 1순위로 쓴다.** 라이브러리가 이미 그 x좌표의 봉으로 스냅해
   *    돌려주는 값이라 우리가 다시 계산하면 스냅 규칙이 갈라진다. 데이터 범위 밖(오른쪽
   *    여백 등)에서는 undefined가 되므로(MouseEventParams.time 정의), 그때만 timeScale의
   *    coordinateToTime으로 되묻는다. 둘 다 없으면 **좌표를 만들 수 없으므로 클릭을 버린다**
   *    — 없는 시간을 0이나 마지막 봉으로 메우면 그 순간 데이터가 거짓이 된다.
   * @returns {{time: string|number, price: number}|null}
   */
  function pointFromClick(param) {
    const ms    = mainSeriesRef.current;
    const chart = priceChartRef.current;
    if (!ms || !chart || !param?.point) return null;
    const price = ms.coordinateToPrice(param.point.y);
    if (price === null || price === undefined || !Number.isFinite(price)) return null;
    const time = param.time ?? chart.timeScale().coordinateToTime(param.point.x);
    if (time === null || time === undefined) return null;
    return { time, price: roundPrice(price) };
  }

  /**
   * 그리기 모드에서의 클릭 1회 — 첫 클릭은 시작점, 두 번째 클릭은 끝점.
   * 두 점이 모이면 도형으로 확정하고 저장한 뒤 **모드를 자동으로 끈다.**
   * ⚠️ 모드가 꺼져 있으면 첫 줄에서 즉시 반환한다 — off 상태에서 이 구독은 아무 일도 하지 않는다.
   */
  function handleDrawClick(param) {
    if (!drawPropsRef.current.drawMode) return;
    const pt = pointFromClick(param);
    if (!pt) return;

    if (!pendingPointRef.current) {
      pendingPointRef.current = pt;
      return;
    }
    // type은 지금 'trendline' 하나뿐이고, 여기서 type으로 분기하지 않는다 —
    // 피보나치가 들어와도 이 경로는 그대로이고 달라지는 것은 렌더링 단계다.
    const shape = makeShape(DRAWING_TYPE.TRENDLINE, [pendingPointRef.current, pt]);
    pendingPointRef.current = null;
    if (!shape) return;

    // 저장 → 부모 state 갱신 순서. 부모가 갱신되면 shapes prop이 내려와 오버레이가 다시 그린다.
    const next = [...shapesRef.current, shape];
    saveDrawings(drawPropsRef.current.symbolKey, next);
    // 확정선이 즉시 보이도록 프리미티브에도 바로 넣는다 — prop이 돌아오는 것을 기다리면
    // 한 프레임 비고, 그 사이 미리보기는 이미 지워져 선이 깜빡인 것처럼 보인다.
    drawPrimRef.current?.setShapes(next);
    drawPrimRef.current?.setPreview(null);
    drawPropsRef.current.onShapesChange?.(next);
    drawPropsRef.current.onDrawModeChange?.(false);
  }

  // ── 도형 hover/선택 + 선별 삭제 ──────────────────────────────
  // 깜빡임 방지 규율은 지지/저항선 ×와 동일하다(선→버튼 이동 중 판정이 빠지는 구간 방지).
  function clearShapeHoverTimer() {
    if (shapeHoverTimerRef.current) {
      clearTimeout(shapeHoverTimerRef.current);
      shapeHoverTimerRef.current = null;
    }
  }
  function showShapeHover(next) { clearShapeHoverTimer(); setShapeHover(next); }
  function scheduleShapeHoverHide() {
    if (isHoveringShapeDelRef.current) return;
    if (shapeHoverRef.current?.sticky) return; // 탭 선택은 다른 곳을 탭해야 풀린다
    if (!shapeHoverRef.current) return;
    clearShapeHoverTimer();
    shapeHoverTimerRef.current = setTimeout(() => {
      shapeHoverTimerRef.current = null;
      if (!isHoveringShapeDelRef.current && !shapeHoverRef.current?.sticky) setShapeHover(null);
    }, SR_HOVER_HIDE_DELAY_MS);
  }
  function forceHideShapeHover() {
    clearShapeHoverTimer();
    isHoveringShapeDelRef.current = false;
    setShapeHover(null);
  }

  /** 페인 좌표에 걸리는 도형(없으면 null). 판정은 drawingGeometry가 하고 여기선 좌표만 넘긴다. */
  function hitShapeAt(x, y) {
    const prim = drawPrimRef.current;
    return prim ? hitTest(prim.segments(), x, y) : null;
  }

  function deleteShape(id) {
    const next = shapesRef.current.filter(s => s.id !== id);
    saveDrawings(drawPropsRef.current.symbolKey, next);
    drawPrimRef.current?.setShapes(next);
    drawPropsRef.current.onShapesChange?.(next);
    forceHideShapeHover();
  }

  // ── X 버튼 hover 깜빡임 방지 ─────────────────────────────────
  // ref만 참조하므로 정의 시점에 상관없이 항상 최신 상태로 동작한다.
  function clearHoverHideTimer() {
    if (hoverHideTimerRef.current) {
      clearTimeout(hoverHideTimerRef.current);
      hoverHideTimerRef.current = null;
    }
  }

  function showHoverLine(hit) {
    clearHoverHideTimer();
    setHoverLine(hit);
  }

  // 즉시 숨기지 않고 디바운스 — 버튼에 마우스가 있으면 아예 예약하지 않는다.
  function scheduleHoverLineHide() {
    if (isHoveringDelBtnRef.current) return;
    clearHoverHideTimer();
    hoverHideTimerRef.current = setTimeout(() => {
      hoverHideTimerRef.current = null;
      if (!isHoveringDelBtnRef.current) setHoverLine(null);
    }, SR_HOVER_HIDE_DELAY_MS);
  }

  // 선 삭제/전체 삭제/차트 재생성 등 "무조건 즉시 숨김"이 필요한 경로용 —
  // 버튼이 DOM에서 사라지면 mouseleave가 안 fire될 수 있어 플래그도 함께 리셋한다.
  function forceHideHoverLine() {
    clearHoverHideTimer();
    isHoveringDelBtnRef.current = false;
    setHoverLine(null);
  }

  // ── 가격 차트 + MA 오버레이 ─────────────────────────────────
  useEffect(() => {
    if (!item || !priceRef.current) return;
    const el = priceRef.current;
    const h  = getHistory(item);
    if (!h.length) return;

    const chart = createChart(el, buildChartOpts(theme, el.clientWidth, el.clientHeight));
    priceChartRef.current = chart;
    // 스크롤·줌을 껐다 켜는 유일한 창구. 차트와 수명을 같이 한다(차트가 새로 생기면 잠금도 새로).
    const interactionLock = createInteractionLock(chart);

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
    // 몸통 평행 이동용 인덱스 표 — setData에 넣은 배열과 **같은 순서**여야 logical 인덱스와 맞는다.
    // 키를 String으로 통일하는 이유: time은 'YYYY-MM-DD' 문자열일 수도 UTCTimestamp 숫자일 수도
    // 있고(getTime), Map은 1 !== '1'이라 타입이 갈리면 조회가 조용히 실패한다.
    barTimesRef.current = priceData.map(d => d.time);
    barIndexRef.current = new Map(priceData.map((d, i) => [String(d.time), i]));

    // ── 수동 지지/저항선 복원 (symbol 기준으로 저장 — tf 변경/차트 재생성에 영향 없음) ──
    srLineObjsRef.current.clear();
    const restoredPrices = loadSRLines(symbolKey);
    for (const price of restoredPrices) createSRLineObj(price);
    srPricesRef.current = restoredPrices;
    notifySRCount();

    // ── 더블클릭: 생성 전용 — 기존 선과 너무 가까우면(±6px) 중복 생성만 방지 ──
    chart.subscribeDblClick(param => {
      // 그리기 모드에서는 클릭이 **점 찍기로만** 해석된다. 이 가드가 없으면 두 점을 가깝게
      // 연달아 찍을 때 더블클릭으로도 판정돼 의도치 않은 지지/저항선이 함께 생긴다.
      // (모드가 꺼져 있으면 이 줄은 통과되므로 기존 동작은 그대로다.)
      if (drawPropsRef.current.drawMode) return;
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
      if (!ms || !param.point) { scheduleHoverLineHide(); return; }
      let hit = null;
      for (const p of srPricesRef.current) {
        const coord = ms.priceToCoordinate(p);
        if (coord !== null && Math.abs(coord - param.point.y) <= SR_HOVER_TOLERANCE_PX) {
          hit = { price: p, y: coord };
          break;
        }
      }
      if (hit) showHoverLine(hit);
      else scheduleHoverLineHide();
    }
    chart.subscribeCrosshairMove(updateHoverLine);
    chart.subscribeClick(updateHoverLine);

    // 그리기 모드 클릭 수집 — 모드가 꺼져 있으면 handleDrawClick이 첫 줄에서 반환한다.
    // 별도 구독으로 두는 이유: 기존 SR hover 구독과 관심사를 섞지 않기 위함이고,
    // lightweight-charts는 같은 이벤트에 여러 핸들러를 허용한다.
    chart.subscribeClick(handleDrawClick);

    // ── 그리기 오버레이(Series Primitive) ─────────────────────────────
    // 차트와 수명을 같이 한다 — chart.remove()가 시리즈를 파괴하므로 매 재생성마다 새로
    // 붙이고, 그때 현재 목록으로 즉시 seed한다(shapes prop을 기다리면 한 프레임 빈다).
    const drawPrim = new DrawingPrimitive(drawStyleFor(theme));
    mainSeries.attachPrimitive(drawPrim);
    drawPrim.setShapes(shapesRef.current);
    drawPrimRef.current = drawPrim;

    // 미리보기 — 첫 점이 찍힌 동안만 커서까지 선을 끈다.
    // ⚠️ 커서 끝은 시간으로 되돌리지 않고 화면 좌표 그대로 넘긴다. 봉과 봉 사이에서
    //    timeToCoordinate로 왕복시키면 선 끝이 커서를 따라오지 않고 봉에 붙어 튄다.
    // ⚠️ 모드가 아닐 때는 setPreview(null)이 조기 반환하므로 마우스 이동에 재렌더가 없다.
    chart.subscribeCrosshairMove(param => {
      const prim = drawPrimRef.current;
      if (!prim) return;
      const pending = pendingPointRef.current;
      if (!drawPropsRef.current.drawMode || !pending || !param?.point) { prim.setPreview(null); return; }
      prim.setPreview({ from: pending, to: { x: param.point.x, y: param.point.y } });
    });

    // ── 도형 hover(마우스) — 선 위에 오면 삭제 × 를 커서 옆에 띄운다 ────
    // ⚠️ **끝점 위에서는 ×를 띄우지 않는다.** 끝점은 드래그(이동) 자리이고, 되돌릴 수 없는
    //    조작(삭제)이 그 위에 겹치면 안 된다 — hitTest의 우선순위 규칙과 같은 근거다.
    // ⚠️ 그리기 모드·드래그 중에는 판정 자체를 하지 않는다(그때 클릭·이동의 의미가 다르다).
    chart.subscribeCrosshairMove(param => {
      if (drawPropsRef.current.drawMode || dragRef.current) return;
      if (!param?.point) { scheduleShapeHoverHide(); return; }
      const hit = hitShapeAt(param.point.x, param.point.y);
      if (hit?.kind === 'segment') {
        showShapeHover({ id: hit.id, x: param.point.x, y: param.point.y, sticky: false });
      } else {
        scheduleShapeHoverHide();
      }
    });

    // ── 포인터 입력 ────────────────────────────────────────────────────
    // 페인 좌표계의 원점은 차트 엘리먼트의 좌상단과 같다(가격축은 오른쪽, 시간축은 아래라
    // 첫 번째 셀이 곧 페인이다). 그래서 el의 rect만으로 param.point와 같은 좌표를 얻는다.
    const paneCoordsFrom = e => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    // ⚠️ **preventDefault를 하지 않는다.** 이 리스너는 판정과 상태 변경만 하고 기본 동작
    //    (스크롤·핀치줌)에 손대지 않는다 — 그리기 모드 off의 터치 동작 불변 요구가
    //    이 한 줄에 걸려 있다. 기본 동작을 막는 곳은 끝점 드래그가 시작된 뒤뿐이다.
    const onPointerDown = e => {
      if (drawPropsRef.current.drawMode) return;
      const pt = paneCoordsFrom(e);
      const hit = hitShapeAt(pt.x, pt.y);
      // 끝점이 몸통을 이긴다 — 우선순위는 hitTest가 이미 정한다(drawingGeometry의 ① 규칙).
      if (hit?.kind === 'endpoint') { startEndpointDrag(hit); return; }
      // ── 마우스: 몸통을 잡으면 곧바로 평행 이동 ─────────────────────────
      if (hit?.kind === 'segment' && e.pointerType !== 'touch') { startBodyDrag(hit, pt); return; }
      if (e.pointerType === 'touch') {
        // 터치에는 hover가 없다 — 탭으로 '선택'해야 ×가 뜬다. 빈 곳을 탭하면 해제.
        if (hit?.kind === 'segment') {
          // ── 터치: **선택된 도형의 몸통만** 잡힌다(2단계) ────────────────
          // ⚠️ 첫 터치부터 몸통을 잡으면, 선 위에서 시작한 세로 스와이프가 페이지 스크롤이
          //    아니라 도형 이동이 된다 — 그리기 모드 off의 스크롤 동작 불변 요구가 깨진다.
          //    iOS 네이티브 스크롤은 시작된 뒤에 취소할 수 없으므로(이 프로젝트 실측) 판단을
          //    pointerdown 시점에 끝내야 하고, 그래서 "이미 선택된 도형"이라는 **명시적 의사
          //    표시**를 조건으로 둔다. 선택하지 않은 선 위에서는 종전과 완전히 같이 굴러간다.
          if (shapeHoverRef.current?.sticky && shapeHoverRef.current.id === hit.id) {
            startBodyDrag(hit, pt);
            return;
          }
          showShapeHover({ id: hit.id, x: pt.x, y: pt.y, sticky: true });
        } else if (!hit) forceHideShapeHover();
      }
    };
    el.addEventListener('pointerdown', onPointerDown);

    // ── 끝점 드래그 ────────────────────────────────────────────────────
    // ⚠️ **setPointerCapture를 쓰지 않는다**(이 프로젝트에서 탭 내비게이션을 깨뜨린 전례).
    //    대신 드래그가 시작되면 **window에 pointermove/up/cancel을 건다** — 포인터가 차트
    //    밖으로 나가도 이벤트가 계속 오므로 캡처와 같은 효과를 얻으면서 캡처의 부작용이 없다.
    // ⚠️ 차트가 같이 움직이면 끝점을 맞출 수 없으므로 드래그 동안 스크롤·줌을 끈다.
    //    끄고 켜는 일은 **chartInteractionLock 한 곳**에서만 한다 — options()가 내부 객체를
    //    참조로 돌려주고 applyOptions가 그것을 제자리 변조하기 때문에, 복원하려면 반드시
    //    깊은 복사본이어야 한다(그 실측 근거와 재진입 규약이 그 파일에 있다).
    // ⚠️ iOS 네이티브 스크롤은 pointermove preventDefault로 막히지 않는다(이 프로젝트 실측).
    //    그래서 드래그 동안만 **non-passive touchmove**를 걸어 preventDefault한다.
    const blockTouchScroll = ev => { if (dragRef.current) ev.preventDefault(); };

    // 잠금·리스너·터치 차단은 **두 드래그가 공유한다.** 갈라 두면 한쪽만 고치는 실수가 나고,
    // 그 실수의 증상이 정확히 "스크롤이 영구히 죽는 것"이다(c4c2324 회귀).
    function beginDrag(state) {
      // 이미 드래그 중이면 새로 시작하지 않는다 — 두 번째 손가락이 다른 끝점에 닿는 경우가
      // 있고, 그때 드래그 상태가 갈아치워지면 첫 손가락의 종료가 엉뚱한 도형을 저장한다.
      if (dragRef.current) return;
      dragRef.current = state;
      forceHideShapeHover();
      interactionLock.lock();
      el.style.touchAction = 'none';
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragEnd);
      window.addEventListener('pointercancel', onDragEnd);
      window.addEventListener('touchmove', blockTouchScroll, { passive: false });
    }

    function startEndpointDrag(hit) {
      const shape = shapesRef.current.find(s => s.id === hit.id);
      if (!shape) return;
      beginDrag({
        mode: 'endpoint',
        id: hit.id,
        index: hit.index,
        points: shape.points.map(p => ({ ...p })),
      });
    }

    /**
     * 몸통 평행 이동 시작 — 기울기·길이를 유지한 채 두 점을 같이 옮긴다.
     *
     * ⚠️ 델타는 화면 px가 아니라 **봉 인덱스**로 잰다. px를 두 점에 각각 적용하면 두 점이
     *    서로 다른 봉으로 스냅돼 기울기가 변한다(시간축이 이산이라서 — movePointsParallel 주석).
     * ⚠️ 점의 시각이 현재 데이터에 없으면 인덱스 공간이 성립하지 않으므로 **시작하지 않는다.**
     *    (그런 도형은 buildSegments가 그리지 않아 hitTest에 잡히지도 않지만, 좌표계 가정이
     *     깨진 상태에서 이동을 시작하는 경로를 코드에 남기지 않는다.)
     */
    function startBodyDrag(hit, pt) {
      const shape = shapesRef.current.find(s => s.id === hit.id);
      if (!shape || !Array.isArray(shape.points) || shape.points.length < 2) return;
      const idxMap = barIndexRef.current;
      const indices = shape.points.map(p => idxMap?.get(String(p?.time)));
      if (indices.some(i => !Number.isFinite(i))) return;
      const startLogical = chart.timeScale().coordinateToLogical(pt.x);
      const startPrice   = mainSeriesRef.current?.coordinateToPrice(pt.y);
      if (!Number.isFinite(startLogical) || !Number.isFinite(startPrice)) return;
      const points = shape.points.map(p => ({ ...p }));
      beginDrag({ mode: 'body', id: hit.id, points, origPoints: points, indices, startLogical, startPrice });
    }

    function onDragMove(ev) {
      const d = dragRef.current;
      const ms = mainSeriesRef.current;
      if (!d || !ms) return;
      const pt = paneCoordsFrom(ev);
      if (d.mode === 'body') { onBodyDragMove(d, pt, ms); return; }
      const price = ms.coordinateToPrice(pt.y);
      const time  = chart.timeScale().coordinateToTime(pt.x);
      // ⚠️ 데이터 범위 밖(마지막 봉 오른쪽 여백 등)에서는 time이 null이다 — 그때는 **직전
      //    시간을 유지**한다. 없는 시각을 지어내면 저장할 수 없는 좌표가 되고, 그건 이번
      //    단계에서 보류한 "데이터 범위 밖 점 찍기"와 같은 문제다.
      d.points = d.points.map((p, i) => (i !== d.index ? p : {
        time:  time ?? p.time,
        price: Number.isFinite(price) ? roundPrice(price) : p.price,
      }));
      // 드래그 중에는 프리미티브에만 반영한다 — 저장과 부모 state 갱신은 놓을 때 한 번.
      drawPrimRef.current?.setShapes(
        shapesRef.current.map(s => (s.id === d.id ? { ...s, points: d.points } : s)),
      );
    }

    /**
     * 몸통 이동 1프레임. **원본(origPoints)에서 매번 새로 계산한다** — 직전 결과에 델타를
     * 누적하면 봉 스냅 오차가 프레임마다 쌓여 선이 서서히 어긋난다.
     */
    function onBodyDragMove(d, pt, ms) {
      const logical = chart.timeScale().coordinateToLogical(pt.x);
      const price   = ms.coordinateToPrice(pt.y);
      // 좌표를 못 얻은 프레임은 **건너뛴다**(직전 상태 유지) — 0으로 메우면 선이 튄다.
      if (!Number.isFinite(logical) || !Number.isFinite(price)) return;
      const moved = movePointsParallel({
        points:      d.origPoints,
        indices:     d.indices,
        times:       barTimesRef.current,
        rawBarDelta: Math.round(logical - d.startLogical),
        priceDelta:  price - d.startPrice,
      });
      // 가격 반올림은 끝점 드래그와 **같은 규칙**을 쓴다(roundPrice).
      d.points = moved.map(p => ({ ...p, price: Number.isFinite(p.price) ? roundPrice(p.price) : p.price }));
      // 드래그 중에는 프리미티브에만 반영한다 — 저장과 부모 state 갱신은 놓을 때 한 번.
      drawPrimRef.current?.setShapes(
        shapesRef.current.map(s => (s.id === d.id ? { ...s, points: d.points } : s)),
      );
    }

    function stopDragListeners() {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
      window.removeEventListener('pointercancel', onDragEnd);
      window.removeEventListener('touchmove', blockTouchScroll);
    }

    function onDragEnd() {
      const d = dragRef.current;
      dragRef.current = null;
      stopDragListeners();
      el.style.touchAction = '';
      // ⚠️ 잠금 해제는 **저장보다 먼저**, 그리고 d 유무와 무관하게 한다 — 뒤에서 무엇이
      //    실패하든 차트 조작은 반드시 살아 있어야 한다(이번 회귀의 증상이 정확히 그것이다).
      interactionLock.unlock();
      if (!d) return;
      const next = shapesRef.current.map(s => (s.id === d.id ? { ...s, points: d.points } : s));
      saveDrawings(drawPropsRef.current.symbolKey, next);
      drawPrimRef.current?.setShapes(next);
      drawPropsRef.current.onShapesChange?.(next);
    }

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

    // ── 가격축(Y) 모바일 터치 드래그로 스케일 조정 ──────────────────────
    // lightweight-charts 4.2.3는 handleScroll.vertTouchDrag를 메인 캔들 영역과 가격축
    // 위젯이 내부적으로 공유한다 — 메인 영역의 세로 스와이프를 페이지 스크롤로 남겨두려고
    // vertTouchDrag:false로 두면(위 buildChartOpts), 라이브러리가 가격축 위의 세로 터치
    // 드래그도 "페이지 스크롤 의도"로 판정해 무시해버려 축 자체 드래그로는 스케일 조정이
    // 안 된다(축만 별도로 켜는 공개 옵션이 없는 라이브러리 제약). 그래서 가격축 DOM 영역만
    // touch-action:none으로 분리하고, scaleMargins를 직접 조작하는 자체 드래그 핸들러로
    // 대체한다(scaleMargins는 series가 아닌 priceScale 단위라 MA선 등과 자동으로 맞물림).
    const priceAxisTd = el.querySelector('table tr:first-child td:last-child');
    if (priceAxisTd) {
      priceAxisTd.style.touchAction = 'none';
      const priceScale = mainSeries.priceScale();
      let axisDragStartY = null;
      let axisDragStartMargins = null;

      const onAxisTouchStart = e => {
        if (e.touches.length !== 1) return;
        axisDragStartY = e.touches[0].clientY;
        axisDragStartMargins = { ...priceScale.options().scaleMargins };
        e.preventDefault();
      };
      const onAxisTouchMove = e => {
        if (axisDragStartY === null || e.touches.length !== 1) return;
        const delta  = (e.touches[0].clientY - axisDragStartY) / 600;
        const top    = Math.min(0.45, Math.max(0.02, axisDragStartMargins.top + delta));
        const bottom = Math.min(0.45, Math.max(0.02, axisDragStartMargins.bottom + delta));
        priceScale.applyOptions({ scaleMargins: { top, bottom } });
        e.preventDefault();
      };
      const onAxisTouchEnd = () => { axisDragStartY = null; };

      priceAxisTd.addEventListener('touchstart', onAxisTouchStart, { passive: false });
      priceAxisTd.addEventListener('touchmove',  onAxisTouchMove,  { passive: false });
      priceAxisTd.addEventListener('touchend',    onAxisTouchEnd,   { passive: true });
      priceAxisTd.addEventListener('touchcancel', onAxisTouchEnd,   { passive: true });
    }

    // 시간축(하단)은 handleScroll.horzTouchDrag(기본 true)로 가로 드래그가 이미 동작하지만,
    // touch-action: pan-y가 이 영역까지 덮고 있어 제스처 판정이 흔들릴 수 있으므로
    // 가격축과 동일하게 별도 분리해둔다(추가 핸들러 없이 touch-action만).
    const timeAxisRow = el.querySelector('table tr:last-child');
    if (timeAxisRow) timeAxisRow.style.touchAction = 'none';

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

    // ── 볼린저밴드(20, 2) — 상/하단 동일 색 얇은 선, 중심선은 점선+반투명으로 구분 ──
    // lightweight-charts 4.2.3는 두 라인 사이를 채우는 band-fill 프리미티브가 없고(v5의
    // ISeriesPrimitive/Band 시리즈 부재), 흔히 쓰는 "Area 시리즈 2개로 흉내내기" 트릭도
    // 이 차트의 배경이 theme별로 투명(transparent)이라 구멍 낸 영역이 캔들/그리드를 가려
    // 오히려 깨져 보인다 — 그래서 라인 3개만 그린다.
    const bb = calcBB(h, 20, 2);
    const bbUpper = chart.addLineSeries({
      color: BB_C, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false, visible: showBB, title: 'BB상단',
    });
    bbUpper.setData(bb.upper);
    bbUpperRef.current = bbUpper;

    const bbBasis = chart.addLineSeries({
      color: BB_C + '99', lineWidth: 1, lineStyle: LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, visible: showBB, title: 'BB중심',
    });
    bbBasis.setData(bb.basis);
    bbBasisRef.current = bbBasis;

    const bbLower = chart.addLineSeries({
      color: BB_C, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false, visible: showBB, title: 'BB하단',
    });
    bbLower.setData(bb.lower);
    bbLowerRef.current = bbLower;

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
      el.removeEventListener('pointerdown', onPointerDown);
      // 드래그 중에 차트가 사라질 수 있다(종목 전환 등) — window 리스너를 반드시 걷고,
      // 잠금도 chart.remove() **전에** 푼다. 이 차트는 곧 버려지지만, "잠갔으면 반드시
      // 푼다"는 규약을 경로마다 다르게 두면 어느 경로가 새는지 추적할 수 없게 된다.
      stopDragListeners();
      dragRef.current = null;
      el.style.touchAction = '';
      interactionLock.unlock();
      chart.remove();
      priceChartRef.current = null;
      mainSeriesRef.current = null;
      ma20Ref.current  = null;
      ma60Ref.current  = null;
      ma100Ref.current = null;
      ma200Ref.current = null;
      bbUpperRef.current = null;
      bbBasisRef.current = null;
      bbLowerRef.current = null;
      volumeRef.current = null;
      srLineObjs.clear(); // chart.remove()로 이미 소멸된 IPriceLine 참조 정리
      forceHideHoverLine();
      // 차트가 사라지면 진행 중이던 첫 점은 좌표계를 잃는다 — 다음 차트로 넘기지 않는다.
      pendingPointRef.current = null;
      // detachPrimitive는 부르지 않는다 — chart.remove()가 시리즈째 파괴한 뒤라 대상이 없다.
      drawPrimRef.current = null;
      forceHideShapeHover();
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
  // useEffect가 아니라 useLayoutEffect — ThemeContext.jsx의 toggle()이 View
  // Transition 콜백을 flushSync로 감싸는데, flushSync는 레이아웃 이펙트만 동기
  // 실행을 보장하고 패시브 이펙트(useEffect)는 보장하지 않는다. 이 캔버스 색상
  // 재적용이 layout effect가 아니면 뷰 트랜지션이 "전/후" 스크린샷을 찍는 시점에
  // 아직 구 테마 색상이 남아있어 크로스페이드 이후 차트만 뒤늦게 툭 바뀌어 보일 수 있다.
  useLayoutEffect(() => {
    const opts = chartColorOpts(theme);
    priceChartRef.current?.applyOptions(opts);
    rsiChartRef.current?.applyOptions(opts);
    const c = CHART_COLORS[theme] ?? CHART_COLORS.dark;
    for (const line of srLineObjsRef.current.values()) line.applyOptions({ color: c.srLine });
    drawPrimRef.current?.setStyle(drawStyleFor(theme));
  }, [theme]);

  // ── 도형 목록이 바뀌면 오버레이에 반영 ───────────────────────────────
  // 부모 state → prop → 여기. 추가(확정)·전체 삭제·심볼 전환이 전부 이 한 경로로 들어온다.
  useEffect(() => { drawPrimRef.current?.setShapes(shapes ?? []); }, [shapes]);

  // 심볼이 바뀌면 진행 중이던 첫 점은 의미를 잃는다(도형 목록 교체는 부모가 한다).
  useEffect(() => {
    pendingPointRef.current = null;
    drawPrimRef.current?.setPreview(null);
    forceHideShapeHover();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- forceHideShapeHover는 ref/setState만 만진다
  }, [symbolKey]);

  // ── ESC 취소 ────────────────────────────────────────────────
  // 첫 점만 찍힌 상태에서만 동작한다(요구사항). 리스너는 **그리기 모드일 때만** 붙고,
  // 모드가 꺼지면 즉시 제거된다 — off 상태에서는 키 입력에 아무 영향이 없다.
  useEffect(() => {
    if (!drawMode) {
      // 모드가 꺼지면 진행 중인 점과 미리보기를 함께 버린다(토글 off·확정 직후 모두 여기로).
      pendingPointRef.current = null;
      drawPrimRef.current?.setPreview(null);
      return undefined;
    }
    const onKeyDown = e => {
      if (e.key !== 'Escape' || !pendingPointRef.current) return;
      pendingPointRef.current = null;
      drawPrimRef.current?.setPreview(null);
      // 취소는 모드 종료까지 포함한다 — 모바일에는 ESC가 없어 토글 버튼이 유일한 탈출구이고,
      // 두 경로의 결과가 다르면 "지금 모드가 켜져 있나"를 화면만 보고 알 수 없게 된다.
      drawPropsRef.current.onDrawModeChange?.(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawMode]);

  // ── MA·거래량 토글 (차트 재생성 없이 visibility만 변경) ──────
  useEffect(() => { ma20Ref.current?.applyOptions({ visible: showMA20 });   }, [showMA20]);
  useEffect(() => { ma60Ref.current?.applyOptions({ visible: showMA60 });   }, [showMA60]);
  useEffect(() => { ma100Ref.current?.applyOptions({ visible: showMA100 }); }, [showMA100]);
  useEffect(() => { ma200Ref.current?.applyOptions({ visible: showMA200 }); }, [showMA200]);
  useEffect(() => {
    bbUpperRef.current?.applyOptions({ visible: showBB });
    bbBasisRef.current?.applyOptions({ visible: showBB });
    bbLowerRef.current?.applyOptions({ visible: showBB });
  }, [showBB]);
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
            onMouseEnter={() => { isHoveringDelBtnRef.current = true; clearHoverHideTimer(); }}
            onMouseLeave={() => { isHoveringDelBtnRef.current = false; scheduleHoverLineHide(); }}
            aria-label={`지지/저항선 ${fp(hoverLine.price)} 삭제`}
          >
            <span className="sr-line-del-btn-dot">×</span>
          </button>
        )}
        {/* 도형 삭제 × — 커서(또는 탭한 지점) 바로 옆. 상시 오버레이가 아니라 hover/선택
            중에만 존재하는 32px 버튼이라, 그리기 모드 off·비hover 상태에서는 DOM 노드가 0개다. */}
        {shapeHover && (
          <button
            type="button"
            className="shape-del-btn"
            style={{ left: shapeHover.x + 16, top: shapeHover.y }}
            onClick={e => { e.stopPropagation(); deleteShape(shapeHover.id); }}
            onPointerDown={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            onTouchStart={e => e.stopPropagation()}
            onMouseEnter={() => { isHoveringShapeDelRef.current = true; clearShapeHoverTimer(); }}
            onMouseLeave={() => { isHoveringShapeDelRef.current = false; scheduleShapeHoverHide(); }}
            aria-label="추세선 삭제"
          >
            <span className="sr-line-del-btn-dot">×</span>
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
