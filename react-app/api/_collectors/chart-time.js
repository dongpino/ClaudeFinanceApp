/**
 * chart-time.js — 인트라데이(분봉/시간봉) 타임스탬프의 KST 표시 보정
 *
 * lightweight-charts는 타임존을 지원하지 않고 UTCTimestamp를 항상 UTC로 렌더링한다
 * (공식 문서 권장 우회법: 원하는 타임존의 벽시계 시각이 나오도록 오프셋만큼 시프트해서 넘긴다).
 * Binance/Bybit/CoinGecko 등 UTC ms epoch 소스는 이 함수로 변환한 값만 `time` 필드에 실어야 한다.
 *
 * 일봉/주봉('date': 'YYYY-MM-DD')은 시:분 정보가 없어 영향받지 않으므로 대상이 아니다.
 * Naver(한국주식/지수)는 이미 KST 기준 날짜 문자열을 쓰므로 대상이 아니다.
 */

const KST_OFFSET_SEC = 9 * 60 * 60;

/**
 * UTC ms epoch → lightweight-charts에 KST 벽시계 시각으로 표시될 UTC seconds
 * @param {number} tsMs — UTC 기준 밀리초 epoch (예: Binance klines의 k[0])
 * @returns {number}
 */
export function toKstChartTime(tsMs) {
  return Math.floor(tsMs / 1000) + KST_OFFSET_SEC;
}
