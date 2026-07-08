/**
 * api/briefing-history.js — AI 시장 브리핑 히스토리 조회
 *
 * GET ?list=true          → 최근 30일 날짜 목록(최신순) 반환: { dates: ["YYYY-MM-DD", ...] }
 * GET ?date=YYYY-MM-DD     → 해당 날짜의 아침 보고/수동 생성을 함께 반환:
 *                            { date, morning: <briefing 데이터|null>, manual: <briefing 데이터|null> }
 *                            둘 다 null이면 404. 프런트가 "기본은 manual, 없으면 morning"
 *                            "manual일 때만 morning 배지로 전환 가능" 로직을 여기서 판단하지
 *                            않고 그대로 넘긴다(UI 정책은 클라이언트 책임).
 *
 * 데이터는 api/briefing.js(manual 슬롯)·api/briefing-cron.js(morning 슬롯, write-once)가
 * 생성 성공 시 각각 적재한다(briefing:day:{날짜}:morning / :manual + briefing:days
 * sorted set — api/_lib/briefing-core.js의 dayArchiveKey/persistMorningArchive/
 * persistManualArchive 참고). 이 스키마 도입 이전에 저장된 briefing:day:{날짜}(슬롯
 * 접미사 없음) 레코드는 manual로 간주해 정규화한다(하위호환, 별도 마이그레이션 불필요).
 * 이 엔드포인트는 읽기 전용이며 Anthropic을 호출하지 않는다.
 *
 * Redis 연결·조회 실패 시: 목록 조회는 빈 배열로, 날짜 조회는 에러 메시지로 우아하게 폴백한다
 * (이 페이지의 다른 기능에 영향을 주지 않음).
 *
 * 환경변수: KV_REST_API_URL / KV_REST_API_TOKEN (Upstash Redis) — 없으면 항상 빈 목록/404.
 */

import { Redis } from '@upstash/redis';
import { dayArchiveKey } from './_lib/briefing-core.js';

const DAYS_INDEX_KEY      = 'briefing:days';
const DAYS_RETENTION_DAYS = 30;
const DAYS_RETENTION_MS   = DAYS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const DATE_RE             = /^\d{4}-\d{2}-\d{2}$/;

// 슬롯 접미사가 없는 예전 키(Stage 4 이전) — 존재하면 manual로 간주.
function legacyDayArchiveKey(dateBucket) {
  return `briefing:day:${dateBucket}`;
}

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

  // ── 날짜별 브리핑 조회(morning + manual) ──────────────────────
  if (date) {
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: '잘못된 날짜 형식입니다 (YYYY-MM-DD)' });
    }
    try {
      const [morning, manualNew, legacy] = await Promise.all([
        r.get(dayArchiveKey(date, 'morning')),
        r.get(dayArchiveKey(date, 'manual')),
        r.get(legacyDayArchiveKey(date)),
      ]);
      // 슬롯 스키마 도입 이전 레코드(legacy)는 manual로 간주 — manual 슬롯이 이미
      // 있으면(스키마 도입 이후 재생성됨) legacy보다 그쪽을 우선한다.
      const manual = manualNew ?? legacy ?? null;

      if (!morning && !manual) {
        return res.status(404).json({ error: `${date} 브리핑을 찾을 수 없습니다` });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ date, morning, manual });
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
