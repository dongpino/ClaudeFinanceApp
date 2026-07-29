/**
 * _collectors/kasi-holidays.js — KASI 특일정보(공휴일) 조회 (네트워크 전담)
 *
 * 공공데이터포털 「한국천문연구원_특일 정보」 SpcdeInfoService.
 * 활용가이드 v1.4(2020-06-09) 원문 확인 사항:
 *   · URL      http://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService (개발=운영)
 *   · 오퍼레이션 getRestDeInfo(공휴일 정보조회) — 국경일/기념일/절기는 별도 오퍼레이션
 *   · 파라미터  solYear(필수) / solMonth(**옵션**) / ServiceKey(필수) / _type=json / numOfRows
 *   · 응답     resultCode·resultMsg + item[]{locdate(YYYYMMDD)·seq·dateKind·isHoliday·dateName}
 *   · 갱신     연 1회. "월력요항 발표 이후 차차년도 먼저 업데이트(현재연도 기준 +2년)"
 *
 * ⚠️ **문서보다 응답이 앞선다.** v1.4 문서는 "휴일 정보 조회로 제헌절은 해당 오퍼레이션에서
 *    제공되지 않는다"라고 적었지만(2020년판), 2026-07-29 실호출은 제헌절을 isHoliday=Y로
 *    반환했다 — 2026-04 개정이 반영돼 있다. 문서 서술을 근거로 쓰지 말 것.
 * ⚠️ solMonth를 생략하면 **연 단위 조회**가 된다(2026 totalCount 22 / 2027 24 실측).
 *    2년치 대조가 2콜로 끝나는 근거다. numOfRows 기본값은 10이라 반드시 올려야 한다.
 * ⚠️ item이 1건이면 배열이 아니라 객체로 온다 — 정규화는 _lib/holiday-audit.js가 한다.
 *
 * ── 격리 규율 ────────────────────────────────────────────────────────
 * trackedFetch가 아니라 순수 fetch를 쓴다. 이건 시세 수집이 아니라 **검증층**이고,
 * health의 수집 성공률 통계에 섞이면 그 지표의 의미가 흐려진다(프로브와 같은 이유).
 * 실패는 throw하지 않고 결과 객체로 회수한다 — 호출측(크론)이 그대로 기록한다.
 */

const BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
const TIMEOUT_MS = 12_000;
const NUM_OF_ROWS = 100;   // 연간 공휴일은 20~30건 — 100이면 페이지네이션이 필요 없다.

/**
 * 한 해치 조회. **절대 throw하지 않는다.**
 * @param {string} year 'YYYY'
 * @returns {Promise<{year, ok, status, totalCount, body, error}>}
 */
export async function fetchKasiYear(year) {
  const key = process.env.KASI_API_KEY;
  if (!key) return { year, ok: false, status: 0, error: 'KASI_API_KEY 미설정' };

  // 키에 %/+ 같은 문자가 없으면 인코딩·디코딩 형태가 같다(2026-07-29 실측 키는 64자
  // 영숫자). 그래도 이미 인코딩된 키를 다시 인코딩하면 401이 나므로 원문 그대로 붙인다.
  const url = `${BASE}?solYear=${year}&_type=json&numOfRows=${NUM_OF_ROWS}&serviceKey=${key}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) {
      return { year, ok: false, status: res.status, error: `HTTP ${res.status} ${text.slice(0, 80)}` };
    }
    let json;
    try { json = JSON.parse(text); }
    catch {
      // 키 오류·장애 시 XML이나 평문이 온다(_type=json을 무시). 원문 앞부분을 남긴다.
      return { year, ok: false, status: res.status, error: `비JSON 응답: ${text.slice(0, 80)}` };
    }
    const header = json?.response?.header;
    if (header?.resultCode !== '00') {
      return { year, ok: false, status: res.status, error: `resultCode=${header?.resultCode} ${header?.resultMsg ?? ''}` };
    }
    const body = json.response.body;
    return { year, ok: true, status: res.status, totalCount: Number(body?.totalCount ?? 0), body };
  } catch (e) {
    return { year, ok: false, status: 0, error: `${e.name}: ${e.message}` };
  }
}
