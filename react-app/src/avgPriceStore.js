/**
 * avgPriceStore.js — 우미 투자 평단가 읽기 추상화 (2차: Redis 백엔드 연동)
 *
 * getAvgPrice(symbol)은 1차와 완전히 동일한 동기 함수 시그니처를 유지한다 —
 * 카드/상세 렌더 코드(MarketCard.jsx/Sparkline.jsx/Chart.jsx)는 이 함수만 호출할
 * 뿐이라 이번 단계에서 전혀 바뀌지 않는다. 실제 값은 모듈 스코프 인메모리
 * 캐시(cache)에서 나오고, 그 캐시는 아래 두 함수로만 채워진다:
 *   - loadAvgPrices() : 홈 진입 시 1회, DataContext.jsx가 호출 — GET /api/user-prefs.
 *     네트워크/401 등 어떤 이유로 실패해도 조용히 무시(카드 기본 렌더와 완전히 격리).
 *   - saveAvgPrices() : 평단가 편집 패널(AvgPriceEditPanel.jsx)이 저장 시 호출 — PUT.
 *     성공하면 서버가 정제해 돌려준 값을 신뢰 소스로 캐시에 반영한다(클라이언트가
 *     보낸 값이 아니라 서버 응답값을 씀 — 검증 로직이 서버에만 있으므로).
 *
 * 캐시가 바뀌면 subscribeAvgPrices로 등록된 구독자에게 알린다 — MarketCard 등은
 * React 훅으로 구독하지 않고 여전히 getAvgPrice()만 호출하는 순수 함수이므로,
 * 화면이 실제로 갱신되려면 "누군가"는 리렌더를 트리거해야 한다. 그 역할은
 * DataContext.jsx가 진다(이미 앱 전역 데이터를 들고 있는 곳이라 자연스러운 지점).
 */

import { loadEditToken } from './editTokenStore';

const WATCHLIST_IDS = ['HYPR', '419530', '028300', '080220'];

let cache = Object.fromEntries(WATCHLIST_IDS.map(id => [id, null]));
const listeners = new Set();

/** @returns {number|null} symbol(=워치리스트 item.id)의 평단가, 없으면 null */
export function getAvgPrice(symbol) {
  return cache[symbol] ?? null;
}

/** 캐시가 바뀔 때마다 호출됨 — 반환값은 구독 해제 함수. */
export function subscribeAvgPrices(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function applyToCache(value) {
  const next = { ...cache };
  for (const id of WATCHLIST_IDS) {
    const v = value?.[id];
    next[id] = (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : null;
  }
  cache = next;
  listeners.forEach(fn => fn());
}

/**
 * 홈 진입 시 1회 호출 — 토큰이 없으면 요청 자체를 시도하지 않는다(어차피 401).
 * 실패(네트워크 오류/401/서버 오류)는 전부 조용히 무시한다: 평단 표시만 계속
 * 비어있을 뿐 카드 기본 렌더(가격/등락/차트 등)에는 아무 영향이 없어야 한다.
 */
export async function loadAvgPrices() {
  const token = loadEditToken();
  if (!token) return;
  try {
    const res = await fetch('/api/user-prefs?key=avgPrices', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    applyToCache(data.value);
  } catch (e) {
    console.warn('[avgPriceStore] 평단가 로드 실패(조용히 무시):', e.message);
  }
}

/**
 * 평단가 편집 패널 저장 — 토큰이 없거나 서버가 401을 돌려주면 code:'AUTH_ERROR'인
 * Error를 던진다(호출부가 토큰 입력 프롬프트를 띄우도록). 그 외 실패는
 * code:'SERVER_ERROR'. 성공 시 서버가 정제한 값으로 캐시를 갱신하고 그 값을 반환한다.
 */
export async function saveAvgPrices(value) {
  const token = loadEditToken();
  if (!token) {
    const e = new Error('토큰이 없습니다');
    e.code = 'AUTH_ERROR';
    throw e;
  }
  let res;
  try {
    res = await fetch('/api/user-prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: 'avgPrices', value }),
    });
  } catch (e) {
    const err = new Error(`네트워크 오류: ${e.message}`);
    err.code = 'SERVER_ERROR';
    throw err;
  }
  if (res.status === 401) {
    const e = new Error('토큰이 올바르지 않습니다');
    e.code = 'AUTH_ERROR';
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`저장 실패 (HTTP ${res.status})`);
    e.code = 'SERVER_ERROR';
    throw e;
  }
  const data = await res.json();
  applyToCache(data.value);
  return data.value;
}

/**
 * avgPrice가 차트에 실제로 그려지는 가격 범위 [lo,hi] ±5% 여유 안에 있는지 판정 —
 * 카드 스파크라인(Sparkline.jsx)과 상세 캔들차트(Chart.jsx)가 공통으로 쓰는 규칙이라
 * 여기 한 곳에만 둔다(두 곳에 각자 구현하면 여유값이 어긋날 위험). 이 함수는 판정만
 * 하고 y축 스케일에는 관여하지 않는다 — "범위 안 = 라인 / 밖 = 가장자리 힌트"를
 * 나누는 것은 호출부 몫이다(y축 왜곡 금지는 호출부가 지켜야 할 제약).
 * @returns {'in'|'above'|'below'}
 */
export function avgPriceRangeStatus(avgPrice, lo, hi) {
  const rng = (hi - lo) || (hi * 0.005) || 1; // lo===hi(플랫) 폴백 — Sparkline.jsx 자체 rng 계산과 동일 규칙
  const margin = rng * 0.05;
  if (avgPrice > hi + margin) return 'above';
  if (avgPrice < lo - margin) return 'below';
  return 'in';
}
