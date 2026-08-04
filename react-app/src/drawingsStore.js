/**
 * drawingsStore.js — 차트 그리기 도형 영속성 레이어
 *
 * 저장 형식: { [symbolKey]: Shape[] } — symbolKey는 "type:market:symbol" 형태로
 * 호출부(AnalysisPage)에서 생성한다. srLinesStore와 **같은 키 체계**를 쓴다
 * (한쪽만 다르면 종목 전환 시 두 레이어가 서로 다른 종목을 가리킬 수 있다).
 *
 * Shape = {
 *   id:        string,                              // 고유 식별자
 *   type:      string,                              // 'trendline' (나중에 'fib'이 들어올 자리)
 *   points:    [{ time, price }, { time, price }],  // 항상 2점
 *   createdAt: number,                              // epoch ms
 * }
 *
 * ⚠️ **type에 따라 분기하지 않는다.** 이 파일도 호출부도 type을 문자열로 나르기만 한다 —
 *    추세선(대각선)과 피보나치(수평선)는 렌더링만 다르고 여기까지의 인터랙션·저장은
 *    완전히 동일하기 때문이다. 분기가 생기는 지점은 렌더링 단계이고 이 단계가 아니다.
 *
 * ⚠️ time 값은 lightweight-charts의 Time을 그대로 보관한다 — 일봉은 'YYYY-MM-DD' 문자열,
 *    분봉은 UTCTimestamp(초). 우리가 정규화하면 차트에 되돌릴 때 다시 역변환해야 하고,
 *    그 왕복이 곧 버그 자리다(_collectors/chart-time.js의 KST 시프트가 이미 한 번 겪은 문제).
 */

export const STORAGE_KEY = 'finance_drawings_v1';

/** 도형 종류 — 지금은 추세선 하나. 'fib'이 들어올 자리다(분기 코드는 아직 없다). */
export const DRAWING_TYPE = {
  TRENDLINE: 'trendline',
};

function loadAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    // 파싱 실패·localStorage 접근 차단(프라이빗 모드 등) — 조용히 빈 상태로 시작한다.
    return {};
  }
}

function saveAll(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('[drawings] localStorage 저장 실패:', e.message);
  }
}

// 좌표 1점 — time은 문자열('YYYY-MM-DD')이거나 숫자(UTCTimestamp) 둘 다 정상이다.
function isValidPoint(p) {
  if (!p || typeof p !== 'object') return false;
  const okTime = typeof p.time === 'string' ? p.time.length > 0 : Number.isFinite(p.time);
  return okTime && Number.isFinite(p.price);
}

// 깨진 항목은 통째로 버리지 않고 **그 도형만** 걸러낸다 — 하나가 깨졌다고 나머지를
// 잃으면 사용자는 이유를 알 수 없이 전부 사라진 것으로 본다.
function isValidShape(s) {
  return Boolean(s)
    && typeof s === 'object'
    && typeof s.id === 'string' && s.id.length > 0
    && typeof s.type === 'string' && s.type.length > 0
    && Array.isArray(s.points) && s.points.length === 2
    && s.points.every(isValidPoint);
}

function newId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* 보안 컨텍스트가 아니면 아래 폴백 */ }
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 도형 1건 생성 — 저장은 하지 않는다(호출부가 목록에 넣고 saveDrawings를 부른다).
 * @param {string} type   DRAWING_TYPE 중 하나
 * @param {Array<{time: string|number, price: number}>} points  2점
 * @returns {object|null} 좌표가 유효하지 않으면 null
 */
export function makeShape(type, points) {
  const shape = { id: newId(), type, points, createdAt: Date.now() };
  return isValidShape(shape) ? shape : null;
}

/** @returns {Array<object>} 저장된 도형 목록 (없거나 깨졌으면 빈 배열) */
export function loadDrawings(symbolKey) {
  if (!symbolKey) return [];
  const arr = loadAll()[symbolKey];
  return Array.isArray(arr) ? arr.filter(isValidShape) : [];
}

/** 종목별 도형 목록 저장(빈 배열이면 키 자체를 제거 — srLinesStore와 동일 규약) */
export function saveDrawings(symbolKey, shapes) {
  if (!symbolKey) return;
  const all = loadAll();
  if (!shapes || shapes.length === 0) delete all[symbolKey];
  else all[symbolKey] = shapes.filter(isValidShape);
  saveAll(all);
}
