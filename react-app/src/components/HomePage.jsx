import { useState, useEffect, useRef } from 'react';
import Header from './Header';
import CategoryTabs from './CategoryTabs';
import MajorEditPanel from './MajorEditPanel';
import MarketCard, { detectIssues } from './MarketCard';
import BottomNav from './BottomNav';
import { useData } from '../DataContext';
import { itemsInCategory, DEFAULT_CATEGORY, ITEM_CATEGORIES, CATEGORY_TABS } from '../itemCategories';
import { loadMajorIds, saveMajorIds } from '../homeMajorStore';

// 경고 배지 시스템이 검사할 전체 종목 — itemCategories.js가 단일 정의 소스이므로
// 여기서 별도로 유지하지 않고 그대로 파생시킨다(새 종목 추가 시 이 목록도 자동 반영).
const EXPECTED_IDS = ITEM_CATEGORIES.map(c => c.id);

// 브리핑 탭 "주요 이슈"와 동일한 카테고리 아이콘 — 홈 스트립은 importance 2 이상만 노출.
const ISSUE_ICON = { regulation: '⚖️', exchange: '🏦', listing: '🆕', earnings: '📈', macro_shock: '💥', other_major: '🔔' };

// 홈 카테고리 슬라이드 트랙 — 드래그 제스처 튜닝 상수
// iOS Safari는 세로 스크롤을 매우 공격적으로 먼저 클레임한다(pointercancel로 우리
// 제스처를 가로챔) — 판정 거리를 줄이고(DRAG_LOCK_SLOP) 가로 판정 콘을 넓혀서
// (DRAG_ANGLE_BIAS) 세로 스크롤에 뺏기기 전에 더 빨리·더 관대하게 가로로 락을 건다.
const DRAG_LOCK_SLOP       = 6;    // 방향 잠금 판정 임계값(px) — 기존 10px보다 앞당김
const DRAG_ANGLE_BIAS      = 0.7;  // 가로 판정: |dx| > |dy| * BIAS (45°→약 55° 콘으로 확대)
const DRAG_COMMIT_RATIO    = 0.3;  // 패널폭의 이 비율 이상 이동하면 카테고리 전환
const DRAG_FLICK_VELOCITY  = 0.3;  // 이보다 빠른 스와이프는 이동량이 짧아도 전환(flick, px/ms)
const RUBBER_BAND_RATIO    = 0.3;  // 첫/마지막 패널을 넘어가려 할 때 저항(끌림 대비 실제 이동 비율)
const EDGE_GUARD_PX        = 24;   // 화면 좌우 이 폭 안에서 시작하면 iOS 엣지 뒤로가기 제스처에 양보

// 드래그 커밋/복귀 안착 애니메이션 — CSS transition이 아니라 rAF로 매 프레임 transform을
// 직접 계산해서 구동한다(감쇠 스프링). 손을 뗀 시점의 속도를 초기 속도로 그대로 이어받아
// CSS transition으로는 안 나오는 "관성이 자연스럽게 이어지는" 느낌을 낸다.
const SPRING_STIFFNESS    = 340;   // 강성 — 클수록 목표 지점으로 빠르고 팽팽하게 당겨짐
const SPRING_DAMPING      = 34;    // 감쇠 — 임계감쇠(2*sqrt(340)≈36.9)보다 살짝 낮춰 아주 미세한 오버슈트 허용
const SPRING_REST_DIST    = 0.5;   // px — 목표와의 위치 오차가 이 밑으로 내려가야 정지 후보
const SPRING_REST_VEL     = 0.01;  // px/ms — 속도도 이 밑이어야(AND) 완전히 멈춘 것으로 판정
const VELOCITY_WINDOW_MS  = 100;   // 손을 뗄 때 속도 계산에 쓰는 최근 pointermove 샘플 윈도우

