/**
 * watchlistStore.js — 즐겨찾기 상태 관리 (영속성 레이어)
 *
 * 저장 형식: { type: 'index'|'crypto'|'stock', id, symbol, name, market?, addedAt }[]
 *   market: type==='stock'일 때만 의미 있음 ('US'|'KR'). load()가 구버전(market 필드
 *   도입 이전) 항목을 6자리 숫자 코드 여부로 자동 추론해 채워 넣는다 — migrateMarket() 참고.
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

// market 필드 도입 이전에 저장된 stock 항목 마이그레이션용 — KR 종목코드는 6자리 숫자.
// (코인은 type:'crypto', 지수는 type:'index'로 이미 구분되므로 stock에만 적용)
const KR_STOCK_ID_RE = /^\d{6}$/;

function inferMarket(symbol) {
  return KR_STOCK_ID_RE.test(symbol ?? '') ? 'KR' : 'US';
}

/**
 * market 필드가 없는 구버전 stock 항목에 market을 채워 넣는다.
 * 변경사항이 없으면 원본 배열을 그대로 반환(불필요한 재저장 방지).
 */
function migrateMarket(list) {
  let changed = false;
  const next = list.map(it => {
    if (it.type !== 'stock' || it.market) return it;
    changed = true;
    return { ...it, market: inferMarket(it.symbol) };
  });
  return changed ? next : list;
}

export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    const migrated = migrateMarket(raw);
    if (migrated !== raw) {
      console.info('[watchlist] 구버전 항목 마이그레이션: market 필드 채움');
      save(migrated);
    }
    return migrated;
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
 * 개별 항목 필드 병합 갱신 (예: 구버전 항목의 name을 첫 조회 응답값으로 백필)
 * @param {string} id
 * @param {object} fields
 * @returns {Array|null} 갱신 후 목록 | null (항목 없음)
 */
export function patch(id, fields) {
  const list = load();
  const idx  = list.findIndex(it => it.id === id);
  if (idx === -1) return null;

  const next = [...list];
  next[idx] = { ...next[idx], ...fields };
  save(next);
  emit(next);
  return next;
}

/**
 * 전체 초기화 (테스트·계정 로그아웃용)
 */
export function clear() {
  save([]);
  emit([]);
}
