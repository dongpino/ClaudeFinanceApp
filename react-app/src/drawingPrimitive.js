/**
 * drawingPrimitive.js — 저장된 도형을 차트에 그리는 Series Primitive
 *
 * lightweight-charts에는 대각선 API가 없다(createPriceLine은 수평선 전용). 4.2.3는
 * **Series Primitives**를 지원하므로(ISeriesApi.attachPrimitive / ISeriesPrimitivePaneView /
 * ISeriesPrimitivePaneRenderer.draw(CanvasRenderingTarget2D)) 라이브러리 자신의 캔버스에
 * 직접 그린다 — 별도 canvas/SVG 오버레이를 얹지 않는다.
 *
 * ⚠️ **DOM에 아무것도 추가하지 않는 것이 이 선택의 핵심 이유다.** 차트 위에 엘리먼트를
 *    얹으면 iOS에서 스크롤·제스처를 삼키는 문제를 다시 만나게 되는데(이 프로젝트가 이미
 *    겪음: pointer-events 누락, pointermove preventDefault로는 네이티브 스크롤 차단 불가,
 *    setPointerCapture는 탭 내비게이션 파손), 프리미티브는 캔버스 픽셀만 건드리므로
 *    터치 대상 자체가 늘지 않는다. 그리기 모드 on/off와 무관하게 히트 영역이 불변이다.
 *
 * ⚠️ hitTest는 구현하지 않는다. 구현하면 라이브러리가 커서 이동마다 호출하고 hover 상태를
 *    관리하기 시작한다 — 이번 단계에 필요 없는 상호작용이고, 선 클릭 선택은 다음 단계 몫이다.
 *
 * ── 재계산 트리거 ────────────────────────────────────────────────────
 * 스크롤·줌·리사이즈·데이터 변경은 라이브러리가 페인을 다시 그리면서 renderer.draw를
 * 부르는 것으로 끝난다 — 우리가 subscribeVisibleLogicalRangeChange 같은 구독을 걸지 않는다.
 * 좌표를 캐시하지 않고 draw 시점에 timeToCoordinate/priceToCoordinate로 즉석 계산하므로
 * updateAllViews()도 할 일이 없다(그래서 빈 구현이다).
 * 우리가 requestUpdate를 직접 부르는 경우는 **입력이 바뀔 때뿐**이다(도형 목록/미리보기/색).
 */

import { extendSegmentRight } from './drawingGeometry.js';

/** 도형 종류로 분기하지 않는다 — 지금은 모든 도형이 2점 선분이다('fib'이 들어오면 그때 분기). */
const DEFAULT_STYLE = {
  color:        '#a3e635',
  previewColor: '#a3e635aa',
  lineWidth:    1.5,
  endpointRadius: 3,
};

const isNum = v => Number.isFinite(v);

/**
 * 도형 목록 + 미리보기 → 화면 좌표 선분 목록. **순수 함수**(테스트 대상).
 *
 * @param {Array<object>} shapes  저장된 도형들
 * @param {{from: {time, price}, to: {x: number, y: number}}|null} preview
 *        미리보기. from은 확정된 첫 점(시간·가격), to는 **커서 좌표**다 — 커서는 아직
 *        어느 봉에도 속하지 않으므로 시간으로 되돌리지 않고 화면 좌표 그대로 쓴다.
 * @param {(time: string|number) => number|null} toX  timeScale.timeToCoordinate
 * @param {(price: number) => number|null} toY        series.priceToCoordinate
 * @returns {Array<{id: string, kind: 'shape'|'preview', x1, y1, x2, y2}>}
 *
 * ⚠️ **좌표를 얻지 못한 도형은 조용히 건너뛴다.** timeToCoordinate는 그 시각이 현재 데이터
 *    범위에 없으면 null을 준다(타임프레임을 바꿔 과거 구간이 빠졌을 때 등). 그때 0이나
 *    마지막 봉으로 메우면 엉뚱한 자리에 선이 생기므로, 그리지 않는 쪽이 정직하다.
 * ⚠️ 반대로 **화면 밖이라고 버리지는 않는다.** 데이터에 있는 시각이면 뷰포트 밖이어도
 *    좌표(음수·폭 초과)가 나오고, 캔버스가 알아서 잘라 준다 — 그래서 화면에 걸치는
 *    구간만 자연스럽게 그려진다. 우리가 클리핑을 계산하지 않는 이유다.
 */
export function buildSegments(shapes, preview, toX, toY) {
  const segs = [];
  for (const s of shapes ?? []) {
    const pts = s?.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    const x1 = toX(pts[0]?.time), y1 = toY(pts[0]?.price);
    const x2 = toX(pts[1]?.time), y2 = toY(pts[1]?.price);
    if (!isNum(x1) || !isNum(y1) || !isNum(x2) || !isNum(y2)) continue;
    // extend — 오른쪽(미래) 연장 여부. **기본 켜짐**이고, 도형에 extendRight:false가 있으면
    // 끈다. 지금 그 필드를 쓰는 UI는 없다(도형별 토글은 다음 단계) — 렌더러가 미리 읽게 두어
    // 나중에 필드 하나만 추가하면 되도록 자리를 남긴다. 저장 구조는 건드리지 않았다.
    segs.push({ id: s.id, kind: 'shape', x1, y1, x2, y2, extend: s.extendRight !== false });
  }
  if (preview?.from && preview?.to) {
    const x1 = toX(preview.from.time), y1 = toY(preview.from.price);
    const x2 = preview.to.x, y2 = preview.to.y;
    if (isNum(x1) && isNum(y1) && isNum(x2) && isNum(y2)) {
      segs.push({ id: '__preview__', kind: 'preview', x1, y1, x2, y2 });
    }
  }
  return segs;
}

