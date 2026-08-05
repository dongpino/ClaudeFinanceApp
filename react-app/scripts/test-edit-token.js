/**
 * scripts/test-edit-token.js — 편집 토큰이 HTTP 헤더로 나가기 전 검사 회귀 테스트
 *
 * 재현 사고(2026-08-05 프로덕션 실측): 한글이 섞인 토큰이 localStorage에 저장돼 있으면
 * 평단가 저장이 **요청을 보내기도 전에** 실패했다.
 *   TypeError: Failed to execute 'fetch' on 'Window': Failed to read the 'headers'
 *              property from 'RequestInit': String contains non ISO-8859-1 code point.
 * saveAvgPrices가 이 TypeError를 '네트워크 오류'로 감싸 사용자에게는 서버 장애로 보였고,
 * 서버 로그에는 아무 흔적도 남지 않았다.
 *
 * 그래서 여기서 고정하는 단언은 하나로 모인다 — **비-ASCII 토큰은 fetch에 닿지 않는다.**
 * (fetch 호출 횟수를 세어 확인한다. 값 검사만으로는 "실제로 안 나갔다"를 증명하지 못한다.)
 *
 * 실행: node scripts/test-edit-token.js
 */

// ── 스텁 ─────────────────────────────────────────────────────────────
let store = {};
globalThis.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};

let fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  // 실제 브라우저 fetch가 하는 헤더 검사를 그대로 재현한다 — 이 스텁이 던지면
  // "우리 코드가 헤더에 비-ASCII를 실었다"는 뜻이다(테스트가 사고를 재현한다).
  for (const v of Object.values(init?.headers ?? {})) {
    for (const ch of String(v)) {
      if (ch.codePointAt(0) > 255) {
        throw new TypeError("Failed to execute 'fetch': String contains non ISO-8859-1 code point.");
      }
    }
  }
  return {
    ok: true, status: 200,
    json: async () => ({ value: { HYPR: 1, 419530: null, '028300': null, '080220': null } }),
  };
};

const { STORAGE_KEY, isHeaderSafeToken, loadEditToken, saveEditToken } =
  await import('../src/editTokenStore.js');
