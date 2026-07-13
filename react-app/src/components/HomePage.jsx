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
const SWIPE_LOCK_PX        = 10;   // 방향 잠금 판정 임계값(가로/세로 중 우세한 쪽으로 확정)
const SWIPE_COMMIT_RATIO   = 0.3;  // 패널폭의 이 비율 이상 이동하면 카테고리 전환
const SWIPE_VELOCITY_PXMS  = 0.3;  // 이보다 빠른 스와이프는 이동량이 짧아도 전환(flick)
const RUBBER_BAND_RATIO    = 0.3;  // 첫/마지막 패널을 넘어가려 할 때 저항(끌림 대비 실제 이동 비율)
const EDGE_GUARD_PX        = 24;   // 화면 좌우 이 폭 안에서 시작하면 iOS 엣지 뒤로가기 제스처에 양보

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

  // ── 드래그 제스처(Pointer Events, 터치+마우스 통합) ──────────────
  // dragRef는 React state가 아니라 순수 mutable ref — pointermove가 프레임마다
  // 여러 번 발생해도 리렌더 없이 값을 갱신하고, transform은 rAF에서 직접 DOM에 쓴다.
  const viewportRef = useRef(null);
  const trackRef    = useRef(null);
  const dragRef = useRef({
    pointerId: null,
    active: false,
    locked: null,     // null(미판정) | 'x'(가로 드래그) | 'y'(세로 스크롤에 양보)
    startX: 0, startY: 0,
    dx: 0,
    panelWidth: 0,
    lastX: 0, lastT: 0, velocity: 0,
    rafId: null,
  });

  function applyTrackTransform(px) {
    if (trackRef.current) trackRef.current.style.transform = `translateX(${px}px)`;
  }

  // 드래그 중 프레임마다 여러 pointermove가 몰려도 rAF 1회로 합쳐서 반영.
  function scheduleDragFrame() {
    const st = dragRef.current;
    if (st.rafId != null) return;
    st.rafId = requestAnimationFrame(() => {
      st.rafId = null;
      if (!st.active || st.locked !== 'x') return;
      let dx = st.dx;
      // 고무줄 저항 — 첫 패널에서 더 오른쪽으로, 마지막 패널에서 더 왼쪽으로 끌 때만.
      if (activeIndex === 0 && dx > 0) dx *= RUBBER_BAND_RATIO;
      if (activeIndex === CATEGORY_TABS.length - 1 && dx < 0) dx *= RUBBER_BAND_RATIO;
      applyTrackTransform(-(activeIndex * st.panelWidth) + dx);
    });
  }

  function resetDrag() {
    const st = dragRef.current;
    if (st.rafId != null) { cancelAnimationFrame(st.rafId); st.rafId = null; }
    st.pointerId = null;
    st.active = false;
    st.locked = null;
    st.dx = 0;
    viewportRef.current?.classList.remove('dragging');
  }

  function handleTrackPointerDown(e) {
    if (editingMajor) return; // 편집 모드에서는 칩 탭만 허용, 드래그 비활성화
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // iOS 엣지 스와이프(뒤로가기 제스처)와 충돌 방지 — 화면 좌우 EDGE_GUARD_PX 안쪽에서
    // 시작한 제스처는 아예 추적하지 않는다.
    if (e.clientX <= EDGE_GUARD_PX || e.clientX >= window.innerWidth - EDGE_GUARD_PX) return;

    const st = dragRef.current;
    st.pointerId = e.pointerId;
    st.active = true;
    st.locked = null;
    st.startX = e.clientX;
    st.startY = e.clientY;
    st.dx = 0;
    st.lastX = e.clientX;
    st.lastT = performance.now();
    st.velocity = 0;
    st.panelWidth = viewportRef.current.clientWidth;
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
      if (Math.abs(dx) < SWIPE_LOCK_PX && Math.abs(dy) < SWIPE_LOCK_PX) return; // 아직 판정 전
      if (Math.abs(dx) > Math.abs(dy)) {
        st.locked = 'x';
        e.currentTarget.setPointerCapture(e.pointerId); // 이 시점부터 뷰포트 밖으로 나가도 계속 추적
        trackRef.current.style.transition = 'none';
        viewportRef.current.classList.add('dragging'); // 드래그 중 카드 텍스트 선택 방지(CSS)
      } else {
        // 세로 의도로 판정 — 제스처를 포기하고 .grid의 overflow-y:auto(또는 touch-action:pan-y
        // 네이티브 스크롤)에 그대로 양보한다. 캡처를 아직 걸지 않았으므로(위 주석 참고)
        // 여기서 딱히 releasePointerCapture할 것도 없다 — 상태만 리셋하면 된다. 여기서
        // preventDefault를 호출한 적이 없어야 브라우저가 이 시점까지의 세로 이동을
        // 정상적으로 스크롤로 이어받을 수 있다.
        resetDrag();
        return;
      }
    }
    if (st.locked !== 'x') return;

    // 가로 드래그로 확정된 뒤부터만 preventDefault — pan-y 세로 스크롤과의 충돌을 피한다.
    e.preventDefault();

    const now = performance.now();
    const dt = now - st.lastT;
    if (dt > 0) st.velocity = (e.clientX - st.lastX) / dt; // px/ms
    st.lastX = e.clientX;
    st.lastT = now;
    st.dx = dx;

    scheduleDragFrame();
  }

  function finishTrackDrag(e) {
    const st = dragRef.current;
    if (!st.active || e.pointerId !== st.pointerId) { resetDrag(); return; }

    const wasDragging = st.locked === 'x';
    const { dx, velocity, panelWidth } = st;
    resetDrag();
    if (!wasDragging) return; // 순수 탭 — 캡처를 건 적이 없으므로 카드의 onClick이 정상적으로 그대로 발생한다

    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }

    const count = CATEGORY_TABS.length;
    let targetIndex = activeIndex;
    const pastThreshold = Math.abs(dx) > panelWidth * SWIPE_COMMIT_RATIO;
    const fastFlick = Math.abs(velocity) > SWIPE_VELOCITY_PXMS;
    if (pastThreshold || fastFlick) {
      if (dx < 0 && activeIndex < count - 1) targetIndex = activeIndex + 1;
      else if (dx > 0 && activeIndex > 0) targetIndex = activeIndex - 1;
    }

    if (trackRef.current) trackRef.current.style.transition = ''; // 스냅 애니메이션을 위해 트랜지션 재활성화
    applyTrackTransform(-(targetIndex * panelWidth));
    if (targetIndex !== activeIndex) {
      setActiveCat(CATEGORY_TABS[targetIndex].key); // 칩 활성 표시는 activeCat prop으로 자동 동기화
    }

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

  // pointercancel(브라우저가 제스처를 가로챈 경우 등) — 전환을 커밋하지 않고 현재
  // 카테고리 위치로 되돌린다. 방향 판정 전(locked===null)이라 이미 트랜지션이 꺼진 적도
  // 없는 상태였다면 그냥 상태만 리셋한다.
  function handleTrackPointerCancel(e) {
    const st = dragRef.current;
    const wasDragging = st.active && st.locked === 'x';
    const panelWidth = st.panelWidth;
    resetDrag();
    if (!wasDragging) return;
    if (trackRef.current) trackRef.current.style.transition = '';
    applyTrackTransform(-(activeIndex * panelWidth));
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
