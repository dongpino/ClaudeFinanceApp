/**
 * briefingStore.js — AI 시장 브리핑 결과 localStorage 캐시
 *
 * 저장 형식: { briefing: string, generated_at: string(KST), meta: object }
 * generated_at은 서버 fmtKST() 형식("YYYY-MM-DD HH:MM KST")을 그대로 사용.
 *
 * 유효기간(복원 가능 여부)은 시간 단위(1시간)로 서버 Redis 캐시 버킷과 정렬돼 있다 —
 * generatedAtHourBucket(generated_at) === kstHourBucket()일 때만 마운트 시 복원한다.
 * "오늘 HH:MM 생성됨" 라벨 표시는 이와 별개로 날짜(하루) 단위 비교를 쓴다(kstDateStr).
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

/** 현재 시각(KST) 시간 단위 버킷 "YYYY-MM-DD-HH" — 서버 kstHourBucket()과 동일한 방식 */
export function kstHourBucket(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  return `${y}-${mo}-${dy}-${h}`;
}

/** 서버 generated_at("YYYY-MM-DD HH:MM KST") → "YYYY-MM-DD-HH" 버킷으로 변환 */
export function generatedAtHourBucket(generatedAt) {
  if (!generatedAt || generatedAt.length < 13) return null;
  return `${generatedAt.slice(0, 10)}-${generatedAt.slice(11, 13)}`;
}
