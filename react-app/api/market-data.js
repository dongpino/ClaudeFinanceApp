/**
 * api/market-data.js — Vercel 서버리스 함수
 *
 * GET /api/market-data
 *   → 6종목 market_data JSON 반환 (Python market_check.py와 동일 구조)
 *
 * 캐싱 전략 (2단계):
 *   1. 인메모리 캐시 (CACHE_TTL_MS = 5분)
 *      - 서버리스 인스턴스가 "warm" 상태인 동안 유지
 *      - 콜드 스타트(인스턴스 재기동) 시 초기화됨
 *   2. CDN Edge 캐시 (Cache-Control: s-maxage=300)
 *      - 인메모리 캐시가 날아가도 CDN이 5분 이내 재요청을 흡수
 *      - stale-while-revalidate=60: 만료 후 60초 동안 구버전 제공하며 백그라운드 갱신
 *
 * 에러 격리:
 *   - 3개 그룹(US, BTC, KR)을 Promise.allSettled로 병렬 실행
 *   - 일부 그룹 실패 → 성공 종목만 items에 포함 (Python 정책과 동일)
 *   - 전체 실패 → HTTP 500
 */

import { collectBTC }       from './_collectors/btc.js';
import { collectUSIndices } from './_collectors/us-indices.js';
import { collectKR }        from './_collectors/kr.js';

// ──────────────────────────────────────────────────────
// 인메모리 캐시 (모듈 스코프 — warm 인스턴스 동안 유지)
// ──────────────────────────────────────────────────────
let cache = null;           // { data: {...}, timestamp: number }
const CACHE_TTL_MS = 5 * 60 * 1000;   // 5분
const ITEM_ORDER   = ['nasdaq', 'dow', 'kospi', 'btc', 'vix', 'usdkrw'];

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

// ──────────────────────────────────────────────────────
// 핸들러
// ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── 1. 인메모리 캐시 확인 ────────────────────────────
  if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    const ageS = Math.floor((Date.now() - cache.timestamp) / 1000);
    console.log(`[market-data] Cache HIT (age=${ageS}s)`);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('X-Cache-Age', String(ageS));
    return res.status(200).json(cache.data);
  }

  // ── 2. 캐시 미스 → 수집 ──────────────────────────────
  const startMs = Date.now();
  console.log(`[market-data] Cache MISS — 수집 시작 (${fmtKST()})`);

  const [usResult, btcResult, krResult] = await Promise.allSettled([
    collectUSIndices(),
    collectBTC(),
    collectKR(),
  ]);

  // ── 3. 결과 수집 + 에러 격리 ────────────────────────
  const itemsById    = {};
  const failedGroups = [];

  for (const [label, result] of [
    ['US 지수 (나스닥·다우·VIX)', usResult],
    ['BTC',                       btcResult],
    ['KR 지표 (코스피·원달러)',    krResult],
  ]) {
    if (result.status === 'fulfilled') {
      const arr = Array.isArray(result.value) ? result.value : [result.value];
      for (const it of arr) { if (it?.id) itemsById[it.id] = it; }
    } else {
      failedGroups.push(label);
      console.error(`[market-data] ${label} 실패: ${result.reason?.message ?? result.reason}`);
    }
  }

  const items   = ITEM_ORDER.filter(id => itemsById[id]).map(id => itemsById[id]);
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  if (items.length === 0) {
    console.error(`[market-data] 전체 종목 수집 실패 (${elapsed}s)`);
    return res.status(500).json({
      error:   '데이터 수집 실패',
      details: failedGroups,
    });
  }

  console.log(`[market-data] ${items.length}/6 종목 완료 (${elapsed}s)${failedGroups.length ? ` | 실패: ${failedGroups.join(', ')}` : ''}`);

  // ── 4. 캐시 갱신 ──────────────────────────────────────
  const data   = { updated_at: fmtKST(), items };
  cache        = { data, timestamp: Date.now() };

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(data);
}
