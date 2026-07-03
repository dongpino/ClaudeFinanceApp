/**
 * itemCategories.js — 홈 탭 카드 표시 목록(탭별 필터) 단일 정의
 *
 * 서버(react-app/api/_collectors/*)가 매기는 item.category(지수/환율/크립토 — 카드에
 * 배지로 표시되는 단일 문자열)와는 별개다. 여기서는 종목 하나가 여러 탭에 동시에
 * 속할 수 있어야 하므로(예: 나스닥은 "주요" 탭과 "지수" 탭에 모두 노출) categories를
 * 배열로 관리한다. 새 종목을 추가할 때는 이 배열에 한 줄만 추가하면 된다.
 *
 * categories 값: 'major'(주요) | 'index'(지수) | 'fx'(환율) | 'crypto'(크립토)
 * source: 어느 수집기(react-app/api/_collectors/*.js)가 이 종목을 제공하는지 —
 *         참고용 메모일 뿐 렌더링에는 쓰이지 않는다. item.source(카드에 표시되는
 *         실제 데이터 출처, 예: "CNBC")와는 다른 필드이니 혼동하지 말 것.
 */

export const ITEM_CATEGORIES = [
  { id: 'nasdaq', name: '나스닥',   source: 'us-indices', categories: ['major', 'index'] },
  { id: 'dow',    name: '다우존스', source: 'us-indices', categories: ['major', 'index'] },
  { id: 'kospi',  name: '코스피',   source: 'kr',          categories: ['major', 'index'] },
  { id: 'btc',    name: '비트코인', source: 'btc',         categories: ['major', 'crypto'] },
  { id: 'vix',    name: 'VIX',      source: 'us-indices', categories: ['index'] },
  { id: 'usdkrw', name: '원/달러',  source: 'kr',          categories: ['fx'] },
];

// 홈 탭 카테고리 버튼 — key는 ITEM_CATEGORIES의 categories 값과 매칭, label은 화면 표시용.
export const CATEGORY_TABS = [
  { key: 'major',  label: '주요' },
  { key: 'index',  label: '지수' },
  { key: 'fx',     label: '환율' },
  { key: 'crypto', label: '크립토' },
];

export const DEFAULT_CATEGORY = 'major';

/** 서버에서 받은 items 중 categoryKey 탭에 속하는 것만, 원래 순서를 유지해 반환 */
export function itemsInCategory(items, categoryKey) {
  const idsInCat = new Set(
    ITEM_CATEGORIES.filter(c => c.categories.includes(categoryKey)).map(c => c.id)
  );
  return items.filter(it => idsInCat.has(it.id));
}
