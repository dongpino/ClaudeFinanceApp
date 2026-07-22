/**
 * _collectors/crypto-simple-price.js — 여러 코인 현재가를 CoinGecko /simple/price 한 번으로.
 *
 * 홈 aggregation에서 btc·eth 현재가를 각 컬렉터가 개별 /simple/price로 2콜 치던 것을
 * ids=bitcoin,ethereum 1콜로 병합한다(진단 1의 버스트 축소, 홈 CoinGecko 5콜 → 4콜).
 * 반환 형식은 btc.js/eth.js의 fetchCurrentPrice와 동일해 그대로 priceOverride로 넘길 수 있다.
 */

import { trackedFetch } from '../_lib/health.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

async function fetchJSON(url) {
  const res = await trackedFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

/**
 * @param {string[]} ids — CoinGecko coin id 배열 (예: ['bitcoin', 'ethereum'])
 * @returns {Promise<Record<string, {current, prevClose, change, changePct, asOf, source}>>}
 *   유효 가격이 없는 id는 결과에서 빠진다(호출부가 개별 폴백을 타게 둠).
 *   source는 항상 'CoinGecko'(이 함수는 CoinGecko 전용) — collectBTC/ETH가 이 값을
 *   item.source에 그대로 실어 배지에 표시한다. 배치 자체가 실패하면 호출부가 각
 *   컬렉터의 fetchCurrentPrice(=Binance/Bybit 폴오버 포함)로 넘어간다.
 */
export async function fetchSimplePrices(ids) {
  if (!ids || ids.length === 0) return {};
  const data = await fetchJSON(
    'https://api.coingecko.com/api/v3/simple/price' +
    `?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`
  );
  const out = {};
  for (const id of ids) {
    const row = data?.[id];
    if (!row || typeof row.usd !== 'number') continue;
    const current   = row.usd;
    const changePct = typeof row.usd_24h_change === 'number' ? row.usd_24h_change : 0;
    const prevClose = current / (1 + changePct / 100);
    const asOf      = row.last_updated_at ? fmtKST(row.last_updated_at * 1000) : fmtKST();
    out[id] = { current, prevClose, change: current - prevClose, changePct, asOf, source: 'CoinGecko' };
  }
  return out;
}
