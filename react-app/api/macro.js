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
 *
 * ── 캐시 포이즈닝 방지(2026-07-07) ──────────────────────────────
 * 예전엔 fomc/cpi/unemployment 중 하나라도 FRED 호출이 실패하면 그 필드가 null로
 * "macro:v1"에 12시간 TTL로 그대로 박혀, 캐시가 살아있는 동안(getCached() HIT)은
 * 재시도 자체가 일어나지 않아 일시 장애가 12시간짜리 영구 장애처럼 보였다(DFEDTARU/L
 * 일시 실패 사례로 확인됨).
 * 지금은 필드별로 독립적으로 승계한다: 이번 fetch가 실패한 필드는 macro:v1:latest
 * (7일 TTL, 12시간 캐시가 다 만료돼도 살아있는 별도 키)에 저장된 마지막 성공값을
 * 그대로 이어받고, 그 필드의 fetchedAt(마지막 실제 FRED 성공 시각)도 함께 승계한다.
 * 전 필드가 실패하고 승계할 값도 전혀 없을 때만 그 필드가 null이 된다 — 그 경우에도
 * 캐시 쓰기 자체는 막지 않고 성공한 다른 필드는 정상 저장한다.
 */

import { Redis } from '@upstash/redis';
import { getNextFomcMeeting, getNextCpiRelease, getUpcomingEvents } from './_lib/macro-calendar.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const CACHE_TTL_SEC = 12 * 60 * 60; // 12시간
const CACHE_KEY = 'macro:v1';

// "마지막 성공값" 승계용 별도 키 — macro:v1(12시간)과 독립적으로 7일간 유지.
// macro:v1이 만료된 뒤에도(하루 이상 FRED가 계속 실패해도) 필드별 승계가 가능하게 한다.
const LATEST_KEY     = 'macro:v1:latest';
const LATEST_TTL_SEC = 7 * 24 * 60 * 60; // 7일 (briefing-core.js의 latest 캐시와 동일 관례)

function r2(n) { return Math.round(n * 100) / 100; }

function getKey() {
  const k = process.env.FRED_API_KEY;
  if (!k) throw new Error('FRED_API_KEY 환경변수가 설정되지 않았습니다');
  return k;
}

const RETRY_DELAY_MS = 700; // 재시도 전 대기(500ms~1s 권장 범위 내)

async function fetchSeriesOnce(seriesId, { limit, sort }) {
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

// 일시적 네트워크/FRED 오류(타임아웃, 순간 5xx 등)를 흡수하기 위해 1회 재시도.
// 재시도까지 실패하면 그대로 던져 호출부가 이전 값 승계 여부를 판단하게 한다.
async function fetchSeries(seriesId, { limit = 1, sort = 'desc' } = {}) {
  try {
    return await fetchSeriesOnce(seriesId, { limit, sort });
  } catch (e) {
    console.warn(`[macro] FRED ${seriesId} 1차 실패(${e.message}) — ${RETRY_DELAY_MS}ms 후 재시도`);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    return fetchSeriesOnce(seriesId, { limit, sort });
  }
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

// upper/lower 중 하나만 실패해도 Promise.all이었다면 성공한 쪽 결과까지 묻히고
// "무엇이 실패했는지" 알 수 없는 에러만 남는다 — allSettled로 격리해 어느 쪽이
// 실패했는지 명확히 남긴다(목표범위는 두 값이 다 있어야 의미가 있어 부분 성공이어도
// 결과 자체는 여전히 실패로 처리 — 상위 handler가 이전 값 전체를 승계한다).
async function fetchRateRange() {
  const [upperResult, lowerResult] = await Promise.allSettled([
    fetchSeries('DFEDTARU', { limit: 1, sort: 'desc' }),
    fetchSeries('DFEDTARL', { limit: 1, sort: 'desc' }),
  ]);
  if (upperResult.status === 'rejected' || lowerResult.status === 'rejected') {
    const detail = [
      upperResult.status === 'rejected' ? `DFEDTARU: ${upperResult.reason.message}` : null,
      lowerResult.status === 'rejected' ? `DFEDTARL: ${lowerResult.reason.message}` : null,
    ].filter(Boolean).join(' / ');
    throw new Error(`기준금리 목표범위 일부 실패 — ${detail}`);
  }
  const upper = upperResult.value, lower = lowerResult.value;
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

// "마지막 성공값" 승계용 — macro:v1과 별개 키라 12시간 캐시가 만료돼도 살아있다.
async function getLatestGood() {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(LATEST_KEY);
  } catch (e) {
    console.error('[macro] latest 조회 실패:', e.message);
    return null;
  }
}

async function setLatestGood(data) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(LATEST_KEY, data, { ex: LATEST_TTL_SEC });
  } catch (e) {
    console.error('[macro] latest 저장 실패:', e.message);
  }
}

