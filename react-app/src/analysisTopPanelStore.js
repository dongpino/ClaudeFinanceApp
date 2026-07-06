/**
 * analysisTopPanelStore.js — 분석 탭 모바일 상단 패널(검색+칩 줄) 접기 상태 localStorage 저장
 *
 * 저장 형식: boolean (true = 접힘)
 */

export const STORAGE_KEY = 'finance_as_toppanel_v1';

export function loadTopPanelCollapsed() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveTopPanelCollapsed(collapsed) {
  try {
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  } catch (e) {
    console.warn('[analysisTopPanel] localStorage 저장 실패:', e.message);
  }
}
