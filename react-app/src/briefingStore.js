/**
 * briefingStore.js — AI 시장 브리핑 결과 localStorage 캐시
 *
 * 저장 형식: { briefing: string, generated_at: string(KST), meta: object }
 * generated_at은 서버 fmtKST() 형식("YYYY-MM-DD HH:MM KST")을 그대로 사용 —
 * 날짜(앞 10자)만 비교해 "오늘 생성된 캐시인지"를 판단한다(재호출 남발 방지용,
 * API 호출 자체를 막는 건 아니고 재방문 시 즉시 보여주기 위한 용도).
 */

export const STORAGE_KEY = 'finance_briefing_v1';

export function loadBriefing() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && data.briefing ? data : null;
  } catch {
    return null;
  }
}

export function saveBriefing(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[briefing] localStorage 저장 실패:', e.message);
  }
}

/** 오늘 날짜(KST) 문자열 "YYYY-MM-DD" — 서버 fmtKST()와 동일한 방식으로 계산 */
export function kstDateStr(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}
