/**
 * editTokenStore.js — 1인용 편집 토큰(EDIT_TOKEN) localStorage 보관
 *
 * /api/user-prefs(및 향후 비슷하게 보호될 엔드포인트)에 Authorization: Bearer로
 * 붙일 토큰을 로컬에만 저장한다. 토큰 값 자체의 검증은 매 요청마다 서버가
 * 하므로, 여기는 단순 보관/조회만 담당한다 — 다른 기기(시크릿 창 등)에서는
 * 이 저장소가 비어 있어 avgPriceStore.js의 읽기/쓰기가 자연히 막힌다.
 */

export const STORAGE_KEY = 'finance_edit_token_v1';

/**
 * **헤더에 실을 수 있는 토큰인가** — 인쇄 가능한 ASCII(공백 포함)만 허용한다.
 *
 * 이 검사가 없으면 한글 등이 섞인 토큰이 그대로 `Authorization` 헤더로 들어가고,
 * fetch가 요청을 **보내기도 전에** 던진다:
 *   TypeError: Failed to read the 'headers' property from 'RequestInit':
 *              String contains non ISO-8859-1 code point.
 * 실측(2026-08-05, 프로덕션 브라우저 콘솔) — 서버 로그에는 아무 흔적이 남지 않는다.
 *
 * ⚠️ 브라우저의 실제 한계보다 **일부러 좁게** 잡는다. fetch가 막는 것은 코드포인트
 *    255 초과지만, 여기서는 \x20~\x7E만 통과시킨다. 근거: 이 토큰은 서버에서
 *    `req.headers.authorization === 'Bearer ' + process.env.EDIT_TOKEN`로 **바이트 단위
 *    일치**를 요구한다(api/user-prefs.js:51). 환경변수로 주입되는 값이라 정의상 ASCII이고,
 *    Latin-1 구간(\x80~\xFF)을 허용해 봐야 인코딩만 모호해지고 결과는 401이다.
 * ⚠️ 공백은 허용한다 — 시크릿에 공백이 들어갈 여지를 굳이 막으면 **정상 토큰을 거부하는**
 *    반대 방향의 사고가 난다. 앞뒤 공백은 호출부가 trim한다.
 */
const HEADER_SAFE_RE = /^[\x20-\x7E]+$/;

/** @returns {boolean} 헤더에 실어도 fetch가 던지지 않는 토큰인지 */
export function isHeaderSafeToken(token) {
  return typeof token === 'string' && HEADER_SAFE_RE.test(token);
}

/**
 * @returns {string|null} 보관된 토큰. **헤더에 실을 수 없는 값이면 없는 것으로 친다.**
 *
 * ⚠️ 이 수정 이전에 저장된 비-ASCII 토큰이 localStorage에 남아 있을 수 있다. 그대로
 *    돌려주면 매번 같은 자리에서 fetch가 던지므로, 여기서 걸러 "토큰 없음"으로 만든다 —
 *    그러면 편집 패널이 다시 물어보는 기존 경로를 그대로 탄다.
 * ⚠️ 여기서 localStorage를 **지우지 않는다.** 읽기 함수가 저장소를 변조하면 호출 순서에
 *    따라 결과가 달라진다. 다음 정상 저장이 덮어쓰므로 남아 있어도 해가 없다.
 */
export function loadEditToken() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || null;
    if (raw && !isHeaderSafeToken(raw)) {
      console.warn('[editToken] 보관된 토큰에 헤더로 보낼 수 없는 문자가 있어 무시합니다(재입력 필요)');
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * @returns {boolean} 실제로 저장했는지. **헤더에 실을 수 없는 값은 저장하지 않는다** —
 *   저장해 두면 그 값이 다음 요청에서 똑같이 터진다(원인을 저장소에 남기지 않는다).
 */
export function saveEditToken(token) {
  try {
    if (!token) {
      localStorage.removeItem(STORAGE_KEY);
      return true;
    }
    if (!isHeaderSafeToken(token)) return false;
    localStorage.setItem(STORAGE_KEY, token);
    return true;
  } catch (e) {
    console.warn('[editToken] localStorage 저장 실패:', e.message);
    return false;
  }
}
