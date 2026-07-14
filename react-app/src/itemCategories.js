/**
 * itemCategories.js — 홈 탭 카드 표시 목록(탭별 필터) 단일 정의
 *
 * 서버(react-app/api/_collectors/*)가 매기는 item.category(지수/환율/크립토 — 카드에
 * 배지로 표시되는 단일 문자열)와는 별개다. 여기서는 종목 하나가 여러 탭에 동시에
 * 속할 수 있어야 하므로(예: 나스닥은 "주요" 탭과 "지수" 탭에 모두 노출) categories를
 * 배열로 관리한다. 새 종목을 추가할 때는 이 배열에 한 줄만 추가하면 된다.
 *
 * categories 값: 'major'(주요) | 'index'(지수) | 'fx'(환율) | 'crypto'(크립토) | 'macro'(매크로)
 * source: 어느 수집기(react-app/api/_collectors/*.js)가 이 종목을 제공하는지 —
 *         참고용 메모일 뿐 렌더링에는 쓰이지 않는다. item.source(카드에 표시되는
 *         실제 데이터 출처, 예: "CNBC")와는 다른 필드이니 혼동하지 말 것.
 */

export const ITEM_CATEGORIES = [
  // "우미 투자" — 개인 워치리스트 고정 종목 4개(api/_collectors/watchlist.js).
  // 사용자가 UI에서 추가/삭제하지 않으므로 'major'처럼 편집 패널이 없다 — 종목을
  // 바꾸려면 이 배열과 watchlist.js의 WATCHLIST 배열을 함께 한 줄씩 고치면 된다.
  { id: 'HYPR',       name: '하이퍼파인',          source: 'watchlist', categories: ['umi'] },
  { id: '419530',     name: 'SAMG엔터',            source: 'watchlist', categories: ['umi'] },
  { id: '028300',     name: 'HLB',                 source: 'watchlist', categories: ['umi'] },
  { id: '080220',     name: '제주반도체',          source: 'watchlist', categories: ['umi'] },
  { id: 'nasdaq',     name: '나스닥',              source: 'us-indices', categories: ['major', 'index'] },
  { id: 'dow',        name: '다우존스',            source: 'us-indices', categories: ['major', 'index'] },
  { id: 'kospi',      name: '코스피',              source: 'kr',          categories: ['major', 'index'] },
  { id: 'btc',        name: '비트코인',            source: 'btc',         categories: ['major', 'crypto'] },
  { id: 'vix',        name: 'VIX',                 source: 'us-indices', categories: ['index'] },
  { id: 'usdkrw',     name: '원/달러',             source: 'kr',          categories: ['fx'] },
  { id: 'kosdaq',     name: '코스닥',              source: 'kr',          categories: ['index'] },
  { id: 'us10y',      name: '미국 10년물 금리',    source: 'us-indices', categories: ['macro'] },
  { id: 'dxy',        name: '달러인덱스',          source: 'us-indices', categories: ['macro', 'fx'] },
  { id: 'sp500',      name: 'S&P500',              source: 'us-indices', categories: ['index'] },
  { id: 'sox',        name: '필라델피아 반도체(SOX)', source: 'us-indices', categories: ['index'] },
  { id: 'eth',        name: '이더리움',            source: 'eth',         categories: ['crypto'] },
  { id: 'dominance',  name: 'BTC 도미넌스',        source: 'btc-dominance', categories: ['crypto'] },
  { id: 'feargreed',  name: '공포탐욕지수',        source: 'fear-greed', categories: ['crypto'] },
  { id: 'jpykrw',     name: '원/엔(100엔)',        source: 'kr',          categories: ['fx'] },
];

// 홈 탭 카테고리 버튼 — key는 ITEM_CATEGORIES의 categories 값과 매칭, label은 화면 표시용.
// 순서가 곧 칩/스와이프 패널 순서(HomePage.jsx가 CATEGORY_TABS.length 기반으로
// 동작해 배열 길이가 몇 개든 자동으로 대응됨 — 하드코딩된 개수 가정 없음).
export const CATEGORY_TABS = [
  { key: 'umi',    label: '우미 투자' },
  { key: 'major',  label: '주요' },
  { key: 'index',  label: '지수' },
  { key: 'fx',     label: '환율' },
  { key: 'crypto', label: '크립토' },
  { key: 'macro',  label: '매크로' },
];

export const DEFAULT_CATEGORY = 'umi';

// 'major'(주요) 탭의 기본값 — ITEM_CATEGORIES에 categories:['major']로 태그된 종목들.
// 사용자가 홈 탭에서 직접 선택을 저장하면(homeMajorStore.js) 이 기본값 대신 그 선택을
// 쓰게 되므로, 여기 하드코딩된 'major' 태그는 "저장된 선택이 없을 때의 기본값 정의"로만
// 쓰인다 — 실제 필터링은 itemsInCategory()에 넘기는 majorIds가 담당한다.
export const DEFAULT_MAJOR_IDS = ITEM_CATEGORIES
  .filter(c => c.categories.includes('major'))
  .map(c => c.id);

/**
 * 서버에서 받은 items 중 categoryKey 탭에 속하는 것만, 원래 순서를 유지해 반환.
 * categoryKey==='major'일 때만 고정된 categories 태그 대신 majorIds(사용자 선택,
 * 없으면 DEFAULT_MAJOR_IDS)를 기준으로 필터링한다.
 */
export function itemsInCategory(items, categoryKey, majorIds = DEFAULT_MAJOR_IDS) {
  const idsInCat = categoryKey === 'major'
    ? new Set(majorIds)
    : new Set(ITEM_CATEGORIES.filter(c => c.categories.includes(categoryKey)).map(c => c.id));
  return items.filter(it => idsInCat.has(it.id));
}
