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
 *     lastSuccessAt, lastFailureAt, lastError, lastErrorCode,
 *     consecutiveFailures, lastEnv
 *  health:daily:{source}:{YYYY-MM-DD KST}  (해시, TTL 7일)
 *     success, failure   — 키 이름에 KST 날짜가 들어가 자정에 새 키로 넘어가며
 *                          "자정 리셋" 효과 + 7일치 추이 보관을 동시에 만족.
 *     err:{code}         — 실패 원인별 히스토그램(classifyError). "실패 11건"이
 *                          한 원인인지 여러 원인인지 총합만으론 알 수 없어서.
 *     env:{tag}          — 기록 주체 구성비.
 *  health:hour:{source}:{YYYY-MM-DDTHH KST}  (해시, TTL 48시간)
 *     success, failure   — 시간대 집중도 확인용 단기 버킷. 간헐 실패가 특정 시각에
 *                          몰리는지(상대 서버 배치/방화벽 주기) 균일한지 판별한다.
 */

import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';

// ── 기록 주체/저장소 식별 ────────────────────────────────────────────
// 이 두 가지가 없어서 실제로 크게 헤맸다(2026-07-27): 로컬 .env.local의
// KV_REST_API_URL이 프로덕션과 다른 DB를 가리키는 줄 모르고 개발 DB를 덤프해
// "크론이 30일간 안 돌았다"는 잘못된 결론까지 냈다. 두 층위로 막는다.
//   ENV_TAG           — 한 DB를 로컬/프리뷰/프로덕션이 공유할 때 기록이 섞이는 것을 사후 구분
//   storeFingerprint  — "지금 보는 DB가 배포본이 쓰는 그 DB인가"를 한 줄로 대조
export const ENV_TAG = process.env.VERCEL_ENV ?? 'local'; // production | preview | development | local

/**
 * 스토어 지문 — KV 호스트의 sha256 앞 8자. 호스트 원문(=계정 식별자)을 노출하지 않고
 * 동일성만 비교할 수 있다. /api/health 응답과 진단 스크립트가 같은 값을 내면 같은 DB다.
 * @param {string} [url] 기본값 process.env.KV_REST_API_URL
 * @returns {string|null} 미설정이면 null
 */
