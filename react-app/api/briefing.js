/**
 * api/briefing.js — AI 시장 브리핑 서버리스 함수 (버튼 클릭용, 공개 GET)
 *
 * GET /api/briefing
 *   → Significance 지표 스냅샷 + 한국 경제 뉴스 RSS를 Anthropic AI에게 주고
 *     오늘의 시장 브리핑(한국어)을 생성해 반환.
 *
 * 실제 캐시·상한·생성 로직은 api/_lib/briefing-core.js에 있다 —
 * Vercel Cron이 호출하는 api/briefing-cron.js와 동일한 로직을 공유한다.
 * 이 엔드포인트는 인증 없이 누구나 호출 가능(클라이언트 "AI 브리핑 생성" 버튼용)하지만
 * 시간별 캐시 + 하루 20회 상한이 실질적인 남용 방지 역할을 한다.
 *
 * 아침 보고/수동 생성 분리(Stage 4): slot:'manual'로 호출해 일별 아카이브를 manual
 * 슬롯(같은 날짜 내 최신본 덮어쓰기)에 쓴다 — api/briefing-cron.js가 쓰는 morning
 * 슬롯(write-once)과는 별개 키라 서로 덮어쓰지 않는다.
 */

import { getOrGenerateBriefing } from './_lib/briefing-core.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const result = await getOrGenerateBriefing({ slot: 'manual' });

  res.setHeader('Cache-Control', 'no-store');
  if (result.cacheStatus) res.setHeader('X-Cache', result.cacheStatus);
  return res.status(result.status).json(result.body);
}
