/**
 * btc-intraday.js — BTC 분봉/시간봉 수집 (Binance klines)
 *
 * 지원: 1m / 5m / 15m / 30m / 1h / 4h
 * 일봉(1d)은 analysis-long.js의 fetchLongBTC() 사용
 *
 * Binance klines 응답 배열 인덱스:
 *   [0] open time (ms), [1] open, [2] high, [3] low, [4] close, ...
 *
 * 반환 history 항목 형식 (intraday 전용):
 *   { time: number (Unix seconds), open, high, low, close }
 *   ← lightweight-charts는 intraday에 Unix seconds를 요구함
 *   ← 일봉/주봉의 { date: 'YYYY-MM-DD' } 형식과 구별됨
 */

function r2(n) { return Math.round(n * 100) / 100; }

// 타임프레임별 수집 봉 수: 차트 분석에 적정한 200~300봉 범위
const TF_LIMITS = {
  '1m':  300,  // ≈ 5시간
  '5m':  288,  // ≈ 24시간
  '15m': 300,  // ≈ 75시간 (3일)
  '30m': 300,  // ≈ 150시간 (6일)
  '1h':  300,  // ≈ 12.5일
  '4h':  250,  // ≈ 41일
};

export const BTC_INTRADAY_TFS = Object.keys(TF_LIMITS);

/**
 * BTC 분봉/시간봉 수집
 * @param {'1m'|'5m'|'15m'|'30m'|'1h'|'4h'} tf
 * @returns {{ history, ohlc_available: true, source: string, tf: string }}
 */
export async function fetchBTCByTF(tf) {
  if (!TF_LIMITS[tf]) throw new Error(`지원하지 않는 타임프레임: ${tf}`);

  const limit = TF_LIMITS[tf];
  const url   = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${tf}&limit=${limit}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status} (tf=${tf})`);

  const raw = await res.json();
  if (!Array.isArray(raw) || raw.length < 2)
    throw new Error(`Binance klines 응답 부족: ${raw?.length ?? 0}행 (tf=${tf})`);

  const history = raw.map(k => ({
    time:  Math.floor(Number(k[0]) / 1000),   // ms → Unix seconds
    open:  r2(parseFloat(k[1])),
    high:  r2(parseFloat(k[2])),
    low:   r2(parseFloat(k[3])),
    close: r2(parseFloat(k[4])),
  }));

  return { history, ohlc_available: true, source: `Binance ${tf}`, tf };
}