// 홈 스와이프 실기기 진단용 HUD — ?debugSwipe=1일 때만 렌더되는 임시 계측 오버레이.
// 드래그 동작에는 전혀 개입하지 않고 HomePage.jsx가 기록해둔 값을 읽기만 한다.
// 원인 확정 후 제거 예정(chore 커밋 참고).
function SwipeDebugHUD({ history }) {
  return (
    <div className="swipe-debug-hud">
      <div className="swipe-debug-title">swipe debug ({history.length}/3)</div>
      {history.length === 0 && <div className="swipe-debug-empty">제스처 대기 중…</div>}
      {history.map((g, i) => (
        <div key={g.id} className="swipe-debug-entry">
          <div className="swipe-debug-entry-head">
            #{history.length - i}
            {g.cancelled && <span className="swipe-debug-cancel">CANCEL</span>}
            <span className={`swipe-debug-outcome ${g.outcome}`}>{g.outcome}</span>
          </div>
          <div>락: {g.lockTimeMs.toFixed(1)}ms / {g.lockDistPx.toFixed(1)}px</div>
          <div>move: {g.moveCount} / {g.dragDurationMs.toFixed(0)}ms = {g.movesPerSec.toFixed(1)}/s</div>
          <div>frame: {g.transformCount} / {g.dragDurationMs.toFixed(0)}ms = {g.framesPerSec.toFixed(1)}/s</div>
          <div>maxGap: {g.maxFrameGapMs.toFixed(1)}ms</div>
          <div>velocity: {g.velocity != null ? g.velocity.toFixed(3) : '-'}px/ms</div>
        </div>
      ))}
    </div>
  );
}

// 홈 상단 돌발 이슈 스트립 — 실패/로딩/이슈 없음이면 조용히 숨긴다(홈 본 기능과 완전 분리).
function IssueStrip({ issues, onClick }) {
  const majorIssues = issues.filter(it => it.importance >= 2);
  if (majorIssues.length === 0) return null;

  return (
    <div className="home-issue-strip" onClick={onClick} role="button" tabIndex={0}>
      {majorIssues.map((it, i) => (
        <span key={i} className="home-issue-chip">
          {ISSUE_ICON[it.category] ?? '🔔'} {it.title_ko}
        </span>
      ))}
    </div>
  );
}

