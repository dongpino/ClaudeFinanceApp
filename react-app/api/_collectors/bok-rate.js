/**
 * _collectors/bok-rate.js — 한국은행 기준금리 (ECOS Open API)
 *
 * 통계코드 722Y001(1.3.1. 한국은행 기준금리 및 여수신금리), item 0101000(한국은행 기준금리),
 * 단위 "연%". 홈 매크로 카드 + 브리핑 매크로 섹션 공용 소스.
 *
 * ── 소스 선택: 일별(D) ───────────────────────────────────────────────
 * 월별(M) 시리즈는 당월 값이 월말 이후에야 게시돼(예: 2026-07 중순에 202607 미게시) 금통위
 * 인상/인하를 최대 한 달 지연 반영한다(실측: 2026-07-16 인상 2.5→2.75를 월별은 아직 2.5로
 * 보여줌). 일별은 결정 즉시 반영하므로 "현재 기준금리"의 유일한 정답 소스다. 일별에서
 * 현재값·정확한 변경일·변경폭을 뽑고, 24개월 스파크라인은 일별을 월별로 다운샘플한다
 * (일별은 조밀해 결측월이 없어 FRED식 버퍼 페치가 불필요 — 26개월 요청→24개월 유지).
 *
 * ── 캐시(macro.js 패턴) ──────────────────────────────────────────────
 *   bok:rate:v1         (6시간 TTL) — 기준금리는 금통위 결정일에만 변함(연 8회)이라 6h면
 *                        새 결정도 6h 내 반영. 값 스냅샷(snapshot=rate@asOfDate)을 함께 담아
 *                        하위(브리핑 Haiku 캐시)가 값 변경 시 자동 무효화하는 키 재료로 쓴다.
 *   bok:rate:v1:latest  (7일 TTL) — ECOS 장애/검증실패 시 마지막 성공본 stale-serve(무기한
 *                        아닌 7일 — macro:v1:latest와 동일 관례).
 * 검증: 현재 기준금리가 0% 미만·10% 초과면 이상치로 거부하고 latest(stale)를 유지한다.
 *
 * 환경변수: BOK_ECOS_API_KEY(필수), KV_REST_API_URL / KV_REST_API_TOKEN(선택 — 없으면
 *           인메모리 캐시만).
 */

import { Redis } from '@upstash/redis';
import { trackedFetch } from '../_lib/health.js';

const ECOS_BASE     = 'https://ecos.bok.or.kr/api/StatisticSearch';
const STAT_CODE     = '722Y001';
const ITEM_CODE     = '0101000';
const FETCH_MONTHS  = 26;                 // 24개월 스파크라인 + 여유(다운샘플 후 마지막 24개 유지)
const HISTORY_MONTHS = 24;
const RATE_MIN = 0, RATE_MAX = 10;        // 검증 경계(0% 미만·10% 초과 거부)

const CACHE_TTL_SEC  = 6 * 60 * 60;       // 6시간
const LATEST_TTL_SEC = 7 * 24 * 60 * 60;  // 7일
const CACHE_KEY  = 'bok:rate:v1';
const LATEST_KEY = 'bok:rate:v1:latest';

function r4(n) { return Math.round(n * 10000) / 10000; }
function direction(pp) { return pp > 0 ? 'up' : pp < 0 ? 'down' : 'flat'; }

