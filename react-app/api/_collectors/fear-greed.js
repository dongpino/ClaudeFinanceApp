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

import { trackedFetch } from '../_lib/health.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'application/json, text/plain, */*',
};

// (fmtKST 제거 — as_of가 소스 timestamp 기반으로 바뀌면서 이 파일의 유일한 사용처가
//  사라졌다. 남겨 두면 "여기서도 현재 시각을 쓴다"는 오해를 부른다.)

function direction(change) { return change > 0 ? 'up' : change < 0 ? 'down' : 'flat'; }
function r4(n) { return Math.round(n * 10000) / 10000; }

async function fetchJSON(url) {
  const res = await trackedFetch(url, { headers: HEADERS });
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
    // ⚠️ 예전엔 fmtKST()(호출 시각)를 찍었다 — 이 지표는 00:00 UTC(=09:00 KST) 기준
    // 하루 한 번만 갱신되므로, 오후에 열어도 "지금 값"인 것처럼 보였다(2026-07-28 감사).
    // 소스가 주는 timestamp를 쓴다. 바로 위 history가 이미 같은 필드를 toDate()로 쓰고
    // 있어 헬퍼를 그대로 재사용 — as_of와 history 마지막 날짜가 항상 일치한다.
    as_of:          `${toDate(latest.timestamp)} (일 1회 갱신)`,
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
