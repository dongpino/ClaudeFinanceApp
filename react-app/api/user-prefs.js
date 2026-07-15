/**
 * api/user-prefs.js — 1인용 사용자 설정 저장소 (2차: 우미 투자 평단가)
 *
 * GET  /api/user-prefs?key=avgPrices  — 저장된 값 조회
 * PUT  /api/user-prefs                — body { key: 'avgPrices', value: {...} } 저장
 *
 * 인증: GET/PUT 둘 다 Authorization: Bearer {EDIT_TOKEN} 필요. 평단가는 읽기만으로도
 * 민감한 정보(매수 원가 노출)라 조회도 토큰 없이는 막는다 — CRON_SECRET(api/
 * briefing-cron.js)과 동일한 "환경변수와 정확히 일치하는 Bearer 토큰" 패턴이다.
 * EDIT_TOKEN은 Vercel 환경변수로 직접 등록해야 한다(.env.example 참고, 코드에
 * 기본값 없음 — 미설정이면 어떤 요청도 통과 못 함).
 *
 * 저장 형식: Redis 키 user:prefs:{key}, TTL 없음 — 다른 api/*.js의 시간 버킷
 * 캐시(만료 있음)와 달리 이건 영속 사용자 데이터라 만료되면 안 된다.
 *
 * key 화이트리스트: 'avgPrices'만 허용(임의 키를 저장하는 범용 KV로 새는 것 방지).
 * value 검증(avgPrices): WATCHLIST_IDS의 4개 심볼만 허용, 값은 양수 유한 숫자만
 * 통과(그 외는 null=미설정 취급), 그 외 알 수 없는 필드는 응답에서 조용히 빠진다.
 */
import { Redis } from '@upstash/redis';
import { WATCHLIST_IDS } from './_collectors/watchlist.js';

let redisClient; // undefined: 미시도, null: 설정 없음/실패, Redis: 정상
function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[user-prefs] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — Redis 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

function sanitizeAvgPrices(value) {
  const out = {};
  for (const sym of WATCHLIST_IDS) {
    const v = value?.[sym];
    out[sym] = (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : null;
  }
  return out;
}

const VALIDATORS = { avgPrices: sanitizeAvgPrices };

function isAuthorized(req) {
  const secret = process.env.EDIT_TOKEN;
  if (!secret) return false; // 서버에 토큰 자체가 없으면 무조건 거부(빈 값끼리 일치 방지)
  return (req.headers.authorization ?? '') === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(500).json({ error: 'Redis 설정 안 됨 (KV_REST_API_URL/KV_REST_API_TOKEN 확인)' });
  }

  if (req.method === 'GET') {
    const key = req.query?.key;
    if (!VALIDATORS[key]) {
      return res.status(400).json({ error: `알 수 없는 key: ${key}` });
    }
    try {
      const stored = await redis.get(`user:prefs:${key}`);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ key, value: stored ?? {} });
    } catch (e) {
      console.error('[user-prefs] GET 실패:', e.message);
      return res.status(500).json({ error: 'Redis 조회 실패' });
    }
  }

  // PUT
  const { key, value } = req.body ?? {};
  const validator = VALIDATORS[key];
  if (!validator) {
    return res.status(400).json({ error: `알 수 없는 key: ${key}` });
  }
  const sanitized = validator(value);
  try {
    await redis.set(`user:prefs:${key}`, sanitized); // TTL 없음 — 영속 사용자 데이터
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ key, value: sanitized });
  } catch (e) {
    console.error('[user-prefs] PUT 실패:', e.message);
    return res.status(500).json({ error: 'Redis 저장 실패' });
  }
}
