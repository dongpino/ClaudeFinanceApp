/**
 * api/analysis.js — 분석 탭 데이터 엔드포인트 (6종목 고정 + 임의 종목 확장)
 *
 * GET /api/analysis?id={nasdaq|dow|kospi|btc|vix|usdkrw}[&tf=...]      (기존, type 생략 시 'index')
 * GET /api/analysis?type=crypto&id={coingeckoId}&symbol={SYM}&tf=...  (신규)
 * GET /api/analysis?type=stock&symbol={SYM}&tf=...                    (신규)
 *
 * 종목별 지원 타임프레임은 timeframe-capability.js의 getSupportedTimeframes()가 단일 소스.
 * tf 미지정 시 기본값: 1d. 종목이 지원하지 않는 tf 요청 시: 400 에러.
 *
 * 소스 분기(어댑터):
 *   index (기존 6종목) — analysis-long.js + btc-intraday.js (기존 로직 100% 그대로)
 *   crypto             — crypto-adapter.js (Binance 상장이면 Binance klines, 아니면 CoinGecko)
 *   stock              — stock-adapter.js (Twelve Data 일봉 → toWeekly 주봉)
 * 세 어댑터 모두 공통 형식 반환: { history, ohlc_available, source }
 *
 * 반환 history 형식:
 *   intraday (1m~4h): { time: number(Unix seconds), open?, high?, low?, close }
 *   일봉/주봉         : { date: 'YYYY-MM-DD', open?, high?, low?, close }
 *
 * 캐시: 인메모리 (type:id:tf 키) + CDN s-maxage. TTL은 tf별 차등(주식은 Twelve Data 한도 보호 위해 더 김).
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
import { getSupportedTimeframes } from './_collectors/timeframe-capability.js';
import { fetchCryptoByTF } from './_collectors/crypto-adapter.js';
import { fetchStockByTF } from './_collectors/stock-adapter.js';

// ── 기존 6종목 정의 (index 어댑터, 무변경) ──────────────────

const ITEM_ORDER = ['nasdaq', 'dow', 'kospi', 'btc', 'vix', 'usdkrw'];

const ITEM_META = {
  btc:    { name: '비트코인 BTC-USD', dailyFn: fetchLongBTC    },
  nasdaq: { name: '나스닥 (^IXIC)',   dailyFn: fetchLongNasdaq },
  dow:    { name: '다우존스 (^DJI)',  dailyFn: fetchLongDow    },
  vix:    { name: 'VIX 공포지수',     dailyFn: fetchLongVIX    },
  kospi:  { name: '코스피 (^KS11)',   dailyFn: fetchLongKOSPI  },
  usdkrw: { name: '원/달러',          dailyFn: fetchLongUSDKRW },
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

// 주식(Twelve Data 800req/day, 8req/min)은 더 긴 TTL로 호출량 절약
const STOCK_TF_TTL = {
  '1d': { mem: 600_000,   cdn: 300 },   // 10분
  '1w': { mem: 1_800_000, cdn: 900 },   // 30분
};

function getTTL(type, tf) {
  return (type === 'stock' ? STOCK_TF_TTL[tf] : null) ?? TF_TTL[tf];
}

const CACHE = {};   // 키: 'type:id:tf'

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

// 기존 index 어댑터 (analysis-long.js + btc-intraday.js) — 로직 100% 그대로
async function fetchIndexData(id, tf) {
  const { dailyFn } = ITEM_META[id];
  const isIntraday  = BTC_INTRADAY_TFS.includes(tf);

  if (isIntraday) {
    return fetchBTCByTF(tf);
  }

  const daily = await dailyFn();

  if (tf === '1w') {
    const weeklyHistory = toWeekly(daily.history, daily.ohlc_available);
    return {
      history:        weeklyHistory,
      ohlc_available: true,
      source:         daily.source + ' → 주봉 변환',
      tf:             '1w',
    };
  }

  return { ...daily, tf: '1d' };
}

async function fetchData(type, id, symbol, tf, market) {
  if (type === 'index')  return fetchIndexData(id, tf);
  if (type === 'crypto') return fetchCryptoByTF(id, symbol, tf);
  if (type === 'stock')  return fetchStockByTF(symbol, tf, market);
  throw new Error(`알 수 없는 type: ${type}`);
}

// ── 핸들러 ─────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' });

  const type   = req.query?.type ?? 'index';   // 생략 시 기존 6종목 경로(하위 호환)
  const id     = req.query?.id ?? null;
  const symbol = req.query?.symbol ?? null;
  const tf     = req.query?.tf ?? '1d';
  // stock 전용: 시장 구분(US/KR) — 생략 시 하위 호환으로 US(Twelve Data) 경로 유지.
  // 지원 tf는 시장과 무관하게 동일(TF.STOCK)하므로 capability 판정에는 영향 없음.
  const market = (req.query?.market ?? 'US').toUpperCase();
  // stock 전용: 표시용 이름(선택) — 없으면 기존처럼 symbol을 대문자로 표시(하위 호환).
  // KR은 숫자 코드라 이름 없이는 화면에 코드만 뜨므로 프론트에서 워치리스트 name을 실어보낸다.
  const nameParam = req.query?.name ?? null;

  let capabilityItem;
  if (type === 'index') {
    if (!id || !ITEM_ORDER.includes(id))
      return res.status(400).json({ error: `id 파라미터 필요. 허용: ${ITEM_ORDER.join(', ')}` });
    capabilityItem = { type: 'index', id };
  } else if (type === 'crypto') {
    if (!id || !symbol)
      return res.status(400).json({ error: 'crypto는 id(coingecko id), symbol 파라미터가 모두 필요합니다' });
    capabilityItem = { type: 'crypto', id, symbol };
  } else if (type === 'stock') {
    if (!symbol)
      return res.status(400).json({ error: 'stock은 symbol 파라미터가 필요합니다' });
    if (market !== 'US' && market !== 'KR')
      return res.status(400).json({ error: `알 수 없는 market: ${market} (허용: US, KR)` });
    capabilityItem = { type: 'stock', symbol };
  } else {
    return res.status(400).json({ error: `알 수 없는 type: ${type} (허용: index, crypto, stock)` });
  }

  const supportedTfs = await getSupportedTimeframes(capabilityItem);
  if (!supportedTfs.includes(tf)) {
    return res.status(400).json({
      error: `이 종목은 [${supportedTfs.join(', ')}]만 지원합니다. 요청된 tf: ${tf}`,
    });
  }

  const cacheId  = type === 'stock' ? symbol : id;
  const cacheKey = type === 'stock' ? `${type}:${market}:${cacheId}:${tf}` : `${type}:${cacheId}:${tf}`;
  const ttl      = getTTL(type, tf);
  const cached   = CACHE[cacheKey];

  if (cached && Date.now() - cached.timestamp < ttl.mem) {
    console.log(`[analysis/${cacheKey}] Cache HIT`);
    res.setHeader('Cache-Control', `s-maxage=${ttl.cdn}, stale-while-revalidate=60`);
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  const startMs = Date.now();
  console.log(`[analysis/${cacheKey}] Cache MISS — 수집 시작 (${fmtKST()})`);

  try {
    const { history, ohlc_available, source } = await fetchData(type, id, symbol, tf, market);

    if (!history || history.length < 2)
      throw new Error(`히스토리 부족: ${history?.length ?? 0}행`);

    const name = type === 'index' ? ITEM_META[id].name : (nameParam || symbol.toUpperCase());
    const latest = history[history.length - 1];
    const prev   = history[history.length - 2];
    const change     = r2(latest.close - prev.close);
    const changePct  = prev.close ? r4(change / prev.close * 100) : 0;

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
      `[analysis/${cacheKey}] ${history.length}봉 완료 (${elapsed}s)  source=${source}  ohlc=${ohlc_available}`
    );

    const item = {
      id: cacheId, type, name, tf,
      price:          latest.close,
      prev_close:     prev.close,
      change,
      change_pct:     changePct,
      direction:      direction(change),
      ohlc_available,
      history_long:   history,
      days_available: history.length,
      supported_tfs:  supportedTfs,
    };

    const data = { updated_at: fmtKST(), item };
    CACHE[cacheKey] = { data, timestamp: Date.now() };

    res.setHeader('Cache-Control', `s-maxage=${ttl.cdn}, stale-while-revalidate=60`);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (e) {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.error(`[analysis/${cacheKey}] 실패 (${elapsed}s): ${e.message}`);
    return res.status(500).json({ error: '데이터 수집 실패', details: e.message, id: cacheId, type, tf });
  }
}
