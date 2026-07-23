/**
 * api/_lib/health.js — 데이터 소스 관측성 1단계: 수집 결과 기록층 + 상태 판정
 *
 * 모든 외부 수집 지점은 각 수집기의 최말단 fetch 호출을 trackedFetch()로 바꿔
 * 계측한다(공통 fetch 래퍼가 없어 파일별로 삽입 — 대신 URL 호스트로 소스를
 * 자동 분류해 한 줄 교체로 끝나게 했다). 성공/실패는 Redis에 누적된다.
 *
 * ── 절대 원칙(요구사항 3) ─────────────────────────────────────────────
 * 기록이 수집을 절대 깨뜨리면 안 된다. 그래서:
 *  · recordSuccess/recordFailure는 fire-and-forget(호출측이 await 안 함).
 *  · 실제 Redis 쓰기는 persist() 안에서 try/catch로 격리 — 어떤 에러도 삼키고
 *    로그만 남긴다. Redis 미설정이면 조용히 no-op.
 *  · trackedFetch는 fetch를 그대로 감싸기만 하므로(응답 body 미소비) 기록 경로가
 *    실패해도 수집 로직은 원래대로 Response를 받는다.
 *
 * ── 저장 스키마 ──────────────────────────────────────────────────────
 *  health:src:{source}          (해시, TTL 없음)
 *     lastSuccessAt, lastFailureAt, lastError, consecutiveFailures
 *  health:daily:{source}:{YYYY-MM-DD KST}  (해시, TTL 7일)
 *     success, failure   — 키 이름에 KST 날짜가 들어가 자정에 새 키로 넘어가며
 *                          "자정 리셋" 효과 + 7일치 추이 보관을 동시에 만족.
 */

import { Redis } from '@upstash/redis';

// 대상 소스 식별자(요구사항 1) — /api/health가 이 순서로 상태를 보고한다.
export const SOURCES = [
  'naver', 'naver-index', 'yahoo', 'daum', 'finnhub', 'twelvedata', 'cnbc', 'coingecko',
  'binance', 'bybit', 'alternative-me', 'fred', 'bok',
  'rss-yna', 'rss-asiae', 'rss-edaily', 'rss-coindesk',
];

// 소스별 기대 갱신 주기(초). lastSuccess가 이 값의 3배 이내면 ok, 초과면 stale.
// 시세류는 수 분, FRED/RSS는 수 시간(요구사항 5).
const EXPECTED_INTERVAL_SEC = {
  'naver': 300, 'naver-index': 300, 'yahoo': 300, 'daum': 300, 'finnhub': 300, 'twelvedata': 900, 'cnbc': 300,
  'coingecko': 300, 'binance': 300, 'bybit': 300, 'alternative-me': 3600,
  'fred': 43200,                     // FRED 월간 데이터 + 12h 캐시 → 12h
  'bok': 43200,                      // 한국은행 기준금리(연 8회 변경) + 6h 캐시 → 넉넉히 12h
  'rss-yna': 10800, 'rss-asiae': 10800, 'rss-edaily': 10800, 'rss-coindesk': 10800, // 3h
};
const DEFAULT_INTERVAL_SEC = 600;

const DAILY_TTL_SEC = 7 * 24 * 60 * 60; // 7일 추이 보관
const DOWN_THRESHOLD = 3;               // consecutiveFailures 이 값 이상이면 down

// ── URL → 소스 분류 ──────────────────────────────────────────────────
// 호스트/경로로 결정적 분류(추정 아님). 미지의 호스트(CBOE VIX CDN 등 비대상)는
// null → 기록하지 않는다.
export function classifySource(url) {
  const u = String(url);
  // Finnhub /stock/candle는 무료 티어에서 상시 403(finnhub.js가 Promise.allSettled로
  // 정상 흡수하는 "예상된 실패")이므로 health 신호에서 제외 — 가용성 판단은 /quote·/search로만.
  if (u.includes('finnhub.io'))      return u.includes('/stock/candle') ? null : 'finnhub';
  if (u.includes('twelvedata.com'))  return 'twelvedata';
  // Yahoo v8 chart: 코스피/코스닥 지수 폴오버 전용(yahoo-index.js). query1/query2 공통.
  if (u.includes('finance.yahoo.com')) return 'yahoo';
  // Daum 금융: 개별 KR 종목 현재가/일봉 폴오버 전용(daum-stock.js).
  if (u.includes('finance.daum.net')) return 'daum';
  // CNBC: 미국 지수(나스닥/다우/S&P500/SOX/VIX/US10Y/DXY) quote 단일 소스(us-indices.js).
  if (u.includes('cnbc.com'))        return 'cnbc';
  if (u.includes('coingecko.com'))   return 'coingecko';
  if (u.includes('bybit.com'))       return 'bybit';
  if (u.includes('binance'))         return 'binance'; // binance.com / data-api.binance.vision
  if (u.includes('alternative.me'))  return 'alternative-me';
  if (u.includes('stlouisfed.org'))  return 'fred';
  if (u.includes('ecos.bok.or.kr'))  return 'bok'; // 한국은행 ECOS(기준금리)
  if (u.includes('yna.co.kr'))       return 'rss-yna';
  if (u.includes('asiae.co.kr'))     return 'rss-asiae';
  if (u.includes('edaily.co.kr'))    return 'rss-edaily';
  if (u.includes('coindesk.com'))    return 'rss-coindesk';
  // 네이버: 개별종목(검색 ac.* / 종목 /api/stock/)은 'naver', 그 외 지수/시장지표는 'naver-index'
  if (u.includes('stock.naver.com') || u.includes('finance.naver.com')) {
    if (u.includes('ac.stock.naver.com') || u.includes('/api/stock/')) return 'naver';
    return 'naver-index';
  }
  return null;
}