export function storeFingerprint(url = process.env.KV_REST_API_URL) {
  if (!url) return null;
  const host = String(url).replace(/^[a-z]+:\/\//, '').replace(/[:/].*$/, '');
  return createHash('sha256').update(host).digest('hex').slice(0, 8);
}

// 대상 소스 식별자(요구사항 1) — /api/health가 이 순서로 상태를 보고한다.
export const SOURCES = [
  'naver', 'naver-index', 'yahoo', 'daum', 'finnhub', 'twelvedata', 'cnbc', 'coingecko',
  'binance', 'bybit', 'alternative-me', 'fred', 'bok',
  'rss-yna', 'rss-asiae', 'rss-edaily', 'rss-coindesk',
];

// ── 온디맨드 소스: 나이 기반 판정 자체가 성립하지 않는 소스 ───────────
// 아래 소스들은 특정 화면(분석 탭 / 종목 상세)을 열 때만 호출된다. 크론도, 홈 카드
// 경로도 건드리지 않으므로 "이 시간 안에는 반드시 한 번 불린다"는 보장 하한이 아예
// 없다 — 며칠 안 열면 성공이 0인 게 정상이다. 그래서 EXPECTED_INTERVAL_SEC에 넣지
// 않고(어떤 값을 넣어도 임의값이다) judgeStatus에서 별도 규칙으로 판정한다.
//   · binance    = BTC/ETH 상세 90d + 분석 탭 klines(btc-intraday/crypto-adapter)
//   · twelvedata = 미국 일봉(상세/분석 화면 전용)
export const ON_DEMAND_SOURCES = new Set(['binance', 'twelvedata']);

// 마지막 '시도'(성공/실패 중 나중)가 이 시간을 넘으면 그 성패는 더 이상 현재 상태의
// 근거가 못 된다 → 'idle'(상태판 '대기 · 미호출' 표기). 며칠 전 성공으로 초록불을
// 켜 두면 상태판이 거짓 안심을 준다.
// ⚠️ SettingsPanel.jsx가 이 판정을 그대로 받아 쓰므로(프론트 재계산 없음) 임계값은
//    여기 한 곳에만 있다.
const ONDEMAND_IDLE_SEC = 24 * 60 * 60;

// 소스별 기대 갱신 주기(초). lastSuccess가 이 값의 3배 이내면 ok, 초과면 stale.
// 시세류는 수 분, FRED/RSS는 수 시간(요구사항 5).
//
// ⚠️ 이 값은 "호출 주기"가 아니라 "호출이 없어도 이상하지 않은 시간"이다. 홈 시세류는
// 크론이 아니라 사용자 트래픽으로 돌고, market-data.js가 Redis 공유 캐시 5분(CACHE_TTL_SEC)
// 을 앞단에 두므로 실호출 간격은 최소 5분 + 트래픽 공백만큼 벌어진다. 5분 기준(×3=15분)
// 이면 앱을 15분만 안 열어도 '지연'으로 뜨는 오탐이 된다 — 그래서 홈 카드를 실제로
// 그리는 경로마다 "그 경로가 보장하는 호출 하한"을 근거로 값을 정한다.
const EXPECTED_INTERVAL_SEC = {
  'naver': 300, 'naver-index': 300, 'yahoo': 300, 'daum': 300, 'finnhub': 300,
  // cnbc/coingecko: 홈 카드 + 일 1회 briefing-cron 경로. 8h(×3=24h) — 크론이
  // collectUSIndices/collectBTC를 거쳐 하루 한 번은 반드시 건드리므로, 24시간 넘게
  // 성공이 없으면 그때는 진짜 이상이다.
  //
  // ⚠️ binance를 여기 두면 안 된다(2026-07-28 정정): 같은 크론 경로를 근거로 binance도
  //    5분(×3=15분)으로 잡혀 있었는데, 그 전제가 틀렸다. 크론/홈이 부르는
  //    collectBTC({ include90d: false })는 현재가·30d를 모두 CoinGecko로 받고 90d
  //    klines는 건너뛴다(btc.js) — CoinGecko가 건강하면 Binance는 단 한 번도 호출되지
  //    않는다. 그래서 binance는 위 ON_DEMAND_SOURCES로 옮겼다.
  'cnbc': 28800, 'coingecko': 28800,
  'bybit': 300, 'alternative-me': 3600,
  'fred': 43200,                     // FRED 월간 데이터 + 12h 캐시 → 12h
  'bok': 43200,                      // 한국은행 기준금리(연 8회 변경) + 6h 캐시 → 넉넉히 12h
  'rss-yna': 10800, 'rss-asiae': 10800, 'rss-edaily': 10800, 'rss-coindesk': 10800, // 3h
};
const DEFAULT_INTERVAL_SEC = 600;

const DAILY_TTL_SEC = 7 * 24 * 60 * 60; // 7일 추이 보관
const HOUR_TTL_SEC  = 48 * 60 * 60;     // 시간대 버킷은 48시간만(진단용 단기 관찰)
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

// 'YYYY-MM-DDTHH' (KST). hourCycle:'h23'을 명시해야 자정이 '24'로 나오는 ICU 차이를 피한다.
export function kstHour(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(d);
  const g = t => parts.find(p => p.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}`;
}

// ── 에러 정체 규명 ───────────────────────────────────────────────────
// undici(Node fetch)는 네트워크 실패를 전부 TypeError("fetch failed")로 상위 래핑하고
// 진짜 원인은 err.cause에 숨긴다. "fetch failed"만 보면 DNS 실패인지, TLS 문제인지,
// 커넥션 리셋인지, 커넥트 타임아웃인지 구분이 안 된다 — rss-yna 간헐 실패(2026-07)가
// 정확히 이 상태였다. 그래서 기록 시 cause까지 벗겨낸다.

function sanitizeCode(s) {
  return String(s).trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown';
}

/**
 * 에러 → 히스토그램용 짧은 코드. Redis 해시 필드명이 되므로 값 종류가 폭발하지
 * 않게 정규화한다(자유 문자열 금지).
 * @returns {string} 예: 'http-403' | 'timeout' | 'ECONNRESET' | 'ENOTFOUND' |
 *                   'UND_ERR_CONNECT_TIMEOUT' | 'non-xml' | 'fetch-failed'
 */
export function classifyError(err) {
  const msg = String(err?.message ?? err ?? '');

  // 수집기가 직접 만든 'HTTP 403' 형태 — 상태코드를 그대로 코드로 쓴다.
  const http = /\bHTTP (\d{3})\b/.exec(msg);
  if (http) return `http-${http[1]}`;

  // rss.js가 판정하는 "200인데 XML이 아님"(챌린지 의심)
  if (/non-XML/i.test(msg)) return 'non-xml';

  // AbortController(rss.js FETCH_TIMEOUT_MS) / AbortSignal.timeout()
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return 'timeout';

  // 여기가 핵심 — cause.code가 실제 정체(ECONNRESET/ENOTFOUND/EAI_AGAIN/
  // UND_ERR_CONNECT_TIMEOUT/CERT_HAS_EXPIRED …)
  const causeCode = err?.cause?.code ?? err?.code ?? null;
  if (causeCode) return sanitizeCode(causeCode);

  // code 없는 cause라도 메시지 첫 토큰은 남긴다(정체불명 'fetch-failed'보다 낫다)
  const causeMsg = err?.cause?.message;
  if (causeMsg) return sanitizeCode(causeMsg.split(/[:(]/)[0]);

  if (/fetch failed/i.test(msg)) return 'fetch-failed';
  return err?.name ? sanitizeCode(err.name) : 'unknown';
}

function summarize(err) {
  const base = String(err?.message ?? err ?? 'unknown');
  // cause를 본문에 덧붙여 lastError만 봐도 정체가 드러나게 한다.
  const cause = err?.cause;
  const detail = cause ? [cause.code, cause.message].filter(Boolean).join(' ') : '';
  return (detail ? `${base} — ${detail}` : base).slice(0, 200);
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

/**
 * 재시도 계측 — "재시도가 실제로 몇 건을 구제했는지"를 관찰하려고 분리해서 센다.
 * 재시도로 살아난 호출은 최종적으로 recordSuccess가 성공으로 집계하므로, 이 카운터가
 * 없으면 그 구제 효과가 성공률에 묻혀 보이지 않는다(도입 판단 근거가 사라진다).
 * @param {string} source
 * @param {{recovered: boolean}} opts recovered=true면 재시도가 성공으로 끝났다는 뜻
 */
export function recordRetry(source, { recovered } = {}) {
  if (!source) return;
  void persistRetry(source, Boolean(recovered));
}

async function persistRetry(source, recovered) {
  const r = getRedis();
  if (!r) return;
  try {
    const dailyKey = `health:daily:${source}:${kstToday()}`;
    const p = r.pipeline();
    p.hincrby(dailyKey, 'retry:attempt', 1);
    if (recovered) p.hincrby(dailyKey, 'retry:recovered', 1);
    p.expire(dailyKey, DAILY_TTL_SEC);
    await p.exec();
  } catch (e) {
    console.warn(`[health] 재시도 기록 실패(${source}) — 무시: ${e.message}`);
  }
}

async function persist(source, ok, err) {
  const r = getRedis();
  if (!r) return;
  try {
    const now = new Date().toISOString();
    const dailyKey = `health:daily:${source}:${kstToday()}`;
    const hourKey  = `health:hour:${source}:${kstHour()}`;
    const srcKey   = `health:src:${source}`;
    const p = r.pipeline();
    if (ok) {
      // lastError/lastFailureAt은 일부러 지우지 않는다 — 간헐 실패 소스는 그 이력이
      // 유일한 단서다. "지금 유효한 에러인가"는 lastFailureAt vs lastSuccessAt 비교로
      // 알 수 있고(getHealthSnapshot의 lastErrorResolved), 그게 삭제보다 정보가 많다.
      p.hset(srcKey, { lastSuccessAt: now, consecutiveFailures: 0, lastEnv: ENV_TAG });
      p.hincrby(dailyKey, 'success', 1);
      p.hincrby(hourKey, 'success', 1);
    } else {
      const code = classifyError(err);
      p.hset(srcKey, { lastFailureAt: now, lastError: summarize(err), lastErrorCode: code, lastEnv: ENV_TAG });
      p.hincrby(srcKey, 'consecutiveFailures', 1);
      p.hincrby(dailyKey, 'failure', 1);
      // 에러 코드 히스토그램 — "실패 11건"이 한 원인인지 여러 원인인지 하루치로 드러난다.
      p.hincrby(dailyKey, `err:${code}`, 1);
      p.hincrby(hourKey, 'failure', 1);
    }
    // 일자별 출처 구성비 — "이 날 기록의 몇 %가 로컬발인가"가 바로 보인다.
    p.hincrby(dailyKey, `env:${ENV_TAG}`, 1);
    p.expire(dailyKey, DAILY_TTL_SEC);
    // 시간대 버킷 — 특정 시각 집중(상대 서버 배치/방화벽 주기)인지 균일 분포인지 판별.
    p.expire(hourKey, HOUR_TTL_SEC);
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
// (기대주기 허용폭 회귀를 scripts/test-health-thresholds.js에서 고정하려고 export)
export function judgeStatus(source, srcHash, nowMs) {
  const cf = Number(srcHash?.consecutiveFailures ?? 0);
  const lastSuccessAt = srcHash?.lastSuccessAt ?? null;
  const lastFailureAt = srcHash?.lastFailureAt ?? null;

  if (!lastSuccessAt && !lastFailureAt) return 'unknown'; // 아직 한 번도 수집 안 됨
  if (cf >= DOWN_THRESHOLD) return 'down';

  // 온디맨드 소스: 호출 보장 하한이 없어 나이로는 아무것도 말할 수 없다 → 마지막
  // '시도'가 최근이면 그 성패로, 오래됐으면 'idle'로 판정한다.
  if (ON_DEMAND_SOURCES.has(source)) {
    const successMs = Date.parse(lastSuccessAt) || 0;
    const failureMs = Date.parse(lastFailureAt) || 0;
    if ((nowMs - Math.max(successMs, failureMs)) / 1000 > ONDEMAND_IDLE_SEC) return 'idle';
    return successMs >= failureMs ? 'ok' : 'stale';
  }

  if (!lastSuccessAt) return 'stale'; // 실패만 있고(cf<3) 성공 이력 없음
  const ageSec = (nowMs - Date.parse(lastSuccessAt)) / 1000;
  const expected = EXPECTED_INTERVAL_SEC[source] ?? DEFAULT_INTERVAL_SEC;
  return ageSec <= expected * 3 ? 'ok' : 'stale';
}

// daily 해시의 env:* 필드만 { production: n, local: m } 형태로 추린다.
export function envCounts(dailyHash) {
  return prefixCounts(dailyHash, 'env:');
}

// daily 해시의 err:* 필드만 { 'http-403': 2, ECONNRESET: 9 } 형태로 추린다.
// 실패 총합만 보면 한 원인인지 여러 원인인지 알 수 없어서 코드별로 쪼개 둔다.
export function errorCounts(dailyHash) {
  return prefixCounts(dailyHash, 'err:');
}

function prefixCounts(hash, prefix) {
  const out = {};
  for (const [k, v] of Object.entries(hash ?? {})) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = Number(v) || 0;
  }
  return out;
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
      lastError: null, lastErrorCode: null, lastErrorResolved: false,
      consecutiveFailures: 0, todayRate: null, today: { success: 0, failure: 0 },
      lastEnv: null, todayEnv: {}, todayErrors: {}, todayRetry: { attempt: 0, recovered: 0 },
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
      // 히스토그램과 같은 코드 체계(classifyError) — lastError 원문 파싱 없이 대조 가능.
      lastErrorCode: srcHash?.lastErrorCode ?? null,
      // 그 에러가 '이미 해소된 과거 사건'인지. lastError는 성공해도 지워지지 않으므로
      // (간헐 실패 진단에 필요) 이 플래그가 없으면 옛 에러가 현재 장애처럼 읽힌다 —
      // binance "HTTP 400" 위양성이 오래 남았던 것이 정확히 그 사례.
      lastErrorResolved: Boolean(
        srcHash?.lastFailureAt && srcHash?.lastSuccessAt &&
        Date.parse(srcHash.lastSuccessAt) > Date.parse(srcHash.lastFailureAt)
      ),
      consecutiveFailures: Number(srcHash?.consecutiveFailures ?? 0),
      todayRate: total ? Math.round((success / total) * 100) / 100 : null,
      today: { success, failure },
      // 오늘 실패의 원인별 분포 { 'ECONNRESET': 9, 'http-403': 2 }
      todayErrors: errorCounts(daily),
      // 오늘 재시도 발동/구제 건수 — recovered가 곧 "재시도가 없었으면 실패했을 건수".
      todayRetry: {
        attempt: Number(daily?.['retry:attempt'] ?? 0),
        recovered: Number(daily?.['retry:recovered'] ?? 0),
      },
      // 마지막 기록을 남긴 실행 환경. 'production'이 아니면 그 행은 배포본 신호가 아니다.
      lastEnv: srcHash?.lastEnv ?? null,
      // 오늘 기록의 환경별 구성 { production: 12, local: 3 } — env:* 필드만 추려서.
      todayEnv: envCounts(daily),
    };
  });
}