const { saveAvgPrices, loadAvgPrices, getAvgPrice } = await import('../src/avgPriceStore.js');

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${label}`); }
}
const reset = () => { store = {}; fetchCalls = []; };

// ── (1) 헤더 안전성 판정 ─────────────────────────────────────────────
{
  assert(isHeaderSafeToken('abc123') === true, '1-1: 영숫자 통과');
  assert(isHeaderSafeToken('a-b_c.d~e!@#$%^&*()') === true, '1-2: 기호 통과');
  assert(isHeaderSafeToken('with space') === true, '1-3: 공백 허용(정상 시크릿을 거부하지 않는다)');
  assert(isHeaderSafeToken('한글토큰') === false, '1-4: 한글 거부 ← 이번 사고의 입력');
  assert(isHeaderSafeToken('abc한글') === false, '1-5: 일부만 섞여도 거부');
  assert(isHeaderSafeToken('emoji🙂') === false, '1-6: 이모지 거부');
  assert(isHeaderSafeToken('café') === false, '1-7: Latin-1 구간도 거부(서버는 ASCII 일치를 요구)');
  assert(isHeaderSafeToken('') === false, '1-8: 빈 문자열');
  assert(isHeaderSafeToken(null) === false && isHeaderSafeToken(undefined) === false, '1-9: 값 없음');
  assert(isHeaderSafeToken(12345) === false, '1-10: 문자열이 아니면 거부');
  assert(isHeaderSafeToken('tab\there') === false, '1-11: 제어문자 거부');
}

// ── (2) 저장소 — 잘못된 값을 들이지 않는다 ───────────────────────────
{
  reset();
  assert(saveEditToken('good-token') === true, '2-1: 정상 토큰은 저장된다');
  assert(store[STORAGE_KEY] === 'good-token', '2-2: 실제로 기록됨');
  assert(saveEditToken('한글토큰') === false, '2-3: 비-ASCII는 저장 거부(false 반환)');
  assert(store[STORAGE_KEY] === 'good-token', '2-4: 거부 시 기존 값을 훼손하지 않는다');
  assert(saveEditToken(null) === true && !(STORAGE_KEY in store), '2-5: null이면 삭제');
}

// ── (3) 이미 오염된 localStorage 방어(수정 이전 사용자) ──────────────
{
  reset();
  store[STORAGE_KEY] = '한글토큰';          // 수정 전에 저장돼 남아 있는 값
  assert(loadEditToken() === null, '3-1: 비-ASCII 보관값은 "없음"으로 취급');
  assert(store[STORAGE_KEY] === '한글토큰', '3-2: 읽기 함수가 저장소를 변조하지 않는다');
  assert(saveEditToken('new-token') === true && loadEditToken() === 'new-token',
    '3-3: 정상 토큰으로 덮어쓰면 복구된다');
}

// ── (4) **핵심** — 비-ASCII 토큰은 fetch에 닿지 않는다 ───────────────
{
  reset();
  store[STORAGE_KEY] = '한글토큰';
  let err = null;
  try { await saveAvgPrices({ HYPR: 1 }); } catch (e) { err = e; }
  assert(err !== null, '4-1: 저장이 실패로 끝난다');
  assert(err?.code === 'AUTH_ERROR', '4-2: 네트워크 오류가 아니라 AUTH_ERROR로 분류된다');
  assert(!(err instanceof TypeError), '4-3: fetch의 TypeError가 새어 나오지 않는다');
  assert(fetchCalls.length === 0, '4-4: **fetch가 아예 호출되지 않는다** (헤더에 닿기 전에 끊긴다)');

  // 읽기 경로도 같다 — 조용히 아무것도 하지 않는다
  reset();
  store[STORAGE_KEY] = '한글토큰';
  await loadAvgPrices();
  assert(fetchCalls.length === 0, '4-5: 로드 경로도 fetch를 부르지 않는다');
}

// ── (5) 정상 토큰은 종전대로 나간다(과잉 차단 아님) ──────────────────
{
  reset();
  store[STORAGE_KEY] = 'good-token';
  await saveAvgPrices({ HYPR: 1 });
  assert(fetchCalls.length === 1, '5-1: 정상 토큰이면 요청이 나간다');
  assert(fetchCalls[0].init.headers.Authorization === 'Bearer good-token', '5-2: Authorization 형식 유지');
  assert(fetchCalls[0].init.method === 'PUT', '5-3: PUT');
  // 헤더에는 토큰과 Content-Type뿐 — 사용자 데이터(종목명 등)가 실리는 자리가 없다
  assert(Object.keys(fetchCalls[0].init.headers).sort().join(',') === 'Authorization,Content-Type',
    '5-4: 헤더는 2개뿐 — 사용자 데이터가 헤더로 가지 않는다');
  // 값은 body로 간다
  assert(JSON.parse(fetchCalls[0].init.body).key === 'avgPrices', '5-5: 값은 body에 실린다');
  assert(getAvgPrice('HYPR') === 1, '5-6: 서버 응답값이 캐시에 반영된다');
}

// ── (6) 갱신 통지 — 저장/삭제가 화면에 닿는 경로 ─────────────────────
// 상세 화면 패리티는 getAvgPrice()를 렌더 중에 동기로 읽으므로, 화면이 바뀌려면 누군가
// 리렌더를 걸어야 한다. 그 트리거가 subscribeAvgPrices → DataContext의 tick이다.
// 여기서는 그 사슬의 앞부분(캐시 갱신 → 구독자 통지)이 실제로 도는지 고정한다.
{
  const { subscribeAvgPrices } = await import('../src/avgPriceStore.js');
  reset();
  store[STORAGE_KEY] = 'good-token';
  let notified = 0;
  const unsub = subscribeAvgPrices(() => { notified++; });

  await saveAvgPrices({ HYPR: 1 });
  assert(notified === 1, '6-1: 저장 성공 시 구독자에게 1회 통지된다(→ 리렌더 → 패리티 표시)');
  assert(getAvgPrice('HYPR') === 1, '6-2: 캐시에 값이 들어온다');

  // 값 삭제 — 서버가 null을 돌려주는 응답으로 바꿔 같은 경로를 태운다
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ value: { HYPR: null } }) });
  await saveAvgPrices({ HYPR: null });
  globalThis.fetch = prevFetch;
  assert(notified === 2, '6-3: 삭제도 같은 경로로 통지된다');
  assert(getAvgPrice('HYPR') === null, '6-4: 값이 사라지면 null (→ 패리티 표시가 숨는다)');

  unsub();
  await saveAvgPrices({ HYPR: 1 });
  assert(notified === 2, '6-5: 구독 해제 후에는 통지되지 않는다');
}

console.log(fail === 0 ? `✓ 전체 통과 — pass ${pass}, fail ${fail}` : `✗ 실패 — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
