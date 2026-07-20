/**
 * api/health.js — 데이터 소스 상태 점검 엔드포인트 (관측성 1단계)
 *
 * GET /api/health → 소스별 상태 판정 + 원시 수치
 *   [{ source, status: 'ok'|'stale'|'down'|'unknown',
 *      lastSuccessAt, lastFailureAt, consecutiveFailures, todayRate, today }]
 *
 * 판정 규칙(_lib/health.js getHealthSnapshot):
 *   - consecutiveFailures >= 3            → down
 *   - lastSuccessAt이 기대 주기의 3배 이내 → ok
 *   - 그 외(성공 있었으나 오래됨/실패만)   → stale
 *   - 수집 이력 자체가 없음                → unknown
 *
 * 조회 전용·민감정보 없음 → 인증 불필요. Redis만 읽고 외부 API는 절대 치지
 * 않는다(health 확인이 시세/뉴스 API 쿼터를 소모하면 안 됨 — 요구사항 6).
 */

import { getHealthSnapshot } from './_lib/health.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const sources = await getHealthSnapshot();
    // 상태가 있으므로 캐시는 짧게만 — 관측 목적상 최신값이 중요.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ checkedAt: new Date().toISOString(), sources });
  } catch (e) {
    console.error('[health] 스냅샷 조회 실패:', e.message);
    return res.status(503).json({ error: 'health 조회 실패(Redis)', details: e.message });
  }
}
