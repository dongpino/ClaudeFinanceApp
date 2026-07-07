/**
 * api/_lib/dominance-history.js — BTC 도미넌스 일별 히스토리 축적(Upstash Redis)
 *
 * CoinGecko 무료 /global 엔드포인트는 "현재값"만 주고 과거 시계열은 유료(Pro) 전용이라
 * (2026-07-07 확인, 401 This request is limited to PRO API subscribers), 자체적으로
 * 하루 1건씩 값을 쌓아 미니차트용 히스토리를 만든다.
 *
 * 저장 패턴은 api/_lib/briefing-core.js의 일별 아카이브(brefing:day:*, briefing:days
 * sorted set)와 동일 — dominance:day:{YYYY-MM-DD} 문자열 값 + dominance:days sorted set
 * (score=기록 시각, member=날짜) 인덱스.
 *
 * 기록 시점: 홈 데이터 갱신 주기(market-data.js, 5분 캐시)에 편승해 collectBtcDominance()가
 * 호출될 때마다 recordTodayIfMissing()을 부르지만, 그날 이미 기록이 있으면 즉시 반환하므로
 * 실제 쓰기는 하루 1회(그날 첫 호출)만 일어난다 — 그 이후 재호출은 GET 1회로 끝난다.
 *
 * Redis 없거나 실패 시: 조용히 아무 것도 안 하고(기록)/빈 배열 반환(조회) — 카드 자체는
 * "히스토리 부족" 상태로 정상 동작(30일 지나면 자동으로 채워짐).
 */

import { Redis } from '@upstash/redis';

const DAY_KEY_PREFIX = 'dominance:day:';
const DAYS_INDEX_KEY = 'dominance:days';
const DAY_TTL_SEC     = 400 * 24 * 60 * 60; // 최대 사용 기간(90일)보다 넉넉하게 보존

let redisClient; // undefined: 아직 시도 안 함, null: 생성 실패/키 없음, Redis: 정상

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[dominance] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — 히스토리 축적 비활성화(현재값만 표시)');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

function todayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 오늘 값이 아직 없을 때만 1회 기록(그날의 첫 수집값을 스냅샷으로 고정) */
export async function recordTodayIfMissing(value) {
  const r = getRedis();
  if (!r) return;
  try {
    const date = todayKST();
    const key  = `${DAY_KEY_PREFIX}${date}`;
    const exists = await r.get(key);
    if (exists != null) return; // 오늘 이미 기록됨 — 재기록하지 않음
    await r.set(key, value, { ex: DAY_TTL_SEC });
    await r.zadd(DAYS_INDEX_KEY, { score: Date.now(), member: date });
  } catch (e) {
    console.error('[dominance] 일별 기록 실패:', e.message);
  }
}

/** 최근 maxDays일 히스토리 — {date, close}[] 날짜 오름차순(오래된→최신). Redis 없으면 빈 배열. */
export async function getRecentHistory(maxDays = 30) {
  const r = getRedis();
  if (!r) return [];
  try {
    const dates = await r.zrange(DAYS_INDEX_KEY, -maxDays, -1);
    if (!dates || dates.length === 0) return [];
    const keys   = dates.map(d => `${DAY_KEY_PREFIX}${d}`);
    const values = await r.mget(...keys);
    return dates
      .map((date, i) => ({ date, close: values[i] }))
      .filter(row => row.close != null);
  } catch (e) {
    console.error('[dominance] 히스토리 조회 실패:', e.message);
    return [];
  }
}