// KST 기준 YYYYMMDD(ECOS 일별 파라미터 포맷)
function kstYmd(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
// 'YYYYMMDD' → 'YYYY-MM-DD'
function isoDate(ymd) { return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`; }

function getKey() {
  const k = process.env.BOK_ECOS_API_KEY;
  if (!k) throw new Error('BOK_ECOS_API_KEY 환경변수가 설정되지 않았습니다');
  return k;
}

// ── ECOS 일별 조회 → 정규화 { rate, asOfDate, history[], lastChange, snapshot } ──
async function fetchFromEcos() {
  const key = getKey();
  const end = kstYmd();
  const startD = new Date();
  startD.setUTCMonth(startD.getUTCMonth() - FETCH_MONTHS);
  const start = kstYmd(startD);

  // 키를 에러 메시지/로그에 노출하지 않도록 URL은 여기서만 조립하고 예외엔 담지 않는다.
  const url = `${ECOS_BASE}/${encodeURIComponent(key)}/json/kr/1/1000/${STAT_CODE}/D/${start}/${end}/${ITEM_CODE}`;
  const res = await trackedFetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`ECOS HTTP ${res.status}`);
  const j = await res.json();
  if (j.RESULT) throw new Error(`ECOS RESULT ${j.RESULT.CODE}: ${j.RESULT.MESSAGE}`);

  const rows = j.StatisticSearch?.row ?? [];
  // {ymd, value} 오름차순, 유효값(숫자)만
  const points = rows
    .map(r => ({ ymd: String(r.TIME), value: parseFloat(r.DATA_VALUE) }))
    .filter(p => /^\d{8}$/.test(p.ymd) && Number.isFinite(p.value))
    .sort((a, b) => (a.ymd < b.ymd ? -1 : 1));
  if (points.length < 2) throw new Error(`ECOS 유효 관측치 부족: ${points.length}건`);

  const latest = points[points.length - 1];
  const rate = latest.value;
  if (!(rate >= RATE_MIN && rate <= RATE_MAX)) throw new Error(`기준금리 이상치 거부: ${rate}`);

  // 최근 변경점 — 뒤에서부터 현재값과 달라지는 첫 지점이 "직전 변경"
  let lastChange = null;
  for (let i = points.length - 1; i > 0; i--) {
    if (points[i].value !== points[i - 1].value) {
      lastChange = {
        date: isoDate(points[i].ymd),          // 변경이 적용된 첫 날 = 금통위 결정일
        prevRate: r4(points[i - 1].value),
        deltaPp: r4(points[i].value - points[i - 1].value),
        direction: direction(points[i].value - points[i - 1].value),
      };
      break;
    }
  }

  // 월별 다운샘플: 각 월의 마지막 일별값(계단형 유지) → 마지막 24개월
  const byMonth = new Map();
  for (const p of points) byMonth.set(p.ymd.slice(0, 6), { date: isoDate(p.ymd), close: r4(p.value) });
  const history = [...byMonth.values()].slice(-HISTORY_MONTHS);

  const asOfDate = isoDate(latest.ymd);
  const daysSinceChange = lastChange
    ? Math.round((Date.parse(asOfDate) - Date.parse(lastChange.date)) / 86400000)
    : null;

  return {
    rate: r4(rate),
    asOfDate,
    unit: 'pct_pt',
    history,                                    // [{date, close}] 월별 24포인트(계단형)
    lastChange,                                 // {date, prevRate, deltaPp, direction} | null
    daysSinceChange,
    snapshot: `${r4(rate)}@${asOfDate}`,        // 하위 캐시 무효화용 값 스냅샷
    fetchedAt: new Date().toISOString(),
  };
}

// ── Redis (macro.js와 동일: 지연 생성, 실패 시 null 폴백) ──
let redisClient;
function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) { console.warn('[bok-rate] KV 미설정 — Redis 캐시 비활성화'); redisClient = null; }
  else redisClient = new Redis({ url, token });
  return redisClient;
}
export function __setRedisClientForTest(client) { redisClient = client; }
// 테스트 전용 — 콜드 인스턴스(캐시 만료 후 새 서버리스 인스턴스) 상황을 재현할 때만.
export function __resetMemCacheForTest() { memCache = null; }

async function redisGet(k) {
  const r = getRedis(); if (!r) return null;
  try { return await r.get(k); } catch (e) { console.error(`[bok-rate] Redis GET 실패(${k}):`, e.message); return null; }
}
async function redisSet(k, data, ttl) {
  const r = getRedis(); if (!r) return;
  try { await r.set(k, data, { ex: ttl }); } catch (e) { console.error(`[bok-rate] Redis SET 실패(${k}):`, e.message); }
}

let memCache = null; // { data, ts }

/**
 * 캐시 우선 원시 데이터 조회.
 * 6h 캐시 HIT → 즉시 반환. MISS → ECOS 조회+검증. 조회/검증 실패 시 latest(7d) stale-serve.
 * @returns {Promise<{rate, asOfDate, unit, history, lastChange, daysSinceChange, snapshot, fetchedAt, stale}>}
 */
export async function getBokRateData() {
  const cached = await redisGet(CACHE_KEY);
  if (cached) return { ...cached, stale: false };
  if (memCache && Date.now() - memCache.ts < CACHE_TTL_SEC * 1000) return { ...memCache.data, stale: false };

  try {
    const data = await fetchFromEcos();
    memCache = { data, ts: Date.now() };
    await redisSet(CACHE_KEY, data, CACHE_TTL_SEC);
    await redisSet(LATEST_KEY, data, LATEST_TTL_SEC);
    console.log(`[bok-rate] ECOS ✅ 현재 ${data.rate}% (기준일 ${data.asOfDate}, 변경 ${data.lastChange ? `${data.lastChange.deltaPp > 0 ? '+' : ''}${data.lastChange.deltaPp}%p @${data.lastChange.date}` : '없음'}, hist ${data.history.length}개월)`);
    return { ...data, stale: false };
  } catch (e) {
    console.warn(`[bok-rate] ECOS 실패/검증거부: ${e.message} → latest(stale) 시도`);
    const latest = (await redisGet(LATEST_KEY)) ?? memCache?.data ?? null;
    if (latest) { console.warn(`[bok-rate] latest stale-serve (기준일 ${latest.asOfDate})`); return { ...latest, stale: true }; }
    throw new Error(`기준금리 조회 실패, 승계할 latest도 없음: ${e.message}`);
  }
}

/**
 * 홈 매크로 카드 아이템(market-data.js가 다른 카드와 동일 형식으로 병합).
 * unit: 'pct_pt' → 가격 "2.75%", 등락 "+0.25%p"(NON_PRICE_UNITS라 동결=0변동 오탐 없음).
 * direction: 인상=up(빨강)/인하=down(파랑) — 한국 관례.
 * @param {{ include90d?: boolean }} [opts]
 */
export async function collectBokRate({ include90d = false } = {}) {
  const d = await getBokRateData();
  const change = d.lastChange ? d.lastChange.deltaPp : 0;
  const item = {
    id: 'kr_base_rate',
    name: '한국 기준금리',
    symbol: 'KR-BASE',
    price: d.rate,
    prev_close: d.lastChange ? d.lastChange.prevRate : d.rate,
    change,
    change_pct: 0,                    // pct_pt는 카드에서 change_pct 미표시
    direction: d.lastChange ? d.lastChange.direction : 'flat',
    source: '한국은행',
    as_of: `${d.asOfDate} (한국은행)`,
    category: '매크로',
    unit: 'pct_pt',
    history: d.history,               // [{date, close}] 월별 24포인트(계단형)
    ohlc_available: false,
    history_90d: include90d ? d.history : [],
    // Stage 2 표시 보강용 확장 필드(다른 카드엔 없음 — 있으면 쓰고 없으면 무시하는 opt-in)
    last_change_date: d.lastChange ? d.lastChange.date : null,
    days_since_change: d.daysSinceChange,
    rate_step: true,                  // 스파크라인 계단형 힌트
    ...(d.stale ? { stale: true } : {}),
  };
  return item;
}
