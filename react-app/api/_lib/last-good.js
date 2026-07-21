/**
 * _lib/last-good.js — 전 수집기 공통 "마지막 성공본(last known good)" 폴백 저장소
 *
 * macro.js의 macro:v1:latest 필드별 승계 패턴을 아이템 단위로 일반화한 것.
 * 외부 소스가 일시 장애일 때, 마지막으로 검증을 통과한 스냅샷을 그대로 계속
 * 서빙해 카드가 비거나 "데이터 없음"으로 깜빡이지 않게 한다(요구사항 1).
 *
 * ── 저장 스키마 ──────────────────────────────────────────────────────
 *   lastgood:{ns}:{id}   (JSON, TTL 없음 — 무기한)
 *     { data: <검증 통과한 아이템>, asOf: <수집 시각 ISO> }
 *   TTL을 두지 않는 이유: "가장 최근 성공본"은 오래됐어도 폴백 가치가 있고, 성공할
 *   때마다 덮어써지므로 무한정 낡을 일이 없다(장애가 길어질수록 오히려 이 값이 유일한
 *   서빙원이 된다). macro:v1:latest는 7일 TTL이었지만 그건 FRED 월간 데이터라 7일이면
 *   충분했던 것 — 시세류는 상시 폴백이 필요해 무기한으로 둔다.
 *
 * ── 오염 방지(요구사항 2) ────────────────────────────────────────────
 *   commit 전에 반드시 caller의 validate(item)를 통과해야 한다. null/빈 필드/가격 0
 *   같은 명백한 이상값은 lastGood을 덮어쓰지 않는다 — 한 번 오염되면 장애 동안 그
 *   이상값이 계속 서빙되기 때문(기존 캐시 포이즈닝 교훈 그대로).
 *
 * ── 수집을 절대 깨뜨리지 않는다(health.js와 동일 원칙) ────────────────
 *   Redis 미설정/실패는 조용히 무시(폴백 없이 원래 동작). 읽기 실패 → 폴백 없음(null),
 *   쓰기 실패 → 로그만. 이 저장소의 어떤 에러도 수집/서빙 경로로 전파하지 않는다.
 */

import { Redis } from '@upstash/redis';

// ── Redis (macro.js/health.js와 동일 패턴: 지연 생성, 실패 시 null) ──
let redisClient; // undefined: 미시도, null: 미설정/실패, Redis: 정상
function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[last-good] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — 폴백 저장 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

// 테스트 전용 주입 훅 — 실제 Redis 없이 인메모리 페이크로 로직을 검증할 때만 쓴다.
// 프로덕션 경로는 절대 호출하지 않는다(getRedis의 지연 생성만 사용).
export function __setRedisClientForTest(client) { redisClient = client; }

function lgKey(ns, id) { return `lastgood:${ns}:${id}`; }
function summarize(err) { return String(err?.message ?? err ?? 'unknown').slice(0, 200); }

// ── 배치 읽기 — ids → Map<id, { data, asOf }> ────────────────────────
export async function readLastGoodBatch(ns, ids) {
  const out = new Map();
  const r = getRedis();
  if (!r || !ids || ids.length === 0) return out;
  try {
    const pipe = r.pipeline();
    for (const id of ids) pipe.get(lgKey(ns, id));
    const raw = await pipe.exec();
    ids.forEach((id, i) => {
      const v = raw[i];
      if (v && v.data) out.set(id, v);
    });
  } catch (e) {
    console.warn(`[last-good] 읽기 실패(${ns}) — 폴백 없이 진행: ${e.message}`);
  }
  return out;
}

