/**
 * indicators.js — 순수 기술적 지표 계산 함수
 *
 * 모든 함수는 부작용 없는 순수 함수.
 * 입력: 종가 배열(number[]) 또는 history 배열({date, close}[])
 * 출력:  lightweight-charts 호환 {time, value}[] (null 구간 제거됨)
 */

// ── 저수준 배열 계산 ──────────────────────────────────────

/**
 * Simple Moving Average
 * @param {number[]} closes
 * @param {number} period
 * @returns {(number|null)[]} 입력과 동일 길이, 앞 (period-1)개는 null
 */
export function smaArray(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    return sum / period;
  });
}

/**
 * RSI — Wilder's Smoothing Method (TradingView 기본값과 동일)
 *
 * Wilder 방식:
 *   초기 avgGain/avgLoss = 첫 period개 변화량의 단순평균
 *   이후 = (prev * (period-1) + current) / period  (지수 이동평균)
 *
 * @param {number[]} closes
 * @param {number} period  기본 14
 * @returns {(number|null)[]} 입력과 동일 길이, 앞 period개는 null
 */
export function rsiArray(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  // 첫 period개 변화량으로 초기 avgGain/avgLoss 계산
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else          avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;

  const toRSI = (g, l) => l === 0 ? 100 : 100 - 100 / (1 + g / l);
  result[period] = toRSI(avgGain, avgLoss);

  // Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = toRSI(avgGain, avgLoss);
  }

  return result;
}

// ── 고수준 — lightweight-charts 호환 출력 ─────────────────

/**
 * history 배열에서 SMA 계산 → {time, value}[] (null 제거)
 * @param {Array<{date:string, close:number}>} history
 * @param {number} period
 * @returns {Array<{time:string, value:number}>}
 */
export function calcMA(history, period) {
  const closes = history.map(r => r.close);
  const vals   = smaArray(closes, period);
  return vals
    .map((v, i) => v === null ? null : { time: history[i].date, value: +v.toFixed(4) })
    .filter(Boolean);
}

/**
 * history 배열에서 RSI 계산 → {time, value}[] (null 제거)
 * @param {Array<{date:string, close:number}>} history
 * @param {number} period  기본 14
 * @returns {Array<{time:string, value:number}>}
 */
export function calcRSI(history, period = 14) {
  const closes = history.map(r => r.close);
  const vals   = rsiArray(closes, period);
  return vals
    .map((v, i) => v === null ? null : { time: history[i].date, value: +v.toFixed(4) })
    .filter(Boolean);
}
