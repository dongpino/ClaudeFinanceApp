/**
 * api/debug-signals.js — Significance Engine 검증용 엔드포인트
 *
 * GET /api/debug-signals?key=<DEBUG_SIGNALS_KEY>
 *   → buildSignals() 결과를 그대로 JSON 반환.
 *
 * 개발/검증 전용 — 홈 화면 등 실제 기능과 무관, DEBUG_SIGNALS_KEY 환경변수로만 보호.
 * (해당 변수가 없으면 프로덕션에서도 항상 403 — 값 설정을 깜빡해 노출되는 사고 방지)
 */

import { buildSignals } from './_lib/significance.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const expected = process.env.DEBUG_SIGNALS_KEY;
  const provided = req.query?.key;
  if (!expected || provided !== expected) {
    return res.status(403).json({ error: '접근 권한 없음' });
  }

  try {
    const signals = await buildSignals();
    return res.status(200).json(signals);
  } catch (e) {
    console.error('[debug-signals] 실패:', e.message);
    return res.status(500).json({ error: '시그널 생성 실패', details: e.message });
  }
}
