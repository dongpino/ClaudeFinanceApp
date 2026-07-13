/**
 * api/macro-history.js — 매크로 지표 히스토리 (프론트 차트용 시계열)
 *
 * GET /api/macro-history?indicator={fomc|cpi|unemployment}
 *
 * FRED(Federal Reserve Economic Data) 시리즈를 날짜 범위로 직접 조회한다 — macro.js의
 * "최신 1개 관측치"와 달리 여기는 차트에 바로 먹일 수 있는 다개 관측치 시계열이 목적이라
 * observation_start(+frequency/units)로 FRED에 범위를 넘긴다.
 *   fomc         → DFEDTARU/DFEDTARL(일간→frequency=m 월간 집계), 최근 5년
 *   cpi          → CPIAUCSL/CPILFESL, units=pc1(전년동월비 %), 최근 3년(월간 시리즈라
 *                  frequency 지정 불필요)
 *   unemployment → UNRATE, 최근 3년(월간 시리즈)
 * indicator는 위 3개 화이트리스트만 허용 — 그 외 값은 400(임의의 FRED series_id를
 * 프록시하는 통로가 되지 않도록 막는다).
 *
 * 캐시: macro.js와 동일 패턴(Upstash Redis, 지연 생성, 실패 시 조용히 비활성화) —
 *   macro:hist:v1:{indicator}   TTL 24시간(요청 캐시)
 *   macro:hist:last:{indicator} TTL 없음(무기한 영속 — 성공할 때마다 덮어쓰는 최후의
 *   폴백본이라 스스로 만료되면 안 된다. FRED가 며칠씩 계속 실패해도 이 키만은 살아있어야
 *   폴백이 의미가 있다). macro.js의 "캐시 포이즈닝 방지" 교훈 그대로, FRED 조회가
 *   비거나 실패하면 macro:hist:v1/macro:hist:last 둘 다 절대 쓰지 않는다(성공한
 *   응답만 캐시에 남긴다 — null/에러를 캐시했다가 재시도가 막히는 사고를 반복하지
 *   않기 위함).
 * 환경변수: FRED_API_KEY(필수), KV_REST_API_URL/KV_REST_API_TOKEN(선택 — 없으면 인메모리
 *           캐시만 사용, macro.js와 동일).
 */

import { Redis } from '@upstash/redis';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const ALLOWED_INDICATORS = ['fomc', 'cpi', 'unemployment'];

const CACHE_TTL_SEC = 24 * 60 * 60; // 24시간 — macro:hist:v1:*(요청 캐시)에만 적용.
// macro:hist:last:*(마지막 성공값)는 TTL 없이 무기한 저장한다 — setLatestGood 참고.

function cacheKey(indicator)  { return `macro:hist:v1:${indicator}`; }
function latestKey(indicator) { return `macro:hist:last:${indicator}`; }

function r2(n) { return Math.round(n * 100) / 100; }

function getKey() {
  const k = process.env.FRED_API_KEY;
  if (!k) throw new Error('FRED_API_KEY 환경변수가 설정되지 않았습니다');
  return k;
}

function isoDateYearsAgo(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

const RETRY_DELAY_MS = 700; // macro.js와 동일 — 일시적 오류 흡수용 1회 재시도 전 대기

// FRED series_id를 날짜 범위로 조회 — sort_order=asc라 바로 오름차순 시계열이 나온다
// (macro.js의 "최신 1개"용 desc+limit+reverse 패턴과 달리 여기는 처음부터 asc 요청).
async function fetchSeriesRangeOnce(seriesId, { start, frequency, units } = {}) {
  const key = getKey();
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: key,
    file_type: 'json',
    sort_order: 'asc',
  });
  if (start)     params.set('observation_start', start);
  if (frequency) params.set('frequency', frequency);
  if (units)     params.set('units', units);

  const url = `${FRED_BASE}?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FRED HTTP ${res.status} (${seriesId}) — ${body.slice(0, 150)}`);
  }
  const data = await res.json();
  // FRED는 결측 관측치를 value:"." 문자열로 준다 — 프론트 차트용이므로 null 관측치는
  // 아예 제거한다(요구사항: "null 관측치는 제거").
  const points = (data.observations ?? [])
    .filter(o => o.value !== '.' && o.value != null)
    .map(o => ({ date: o.date, value: r2(parseFloat(o.value)) }));
  if (!points.length) throw new Error(`FRED ${seriesId}: 유효 관측치 없음`);
  return points;
}

