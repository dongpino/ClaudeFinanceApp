/**
 * api/analysis.js — 분석 탭 전용 장기 히스토리 엔드포인트
 *
 * GET /api/analysis?id={nasdaq|dow|kospi|btc|vix|usdkrw}[&tf={1m|5m|15m|30m|1h|4h|1d|1w}]
 *
 * 종목별 지원 타임프레임:
 *   btc    : 1m / 5m / 15m / 30m / 1h / 4h / 1d / 1w  (8개, Binance klines)
 *   나머지  : 1d / 1w  (일봉 250일 + 주봉 변환)
 *
 * tf 미지정 시 기본값: 1d
 * 종목이 지원하지 않는 tf 요청 시: 400 에러
 *
 * 반환 history 형식:
 *   intraday (1m~4h, BTC 전용): { time: number(Unix seconds), open, high, low, close }
 *   일봉/주봉              : { date: 'YYYY-MM-DD', open?, high?, low?, close }
 *
 * 캐시: 타임프레임별 차등 TTL (인메모리 + CDN s-maxage)
 */

import {
  fetchLongBTC,
  fetchLongNasdaq,
  fetchLongDow,
  fetchLongVIX,
  fetchLongKOSPI,
  fetchLongUSDKRW,
} from './_collectors/analysis-long.js';
import { fetchBTCByTF, BTC_INTRADAY_TFS } from './_collectors/btc-intraday.js';
import { toWeekly } from './_collectors/weekly-transform.js';

// ── 종목 정의 ──────────────────────────────────────────────

const ITEM_ORDER = ['nasdaq', 'dow', 'kospi', 'btc', 'vix', 'usdkrw'];

const ITEM_META = {
  btc:    { name: '비트코인 BTC-USD', dailyFn: fetchLongBTC    },
  nasdaq: { name: '나스닥 (^IXIC)',   dailyFn: fetchLongNasdaq },
  dow:    { name: '다우존스 (^DJI)',  dailyFn: fetchLongDow    },
  vix:    { name: 'VIX 공포지수',     dailyFn: fetchLongVIX    },
  kospi:  { name: '코스피 (^KS11)',   dailyFn: fetchLongKOSPI  },
  usdkrw: { name: '원/달러',          dailyFn: fetchLongUSDKRW },
};

// 종목별 허용 타임프레임
const SUPPORTED_TF = {
  btc:    [...BTC_INTRADAY_TFS, '1d', '1w'],  // 1m,5m,15m,30m,1h,4h,1d,1w
  nasdaq: ['1d', '1w'],
  dow:    ['1d', '1w'],
  vix:    ['1d', '1w'],
  kospi:  ['1d', '1w'],
  usdkrw: ['1d', '1w'],
};

// ── 캐시 TTL (인메모리 ms / CDN s-maxage 초) ───────────────

const TF_TTL = {
  '1m':  { mem:     60_000, cdn:  30 },
  '5m':  { mem:    300_000, cdn: 120 },
  '15m': { mem:    600_000, cdn: 300 },
  '30m': { mem:    900_000, cdn: 600 },
  '1h':  { mem:  1_800_000, cdn: 900 },
  '4h':  { mem:  3_600_000, cdn: 1_800 },
  '1d':  { mem:    900_000, cdn: 600 },
  '1w':  { mem:  3_600_000, cdn: 1_800 },
};

const CACHE = {};   // 키: 'id:tf'

// ── 유틸 ───────────────────────────────────────────────────

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

// ── 데이터 수집 ────────────────────────────────────────────

async function fetchData(id, tf) {
  const { dailyFn } = ITEM_META[id];
  const isIntraday  = BTC_INTRADAY_TFS.includes(tf);

  if (isIntraday) {
    // BTC 분봉/시간봉: btc-intraday.js 직접 수집
    return fetchBTCByTF(tf);
  }

  // 일봉 수집 (1d / 주봉의 원본)
  const daily = await dailyFn();

  if (tf === '1w') {
    const weeklyHistory = toWeekly(daily.history, daily.ohlc_available);
    return {
      history:        weeklyHistory,
      ohlc_available: true,   // synthetic OHLC 포함 (weekly-transform.js 참조)
      source:         daily.source + ' → 주봉 변환',
      tf:             '1w',
    };
  }

  return { ...daily, tf: '1d' };
}

// ── 핸들러 ─────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' });

  const id = req.query?.id ?? null;
  if (!id || !ITEM_ORDER.includes(id))
    return res.status(400).json({ error: `id 파라미터 필요. 허용: ${ITEM_ORDER.join(', ')}` });

  const tf = req.query?.tf ?? '1d';

  if (!SUPPORTED_TF[id]?.includes(tf)) {
    return res.status(400).json({
      error: `${id}는 [${SUPPORTED_TF[id].join(', ')}]만 지원합니다. 요청된 tf: ${tf}`,
    });
  }

  const cacheKey = `${id}:${tf}`;
  const ttl      = TF_TTL[tf];
  const cached   = CACHE[cacheKey];

  if (cached && Date.now() - cached.timestamp < ttl.mem) {
    console.log(`[analysis/${id}/${tf}] Cache HIT`);
    res.setHeader('Cache-Control', `s-maxage=${ttl.cdn}, stale-while-revalidate=60`);
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  const startMs = Date.now();
  console.log(`[analysis/${id}/${tf}] Cache MISS — 수집 시작 (${fmtKST()})`);

  try {
    const { history, ohlc_available, source } = await fetchData(id, tf);

    if (!history || history.length < 2)
      throw new Error(`히스토리 부족: ${history?.length ?? 0}행`);

    const { name } = ITEM_META[id];
    const latest   = history[history.length - 1];
    const prev     = history[history.length - 2];
    const change     = r2(latest.close - prev.close);
    const changePct  = prev.close ? r4(change / prev.close * 100) : 0;

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
      `[analysis/${id}/${tf}] ${history.length}봉 완료 (${elapsed}s)  source=${source}  ohlc=${ohlc_available}`
    );

    const item = {
      id, name, tf,
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
    CACHE[cacheKey] = { data, timestamp: Date.now() };

    res.setHeader('Cache-Control', `s-maxage=${ttl.cdn}, stale-while-revalidate=60`);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (e) {
    console.error(`[analysis/${id}/${tf}] 실패: ${e.message}`);
    return res.status(500).json({ error: '데이터 수집 실패', details: e.message });
  }
}
