/**
 * btc-intraday.js — Binance 심볼 분봉/시간봉 수집 (BTC 전용에서 임의 심볼로 일반화)
 *
 * 소스 우선순위 (Vercel 환경에서 api.binance.com이 차단될 수 있음):
 *   1. data-api.binance.vision  — Binance 공개 데이터 CDN, 지역 제한 없음
 *   2. api.binance.com          — 표준 Binance REST API
 *   3. api.bybit.com            — 최종 폴백 (인터벌 코드 변환 필요, BTC 전용 경로에서만 사용)
 *
 * 반환 history 항목: { time: number(Unix seconds), open, high, low, close }
 * ← lightweight-charts intraday 형식; 일봉/주봉의 { date: 'YYYY-MM-DD' }와 구별
 *
 * fetchBTCByTF(tf)는 fetchIntradayKlines('BTCUSDT', tf)의 얇은 wrapper — 기존 동작 100% 동일.
 */

function r2(n) { return Math.round(n * 100) / 100; }

const TF_LIMITS = {
  '1m':  300,  // ≈ 5시간
  '5m':  288,  // ≈ 24시간
  '15m': 300,  // ≈ 75시간 (3일)
  '30m': 300,  // ≈ 150시간 (6일)
  '1h':  300,  // ≈ 12.5일
  '4h':  250,  // ≈ 41일
};

// Bybit interval 코드 매핑 (Binance tf 코드 → Bybit 숫자)
const BYBIT_INTERVAL = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240',
};

export const BTC_INTRADAY_TFS = Object.keys(TF_LIMITS);

// ── 소스별 수집 함수 ────────────────────────────────────────

function parseBinanceKlines(raw) {
  if (!Array.isArray(raw) || raw.length < 2)
    throw new Error(`응답 행 부족: ${raw?.length ?? 0}행`);
  // k[5] = 거래량(base asset volume)
  return raw.map(k => ({
    time:   Math.floor(Number(k[0]) / 1000),
    open:   r2(parseFloat(k[1])),
    high:   r2(parseFloat(k[2])),
    low:    r2(parseFloat(k[3])),
    close:  r2(parseFloat(k[4])),
    volume: r2(parseFloat(k[5])),
  }));
}

async function fetchFromBinanceVision(pair, tf, limit) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${tf}&limit=${limit}`;
  console.log(`[intraday/${pair}/${tf}] 시도 1: data-api.binance.vision`);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '(body 없음)');
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const raw = await res.json();
  const history = parseBinanceKlines(raw);
  console.log(`[intraday/${pair}/${tf}] ✅ binance.vision: ${history.length}봉`);
  return { history, source: `Binance-Vision ${tf}` };
}

async function fetchFromBinanceCom(pair, tf, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${tf}&limit=${limit}`;
  console.log(`[intraday/${pair}/${tf}] 시도 2: api.binance.com`);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '(body 없음)');
    throw new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const raw = await res.json();
  const history = parseBinanceKlines(raw);
  console.log(`[intraday/${pair}/${tf}] ✅ binance.com: ${history.length}봉`);
  return { history, source: `Binance ${tf}` };
}

async function fetchFromBybit(pair, tf, limit) {
  const interval = BYBIT_INTERVAL[tf];
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${pair}&interval=${interval}&limit=${limit}`;
  console.log(`[intraday/${pair}/${tf}] 시도 3: api.bybit.com (interval=${interval})`);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '(body 없음)');
    throw new Error(`Bybit HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.retCode !== 0)
    throw new Error(`Bybit API 에러: retCode=${json.retCode} msg=${json.retMsg}`);
  const list = json?.result?.list;
  if (!Array.isArray(list) || list.length < 2)
    throw new Error(`Bybit 응답 행 부족: ${list?.length ?? 0}행`);
  // Bybit은 최신 봉이 앞에 옴 → reverse
  // list 항목: [startTimeMs, open, high, low, close, volume, turnover]
  const history = [...list].reverse().map(k => ({
    time:   Math.floor(Number(k[0]) / 1000),
    open:   r2(parseFloat(k[1])),
    high:   r2(parseFloat(k[2])),
    low:    r2(parseFloat(k[3])),
    close:  r2(parseFloat(k[4])),
    volume: r2(parseFloat(k[5])),
  }));
  console.log(`[intraday/${pair}/${tf}] ✅ Bybit: ${history.length}봉`);
  return { history, source: `Bybit ${tf}` };
}

async function fetchIntradaySources(pair, tf, limit, includeBybit) {
  const attempts = [
    ['binance.vision', () => fetchFromBinanceVision(pair, tf, limit)],
    ['binance.com',    () => fetchFromBinanceCom(pair, tf, limit)],
  ];
  if (includeBybit) attempts.push(['bybit', () => fetchFromBybit(pair, tf, limit)]);

  const errors = [];
  for (const [label, fn] of attempts) {
    try {
      const { history, source } = await fn();
      return { history, ohlc_available: true, source, tf };
    } catch (e) {
      console.warn(`[intraday/${pair}/${tf}] ❌ ${label}: ${e.message}`);
      errors.push(`${label}: ${e.message}`);
    }
  }

  throw new Error(`${pair} ${tf} 모든 소스 실패:\n  ${errors.join('\n  ')}`);
}

// ── 공개 함수 ───────────────────────────────────────────────

/**
 * 임의 Binance 심볼(USDT 마켓)의 분봉/시간봉 수집 — 2단계 소스 폴백(vision → binance.com)
 * @param {string} pair — 예: 'ETHUSDT'
 * @param {'1m'|'5m'|'15m'|'30m'|'1h'|'4h'} tf
 * @returns {{ history, ohlc_available: true, source: string, tf: string }}
 */
export async function fetchIntradayKlines(pair, tf) {
  if (!TF_LIMITS[tf]) throw new Error(`지원하지 않는 타임프레임: ${tf}`);
  return fetchIntradaySources(pair, tf, TF_LIMITS[tf], false);
}

/**
 * BTC 분봉/시간봉 수집 — 3단계 소스 폴백(vision → binance.com → bybit)
 * @param {'1m'|'5m'|'15m'|'30m'|'1h'|'4h'} tf
 * @returns {{ history, ohlc_available: true, source: string, tf: string }}
 */
export async function fetchBTCByTF(tf) {
  if (!TF_LIMITS[tf]) throw new Error(`지원하지 않는 타임프레임: ${tf}`);
  return fetchIntradaySources('BTCUSDT', tf, TF_LIMITS[tf], true);
}
