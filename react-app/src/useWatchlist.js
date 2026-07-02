/**
 * useWatchlist.js — 즐겨찾기 React hook
 *
 * watchlistStore를 구독해서 여러 컴포넌트가 동기화됨.
 * 컴포넌트는 이 hook만 호출하고 localStorage를 직접 접근하지 않음.
 *
 * 반환:
 *   watchlist   — 현재 즐겨찾기 배열 ({ type, id, symbol, name, addedAt }[])
 *   add(item)   — 추가. 성공: 새 배열, 실패(중복·상한): null
 *   remove(id)  — 삭제
 *   reorder(fromIdx, toIdx) — 순서 변경
 *   isWatched(id) — 즐겨찾기 여부
 *   patchItem(id, fields) — 개별 항목 필드 병합 갱신 (예: 구버전 항목 name 백필)
 *   MAX_WATCHLIST — 상한값 (상수)
 */

import { useState, useEffect, useCallback } from 'react';
import * as store from './watchlistStore.js';

export default function useWatchlist() {
  const [watchlist, setWatchlist] = useState(() => store.load());

  // store 변경 구독 — 여러 컴포넌트/hook 인스턴스 동기화
  useEffect(() => {
    const unsub = store.subscribe(setWatchlist);
    return unsub;
  }, []);

  const add = useCallback((item) => {
    return store.add(item);   // null이면 중복·상한 초과
  }, []);

  const remove = useCallback((id) => {
    store.remove(id);
  }, []);

  const reorder = useCallback((fromIdx, toIdx) => {
    store.reorder(fromIdx, toIdx);
  }, []);

  const isWatched = useCallback((id) => {
    return watchlist.some(it => it.id === id);
  }, [watchlist]);

  const patchItem = useCallback((id, fields) => {
    return store.patch(id, fields);
  }, []);

  return {
    watchlist,
    add,
    remove,
    reorder,
    isWatched,
    patchItem,
    MAX_WATCHLIST: store.MAX_WATCHLIST,
  };
}
