/**
 * api/weekly-briefing.js — 주간 브리핑 조회 + 수동 생성
 *
 * 읽기(공개):
 *   GET /api/weekly-briefing                     → 이번 주(ISO) 저장본. 없으면 404
 *   GET /api/weekly-briefing?week=2026-W32       → 특정 주 저장본
 *   GET /api/weekly-briefing?list=true           → 저장된 주 라벨 목록(최신순)
 *
 * 생성(키 필요 — Sonnet 호출 비용 보호):
 *   GET /api/weekly-briefing?generate=1&key=<DEBUG_SIGNALS_KEY>
 *   GET /api/weekly-briefing?generate=1&key=...&week=2026-W31   → 지난 주 생성
 *   GET /api/weekly-briefing?generate=1&key=...&force=1         → 저장본이 있어도 재생성
 *
 * 1단계에서 수동 생성을 키로 막아 둔 이유: 프런트 버튼은 2단계이고, 그때 공개 트리거를
 * 어떻게 설계할지(일일처럼 상한만 둘지, 버튼을 아예 안 둘지)가 아직 정해지지 않았다.
 * 새 환경변수를 만들지 않으려고 이미 프로덕션에 있는 DEBUG_SIGNALS_KEY를 재사용한다 —
 * 2단계에서 공개 트리거를 정하면 그때 다시 볼 자리다.
 *
 * 읽기 경로는 Anthropic을 호출하지 않는다.
 */

import {
  generateWeeklyBriefing,
  getWeeklyBriefing,
  listWeeklyLabels,
  isoWeekLabel,
  mondayOfWeekLabel,
} from './_lib/weekly-core.js';

function currentWeekLabel() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return isoWeekLabel(new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate())));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const q = req.query ?? {};

  // ── 목록 ──
  if (q.list === 'true' || q.list === '1') {
    return res.status(200).json({ weeks: await listWeeklyLabels() });
  }

  const week = q.week ?? null;
  if (week && !mondayOfWeekLabel(week)) {
    return res.status(400).json({ error: '잘못된 주 형식입니다 (YYYY-Www)' });
  }

  // ── 수동 생성 ──
  if (q.generate === '1' || q.generate === 'true') {
    const expected = process.env.DEBUG_SIGNALS_KEY;
    if (!expected) {
      return res.status(500).json({ error: 'DEBUG_SIGNALS_KEY 환경변수가 설정되지 않았습니다.' });
    }
    if (q.key !== expected) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const result = await generateWeeklyBriefing({
      weekLabel: week,
      force: q.force === '1' || q.force === 'true',
    });
    return res.status(result.status).json(result.body);
  }

  // ── 조회 ──
  const label = week ?? currentWeekLabel();
  const data  = await getWeeklyBriefing(label);
  if (!data) {
    return res.status(404).json({ error: `${label} 주간 브리핑을 찾을 수 없습니다`, week: label });
  }
  return res.status(200).json({ ...data, cached: true });
}
