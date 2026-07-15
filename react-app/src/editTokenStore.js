/**
 * editTokenStore.js — 1인용 편집 토큰(EDIT_TOKEN) localStorage 보관
 *
 * /api/user-prefs(및 향후 비슷하게 보호될 엔드포인트)에 Authorization: Bearer로
 * 붙일 토큰을 로컬에만 저장한다. 토큰 값 자체의 검증은 매 요청마다 서버가
 * 하므로, 여기는 단순 보관/조회만 담당한다 — 다른 기기(시크릿 창 등)에서는
 * 이 저장소가 비어 있어 avgPriceStore.js의 읽기/쓰기가 자연히 막힌다.
 */

export const STORAGE_KEY = 'finance_edit_token_v1';

export function loadEditToken() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function saveEditToken(token) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.warn('[editToken] localStorage 저장 실패:', e.message);
  }
}
