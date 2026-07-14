/**
 * analysisLink.js — 홈/상세 카드 → 분석 탭 선택 상태 매핑
 *
 * 모든 카드가 분석 탭에서 열리지는 않는다 — api/analysis.js가 서버에서 엄격하게
 * 검증하는 대상만 매핑한다(허용 안 되는 조합은 400). "일단 시도해보고 실패하면
 * 숨긴다" 대신, 이미 검증된(analysis.js 코드 열람 + 실측) 조합만 명시적으로
 * 등록해 "눌리는데 실패하는 버튼"을 원천 차단한다(getAnalysisSelection이 null을
 * 반환하면 호출부가 버튼 자체를 렌더하지 않음).
 *
 * - index: api/analysis.js의 ITEM_ORDER(기존 6종목)만 — id 그대로 전달.
 *   (kosdaq/us10y/dxy/sp500/sox/jpykrw는 이 목록에 없어 전부 400 — 대상 아님)
 * - crypto: 홈의 짧은 id와 분석 탭이 요구하는 CoinGecko id가 다르다(2026-07-14
 *   vercel dev 실측: type=crypto&id=eth는 실패, id=ethereum이어야 성공) — 변환 필요.
 *   (dominance/feargreed는 가격·OHLC 자산이 아니라 애초에 대상 아님)
 * - stock: "우미 투자" 워치리스트 4종(api/_collectors/watchlist.js와 동일 목록을
 *   여기 별도로 유지 — 그쪽은 서버 전용 모듈이라 클라이언트에서 직접 import 불가).
 */

const INDEX_IDS = new Set(['nasdaq', 'dow', 'kospi', 'btc', 'vix', 'usdkrw']);

// 홈 id → 분석 탭(crypto) CoinGecko id. symbol은 홈 item이 이미 분석 탭과 동일한
// 값을 쓰고 있어(예: 'ETH-USD') 별도 변환이 필요 없다.
const CRYPTO_ID_MAP = {
  eth: 'ethereum',
};

// 우미 투자 워치리스트 — api/_collectors/watchlist.js의 WATCHLIST와 반드시 같은
// 심볼 집합을 유지해야 한다(종목 추가/삭제 시 양쪽 다 고칠 것).
const STOCK_MARKET_MAP = {
  HYPR:     'US',
  '419530': 'KR',
  '028300': 'KR',
  '080220': 'KR',
};

/**
 * @param {object} item — 홈/상세 카드의 item 객체(id, symbol, name 등)
 * @returns {{type:string, id?:string, symbol:string, name:string, market?:string} | null}
 */
export function getAnalysisSelection(item) {
  if (!item?.id) return null;

  if (INDEX_IDS.has(item.id)) {
    return { type: 'index', id: item.id, symbol: item.symbol ?? item.id, name: item.name };
  }
  if (CRYPTO_ID_MAP[item.id]) {
    return { type: 'crypto', id: CRYPTO_ID_MAP[item.id], symbol: item.symbol ?? item.id.toUpperCase(), name: item.name };
  }
  if (STOCK_MARKET_MAP[item.id]) {
    // AnalysisPage.jsx의 selectItem()이 item.id를 selected.id로 그대로 저장하고
    // isSelected()/isWatched() 등이 그 id로 비교한다 — 검색 결과 stock 항목도
    // 항상 id를 symbol과 동일하게 채우는 관례(AnalysisPage.jsx의
    // `{...s, id: s.symbol}`)를 그대로 따라야 즐겨찾기/선택 하이라이트가 맞는다.
    return { type: 'stock', id: item.id, symbol: item.id, name: item.name, market: STOCK_MARKET_MAP[item.id] };
  }
  return null;
}