class DrawingPaneRenderer {
  constructor(source) { this._source = source; }

  draw(target) {
    const segs = this._source.segments();
    if (segs.length === 0) return;
    const style = this._source.style();
    // 미디어 좌표계 = timeToCoordinate/priceToCoordinate가 돌려주는 것과 같은 CSS 픽셀 공간.
    // 비트맵 좌표계로 그리면 DPR 배율을 우리가 직접 곱해야 하고, 그건 좌표 원본과 어긋날
    // 여지를 만든다.
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = style.lineWidth;
      for (const s of segs) {
        const preview = s.kind === 'preview';
        ctx.beginPath();
        ctx.setLineDash(preview ? [5, 4] : []);
        ctx.strokeStyle = preview ? style.previewColor : style.color;
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        // ── 오른쪽(미래) 연장 ────────────────────────────────────────
        // 페인 폭은 여기서만 알 수 있으므로(mediaSize) 연장 계산도 그릴 때 한다.
        // 확정 도형만 늘린다 — 미리보기는 아직 두 번째 점이 정해지지 않아 직선이 확정되지 않았다.
        if (!preview && s.extend) {
          const ext = extendSegmentRight(s, mediaSize.width);
          if (ext) {
            ctx.beginPath();
            ctx.moveTo(ext.x1, ext.y1);
            ctx.lineTo(ext.x2, ext.y2);
            ctx.stroke();
          }
        }
        // 확정된 도형만 끝점을 점으로 표시한다 — 어느 두 점을 찍었는지 눈으로 확인하는
        // 수단이고(이번 단계의 검증 수단), 미리보기의 커서 끝에는 붙이지 않는다.
        if (!preview) {
          ctx.setLineDash([]);
          ctx.fillStyle = style.color;
          for (const [cx, cy] of [[s.x1, s.y1], [s.x2, s.y2]]) {
            ctx.beginPath();
            ctx.arc(cx, cy, style.endpointRadius, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    });
  }
}

class DrawingPaneView {
  constructor(source) { this._renderer = new DrawingPaneRenderer(source); }
  // 'top' — 캔들 위에 그린다. 'normal'이면 시리즈와 같은 층이라 캔들에 가려질 수 있다.
  zOrder() { return 'top'; }
  renderer() { return this._renderer; }
}

/**
 * 시리즈에 붙여 쓰는 그리기 프리미티브.
 *   const p = new DrawingPrimitive({ color });
 *   series.attachPrimitive(p);
 *   p.setShapes(shapes);           // 목록이 바뀔 때
 *   p.setPreview({ from, to });    // 그리는 중
 */
export class DrawingPrimitive {
  constructor(style = {}) {
    this._style   = { ...DEFAULT_STYLE, ...style };
    this._shapes  = [];
    this._preview = null;
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    // paneViews는 **같은 배열 참조를 유지**해야 한다(라이브러리가 참조로 캐시한다).
    this._paneViews = [new DrawingPaneView(this)];
  }

  attached({ chart, series, requestUpdate }) {
    this._chart = chart;
    this._series = series;
    this._requestUpdate = requestUpdate;
  }

  detached() {
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  // 좌표 캐시가 없으므로 뷰포트 변경 시 무효화할 것이 없다(draw가 매번 즉석 계산).
  updateAllViews() {}

  paneViews() { return this._paneViews; }

  style() { return this._style; }

  setStyle(style) {
    this._style = { ...this._style, ...style };
    this._requestUpdate?.();
  }

  setShapes(shapes) {
    this._shapes = Array.isArray(shapes) ? shapes : [];
    this._requestUpdate?.();
  }

  /**
   * @param {{from: {time, price}, to: {x, y}}|null} preview
   * ⚠️ null → null은 **조기 반환**한다. 이 함수는 크로스헤어 이동마다 불리므로, 그리기
   *    모드가 아닐 때도 매번 requestUpdate를 부르면 마우스만 움직여도 차트가 다시 그려진다.
   */
  setPreview(preview) {
    if (!preview && !this._preview) return;
    this._preview = preview ?? null;
    this._requestUpdate?.();
  }

  /** 현재 좌표계 기준 선분 목록. 차트에서 분리된 뒤에는 빈 배열. */
  segments() {
    if (!this._chart || !this._series) return [];
    const ts = this._chart.timeScale();
    return buildSegments(
      this._shapes,
      this._preview,
      t => ts.timeToCoordinate(t),
      p => this._series.priceToCoordinate(p),
    );
  }
}