export default function HomePage({ activePage, onPageChange }) {
  const { items, updatedAt, loadError, source } = useData();
  const [activeCat, setActiveCat] = useState(DEFAULT_CATEGORY);

  // "주요" 탭 사용자 선택(최대 4개) — 없으면 loadMajorIds()가 기본값으로 폴백.
  const [majorIds, setMajorIds]         = useState(loadMajorIds);
  const [editingMajor, setEditingMajor] = useState(false);

  // 돌발 이슈 스트립 — 실패해도 조용히 숨길 뿐 홈 본 기능에는 영향 없음.
  const [issues, setIssues] = useState([]);
  useEffect(() => {
    fetch('/api/issues')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => setIssues(Array.isArray(data.issues) ? data.issues : []))
      .catch(() => setIssues([]));
  }, []);

  function handleSaveMajor(ids) {
    setMajorIds(ids);
    saveMajorIds(ids);
    setEditingMajor(false);
  }

  // 가로 슬라이드 트랙 위치 계산용 — CATEGORY_TABS 순서가 곧 패널 순서.
  const activeIndex = Math.max(0, CATEGORY_TABS.findIndex(t => t.key === activeCat));

  // ── 스와이프 실기기 진단 HUD(계측 전용, ?debugSwipe=1) ──────────────
  // debugSwipeEnabled가 false면 아래 mark*/finish 함수들은 모두 debugGestureRef가
  // null이라 즉시 no-op으로 빠진다 — 평소 드래그 경로에 실질적 비용이 없다.
  const [debugSwipeEnabled] = useState(() => new URLSearchParams(window.location.search).get('debugSwipe') === '1');
  const [swipeDebugHistory, setSwipeDebugHistory] = useState([]);
  const debugGestureRef = useRef(null);

  function startDebugGesture(now) {
    if (!debugSwipeEnabled) return;
    debugGestureRef.current = {
      startT: now,
      lockT: null,       // 방향 락이 확정된 시각(요구사항1)
      lockDistPx: null,  // 락 확정 시점까지의 이동량(요구사항1)
      moveCount: 0,       // 락 이후 pointermove 수신 횟수(요구사항2)
      transformCount: 0,  // 락 이후 applyTrackTransform 실행 횟수(요구사항3)
      maxFrameGapMs: 0,   // 락 이후 rAF 프레임 간격 최대값(요구사항4)
      lastFrameT: null,
      cancelled: false,   // pointercancel 발생 여부(요구사항5)
    };
  }

  function markDebugLock(dx, dy, now) {
    const g = debugGestureRef.current;
    if (!g) return;
    g.lockT = now;
    g.lockDistPx = Math.hypot(dx, dy);
    g.lastFrameT = now;
  }

  function markDebugMove() {
    const g = debugGestureRef.current;
    if (!g || g.lockT == null) return;
    g.moveCount++;
  }

  function markDebugFrame(now) {
    const g = debugGestureRef.current;
    if (!g || g.lockT == null) return;
    g.transformCount++;
    if (g.lastFrameT != null) {
      const gap = now - g.lastFrameT;
      if (gap > g.maxFrameGapMs) g.maxFrameGapMs = gap;
    }
    g.lastFrameT = now;
  }

  function markDebugCancelled() {
    const g = debugGestureRef.current;
    if (g) g.cancelled = true;
  }

  // 제스처 종료(pointerup 또는 pointercancel) 시 1회 호출 — 락이 걸린 적 없는 제스처
  // (순수 탭, 세로로 양보된 제스처)는 요구사항 1~6이 애초에 정의되지 않으므로 히스토리에
  // 남기지 않고 조용히 버린다. 최근 3개만 유지(요구사항: "이전 값이 남아있게 최근 3회").
  function finishDebugGesture(outcome, velocity) {
    const g = debugGestureRef.current;
    debugGestureRef.current = null;
    if (!g || g.lockT == null) return;
    const now = performance.now();
    const dragDurationMs = now - g.lockT;
    const entry = {
      id: `${now}-${Math.random()}`,
      lockTimeMs: g.lockT - g.startT,
      lockDistPx: g.lockDistPx,
      moveCount: g.moveCount,
      dragDurationMs,
      movesPerSec: dragDurationMs > 0 ? g.moveCount / (dragDurationMs / 1000) : 0,
      transformCount: g.transformCount,
      framesPerSec: dragDurationMs > 0 ? g.transformCount / (dragDurationMs / 1000) : 0,
      maxFrameGapMs: g.maxFrameGapMs,
      cancelled: g.cancelled,
      outcome,   // 'commit' | 'snapback'(요구사항6)
      velocity,  // px/ms, computeWindowVelocity가 산출한 값 그대로(요구사항6)
    };
    setSwipeDebugHistory(prev => [entry, ...prev].slice(0, 3));
  }

  // ── 드래그 제스처(Pointer Events, 터치+마우스 통합) ──────────────
  // dragRef는 React state가 아니라 순수 mutable ref — pointermove가 프레임마다
  // 여러 번 발생해도 리렌더 없이 값을 갱신하고, transform은 rAF에서 직접 DOM에 쓴다.
  const viewportRef = useRef(null);
  const trackRef    = useRef(null);
  // 트랙의 "지금 실제" translate3d X(px) — 드래그의 매 프레임과 스프링의 매 프레임이
  // 공통으로 이 값을 읽고 쓴다. 스프링 도중 새 드래그가 시작되면(요구사항4) 여기서
  // 그대로 이어받아, 원위치로 스냅하지 않고 현재 위치에서 드래그를 계속한다.
  const posRef  = useRef(0);
  const dragRef = useRef({
    pointerId: null,
    active: false,
    locked: null,     // null(미판정) | 'x'(가로 드래그) | 'y'(세로 스크롤에 양보)
    startX: 0, startY: 0,
    baseX: 0,          // 드래그 시작 시점의 트랙 실제 위치(px, posRef에서 캡처)
    dx: 0,
    panelWidth: 0,
    samples: [],       // {x, t} 링버퍼(최근 VELOCITY_WINDOW_MS) — 손 뗄 때 속도 계산용(요구사항1)
    rafId: null,
  });
  const springRef = useRef({ rafId: null, active: false, target: 0 });

  // activeIndex가 드래그/스프링이 아닌 경로(칩 탭)로 바뀌면 posRef도 같이 동기화해서
  // 다음 드래그가 실제 위치에서 정확히 시작하게 한다. 우리 쪽 흐름(드래그/스프링) 중에
  // setActiveCat이 불린 경우는 이 시점에 springRef.current.active가 이미 true라 건드리지
  // 않는다(스프링이 계산 중인 posRef를 여기서 되돌려버리면 안 됨).
  useEffect(() => {
    if (dragRef.current.active || springRef.current.active) return;
    const pw = viewportRef.current?.clientWidth;
    if (pw) posRef.current = -(activeIndex * pw);
  }, [activeIndex]);

  function applyTrackTransform(px) {
    posRef.current = px;
    if (trackRef.current) trackRef.current.style.transform = `translate3d(${px}px,0,0)`;
  }

  // 드래그 중 프레임마다 여러 pointermove가 몰려도 rAF 1회로 합쳐서 반영.
  function scheduleDragFrame() {
    const st = dragRef.current;
    if (st.rafId != null) return;
    st.rafId = requestAnimationFrame((now) => {
      st.rafId = null;
      if (!st.active || st.locked !== 'x') return;
      const count = CATEGORY_TABS.length;
      const minX = -((count - 1) * st.panelWidth);
      const maxX = 0;
      let pos = st.baseX + st.dx;
      // 고무줄 저항 — baseX가 항상 "도킹된" 위치라는 보장이 없으므로(스프링 인터럽트
      // 직후일 수 있음, 요구사항4) activeIndex가 아니라 실제 절대 경계로 판정한다.
      if (pos > maxX) pos = maxX + (pos - maxX) * RUBBER_BAND_RATIO;
      if (pos < minX) pos = minX + (pos - minX) * RUBBER_BAND_RATIO;
      applyTrackTransform(pos);
      markDebugFrame(now); // 계측 전용 — 실제 transform 갱신 프레임 수/간격 기록(요구사항3/4)
    });
  }

  function resetDrag() {
    const st = dragRef.current;
    if (st.rafId != null) { cancelAnimationFrame(st.rafId); st.rafId = null; }
    st.pointerId = null;
    st.active = false;
    st.locked = null;
    st.dx = 0;
    st.samples = [];
    viewportRef.current?.classList.remove('dragging');
  }

  function cancelSpring() {
    const sp = springRef.current;
    if (sp.rafId != null) cancelAnimationFrame(sp.rafId);
    sp.rafId = null;
    if (sp.active && trackRef.current) {
      // 안착 전에 강제로 끊겼다 — transition만 유휴 상태로 되돌린다(will-change는 CSS에
      // 정적으로 걸려있어 건드릴 필요가 없다 — iOS 중첩 스크롤 회귀로 동적 토글은 폐기).
      // 이 직후 새 제스처가 가로로 락되면 handleTrackPointerMove가 transition:none을 다시 켠다.
      trackRef.current.style.transition = '';
    }
    sp.active = false;
  }

  function pushVelocitySample(st, x, t) {
    st.samples.push({ x, t });
    while (st.samples.length > 1 && t - st.samples[0].t > VELOCITY_WINDOW_MS) {
      st.samples.shift();
    }
  }

  // 최근 VELOCITY_WINDOW_MS 윈도우 전체의 평균 속도(px/ms, dx와 부호가 같다 — 요구사항6).
  // 마지막 두 샘플만 쓰면 손을 떼기 직전 미세하게 멈칫하는 순간의 값(종종 0에 가까움)을
  // 그대로 속도로 오인해 플릭이 플릭으로 인식되지 않는 문제가 생긴다(요구사항1).
  function computeWindowVelocity(st) {
    const s = st.samples;
    if (s.length < 2) return 0;
    const first = s[0];
    const last = s[s.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    return (last.x - first.x) / dt;
  }

  // 목표 위치(targetPx)까지 감쇠 스프링으로 안착시킨다 — CSS transition이 아니라 매
  // 프레임 transform: translate3d()를 직접 계산해서 쓴다(요구사항3). 초기 속도
  // (initialVelocityPxMs)는 손을 뗄 때 링버퍼로 계산한 값을 그대로 이어받는다(요구사항2).
  // 부호 확인(요구사항6): dx>0(오른쪽 드래그)일 때 pos(=posRef/transform X)도 커지는
  // 방향이므로, velocity도 같은 부호를 그대로 쓰면 된다 — 여기서 뒤집지 않는다.
  function startSpring(targetPx, initialVelocityPxMs) {
    cancelSpring();
    const sp = springRef.current;
    sp.active = true;
    sp.target = targetPx;

    let pos = posRef.current;
    let velocity = initialVelocityPxMs * 1000; // px/ms -> px/s (적분을 초 단위로 통일)
    let lastT = performance.now();

    function tick(now) {
      const dt = Math.min((now - lastT) / 1000, 1 / 30); // 초 단위, 프레임 드롭 시 스프링이 튀지 않게 상한
      lastT = now;

      const accel = -SPRING_STIFFNESS * (pos - sp.target) - SPRING_DAMPING * velocity;
      velocity += accel * dt;
      pos += velocity * dt;

      const velocityPxMs = velocity / 1000;
      const settled = Math.abs(pos - sp.target) < SPRING_REST_DIST && Math.abs(velocityPxMs) < SPRING_REST_VEL;
      if (settled) {
        applyTrackTransform(sp.target);
        sp.active = false;
        sp.rafId = null;
        if (trackRef.current) {
          trackRef.current.style.transition = '';  // 이후 칩 탭 전환은 다시 CSS transition으로 처리
          // will-change는 여기서 끄지 않는다 — CSS에 정적으로 걸려있다(합성 레이어를
          // 제스처마다 만들고 부수면 iOS Safari에서 중첩된 .grid의 스크롤이 깨지는
          // 회귀가 있었음, 아래 index.css의 .home-cat-track 참고).
        }
        return;
      }

      applyTrackTransform(pos);
      sp.rafId = requestAnimationFrame(tick);
    }

    sp.rafId = requestAnimationFrame(tick);
  }

  function handleTrackPointerDown(e) {
    if (editingMajor) return; // 편집 모드에서는 칩 탭만 허용, 드래그 비활성화
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // iOS 엣지 스와이프(뒤로가기 제스처)와 충돌 방지 — 화면 좌우 EDGE_GUARD_PX 안쪽에서
    // 시작한 제스처는 아예 추적하지 않는다.
    if (e.clientX <= EDGE_GUARD_PX || e.clientX >= window.innerWidth - EDGE_GUARD_PX) return;

    // 스프링 안착 중이었다면 그 자리에서 즉시 끊고 이어받는다 — 원위치로 스냅하지
    // 않는다(요구사항4). posRef.current가 바로 "지금 실제 위치"라 baseX로 그대로 쓴다.
    cancelSpring();

    const st = dragRef.current;
    st.pointerId = e.pointerId;
    st.active = true;
    st.locked = null;
    st.startX = e.clientX;
    st.startY = e.clientY;
    st.baseX = posRef.current;
    st.dx = 0;
    st.panelWidth = viewportRef.current.clientWidth;
    const now = performance.now();
    st.samples = [{ x: e.clientX, t: now }];
    startDebugGesture(now); // 계측 전용 — pointerdown 시각 기록(요구사항1)
    // setPointerCapture는 여기서 곧장 걸지 않는다 — Chromium은 캡처된 포인터의 이후
    // click(호환 마우스 이벤트)까지 캡처 요소로 재타겟팅해서, 이동이 전혀 없는 순수 탭조차
    // 카드의 onClick(상세 페이지 이동)이 뷰포트로 흡수돼 통째로 먹혀버린다. 그래서 가로
    // 드래그로 방향이 확정되는 시점(아래 handleTrackPointerMove의 'x' 분기)까지 미룬다 —
    // 그 전까지는 clientX/clientY만으로 추적해도 충분하고, 탭은 이 캡처를 아예 거치지 않는다.
  }

  function handleTrackPointerMove(e) {
    const st = dragRef.current;
    if (!st.active || e.pointerId !== st.pointerId) return;

    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;

    if (st.locked === null) {
      // 판정 거리 — 순수 |dx|/|dy| 개별 임계값 대신 대각 이동도 놓치지 않도록 유클리드 거리 사용.
      if (Math.hypot(dx, dy) <= DRAG_LOCK_SLOP) return; // 아직 판정 전
      if (Math.abs(dx) > Math.abs(dy) * DRAG_ANGLE_BIAS) {
        // 가로 우세(콘 확대분 포함) — 즉시 락.
        st.locked = 'x';
        e.currentTarget.setPointerCapture(e.pointerId); // 이 시점부터 뷰포트 밖으로 나가도 계속 추적
        trackRef.current.style.transition = 'none';
        // will-change는 여기서 켜지 않는다 — index.css의 .home-cat-track에 정적으로
        // 걸려있다(제스처마다 합성 레이어를 만들고 부수면 iOS Safari에서 중첩된 .grid의
        // 스크롤이 깨지는 회귀가 있었음).
        viewportRef.current.classList.add('dragging'); // 드래그 중 카드 텍스트 선택 방지(CSS)
        markDebugLock(dx, dy, performance.now()); // 계측 전용 — 락 확정 시각/이동량 기록(요구사항1)
      } else if (Math.abs(dy) >= Math.abs(dx) / DRAG_ANGLE_BIAS) {
        // 세로 의도로 판정 — 제스처를 포기하고 .grid의 overflow-y:auto(또는 touch-action:pan-y
        // 네이티브 스크롤)에 그대로 양보한다. 캡처를 아직 걸지 않았으므로(위 주석 참고)
        // 여기서 딱히 releasePointerCapture할 것도 없다 — 상태만 리셋하면 된다. 여기서
        // preventDefault를 호출한 적이 없어야 브라우저가 이 시점까지의 세로 이동을
        // 정상적으로 스크롤로 이어받을 수 있다.
        resetDrag();
        return;
      } else {
        return; // 두 조건이 정확히 여집합이라 이론상 도달하지 않는 안전망 — 판정 보류
      }
    }
    if (st.locked !== 'x') return;

    // 가로 드래그로 확정된 뒤부터만 preventDefault — pan-y 세로 스크롤과의 충돌을 피한다.
    e.preventDefault();

    pushVelocitySample(st, e.clientX, performance.now()); // 링버퍼에 샘플 적재(요구사항1) — 실제 속도 계산은 손 뗄 때
    st.dx = dx;
    markDebugMove(); // 계측 전용 — 락 이후 pointermove 수신 횟수(요구사항2)

    scheduleDragFrame();
  }

  // 트랙을 목표 인덱스로 스프링 안착시킨다(칩 활성 표시는 즉시 동기화, 시각적 이동은
  // 스프링이 이어서 처리 — 요구사항2/3). pointerup(정상 릴리스)과 pointercancel(가로챔,
  // 아래 handleTrackPointerCancel 참고)이 계산한 targetIndex를 각자 다른 기준으로
  // 넘겨 공유해서 쓴다.
  function settleTrackTo(targetIndex, panelWidth, initialVelocityPxMs) {
    if (targetIndex !== activeIndex) {
      setActiveCat(CATEGORY_TABS[targetIndex].key); // 칩 활성 표시는 activeCat prop으로 자동 동기화
    }
    startSpring(-(targetIndex * panelWidth), initialVelocityPxMs);
  }

  function commitIndexFor(dx) {
    const count = CATEGORY_TABS.length;
    if (dx < 0 && activeIndex < count - 1) return activeIndex + 1;
    if (dx > 0 && activeIndex > 0) return activeIndex - 1;
    return activeIndex;
  }

  function finishTrackDrag(e) {
    const st = dragRef.current;
    if (!st.active || e.pointerId !== st.pointerId) { resetDrag(); return; }

    const wasDragging = st.locked === 'x';
    const { dx, panelWidth } = st;
    const velocity = computeWindowVelocity(st); // resetDrag가 samples를 비우기 전에 계산(요구사항1)
    resetDrag();
    if (!wasDragging) { finishDebugGesture(null, null); return; } // 순수 탭 — 캡처를 건 적이 없으므로 카드의 onClick이 정상적으로 그대로 발생한다

    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }

    // 정상 릴리스(pointerup) — 사용자가 스스로 놓은 시점이므로 거리/속도 임계값으로
    // "충분히 끌었는지"를 판정한다(기존 로직 그대로 — 요구사항7). 미달이면 원위치로 스프링 복귀.
    const pastThreshold = Math.abs(dx) > panelWidth * DRAG_COMMIT_RATIO;
    const fastFlick = Math.abs(velocity) > DRAG_FLICK_VELOCITY;
    const targetIndex = (pastThreshold || fastFlick) ? commitIndexFor(dx) : activeIndex;
    settleTrackTo(targetIndex, panelWidth, velocity);
    finishDebugGesture(targetIndex !== activeIndex ? 'commit' : 'snapback', velocity); // 계측 전용(요구사항6)

    // 카드를 스치며 드래그가 끝나면 pointerup 뒤에 이어지는 click(특히 마우스는
    // preventDefault로 막히지 않음)이 카드 상세 페이지로 오내비게이션하는 걸 막는다.
    if (Math.abs(dx) > 2) {
      const vp = viewportRef.current;
      if (vp) {
        const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
        vp.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => vp.removeEventListener('click', swallow, { capture: true }), 400);
      }
    }
  }

  // pointercancel — 방향 판정 전(locked===null)에 온 것이면 그냥 상태만 리셋한다(아직
  // 드래그로 확정되지 않았으니 잃을 것도 없다). 문제는 locked==='x'로 이미 가로 드래그가
  // 확정된 뒤에도 오는 경우다: `.grid`가 (지수 탭처럼 카드가 4개를 넘는 카테고리에서
  // overflow-y:auto로 세로 스크롤을 담당해야 하므로) touch-action:pan-y 트랙 안에 중첩된
  // 스크롤 컨테이너로 존재하는데, 이 중첩 구조 자체가 (Chromium 실측 확인 — 각도/슬롭을
  // 아무리 좁혀도 못 피함) preventDefault를 정확히 호출했는지와 무관하게 락이 걸리고
  // 나서 불과 20~50px 이내에 브라우저가 그 스크롤 컨테이너 쪽으로 제스처를 가로채며
  // pointercancel을 보낸다. 이 시점의 dx는 pointerup 기준 임계값(패널폭의 30% 등)에
  // 턱없이 못 미치는 게 보통이라 finishTrackDrag와 같은 거리/속도 판정을 그대로 쓰면
  // 사실상 항상 미달로 원위치 스냅되어 "가로 판정이 씹힌다"는 원래 증상이 재현된다.
  // cancel은 사용자가 놓은 게 아니라 브라우저가 뺏어간 것이고, locked==='x'로 확정된
  // 것 자체가 이미 가로 의도의 충분한 증거이므로 — 여기서는 임계값 없이 dx 부호
  // 방향으로 그대로 전환한다.
  function handleTrackPointerCancel(e) {
    const st = dragRef.current;
    const wasDragging = st.active && st.locked === 'x';
    const { dx, panelWidth } = st;
    const velocity = computeWindowVelocity(st); // 스프링 초기 속도용 — 커밋 방향 판정에는 안 씀(요구사항7)
    if (wasDragging) markDebugCancelled(); // 계측 전용 — pointercancel 발생 여부(요구사항5)
    resetDrag();
    if (!wasDragging) { finishDebugGesture(null, null); return; }
    const targetIndex = commitIndexFor(dx);
    settleTrackTo(targetIndex, panelWidth, velocity);
    finishDebugGesture(targetIndex !== activeIndex ? 'commit' : 'snapback', velocity); // 계측 전용(요구사항6)
  }

  // 이상 종목 집계 (데이터가 있는 경우에만 검사)
  const itemsWithIssues = items.filter(it => detectIssues(it).length > 0);
  const missingIds = items.length > 0
    ? EXPECTED_IDS.filter(id => !items.some(it => it.id === id))
    : [];
  const totalWarnings = itemsWithIssues.length + missingIds.length;

  const isStatic = source === 'static';

  return (
    <>
      {debugSwipeEnabled && <SwipeDebugHUD history={swipeDebugHistory} />}
      <Header />
      <div className="page active">

        {/* 갱신 바 — 정적 소스일 때 점 색상을 amber로 변경 */}
        <div className="refresh-bar">
          <div className={`pulse-dot${isStatic ? ' static' : ''}`} />
          <span>{updatedAt}</span>
          {isStatic && <span className="static-chip">정적 데이터</span>}
        </div>

        {/* 이상 종목 요약 바 — 이상이 있을 때만 표시 */}
        {totalWarnings > 0 && (
          <div className="warn-bar">
            <span>⚠</span>
            <span>
              {itemsWithIssues.length > 0 && `${itemsWithIssues.length}개 종목 데이터 이상`}
              {itemsWithIssues.length > 0 && missingIds.length > 0 && ' · '}
              {missingIds.length > 0 && `${missingIds.join(', ')} 누락`}
              &nbsp;— 카드 ⚠ 배지 확인
            </span>
          </div>
        )}

        <IssueStrip issues={issues} onClick={() => onPageChange('briefing')} />

        <CategoryTabs
          activeCat={activeCat}
          onChange={setActiveCat}
          onEditMajor={() => setEditingMajor(true)}
        />
        <div
          className="home-cat-viewport"
          ref={viewportRef}
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={finishTrackDrag}
          onPointerCancel={handleTrackPointerCancel}
        >
          <div
            className="home-cat-track"
            ref={trackRef}
            style={{ transform: `translateX(-${activeIndex * 20}%)` }}
          >
            {CATEGORY_TABS.map(({ key: catKey }, idx) => {
              // 성능: 현재 패널과 좌우 인접 패널만 카드(스파크라인 포함)를 실제로 마운트하고,
              // 그 밖의 패널은 빈 placeholder로 둔다 — 5개 패널 전부를 항상 그리면
              // 스파크라인 차트가 최대 15개 동시에 마운트돼 무거워진다.
              const isNear = Math.abs(idx - activeIndex) <= 1;
              if (!isNear) {
                return <div className="home-cat-panel" key={catKey}><div className="home-cat-placeholder" aria-hidden="true" /></div>;
              }

              const catList = itemsInCategory(items, catKey, majorIds);
              return (
                <div className="home-cat-panel" key={catKey}>
                  <div
                    className={`grid${catList.length === 1 ? ' solo' : ''}`}
                    role={catKey === activeCat ? 'main' : undefined}
                    aria-live={catKey === activeCat ? 'polite' : 'off'}
                  >
                    {loadError ? (
                      <div className="state-wrap error">
                        <p>데이터 로드 실패: {loadError}</p>
                        <small>public/market_data.json 파일을 확인하세요.</small>
                      </div>
                    ) : !items.length ? (
                      <div className="state-wrap">
                        <p>데이터 불러오는 중…</p>
                      </div>
                    ) : !catList.length ? (
                      <div className="state-wrap">
                        <p>해당 카테고리에 데이터가 없습니다</p>
                      </div>
                    ) : (
                      catList.map(item => <MarketCard key={item.id} item={item} />)
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {editingMajor && (
        <MajorEditPanel selectedIds={majorIds} onSave={handleSaveMajor} />
      )}
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </>
  );
}
