/**
 * api/_lib/probe-store.js — [임시] 시계 묶인 관측을 크론으로 적재하는 공용 저장층
 *
 * "사람이 그 시각에 앱을 열어야만 볼 수 있는 값"을 크론이 대신 찍어 Redis에 쌓는다.
 * 지금 두 프로브가 쓴다.
 *   · probe-daum-status.js — 08:40 KST 장전 marketStatus 토큰
 *   · probe-cnbc-format.js — 23:00 KST 미 장중 last_timedate 형식
 *
 * ── 절대 원칙(health.js 기록층과 동일) ───────────────────────────────
 * 프로브는 수집 파이프라인에 어떤 영향도 주면 안 된다. 그래서:
 *  · 이 모듈의 모든 함수는 절대 throw하지 않는다(에러를 삼키고 false/null 반환).
 *  · Redis 미설정이면 조용히 no-op — 로컬에서 KV 없이 실행해도 그냥 저장만 안 된다.
 *  · 호출측 프로브는 수집기의 trackedFetch가 아니라 순수 fetch를 쓴다
 *    (프로브 트래픽이 health 상태판에 집계되면 관측 대상이 오염된다 —
 *     probe-backup.js가 같은 이유로 같은 규율을 따른다).
 *
 * ── 저장 스키마 ──────────────────────────────────────────────────────
 *  {key}  (해시, TTL 7일)
 *     "YYYY-MM-DD"(KST) → JSON 문자열 1건 (그날의 캡처 결과)
 *
 *  ⚠️ TTL은 키 단위이고 쓸 때마다 갱신된다. 즉 크론이 도는 동안에는 과거 필드도
 *     같이 살아 있어(=며칠치가 쌓임) 목적을 만족하고, 크론을 은퇴시키면 마지막
 *     쓰기로부터 7일 뒤 키 전체가 스스로 사라진다. 프로브가 잔여물을 남기지
 *     않게 하려는 의도적 선택이다(수동 청소 불필요).
 */

import { Redis } from '@upstash/redis';

export const PROBE_TTL_SEC = 7 * 24 * 60 * 60; // 7일

// ── Redis (health.js/user-prefs.js와 동일 패턴: 지연 생성, 실패 시 null) ──
let redisClient; // undefined: 미시도, null: 미설정/실패, Redis: 정상
function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[probe-store] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — 적재 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

/** 'YYYY-MM-DD' (KST). 해시 필드명이자 "며칠치가 쌓였나"의 단위. */
export function kstDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}

// 'YYYY-MM-DD HH:mm ZZZ' 한 줄. zone=null이면 Intl이 주는 약어를 붙이고, 문자열이면 그 값을 쓴다.
// ⚠️ Asia/Seoul은 Intl(en-CA)이 'KST'가 아니라 'GMT+9'를 준다 — 한국은 서머타임이 없어
//    'KST' 고정 표기가 어느 계절에도 거짓이 되지 않으므로 그쪽만 리터럴로 붙인다.
//    반대로 미 동부는 EDT/EST가 실제로 바뀌므로 절대 하드코딩하지 않고 Intl 값을 쓴다.
function stamp(d, tz, zone) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', ...(zone ? {} : { timeZoneName: 'short' }),
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const g = t => p.find(x => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')} ${zone ?? g('timeZoneName')}`;
}

/** 'YYYY-MM-DD HH:mm KST' — 캡처 시각을 사람이 바로 읽을 수 있게 함께 남긴다. */
export function kstStamp(d = new Date()) { return stamp(d, 'Asia/Seoul', 'KST'); }

/**
 * 'YYYY-MM-DD HH:mm EDT|EST' — 같은 순간을 미 동부 시각으로도 남긴다.
 *
 * 왜 양쪽을 다 적는가: 크론은 UTC 고정이라 KST는 늘 같은 시각이지만 **ET는 서머타임에
 * 따라 한 시간 움직인다**(14:00 UTC = EDT 10:00 / EST 09:00). KST만 남기면 "23:00 KST
 * 표본"이 몇 월에 찍혔느냐에 따라 미 장중인지 개장 전인지가 달라지는데, 나중에 그걸
 * 되짚을 근거가 기록에 없다. 꼬리표(EDT/EST)까지 남으면 사후 해석이 가능해진다.
 * ⚠️ 여기서 장중/장전을 판정하지는 않는다 — 사실만 적고 해석은 사람이 한다.
 */
export function etStamp(d = new Date()) { return stamp(d, 'America/New_York', null); }

/**
 * 하루치 캡처 1건 적재. 같은 날 다시 호출하면 덮어쓴다(재시도/수동 호출 대비).
 * @returns {Promise<boolean>} 실제로 저장했으면 true (Redis 미설정/실패면 false)
 */
export async function saveProbe(key, field, payload) {
  const r = getRedis();
  if (!r) return false;
  try {
    const p = r.pipeline();
    p.hset(key, { [field]: JSON.stringify(payload) });
    p.expire(key, PROBE_TTL_SEC);
    await p.exec();
    return true;
  } catch (e) {
    console.warn(`[probe-store] 적재 실패(${key}/${field}) — 무시: ${e.message}`);
    return false;
  }
}

// Upstash 클라이언트는 읽을 때 JSON 문자열을 자동 파싱해 주기도 하고 아니기도 한다
// (값 모양에 따라). 어느 쪽이 와도 같은 객체가 나오게 흡수한다.
function parseMaybe(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

/**
 * 쌓인 전체를 날짜 오름차순으로. 조회 전용(외부 API 미접속).
 * @returns {Promise<Array<{date: string, [k: string]: unknown}>>}
 */
export async function readProbe(key) {
  const r = getRedis();
  if (!r) return [];
  try {
    const hash = await r.hgetall(key);
    return Object.entries(hash ?? {})
      .map(([date, v]) => ({ date, ...(typeof parseMaybe(v) === 'object' ? parseMaybe(v) : { raw: v }) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch (e) {
    console.warn(`[probe-store] 조회 실패(${key}) — 무시: ${e.message}`);
    return [];
  }
}

/**
 * 프로브 엔드포인트 공통 인증.
 *   · Vercel Cron  — Authorization: Bearer {CRON_SECRET} (briefing-cron.js와 동일 규약)
 *   · 수동 호출    — ?key={DEBUG_SIGNALS_KEY} (probe-backup.js/debug-signals.js와 동일 규약)
 * 둘 다 환경변수가 없으면 그 경로는 성립하지 않는다(값 미설정으로 인한 노출 사고 방지).
 */
export function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req?.headers?.authorization === `Bearer ${cronSecret}`) return true;
  const debugKey = process.env.DEBUG_SIGNALS_KEY;
  if (debugKey && req?.query?.key === debugKey) return true;
  return false;
}
