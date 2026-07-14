/**
 * _collectors/watchlist.js — 개인 워치리스트("우미 투자") 고정 종목 4개 수집
 *
 * 홈 탭의 6번째 카테고리("우미 투자")용 — 지수/환율처럼 시장 전체를 대표하는
 * 종목이 아니라 사용자가 직접 고른 개별 종목 4개(미국 1 + 한국 3)를 고정
 * 배열로 수집한다. "주요" 탭과 달리 사용자가 UI에서 추가/삭제하지 않는
 * 고정 워치리스트라 편집 패널(MajorEditPanel.jsx)과는 무관하다.
 *
 * 시세는 각 시장의 기존 실시간 경로를 그대로 재사용한다:
 *   - 한국(419530/028300/080220): naver-stock.js의 개별종목 엔드포인트
 *     (kr.js가 쓰는 지수용 api/index/{code}와는 다른 api/stock/{code} 경로 — 이미
 *     구현돼 있던 것을 홈 탭에 처음 연결하는 것뿐).
 *   - 미국(HYPR): finnhub.js의 실시간 시세(/quote)는 그대로 쓰되, 일봉 히스토리는
 *     Finnhub가 아니라 Twelve Data로 받는다 — Finnhub 무료 티어가 /stock/candle을
 *     지원하지 않아(403, twelvedata.js 상단 주석 및 2026-07-14 재확인 — HYPR뿐
 *     아니라 이 API 키로는 어떤 심볼도 403) 분석 탭과 동일한 대체 경로를 쓴다.
 *
 * 두 히스토리 함수(fetchKRDailyHistory/fetchUSDailyHistory) 모두 이미 완전한
 * OHLC({date,open,high,low,close,volume})를 주므로 그대로 슬라이스만 해서 쓴다 —
 * DetailPage.jsx의 캔들차트(Chart.jsx, item.ohlc_available 체크)가 별도 비용 없이
 * 그대로 동작한다. include90d는 다른 컬렉터(kr.js 등)와 동일한 관례 — 홈 집계
 * (include90d:false)에서는 가볍게, 상세 조회(include90d:true)에서만 90일까지 슬라이스.
 *
 * currency 필드('krw'|'usd')는 이 컬렉터가 새로 추가하는 값이다 — MarketCard/
 * DetailPage가 있으면 $/₩ 접두어를 붙이고 없으면(기존 15종목) 아무것도 안 붙이는
 * opt-in 방식이라 기존 카드 표시에는 영향이 없다.
 */
import { fetchKRQuotes, fetchKRDailyHistory } from './naver-stock.js';
import { fetchStockPrices } from './finnhub.js';
import { fetchDailyHistory as fetchUSDailyHistory } from './twelvedata.js';

const HOME_HISTORY_DAYS = 30; // 홈 카드 스파크라인 — 다른 홈 카드(지수 등)와 동일한 기간
const DETAIL_HISTORY_DAYS = 90; // 상세 화면 — 다른 종목의 history_90d와 동일한 기간

const WATCHLIST = [
  { market: 'us', symbol: 'HYPR',   name: '하이퍼파인' },
  { market: 'kr', symbol: '419530', name: 'SAMG엔터' },
  { market: 'kr', symbol: '028300', name: 'HLB' },
  { market: 'kr', symbol: '080220', name: '제주반도체' },
];

export const WATCHLIST_IDS = WATCHLIST.map(w => w.symbol);

async function buildKRItem({ symbol, name }, include90d) {
  const wantRows = include90d ? DETAIL_HISTORY_DAYS : HOME_HISTORY_DAYS;
  const [quotes, historyResult] = await Promise.all([
    fetchKRQuotes([symbol]),
    fetchKRDailyHistory(symbol, { totalRows: wantRows })
      .catch(e => { console.warn(`[watchlist] ${symbol} history 실패: ${e.message}`); return null; }),
  ]);
  const base = quotes[0];
  if (!base) return null;

  const fullHistory = historyResult?.history ?? [];
  const history      = fullHistory.slice(-HOME_HISTORY_DAYS);
  const history_90d  = include90d ? fullHistory.slice(-DETAIL_HISTORY_DAYS) : [];

  return {
    ...base,
    name: base.name || name, // Naver stockName 우선(이미 실측 대조 완료) — 실패 시만 하드코딩 이름 폴백
    history,
    history_90d,
    ohlc_available: Boolean(historyResult?.ohlc_available),
    as_of: history.length ? `${history.at(-1).date} (Naver 종가)` : undefined,
    currency: 'krw',
  };
}

async function buildUSItem({ symbol, name }, include90d) {
  const [quotes, historyResult] = await Promise.all([
    fetchStockPrices([symbol]),
    fetchUSDailyHistory(symbol)
      .catch(e => { console.warn(`[watchlist] ${symbol} history 실패: ${e.message}`); return null; }),
  ]);
  const base = quotes[0];
  if (!base) return null;

  const fullHistory = historyResult?.history ?? [];
  const history      = fullHistory.slice(-HOME_HISTORY_DAYS);
  const history_90d  = include90d ? fullHistory.slice(-DETAIL_HISTORY_DAYS) : [];

  return {
    ...base,
    name, // Finnhub는 name을 symbol로 채우는 관례(finnhub.js 주석 참고) — 실제 회사명으로 덮어씀
    history,
    history_90d,
    ohlc_available: Boolean(historyResult?.ohlc_available),
    as_of: history.length ? `${history.at(-1).date} (Twelve Data 종가)` : undefined,
    currency: 'usd',
  };
}

export async function collectWatchlist({ include90d = false } = {}) {
  const results = await Promise.allSettled(
    WATCHLIST.map(w => (w.market === 'kr' ? buildKRItem(w, include90d) : buildUSItem(w, include90d)))
  );

  const items = [];
  results.forEach((r, i) => {
    const w = WATCHLIST[i];
    if (r.status === 'fulfilled' && r.value) items.push(r.value);
    else console.error(`[watchlist] ${w.symbol} 수집 실패: ${r.status === 'rejected' ? r.reason?.message : '결과 없음'}`);
  });
  return items;
}
