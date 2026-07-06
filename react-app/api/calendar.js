/**
 * api/calendar.js — 캘린더 탭 데이터 엔드포인트 (순수 계산, FRED/Anthropic 무관 — 캐시 불필요)
 *
 * GET /api/calendar?year=YYYY&month=M   → 해당 월 그리드용 이벤트 전부
 * GET /api/calendar?upcoming=N          → 오늘부터 N일 이내 이벤트(D-day 포함, 기본 30일)
 *
 * _lib/macro-calendar.js의 getEventsForMonth/getUpcomingEvents를 그대로 노출한다.
 * 값이 자주 안 바뀌므로(하드코딩 상수 + 순수 계산) CDN s-maxage로만 캐시.
 */

import { getEventsForMonth, getUpcomingEvents } from './_lib/macro-calendar.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { year, month, upcoming } = req.query ?? {};

  if (upcoming !== undefined) {
    const days = parseInt(upcoming, 10) || 30;
    const events = getUpcomingEvents(days);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
    return res.status(200).json({ events });
  }

  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!y || !m || m < 1 || m > 12) {
    return res.status(400).json({ error: 'year, month(1~12) 파라미터가 필요합니다(또는 upcoming=N)' });
  }

  const events = getEventsForMonth(y, m);
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json({ year: y, month: m, events });
}