// Redis도 없을 때의 최소 폴백 — 같은 서버리스 인스턴스 내에서만 유효(콜드 스타트 시 초기화)
let memCache = null;

// 이번 fetch 결과(성공 시 값, 실패 시 undefined)를 이전 값(previous)과 병합한다.
// 성공하면 새 값 + 지금 시각을 fetchedAt으로 기록, 실패하면 previous의 값+fetchedAt을
// 그대로 승계(있으면), 승계할 것도 없으면 null.
function mergeField(newValue, previousValue, label) {
  if (newValue != null) {
    return { ...newValue, fetchedAt: new Date().toISOString() };
  }
  if (previousValue) {
    console.warn(`[macro] ${label} 승계(마지막 성공: ${previousValue.fetchedAt})`);
    return previousValue;
  }
  return null;
}

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
    // macro:v1이 만료돼 여기 도달했다는 건 재조회가 필요하다는 뜻 — 그 전에 "마지막
    // 성공값"(12시간보다 오래 살아있는 latest 키)을 먼저 읽어 필드별 승계 후보로 둔다.
    const previous = (await getLatestGood()) ?? memCache?.data ?? null;

    const [cpiResult, rateResult, unemploymentResult] = await Promise.allSettled([
      fetchCPI(), fetchRateRange(), fetchUnemployment(),
    ]);

    if (cpiResult.status === 'rejected') console.warn('[macro] CPI 조회 실패:', cpiResult.reason.message);
    if (rateResult.status === 'rejected') console.warn('[macro] 기준금리 조회 실패:', rateResult.reason.message);
    if (unemploymentResult.status === 'rejected') console.warn('[macro] 실업률 조회 실패:', unemploymentResult.reason.message);

    const fomcRate = mergeField(
      rateResult.status === 'fulfilled' ? rateResult.value : null,
      previous?.fomc?.rate ?? null,
      '기준금리',
    );
    const cpi = mergeField(
      cpiResult.status === 'fulfilled' ? cpiResult.value : null,
      previous?.cpi ?? null,
      'CPI',
    );
    const unemployment = mergeField(
      unemploymentResult.status === 'fulfilled' ? unemploymentResult.value : null,
      previous?.unemployment ?? null,
      '실업률',
    );

    // 이번 fetch·승계를 다 합쳐도 전 필드가 null인 최악의 경우(첫 실행이자 전부 실패
    // 등)에만 에러로 처리한다 — 하나라도 값이 있으면 그 필드는 정상 저장해야 한다.
    if (!fomcRate && !cpi && !unemployment)
      throw new Error('FRED 데이터 조회 전부 실패, 승계할 이전 값도 없음');

    const data = {
      updated_at: new Date().toISOString(),
      fomc: { rate: fomcRate, next: getNextFomcMeeting() },
      cpi:  cpi ? { ...cpi, next: getNextCpiRelease() } : null,
      unemployment,
      upcoming: getUpcomingEvents(30),
    };

    memCache = { data, ts: Date.now() };
    await setCached(data);
    await setLatestGood(data);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (e) {
    console.error('[macro] 조회 실패:', e.message);
    return res.status(500).json({ error: '매크로 데이터 조회 실패', details: e.message });
  }
}