// ── Redis (user-prefs.js/macro.js와 동일 패턴: 지연 생성, 실패 시 null) ──
let redisClient; // undefined: 미시도, null: 미설정/실패, Redis: 정상
function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[health] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — 기록 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

function kstToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function summarize(err) {
  return String(err?.message ?? err ?? 'unknown').slice(0, 200);
}

// ── 기록(fire-and-forget) ────────────────────────────────────────────
export function recordSuccess(source) {
  if (!source) return;
  void persist(source, true, null);
}
export function recordFailure(source, err) {
  if (!source) return;
  void persist(source, false, err);
}

async function persist(source, ok, err) {
  const r = getRedis();
  if (!r) return;
  try {
    const now = new Date().toISOString();
    const dailyKey = `health:daily:${source}:${kstToday()}`;
    const srcKey   = `health:src:${source}`;
    const p = r.pipeline();
    if (ok) {
      p.hset(srcKey, { lastSuccessAt: now, consecutiveFailures: 0 });
      p.hincrby(dailyKey, 'success', 1);
    } else {
      p.hset(srcKey, { lastFailureAt: now, lastError: summarize(err) });
      p.hincrby(srcKey, 'consecutiveFailures', 1);
      p.hincrby(dailyKey, 'failure', 1);
    }
    p.expire(dailyKey, DAILY_TTL_SEC);
    await p.exec();
  } catch (e) {
    // 기록층 에러는 무시(로그만) — 수집에 절대 전파하지 않는다(요구사항 3).
    console.warn(`[health] 기록 실패(${source}) — 무시: ${e.message}`);
  }
}

/**
 * fetch 드롭인 래퍼 — URL로 소스를 분류해 성공(res.ok)/실패(throw 또는 !res.ok)를
 * 기록한다. 기록은 fire-and-forget이라 수집 지연·실패에 영향 없음. body를 소비하지
 * 않으므로 호출측은 평소처럼 res.json()/res.text()를 그대로 쓴다.
 */
export async function trackedFetch(url, options) {
  const source = classifySource(url);
  try {
    const res = await fetch(url, options);
    if (source) {
      if (res.ok) recordSuccess(source);
      else recordFailure(source, new Error(`HTTP ${res.status}`));
    }
    return res;
  } catch (err) {
    if (source) recordFailure(source, err);
    throw err;
  }
}

// ── 상태 판정 + 스냅샷(조회 전용, 외부 API 미접속) ───────────────────
function judgeStatus(source, srcHash, nowMs) {
  const cf = Number(srcHash?.consecutiveFailures ?? 0);
  const lastSuccessAt = srcHash?.lastSuccessAt ?? null;
  const lastFailureAt = srcHash?.lastFailureAt ?? null;

  if (!lastSuccessAt && !lastFailureAt) return 'unknown'; // 아직 한 번도 수집 안 됨
  if (cf >= DOWN_THRESHOLD) return 'down';
  if (!lastSuccessAt) return 'stale'; // 실패만 있고(cf<3) 성공 이력 없음
  const ageSec = (nowMs - Date.parse(lastSuccessAt)) / 1000;
  const expected = EXPECTED_INTERVAL_SEC[source] ?? DEFAULT_INTERVAL_SEC;
  return ageSec <= expected * 3 ? 'ok' : 'stale';
}

/**
 * 소스별 상태 + 원시 수치. Redis만 읽고 외부 API는 치지 않는다(요구사항 6).
 * @returns {Array<{source,status,lastSuccessAt,lastFailureAt,lastError,consecutiveFailures,todayRate,today}>}
 */
export async function getHealthSnapshot() {
  const r = getRedis();
  const nowMs = Date.now();
  const day = kstToday();

  if (!r) {
    return SOURCES.map(source => ({
      source, status: 'unknown', lastSuccessAt: null, lastFailureAt: null,
      lastError: null, consecutiveFailures: 0, todayRate: null, today: { success: 0, failure: 0 },
    }));
  }

  const pipe = r.pipeline();
  for (const s of SOURCES) {
    pipe.hgetall(`health:src:${s}`);
    pipe.hgetall(`health:daily:${s}:${day}`);
  }
  const raw = await pipe.exec(); // [srcHash, dailyHash, srcHash, dailyHash, ...]

  return SOURCES.map((source, i) => {
    const srcHash = raw[i * 2]     || null;
    const daily   = raw[i * 2 + 1] || null;
    const success = Number(daily?.success ?? 0);
    const failure = Number(daily?.failure ?? 0);
    const total   = success + failure;
    return {
      source,
      status: judgeStatus(source, srcHash, nowMs),
      lastSuccessAt: srcHash?.lastSuccessAt ?? null,
      lastFailureAt: srcHash?.lastFailureAt ?? null,
      // 마지막 실패 원인 요약(persist가 저장) — 진단 시 429/타임아웃/스키마 구분에 씀.
      // 그동안 스냅샷에서 누락돼 /api/health로는 안 보였다(관측성 갭 보완).
      lastError: srcHash?.lastError ?? null,
      consecutiveFailures: Number(srcHash?.consecutiveFailures ?? 0),
      todayRate: total ? Math.round((success / total) * 100) / 100 : null,
      today: { success, failure },
    };
  });
}
