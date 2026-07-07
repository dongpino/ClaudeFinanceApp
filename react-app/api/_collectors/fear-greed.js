/**
 * _collectors/fear-greed.js — 공포탐욕지수(Crypto Fear & Greed Index) 수집
 *
 * 소스: Alternative.me 무료 API(https://api.alternative.me/fng/) — 현재값뿐 아니라
 * 과거 값까지 한 번의 호출로 제공해(2026-07-07 확인, limit=100 정상 응답) BTC
 * 도미넌스와 달리 자체 히스토리 축적이 필요 없다.
 *
 * unit: 'score' — 0~100 지수(가격이 아님). 값은 그대로("72"), 등락은 %가 아니라
 * 포인트 차("+3")로 표시한다(MarketCard.jsx fcUnit 참고). 등급(value_classification)은
 * 영문 원본 그대로 item.grade에 담아 컴포넌트에서 한글 라벨·색으로 매핑한다.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'application/json, text/plain, */*',
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

function direction(change) { return change > 0 ? 'up' : change < 0 ? 'down' : 'flat'; }
function r4(n) { return Math.round(n * 10000) / 10000; }

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

export async function collectFearGreed({ include90d = true } = {}) {
  const limit = include90d ? 100 : 30;
  const data  = await fetchJSON(`https://api.alternative.me/fng/?limit=${limit}`);
  const rows  = data?.data ?? [];
  if (rows.length === 0) throw new Error('Fear&Greed 데이터 없음');

  // API는 최신순(index 0=오늘) — history는 날짜 오름차순(오래된→최신) 관례를 따른다.
  const toDate = ts => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
  const asc = [...rows].reverse().map(r => ({ date: toDate(r.timestamp), close: Number(r.value) }));

  const latest  = rows[0];
  const prev    = rows[1];
  const current = Number(latest.value);
  const prevVal = prev ? Number(prev.value) : current;
  const change  = current - prevVal;
  const changePct = prevVal ? r4(change / prevVal * 100) : 0;

  const item = {
    id: 'feargreed', name: '공포탐욕지수', symbol: 'FNG',
    price:          current,
    prev_close:     prevVal,
    change,
    change_pct:     changePct,
    direction:      direction(change),
    source:         'Alternative.me',
    as_of:          fmtKST(),
    category:       '크립토',
    unit:           'score',
    grade:          latest.value_classification, // 'Extreme Fear'|'Fear'|'Neutral'|'Greed'|'Extreme Greed'
    history:        asc.slice(-30),
    ohlc_available: false,
    history_90d:    include90d ? asc.slice(-90) : [],
  };

  const sign = n => (n >= 0 ? '+' : '') + n;
  console.log(`[feargreed] ${item.price}(${item.grade})  ${sign(item.change)}  hist=${item.history.length}  hist_90d=${item.history_90d.length}`);
  return item;
}
