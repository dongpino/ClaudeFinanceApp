/**
 * stock-adapter.js — 주식 분석 데이터 어댑터 (미국·한국 공용)
 *
 * 일봉: market='US' → Twelve Data time_series (Finnhub 무료 티어는 과거 OHLC 미지원)
 *       market='KR' → Naver 모바일 API (Twelve Data 무료 티어는 KRX 심볼 미지원 — 404 "Pro/Venture plan")
 * 주봉: 일봉을 weekly-transform.js(toWeekly)로 집계 — 인덱스 어댑터와 동일 방식 재사용
 *
 * 반환 형식은 index/crypto 어댑터와 동일: { history, ohlc_available, source }
 */

import { fetchDailyHistory } from './twelvedata.js';
import { fetchKRDailyHistory } from './naver-stock.js';
import { toWeekly } from './weekly-transform.js';

// KRX 종목코드는 6자리 숫자(예: '005930'). market 파라미터가 누락되거나 잘못 전달돼도
// 이런 심볼이 Twelve Data(KRX 심볼 미지원, 404)로 새는 것을 막기 위한 가드.
const KR_SYMBOL_RE = /^\d{6}$/;

/**
 * @param {string} symbol
 * @param {'1d'|'1w'} tf
 * @param {'US'|'KR'} [market='US']
 * @returns {Promise<{ history, ohlc_available, source }>}
 */
export async function fetchStockByTF(symbol, tf, market = 'US') {
  const isKR  = market === 'KR' || KR_SYMBOL_RE.test(symbol);
  const daily = isKR ? await fetchKRDailyHistory(symbol) : await fetchDailyHistory(symbol);

  if (tf === '1w') {
    const weekly = toWeekly(daily.history, true);
    return { history: weekly, ohlc_available: true, source: daily.source + ' → 주봉 변환' };
  }
  if (tf === '1d') return daily;

  throw new Error(`stock ${symbol}: 지원하지 않는 tf "${tf}"`);
}