async function fetchSeriesRange(seriesId, opts) {
  try {
    return await fetchSeriesRangeOnce(seriesId, opts);
  } catch (e) {
    console.warn(`[macro-history] FRED ${seriesId} 1차 실패(${e.message}) — ${RETRY_DELAY_MS}ms 후 재시도`);
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    return fetchSeriesRangeOnce(seriesId, opts);
  }
}

// 두 시리즈를 함께 조회 — 하나만 실패해도 allSettled로 어느 쪽이 실패했는지 구분해
// 에러 메시지에 남긴다(macro.js의 fetchRateRange와 동일 패턴). 목표범위/헤드라인+근원
// CPI 둘 다 "짝"으로 의미가 있는 값이라 부분 성공이어도 이 indicator 전체는 실패로
// 처리하고, 상위 handler가 latest 캐시로 폴백할지 판단한다.
async function fetchPairSettled(idA, idB, opts) {
  const [a, b] = await Promise.allSettled([
    fetchSeriesRange(idA, opts),
    fetchSeriesRange(idB, opts),
  ]);
  if (a.status === 'rejected' || b.status === 'rejected') {
    const detail = [
      a.status === 'rejected' ? `${idA}: ${a.reason.message}` : null,
      b.status === 'rejected' ? `${idB}: ${b.reason.message}` : null,
    ].filter(Boolean).join(' / ');
    throw new Error(`시리즈 일부 실패 — ${detail}`);
  }
  return [a.value, b.value];
}

// 값이 바뀐 지점만 뽑아 변경 이력으로 만든다 — 반드시 frequency 지정 없는 일간 원본
// 시계열에 대해서만 호출할 것. frequency=m(월평균) 시계열에 대해 이 함수를 쓰면 변경월의
// 평균값이 전후 값과 섞여 계단이 번지면서 25bp 표준 단위가 아닌 허위 폭(예: 8bp)이
// 나온다 — 실측으로 확인된 문제라 changes 추출은 항상 일간 원본에서만 한다(아래
// INDICATOR_BUILDERS.fomc 참고).
function extractRateChanges(points) {
  const changes = [];
  for (let i = 1; i < points.length; i++) {
    const deltaBp = Math.round((points[i].value - points[i - 1].value) * 100);
    if (deltaBp !== 0) {
      changes.push({
        date: points[i].date,
        direction: deltaBp > 0 ? '인상' : '인하',
        delta_bp: Math.abs(deltaBp),
      });
    }
  }
  return changes;
}

const INDICATOR_BUILDERS = {
  async fomc() {
    const start5y = isoDateYearsAgo(5);
    const start3y = isoDateYearsAgo(3);
    // upper/lower(월간, 5년)는 차트 표시용 series 그대로 유지하고, changes는 별도로
    // DFEDTARU를 frequency 지정 없이(일간 원본, 최근 3년) 다시 받아서 뽑는다 — 일간
    // 원본이라야 값이 바뀌는 지점(=발효일)과 정확한 25bp 단위 폭이 그대로 드러난다.
    const [upperR, lowerR, dailyUpperR] = await Promise.allSettled([
      fetchSeriesRange('DFEDTARU', { start: start5y, frequency: 'm' }),
      fetchSeriesRange('DFEDTARL', { start: start5y, frequency: 'm' }),
      fetchSeriesRange('DFEDTARU', { start: start3y }),
    ]);
    if (upperR.status === 'rejected' || lowerR.status === 'rejected' || dailyUpperR.status === 'rejected') {
      const detail = [
        upperR.status === 'rejected'      ? `DFEDTARU(월간): ${upperR.reason.message}` : null,
        lowerR.status === 'rejected'      ? `DFEDTARL(월간): ${lowerR.reason.message}` : null,
        dailyUpperR.status === 'rejected' ? `DFEDTARU(일간): ${dailyUpperR.reason.message}` : null,
      ].filter(Boolean).join(' / ');
      throw new Error(`fomc 시리즈 일부 실패 — ${detail}`);
    }
    return {
      series: [
        { id: 'DFEDTARU', label: '목표금리 상단', points: upperR.value },
        { id: 'DFEDTARL', label: '목표금리 하단', points: lowerR.value },
      ],
      changes: extractRateChanges(dailyUpperR.value).slice(-3),
    };
  },

  async cpi() {
    const start = isoDateYearsAgo(3);
    const [headline, core] = await fetchPairSettled('CPIAUCSL', 'CPILFESL', { start, units: 'pc1' });
    return {
      series: [
        { id: 'CPIAUCSL', label: 'CPI(전체, YoY%)', points: headline },
        { id: 'CPILFESL', label: '근원 CPI(YoY%)', points: core },
      ],
    };
  },

  async unemployment() {
    const start = isoDateYearsAgo(3);
    const points = await fetchSeriesRange('UNRATE', { start });
    return {
      series: [{ id: 'UNRATE', label: '실업률', points }],
    };
  },
};

