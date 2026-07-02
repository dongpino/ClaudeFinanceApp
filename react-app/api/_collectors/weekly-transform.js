/**
 * weekly-transform.js — 일봉 히스토리 → 주봉 변환 (전 종목 공통)
 *
 * 입력: 일봉 history 배열 { date: 'YYYY-MM-DD', close, open?, high?, low? }
 * 출력: 주봉 history 배열 { date: 'YYYY-MM-DD'(해당 주 월요일), open, high, low, close }
 *
 * OHLC 출처:
 *   - ohlcAvailable=true  (BTC): 실제 일봉 OHLC를 주 단위 집계
 *   - ohlcAvailable=false (나머지): 주간 일봉 종가들로 synthetic OHLC 생성
 *     open=주 첫날 종가, high=주중 최고 종가, low=주중 최저 종가, close=주 마지막날 종가
 *     → 가격 범위는 실제 거래 범위와 다를 수 있으나, 주간 추세 파악에 충분
 *
 * 반환 history도 { date, open, high, low, close } 형식으로 통일.
 * 호출측에서 ohlc_available=true로 처리해도 무방 (synthetic 여부는 source 필드로 구분).
 *
 * volume이 있는 일봉(어댑터가 제공하는 경우)은 주 단위로 합산해 volume 필드로 실어 보낸다.
 * 없으면 그대로 생략(undefined) — 호출측에서 volume 유무로 표시 여부를 판단.
 */

/**
 * dateStr('YYYY-MM-DD')이 속하는 주의 월요일 ISO 날짜 반환
 * @param {string} dateStr
 * @returns {string}
 */
function getWeekMonday(dateStr) {
  const d   = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay();                          // 0=일, 1=월, ..., 6=토
  const diff = day === 0 ? -6 : 1 - day;             // 월요일까지의 오프셋
  return new Date(d.getTime() + diff * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 일봉 히스토리를 주봉으로 집계
 *
 * @param {Array<{date:string, close:number, open?:number, high?:number, low?:number}>} history
 * @param {boolean} ohlcAvailable - 실제 OHLC 보유 여부
 * @returns {Array<{date:string, open:number, high:number, low:number, close:number}>}
 */
export function toWeekly(history, ohlcAvailable) {
  const weeks = new Map(); // monday → candle

  for (const row of history) {
    const monday = getWeekMonday(row.date);
    const o = ohlcAvailable ? row.open  : row.close;
    const h = ohlcAvailable ? row.high  : row.close;
    const l = ohlcAvailable ? row.low   : row.close;
    const v = typeof row.volume === 'number' ? row.volume : undefined;

    if (!weeks.has(monday)) {
      const candle = { date: monday, open: o, high: h, low: l, close: row.close };
      if (v !== undefined) candle.volume = v;
      weeks.set(monday, candle);
    } else {
      const w   = weeks.get(monday);
      w.high    = Math.max(w.high, h);
      w.low     = Math.min(w.low,  l);
      w.close   = row.close;             // 마지막 일봉 종가 = 주봉 종가
      if (v !== undefined) w.volume = (w.volume ?? 0) + v;
    }
  }

  return [...weeks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, candle]) => candle);
}
