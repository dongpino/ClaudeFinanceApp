/**
 * homeMajorStore.js — 홈 탭 "주요" 카테고리 사용자 선택 localStorage 저장
 *
 * 저장 형식: string[] (선택된 종목 id, 최대 MAX_MAJOR개)
 * 저장값이 없거나 전부 무효한 id면(예: 이후 종목이 카탈로그에서 삭제된 경우)
 * DEFAULT_MAJOR_IDS로 폴백한다 — 개별 id는 유효한 것만 골라 살리고, 그 결과가
 * 하나도 안 남을 때만 기본값 전체로 되돌아간다.
 */

import { ITEM_CATEGORIES, DEFAULT_MAJOR_IDS } from './itemCategories';

export const STORAGE_KEY = 'home_major_v1';
export const MAX_MAJOR   = 4;

const VALID_IDS = new Set(ITEM_CATEGORIES.map(c => c.id));

function sanitize(ids) {
  if (!Array.isArray(ids)) return null;
  const valid = [...new Set(ids)].filter(id => VALID_IDS.has(id)).slice(0, MAX_MAJOR);
  return valid.length > 0 ? valid : null;
}

export function loadMajorIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_MAJOR_IDS;
    return sanitize(JSON.parse(raw)) ?? DEFAULT_MAJOR_IDS;
  } catch {
    return DEFAULT_MAJOR_IDS;
  }
}

export function saveMajorIds(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch (e) {
    console.warn('[homeMajor] localStorage 저장 실패:', e.message);
  }
}
