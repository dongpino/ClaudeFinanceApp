/**
 * api/analysis.js — 분석 탭 전용 장기 히스토리 엔드포인트
 *
 * GET /api/analysis?id={nasdaq|dow|kospi|btc|vix|usdkrw}
 *   → 해당 종목 250 거래일 히스토리 (MA100/200 대응)
 *   → BTC는 OHLC 포함, 나머지는 종가(close)만
 *
 * 캐시: 인메모리 15분 + CDN s-maxage=600
 * 용도: 분석 탭 전용. /api/market-data (홈/상세용 90일)와 완전 분리.
 */

import {
  fetchLongBTC,
  fetchLongNasdaq,
  fetchLongDow,
  fetchLongVIX,
  fetchLongKOSPI,
  fetchLongUSDKRW,
} from './_collectors/analysis-long.js';

const ITEM_ORDER = ['nasdaq', 'dow', 'kospi', 'btc', 'vix', 'usdkrw'];

const ITEM_META = {
  btc:    { name: '비트코인 BTC-USD',  fn: fetchLongBTC     },
  nasdaq: { name: '나스닥 (^IXIC)',    fn: fetchLongNasdaq  },
  dow:    { name: '다우존스 (^DJI)',   fn: fetchLongDow     },
  vix:    { name: 'VIX 공포지수',      fn: fetchLongVIX     },
  kospi:  { name: '코스피 (^KS11)',    fn: fetchLongKOSPI   },
  usdkrw: { name: '원/달러',           fn: fetchLongUSDKRW  },
};

const CACHE = {};
const CACHE_TTL_MS = 15 * 60 * 1000;

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }
function direction(change) { return change > 0 ? 'up' : change < 0 ? 'down' : 'flat'; }

export default async function handler(req, res) {
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' });

  const id = req.query?.id ?? null;
  if (!id || !ITEM_ORDER.includes(id))
    return res.status(400).json({ error: `id 파라미터 필요. 허용: ${ITEM_ORDER.join(', ')}` });

  const cached = CACHE[id];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[analysis/${id}] Cache HIT`);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  const startMs = Date.now();
  console.log(`[analysis/${id}] Cache MISS — 수집 시작 (${fmtKST()})`);

  try {
    const { name, fn } = ITEM_META[id];
    const { history, ohlc_available, source } = await fn();

    if (!history || history.length < 10)
      throw new Error(`히스토리 부족: ${history?.length ?? 0}행`);

    // 현재가: 히스토리 마지막 두 항목에서 유도 (당일 종가 기준)
    const latest = history[history.length - 1];
    const prev   = history[history.length - 2];
    const change    = r2(latest.close - prev.close);
    const changePct = prev.close ? r4(change / prev.close * 100) : 0;

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
      `[analysis/${id}] ${history.length}일 완료 (${elapsed}s)  source=${source}  ohlc=${ohlc_available}`
    );

    const item = {
      id, name,
      price:          latest.close,
      prev_close:     prev.close,
      change,
      change_pct:     changePct,
      direction:      direction(change),
      ohlc_available,
      history_long:   history,
      days_available: history.length,
    };

    const data = { updated_at: fmtKST(), item };
    CACHE[id] = { data, timestamp: Date.now() };

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=60');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (e) {
    console.error(`[analysis/${id}] 실패: ${e.message}`);
    return res.status(500).json({ error: '장기 데이터 수집 실패', details: e.message });
  }
}