// ── 배치 쓰기 — entries: [{ id, data, asOf }], TTL 없음(무기한) ──────
export async function writeLastGoodBatch(ns, entries) {
  const r = getRedis();
  if (!r || !entries || entries.length === 0) return;
  try {
    const pipe = r.pipeline();
    for (const { id, data, asOf } of entries) {
      pipe.set(lgKey(ns, id), { data, asOf }); // ex 옵션 없음 → 만료 없음(-1)
    }
    await pipe.exec();
  } catch (e) {
    console.warn(`[last-good] 쓰기 실패(${ns}) — 무시: ${e.message}`);
  }
}

/**
 * 아이템 배열에 last-good 폴백을 적용한다 — 세 핸들러(market-data/coin-price/
 * stock-quote)가 공유하는 단일 진입점.
 *
 *  · commitIds 안의 아이템이 이번에 신선하게 수집됐고 validate를 통과하면
 *    → lastGood을 덮어쓰고(오염 방지된 성공본만), 응답 아이템에 asOf(수집 시각)를 붙인다.
 *  · fillIds 안의 아이템이 이번에 없거나(수집 실패) validate에 걸리면
 *    → lastGood을 읽어 { stale:true, asOf, error }를 붙여 대신 서빙한다.
 *      lastGood도 없으면 그냥 빠진다(신규 심볼 등 — 기존 동작 그대로).
 *  · 그 외(범위 밖) 아이템은 손대지 않고 통과시키되 asOf만 보강한다(요구사항 4:
 *    정상 시에도 asOf 항상 포함).
 *
 * @param {object}   p
 * @param {string}   p.ns            네임스페이스(핸들러별: 'market'|'coin'|'stock:us'…)
 * @param {object[]} p.collected     이번에 새로 수집한 아이템들(각 .id 보유)
 * @param {Iterable<string>} p.commitIds  lastGood 갱신 대상 id 범위
 * @param {Iterable<string>} [p.fillIds]  폴백 서빙 대상 id 범위(기본: commitIds)
 * @param {(item:object)=>boolean} p.validate  commit 자격 검증(오염 방지)
 * @param {string}   [p.errorSummary]  stale 아이템에 붙일 error 요약(핸들러가 아는 경우)
 * @returns {Promise<{ items: object[], stale: string[] }>}
 */
export async function applyLastGoodFallback({ ns, collected = [], commitIds, fillIds, validate, errorSummary }) {
  const commitSet = commitIds instanceof Set ? commitIds : new Set(commitIds ?? []);
  const fillSet   = fillIds   == null ? commitSet : (fillIds instanceof Set ? fillIds : new Set(fillIds));
  const asOfNow   = new Date().toISOString();

  const freshById = new Map();
  const commitEntries = [];

  for (const item of collected) {
    const id = item?.id;
    if (!id) continue;
    if (commitSet.has(id)) {
      if (validate(item)) {
        freshById.set(id, { ...item, asOf: asOfNow });
        commitEntries.push({ id, data: item, asOf: asOfNow });
      }
      // commit 범위인데 validate 실패 → 신선분에서 제외(오염 방지). fillIds에 있으면 아래서 폴백.
    } else {
      // 범위 밖 — 그대로 통과, asOf만 보강.
      freshById.set(id, item.asOf ? item : { ...item, asOf: asOfNow });
    }
  }

  const missing = [...fillSet].filter(id => !freshById.has(id));
  // 읽기(missing)와 쓰기(commit)는 키가 서로 겹치지 않아 동시에 돌려도 안전하다.
  const [lastGood] = await Promise.all([
    readLastGoodBatch(ns, missing),
    writeLastGoodBatch(ns, commitEntries),
  ]);

  const items = [...freshById.values()];
  const stale = [];
  for (const id of missing) {
    const lg = lastGood.get(id);
    if (!lg) continue; // 폴백할 성공본 없음 → 기존과 동일하게 빠짐
    items.push({ ...lg.data, asOf: lg.asOf, stale: true, error: errorSummary ?? '실시간 조회 실패 — 마지막 성공본 서빙' });
    stale.push(id);
  }
  return { items, stale };
}

export { summarize as summarizeError };
