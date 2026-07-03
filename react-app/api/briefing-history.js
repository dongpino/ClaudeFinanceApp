/**
 * api/briefing-history.js — AI 시장 브리핑 히스토리 조회
 *
 * GET ?list=true          → 최근 30일 날짜 목록(최신순) 반환: { dates: ["YYYY-MM-DD", ...] }
 * GET ?date=YYYY-MM-DD     → 해당 날짜의 브리핑 반환(api/briefing.js 응답과 동일한 shape).
 *                            없으면 404.
 *
 * 데이터는 api/briefing.js가 브리핑 생성에 성공할 때마다 함께 적재한다
 * (briefing:day:{날짜} + briefing:days sorted set). 이 엔드포인트는 읽기 전용이며
 * Anthropic을 호출하지 않는다.
 *
 * Redis 연결·조회 실패 시: 목록 조회는 빈 배열로, 날짜 조회는 에러 메시지로 우아하게 폴백한다
 * (이 페이지의 다른 기능에 영향을 주지 않음).
 *
 * 환경변수: KV_REST_API_URL / KV_REST_API_TOKEN (Upstash Redis) — 없으면 항상 빈 목록/404.
 */

import { Redis } from '@upstash/redis';

const DAYS_INDEX_KEY      = 'briefing:days';
const DAYS_RETENTION_DAYS = 30;
const DAYS_RETENTION_MS   = DAYS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const DATE_RE             = /^\d{4}-\d{2}-\d{2}$/;

// ── Redis 클라이언트 (지연 생성, 환경변수 없으면 null → 호출부에서 폴백) ──
let redisClient;

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[briefing-history] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — 히스토리 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const date = req.query?.date ?? null;

  const r = getRedis();
  if (!r) {
    if (date) {
      return res.status(404).json({ error: '히스토리 기능을 사용할 수 없습니다(Redis 미설정)' });
    }
    return res.status(200).json({ dates: [] });
  }

  // ── 날짜별 브리핑 조회 ───────────────────────────────────────
  if (date) {
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: '잘못된 날짜 형식입니다 (YYYY-MM-DD)' });
    }
    try {
      const data = await r.get(`briefing:day:${date}`);
      if (!data) {
        return res.status(404).json({ error: `${date} 브리핑을 찾을 수 없습니다` });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(data);
    } catch (e) {
      console.error('[briefing-history] 날짜 조회 실패:', e.message);
      return res.status(500).json({ error: '브리핑 히스토리 조회에 실패했습니다' });
    }
  }

  // ── 날짜 목록(최신순) ────────────────────────────────────────
  try {
    const cutoff = Date.now() - DAYS_RETENTION_MS;
    try {
      await r.zremrangebyscore(DAYS_INDEX_KEY, 0, cutoff);
    } catch (e) {
      // 정리 실패는 목록 조회 자체를 막지 않는다 — 로그만 남김.
      console.error('[briefing-history] 오래된 인덱스 정리 실패:', e.message);
    }

    const dates = await r.zrange(DAYS_INDEX_KEY, 0, -1, { rev: true });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ dates: dates ?? [] });
  } catch (e) {
    console.error('[briefing-history] 목록 조회 실패:', e.message);
    return res.status(200).json({ dates: [], error: '히스토리 목록을 불러오지 못했습니다' });
  }
}
