/**
 * api/health.js — 데이터 소스 상태 점검 엔드포인트 (관측성 1단계)
 *
 * GET /api/health → 소스별 상태 판정 + 원시 수치
 *   [{ source, status: 'ok'|'stale'|'down'|'unknown',
 *      lastSuccessAt, lastFailureAt, lastError, consecutiveFailures, todayRate, today }]
 *
 * 판정 규칙(_lib/health.js getHealthSnapshot):
 *   - consecutiveFailures >= 3            → down
 *   - lastSuccessAt이 기대 주기의 3배 이내 → ok
 *   - 그 외(성공 있었으나 오래됨/실패만)   → stale
 *   - 수집 이력 자체가 없음                → unknown
 *
 * 조회 전용·민감정보 없음 → 인증 불필요. Redis만 읽고 외부 API는 절대 치지
 * 않는다(health 확인이 시세/뉴스 API 쿼터를 소모하면 안 됨 — 요구사항 6).
 *
 * calendar 유사(pseudo) 행:
 *   시장 캘린더(_lib/macro-calendar.js)는 외부 fetch가 없는 하드코딩 상수라
 *   trackedFetch/Redis 기록층에 잡히지 않는다 → SOURCES에 넣을 수 없다. 대신
 *   getScheduleDepletion()/VERIFIED_AT을 직접 조회해 같은 모양의 행 하나를 만들어
 *   목록 끝에 덧붙인다. 상태판이 sources 배열을 그대로 렌더하므로 프론트 하드코딩
 *   없이 행이 나타난다. kind:'derived'로 trackedFetch 소스와 구분한다.
 *     · 소진 임박(depletion 있음) → 'warn'(노랑, 갱신 필요)
 *     · 그 외                      → 'ok'
 */

import { getHealthSnapshot } from './_lib/health.js';
import { getScheduleDepletion, VERIFIED_AT } from './_lib/macro-calendar.js';

const DEPLETION_LABEL = { fomc: 'FOMC', cpi: 'CPI', msci: 'MSCI', earnings: '실적' };

// 'YYYY-MM-DD' → 'M/D'
function monthDay(dateStr) {
  const [, m, d] = String(dateStr).split('-').map(Number);
  return `${m}/${d}`;
}

/**
 * 캘린더 유사 행 — Redis/외부호출 없이 순수 계산이라 실패할 수 없다.
 * note: 상태판 우측 메타 칸에 그대로 출력할 한 줄 요약.
 * (scripts/test-calendar-schedule.js에서 직접 검증하므로 export)
 */
export function buildCalendarSource() {
  const depletion  = getScheduleDepletion();
  const verifiedAt = VERIFIED_AT;
  // 여러 카테고리가 동시에 소진 임박이면 가장 급한 것(daysLeft 오름차순 첫 항목)만
  // 적고 나머지는 "외 N"으로 줄인다 — 메타 칸이 한 줄이라 길면 잘린다.
  const head = depletion[0];
  const note = head
    ? `${DEPLETION_LABEL[head.category] ?? head.category} ${monthDay(head.lastDate)} 이후 없음`
      + (depletion.length > 1 ? ` 외 ${depletion.length - 1}` : '')
    : `${monthDay(Object.values(verifiedAt).sort()[0])} 확인`;

  return {
    source: 'calendar',
    kind: 'derived',                 // trackedFetch 소스가 아님(수집기 없음)
    status: depletion.length > 0 ? 'warn' : 'ok',
    note,
    depletion,
    verifiedAt,
    // 아래는 상태판이 공통으로 읽는 필드 — 캘린더엔 수집 개념이 없어 전부 중립값.
    lastSuccessAt: null, lastFailureAt: null, lastError: null,
    consecutiveFailures: 0, todayRate: null, today: { success: 0, failure: 0 },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const sources = await getHealthSnapshot();
    sources.push(buildCalendarSource()); // 목록 끝에 유사 행 1개
    // 상태가 있으므로 캐시는 짧게만 — 관측 목적상 최신값이 중요.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ checkedAt: new Date().toISOString(), sources });
  } catch (e) {
    console.error('[health] 스냅샷 조회 실패:', e.message);
    return res.status(503).json({ error: 'health 조회 실패(Redis)', details: e.message });
  }
}
