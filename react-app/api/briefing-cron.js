/**
 * api/briefing-cron.js — 아침 자동 브리핑 생성 (Vercel Cron 전용)
 *
 * GET /api/briefing-cron
 *   vercel.json의 crons 설정("30 23 * * *" = KST 08:30)에 의해 매일 호출된다.
 *   Vercel Cron 요청에는 Authorization: Bearer {CRON_SECRET} 헤더가 자동으로 붙는데,
 *   이 값이 환경변수 CRON_SECRET과 일치하는 요청만 처리한다 — 외부인이 이 경로를
 *   직접 호출해 생성을 유발할 수 없게 막는 용도(Anthropic 호출 비용 보호).
 *
 * 생성 로직은 api/briefing.js(버튼 클릭용)와 완전히 동일하게 api/_lib/briefing-core.js를
 * 공유한다 — cron이라고 캐시·상한·히스토리 저장을 다르게 취급하지 않는다. 이미 이번 시간에
 * 생성된 캐시가 있으면(예: 새벽에 아무도 안 눌렀는데 상한에 걸린 경우는 없지만) Anthropic을
 * 다시 호출하지 않고 그대로 반환한다.
 *
 * 환경변수: CRON_SECRET (필수 — 없으면 요청 자체를 거부), ANTHROPIC_API_KEY,
 *           KV_REST_API_URL / KV_REST_API_TOKEN — api/_lib/briefing-core.js 참고.
 *
 * AI 브리핑 개선 Stage 2: 브리핑 생성 후 significance.js의 buildSignals()+saveSnapshot()을
 * 호출해 오늘의 지표 스냅샷을 signals:daily에 하루 1건씩 쌓는다(Stage 3의 5일 추세 문맥용
 * 데이터 축적 — 이 단계에서는 브리핑 프롬프트에 연결하지 않는다). 완전히 격리돼 있어 이
 * 수집/적재가 실패해도 브리핑 응답에는 전혀 영향을 주지 않는다.
 */

import { getOrGenerateBriefing } from './_lib/briefing-core.js';
import { buildSignals, saveSnapshot } from './_lib/significance.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[briefing-cron] CRON_SECRET 환경변수가 설정되지 않았습니다 — 요청 거부');
    return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되지 않았습니다.' });
  }

  const authHeader = req.headers.authorization ?? '';
  if (authHeader !== `Bearer ${secret}`) {
    console.warn('[briefing-cron] 인증 실패 — Authorization 헤더가 CRON_SECRET과 일치하지 않음');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[briefing-cron] 인증 성공 — 아침 자동 브리핑 생성 시작');
  const result = await getOrGenerateBriefing();

  // Stage 2 지표 스냅샷 적재 — 브리핑 응답과 완전히 무관하게 격리(실패해도 무시하고 진행).
  try {
    const signals = await buildSignals();
    await saveSnapshot(signals);
  } catch (e) {
    console.error('[briefing-cron] 일별 스냅샷 수집/적재 실패(브리핑 응답에는 영향 없음):', e.message);
  }

  res.setHeader('Cache-Control', 'no-store');
  if (result.cacheStatus) res.setHeader('X-Cache', result.cacheStatus);
  return res.status(result.status).json(result.body);
}
