/**
 * api/macro.js — 브리핑 탭 "매크로 현황" 데이터 (FOMC 기준금리 + CPI + 실업률)
 *
 * FRED(Federal Reserve Economic Data) API 사용 — series_id별 최신 관측치 조회.
 *   CPI:    CPIAUCSL(월간, NSA) → 최신 YoY%/전월비(MoM)/기준월 + 최근 12개월 YoY 추이
 *   기준금리: DFEDTARU/DFEDTARL(일간) → 목표범위 상한/하한
 *   실업률:  UNRATE(월간) → 최신치 + 기준월
 * 발표 일정(FOMC 회의/CPI 발표)은 _lib/macro-calendar.js의 하드코딩 상수 + D-day 계산.
 * "시장 캘린더"(다가오는 이벤트, 30일 이내)는 FOMC/CPI에 선물옵션 만기/MSCI 리밸런싱/
 * 실적 발표까지 통합한 getUpcomingEvents()를 그대로 실어 보낸다(순수 계산, FRED 무관).
 *
 * 캐시: Upstash Redis(briefing-core.js와 동일 패턴) TTL 12시간 — 월간 데이터라 충분.
 *       Redis 없거나 실패 시 인메모리 폴백, 그마저 없으면 FRED 직접 조회.
 * 환경변수: FRED_API_KEY (필수), KV_REST_API_URL / KV_REST_API_TOKEN (선택 — 없으면
 *           서버리스 인스턴스 인메모리 캐시만 사용)
 */

import { Redis } from '@upstash/redis';
import { getNextFomcMeeting, getNextCpiRelease, getUpcomingEvents } from './_lib/macro-calendar.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const CACHE_TTL_SEC = 12 * 60 * 60; // 12시간
const CACHE_KEY = 'macro:v1';

function r2(n) { return Math.round(n * 100) / 100; }

function getKey() {
  const k = process.env.FRED_API_KEY;
  if (!k) throw new Error('FRED_API_KEY 환경변수가 설정되지 않았습니다');
  return k;
}

async function fetchSeries(seriesId, { limit = 1, sort = 'desc' } = {}) {
  const key = getKey();
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=${sort}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FRED HTTP ${res.status} (${seriesId}) — ${body.slice(0, 150)}`);
  }
  const data = await res.json();
  const obs = (data.observations ?? []).filter(o => o.value !== '.');
  if (!obs.length) throw new Error(`FRED ${seriesId}: 유효 관측치 없음`);
  return obs;
}

// 최근 26개월로 최신 YoY/MoM + 12개월 YoY 추이 계산.
// sort_order=asc + limit은 "가장 오래된 N개"가 되어버리므로(계열이 1947년부터 시작),
// desc로 최신 N개를 받은 뒤 오름차순으로 뒤집어야 한다.
async function fetchCPI() {
  const obs = (await fetchSeries('CPIAUCSL', { limit: 26, sort: 'desc' })).reverse();
  const vals = obs.map(o => parseFloat(o.value));
  const dates = obs.map(o => o.date);
  const n = vals.length;
  if (n < 13) throw new Error(`CPIAUCSL 데이터 부족: ${n}개월`);

  const yoyAt = i => (i >= 12 ? r2((vals[i] / vals[i - 12] - 1) * 100) : null);
  const latest = n - 1;

  const trend = [];
  for (let i = Math.max(12, n - 12); i < n; i++) {
    const v = yoyAt(i);
    if (v !== null) trend.push({ month: dates[i].slice(0, 7), yoy: v });
  }

  return {
    yoy: yoyAt(latest),
    mom: r2((vals[latest] / vals[latest - 1] - 1) * 100),
    refMonth: dates[latest].slice(0, 7),
    trend,
  };
}

async function fetchRateRange() {
  const [upper, lower] = await Promise.all([
    fetchSeries('DFEDTARU', { limit: 1, sort: 'desc' }),
    fetchSeries('DFEDTARL', { limit: 1, sort: 'desc' }),
  ]);
  return {
    upper: r2(parseFloat(upper[0].value)),
    lower: r2(parseFloat(lower[0].value)),
    asOf: upper[0].date,
  };
}

async function fetchUnemployment() {
  const obs = await fetchSeries('UNRATE', { limit: 1, sort: 'desc' });
  return { rate: r2(parseFloat(obs[0].value)), refMonth: obs[0].date.slice(0, 7) };
}

// ── Redis 캐시 (briefing-core.js와 동일 패턴: 지연 생성, 실패 시 null 폴백) ──
let redisClient; // undefined: 아직 시도 안 함, null: 생성 실패/키 없음, Redis: 정상

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[macro] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — Redis 캐시 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

async function getCached() {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(CACHE_KEY);
  } catch (e) {
    console.error('[macro] Redis GET 실패 — 캐시 없이 진행:', e.message);
    return null;
  }
}

async function setCached(data) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(CACHE_KEY, data, { ex: CACHE_TTL_SEC });
  } catch (e) {
    console.error('[macro] Redis 저장 실패(응답 자체는 정상 반환):', e.message);
  }
}

// Redis도 없을 때의 최소 폴백 — 같은 서버리스 인스턴스 내에서만 유효(콜드 스타트 시 초기화)
let memCache = null;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const cached = await getCached();
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }
  if (memCache && Date.now() - memCache.ts < CACHE_TTL_SEC * 1000) {
    res.setHeader('X-Cache', 'HIT-MEM');
    return res.status(200).json(memCache.data);
  }

  try {
    const [cpiResult, rateResult, unemploymentResult] = await Promise.allSettled([
      fetchCPI(), fetchRateRange(), fetchUnemployment(),
    ]);

    if (cpiResult.status === 'rejected') console.warn('[macro] CPI 조회 실패:', cpiResult.reason.message);
    if (rateResult.status === 'rejected') console.warn('[macro] 기준금리 조회 실패:', rateResult.reason.message);
    if (unemploymentResult.status === 'rejected') console.warn('[macro] 실업률 조회 실패:', unemploymentResult.reason.message);

    const fomcRate = rateResult.status === 'fulfilled' ? rateResult.value : null;
    const cpi      = cpiResult.status === 'fulfilled' ? cpiResult.value : null;

    if (!fomcRate && !cpi)
      throw new Error('FRED 데이터 조회 전부 실패');

    const data = {
      updated_at: new Date().toISOString(),
      fomc: { rate: fomcRate, next: getNextFomcMeeting() },
      cpi:  cpi ? { ...cpi, next: getNextCpiRelease() } : null,
      unemployment: unemploymentResult.status === 'fulfilled' ? unemploymentResult.value : null,
      upcoming: getUpcomingEvents(30),
    };

    memCache = { data, ts: Date.now() };
    await setCached(data);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (e) {
    console.error('[macro] 조회 실패:', e.message);
    return res.status(500).json({ error: '매크로 데이터 조회 실패', details: e.message });
  }
}
