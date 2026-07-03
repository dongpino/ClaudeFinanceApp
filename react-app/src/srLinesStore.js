/**
 * srLinesStore.js — 수동 지지/저항선 영속성 레이어
 *
 * 저장 형식: { [symbolKey]: number[] } — symbolKey는 "type:market:symbol" 형태로
 * 호출부(AnalysisPage)에서 생성. 가격 기준으로 저장하므로 타임프레임이 바뀌어도
 * 그대로 유지된다.
 */

export const STORAGE_KEY = 'finance_srlines_v1';

function loadAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveAll(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('[srLines] localStorage 저장 실패:', e.message);
  }
}

/** @returns {number[]} 저장된 가격 목록 (없으면 빈 배열) */
export function loadLines(symbolKey) {
  if (!symbolKey) return [];
  const arr = loadAll()[symbolKey];
  return Array.isArray(arr) ? arr.filter(n => typeof n === 'number' && Number.isFinite(n)) : [];
}

/** 종목별 가격 목록 저장(빈 배열이면 키 자체를 제거) */
export function saveLines(symbolKey, prices) {
  if (!symbolKey) return;
  const all = loadAll();
  if (!prices || prices.length === 0) delete all[symbolKey];
  else all[symbolKey] = prices;
  saveAll(all);
}
