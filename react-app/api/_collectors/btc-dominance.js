/**
 * _collectors/btc-dominance.js — BTC 시가총액 도미넌스(%) 수집
 *
 * 소스: CoinGecko /global의 market_cap_percentage.btc — 현재값만 제공(과거 시계열은
 * 유료 Pro 전용, 2026-07-07 확인). 히스토리는 api/_lib/dominance-history.js가 매일
 * 값을 축적해 만든다 — 첫 며칠은 포인트가 적어 미니차트가 비거나(<5포인트) 짧게
 * 보이고, 30일이 지나면 다른 카드와 같은 30일 미니차트가 된다.
 *
 * unit: 'pct_pt' — 값 자체는 %(55.82%)로 표시하되, 등락은 국채금리(bp)와 달리
 * %p(퍼센트 포인트, +0.15%p)로 표시한다(MarketCard.jsx fcUnit 참고).
 *
 * history_bootstrapping: true — 항상 켜져 있음(이 종목의 history가 짧은 건 항상
 * "아직 못 쌓임"이지 "수집 실패"가 아니라서). change_unavailable: true — 비교할
 * 전날 기록이 아예 없을 때(서비스 시작 첫날)만 켜짐. 둘 다 MarketCard.jsx/DetailPage.jsx가
 * 읽어 "차트 데이터 부족" 경고 억제 + "수집 중 N/5일" 안내 + 등락 "—" 표시에 쓴다.
 */

import { trackedFetch } from '../_lib/health.js';

import { recordTodayIfMissing, getRecentHistory } from '../_lib/dominance-history.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'application/json, text/plain, */*',
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

function todayKST() { return fmtKST().slice(0, 10); }
function direction(change) { return change > 0 ? 'up' : change < 0 ? 'down' : 'flat'; }
function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }

async function fetchJSON(url) {
  const res = await trackedFetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function fetchCurrentDominance() {
  const data = await fetchJSON('https://api.coingecko.com/api/v3/global');
  const pct  = data?.data?.market_cap_percentage?.btc;
  if (typeof pct !== 'number') throw new Error('BTC 도미넌스 데이터 없음');
  return r2(pct);
}

export async function collectBtcDominance({ include90d = true } = {}) {
  const current = await fetchCurrentDominance();

  // 오늘 값 기록(이미 있으면 no-op) — 히스토리 축적은 이 한 줄이 전부.
  await recordTodayIfMissing(current);

  const history     = await getRecentHistory(30);
  const history_90d = include90d ? await getRecentHistory(90) : [];

  // 전일 대비 = 오늘 이전(strictly before) 마지막 기록값 대비 — 아직 그런 기록이 없으면
  // (서비스 시작 첫날) 비교 대상 자체가 없는 것이므로 change_unavailable=true로 표시해
  // "0.00%p"(실제로는 -0이 뜰 수도 있는) 대신 컴포넌트가 "—"를 보여주게 한다.
  const today     = todayKST();
  const priors    = history.filter(h => h.date < today);
  const hasPrior  = priors.length > 0;
  const prevClose = hasPrior ? priors[priors.length - 1].close : current;
  const change     = hasPrior ? r2(current - prevClose) : 0;
  const changePct  = hasPrior && prevClose ? r4(change / prevClose * 100) : 0;

  const item = {
    id: 'dominance', name: 'BTC 도미넌스', symbol: 'BTC.D',
    price:          current,
    prev_close:     r2(prevClose),
    change,
    change_pct:     changePct,
    direction:      direction(change),
    source:         'CoinGecko',
    as_of:          fmtKST(),
    category:       '크립토',
    unit:           'pct_pt',
    // 이 종목의 history는 Redis 일별 축적물이라 짧은 게 "장애"가 아니라 정상 상태다 —
    // MarketCard.jsx가 detectIssues의 "차트 데이터 부족" 경고를 끄고 "수집 중 N/5일"
    // 안내로 대체하는 데 쓴다.
    history_bootstrapping: true,
    change_unavailable: !hasPrior,
    history,
    ohlc_available: false,
    history_90d,
  };

  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  console.log(`[dominance] ${item.price}%  ${hasPrior ? sign(item.change) + '%p' : '(비교 대상 없음)'}  hist=${history.length}  hist_90d=${history_90d.length}`);
  return item;
}
