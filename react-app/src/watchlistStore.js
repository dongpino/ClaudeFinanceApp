/**
 * watchlistStore.js — 즐겨찾기 상태 관리 (영속성 레이어)
 *
 * 저장 형식: { type: 'index'|'crypto', id, symbol, name, addedAt }[]
 *
 * ── 계정 연동 마이그레이션 가이드 ────────────────────────────────
 * load()  → API GET  /user/watchlist
 * save()  → API PUT  /user/watchlist
 * 구독자 알림 방식을 WebSocket·폴링으로 교체
 * 이 파일 내부만 수정하면 hook·컴포넌트는 변경 불필요.
 * ────────────────────────────────────────────────────────────────
 */

export const STORAGE_KEY    = 'finance_watchlist_v1';
export const MAX_WATCHLIST  = 20;

// ── 구독자 (여러 hook 인스턴스 동기화용) ─────────────────────────
const listeners = new Set();

function emit(list) {
  for (const cb of listeners) cb(list);
}

/** store 변경 구독. 반환값: unsubscribe 함수 */
export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ── 영속성 (localStorage) ─────────────────────────────────────────

export function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('[watchlist] localStorage 저장 실패:', e.message);
  }
}

// ── CRUD ─────────────────────────────────────────────────────────

/**
 * 즐겨찾기 추가
 * @param {{ type: 'index'|'crypto', id: string, symbol: string, name: string }} item
 * @returns {Array} 추가 후 목록 | null (중복 or 상한 초과 or 필드 부족)
 */
export function add({ type, id, symbol, name }) {
  if (!type || !id || !symbol || !name) {
    console.warn('[watchlist] add(): 필수 필드 부족', { type, id, symbol, name });
    return null;
  }
  const list = load();
  if (list.some(it => it.id === id)) return null;        // 중복
  if (list.length >= MAX_WATCHLIST)  return null;        // 상한 초과

  const next = [...list, {
    type,
    id,
    symbol: symbol.toUpperCase(),
    name,
    addedAt: new Date().toISOString(),
  }];
  save(next);
  emit(next);
  return next;
}

/**
 * 즐겨찾기 삭제
 * @param {string} id
 * @returns {Array} 삭제 후 목록
 */
export function remove(id) {
  const next = load().filter(it => it.id !== id);
  save(next);
  emit(next);
  return next;
}

/**
 * 순서 변경 (fromIdx → toIdx)
 * @returns {Array} 변경 후 목록
 */
export function reorder(fromIdx, toIdx) {
  const list = load();
  if (
    fromIdx === toIdx ||
    fromIdx < 0 || fromIdx >= list.length ||
    toIdx   < 0 || toIdx   >= list.length
  ) return list;

  const next = [...list];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  save(next);
  emit(next);
  return next;
}

/**
 * 즐겨찾기 여부 확인
 * @param {string} id
 * @returns {boolean}
 */
export function has(id) {
  return load().some(it => it.id === id);
}

/**
 * 전체 초기화 (테스트·계정 로그아웃용)
 */
export function clear() {
  save([]);
  emit([]);
}