// ── Redis 캐시 (macro.js와 동일 패턴: 지연 생성, 실패 시 null 폴백) ──
let redisClient; // undefined: 아직 시도 안 함, null: 생성 실패/키 없음, Redis: 정상

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[macro-history] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — Redis 캐시 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

async function getCached(indicator) {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(cacheKey(indicator));
  } catch (e) {
    console.error(`[macro-history] Redis GET 실패(${indicator}) — 캐시 없이 진행:`, e.message);
    return null;
  }
}

async function setCached(indicator, data) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(cacheKey(indicator), data, { ex: CACHE_TTL_SEC });
  } catch (e) {
    console.error(`[macro-history] Redis 저장 실패(${indicator}, 응답 자체는 정상 반환):`, e.message);
  }
}

// "마지막 성공값" 승계용 — macro:hist:v1:*과 별개 키라 24시간 캐시가 만료된 뒤에도
// 유지된다. TTL을 주지 않아(ex 옵션 생략) 무기한 저장되며, 성공할 때마다 최신값으로
// 덮어써진다 — 폴백 본이 스스로 만료돼 사라지면 안 되므로. 조회/저장 둘 다 내부에서
// 에러를 삼켜 절대 상위로 던지지 않는다(요구사항: "폴백 실패가 상위로 전파되지 않게 격리").
async function getLatestGood(indicator) {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(latestKey(indicator));
  } catch (e) {
    console.error(`[macro-history] latest 조회 실패(${indicator}):`, e.message);
    return null;
  }
}

async function setLatestGood(indicator, data) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(latestKey(indicator), data); // TTL 없음(무기한) — 의도적으로 ex 생략
  } catch (e) {
    console.error(`[macro-history] latest 저장 실패(${indicator}):`, e.message);
  }
}

// Redis도 없을 때의 최소 폴백 — indicator별로 같은 서버리스 인스턴스 내에서만 유효.
const memCache = {}; // { [indicator]: { data, ts } }

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const { indicator } = req.query;
  if (!ALLOWED_INDICATORS.includes(indicator)) {
    return res.status(400).json({
      error: `indicator는 ${ALLOWED_INDICATORS.join('|')} 중 하나여야 합니다`,
    });
  }

  const cached = await getCached(indicator);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }
  const mem = memCache[indicator];
  if (mem && Date.now() - mem.ts < CACHE_TTL_SEC * 1000) {
    res.setHeader('X-Cache', 'HIT-MEM');
    return res.status(200).json(mem.data);
  }

  try {
    const built = await INDICATOR_BUILDERS[indicator]();
    const data = {
      indicator,
      updated_at: new Date().toISOString(),
      ...built, // series + (fomc만) changes
    };

    // FRED 조회가 성공했을 때만 캐시에 쓴다 — 비었거나 실패한 응답은 절대 캐시하지
    // 않는다(요구사항: null 캐시 오염 금지). 이 지점에 도달했다는 것 자체가 이미
    // INDICATOR_BUILDERS[indicator]()가 예외 없이 끝났다는 뜻이라 항상 성공 데이터다.
    memCache[indicator] = { data, ts: Date.now() };
    await setCached(indicator, data);
    await setLatestGood(indicator, data);

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (e) {
    console.error(`[macro-history] ${indicator} 조회 실패:`, e.message);

    const fallback = await getLatestGood(indicator);
    if (fallback) {
      console.warn(`[macro-history] ${indicator} 폴백 사용(마지막 성공값)`);
      res.setHeader('X-Cache', 'FALLBACK');
      return res.status(200).json(fallback);
    }

    return res.status(500).json({ error: `${indicator} 히스토리 조회 실패`, details: e.message });
  }
}
