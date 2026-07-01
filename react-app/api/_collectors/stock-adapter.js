/**
 * stock-adapter.js — 미국 주식 분석 데이터 어댑터
 *
 * 일봉: Twelve Data time_series (Finnhub 무료 티어는 과거 OHLC 미지원)
 * 주봉: 일봉을 weekly-transform.js(toWeekly)로 집계 — 인덱스 어댑터와 동일 방식 재사용
 *
 * 반환 형식은 index/crypto 어댑터와 동일: { history, ohlc_available, source }
 */

import { fetchDailyHistory } from './twelvedata.js';
import { toWeekly } from './weekly-transform.js';

/**
 * @param {string} symbol
 * @param {'1d'|'1w'} tf
 * @returns {Promise<{ history, ohlc_available, source }>}
 */
export async function fetchStockByTF(symbol, tf) {
  const daily = await fetchDailyHistory(symbol);

  if (tf === '1w') {
    const weekly = toWeekly(daily.history, true);
    return { history: weekly, ohlc_available: true, source: daily.source + ' → 주봉 변환' };
  }
  if (tf === '1d') return daily;

  throw new Error(`stock ${symbol}: 지원하지 않는 tf "${tf}"`);
}
