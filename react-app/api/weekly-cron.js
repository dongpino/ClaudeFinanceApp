/**
 * api/weekly-cron.js — 주간 브리핑 자동 생성 (Vercel Cron 전용)
 *
 * GET /api/weekly-cron
 *   vercel.json의 crons 설정("30 0 * * 6" = 토요일 09:30 KST)에 의해 주 1회 호출된다.
 *   토요일 오전인 이유: 미국 금요일장이 토 05:00~06:00 KST에 마감하므로, 그 이후여야
 *   한 주(월~금)가 온전히 담긴다. signals:daily의 토요일 스냅샷이 금요일 종가를 담는다는
 *   것은 30/30 실측으로 확정했다(2026-08-07 조사).
 *
 *   09:30을 고른 것은 08:30의 일일 크론(/api/briefing-cron)과 1시간 띄우기 위해서다 —
 *   주간은 그 토요일 스냅샷을 읽으므로 일일 크론이 먼저 적재를 끝내야 한다.
 *
 * 일일 크론(api/briefing-cron.js)과 같은 방식으로 CRON_SECRET을 검사한다. 이 경로를
 * 외부인이 직접 호출해 Sonnet 생성을 유발할 수 없게 막는 용도다(비용 보호).
 *
 * 생성 로직은 api/_lib/weekly-core.js가 전담한다. 이미 그 주 브리핑이 있으면 Anthropic을
 * 다시 호출하지 않고 저장본을 그대로 반환한다(force 없음 = write-once에 가깝게 동작).
 *
 * 환경변수: CRON_SECRET(필수), ANTHROPIC_API_KEY, KV_REST_API_URL / KV_REST_API_TOKEN.
 */

import { generateWeeklyBriefing } from './_lib/weekly-core.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[weekly-cron] CRON_SECRET 환경변수가 설정되지 않았습니다 — 요청 거부');
    return res.status(500).json({ error: 'CRON_SECRET 환경변수가 설정되지 않았습니다.' });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    console.warn('[weekly-cron] 인증 실패 — 요청 거부');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = await generateWeeklyBriefing();
  res.setHeader('Cache-Control', 'no-store');
  return res.status(result.status).json(result.body);
}
