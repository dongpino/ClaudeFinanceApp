/**
 * twelvedata.js — Twelve Data 미국 주식 일봉 히스토리 수집
 *
 * Finnhub 무료 티어는 /stock/candle(과거 OHLC)을 지원하지 않음
 * (실측: 403 "You don't have access to this resource" — 2026-07-01 확인).
 * 실시간 시세·검색은 Finnhub를 그대로 쓰고, 분석 탭의 과거 250일 일봉만
 * Twelve Data time_series로 조달한다.
 *
 * 인증: apikey 쿼리 파라미터 (process.env.TWELVEDATA_API_KEY)
 * 무료 티어 한도: 800 req/day, 8 req/min → api/analysis.js의 캐시(TTL 5~10분)로 보호
 */

const TD_BASE = 'https://api.twelvedata.com';

/** 키 존재 여부 (핸들러에서 조기 체크용) */
export function hasKey() {
  return Boolean(process.env.TWELVEDATA_API_KEY);
}

function getKey() {
  const k = process.env.TWELVEDATA_API_KEY;
  if (!k) throw new Error('TWELVEDATA_API_KEY 환경변수가 설정되지 않았습니다');
  return k;
}

function r2(n) { return Math.round(n * 100) / 100; }

/**
 * 미국 주식 일봉 히스토리 (최근 250 거래일)
 * @param {string} symbol
 * @returns {Promise<{ history, ohlc_available: true, source: string }>}
 */
export async function fetchDailyHistory(symbol) {
  const key = getKey();
  const url = `${TD_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=250&apikey=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Twelve Data HTTP ${res.status} — ${body.slice(0, 150)}`);
  }
  const data = await res.json();
  if (data.status === 'error') throw new Error(`Twelve Data 오류: ${data.message ?? '알 수 없음'}`);
  if (!Array.isArray(data.values) || data.values.length < 10)
    throw new Error(`Twelve Data ${symbol}: 행 부족 (${data.values?.length ?? 0})`);

  // Twelve Data는 최신 순으로 내려줌 → 오래된 순으로 정렬
  const history = [...data.values].reverse().map(v => ({
    date:  v.datetime,
    open:  r2(parseFloat(v.open)),
    high:  r2(parseFloat(v.high)),
    low:   r2(parseFloat(v.low)),
    close: r2(parseFloat(v.close)),
  }));

  return { history, ohlc_available: true, source: 'Twelve Data' };
}
