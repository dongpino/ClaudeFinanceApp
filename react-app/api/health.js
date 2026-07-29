/**
 * api/health.js — 데이터 소스 상태 점검 엔드포인트 (관측성 1단계)
 *
 * GET /api/health → 소스별 상태 판정 + 원시 수치
 *   [{ source, status: 'ok'|'stale'|'idle'|'down'|'unknown',
 *      lastSuccessAt, lastFailureAt, lastError, lastErrorCode, lastErrorResolved,
 *      consecutiveFailures, todayRate, today, todayErrors, lastEnv, todayEnv }]
 *
 * lastError는 성공해도 지워지지 않는다(간헐 실패 소스는 그 이력이 유일한 단서).
 * 대신 lastErrorResolved=true면 그 뒤에 성공이 있었다는 뜻 — 현재 장애가 아니다.
 * todayErrors는 원인별 히스토그램 { 'ECONNRESET': 9, 'http-403': 2 }.
 *
 * 판정 규칙(_lib/health.js getHealthSnapshot):
 *   - consecutiveFailures >= 3            → down
 *   - lastSuccessAt이 기대 주기의 3배 이내 → ok
 *   - 그 외(성공 있었으나 오래됨/실패만)   → stale
 *   - 수집 이력 자체가 없음                → unknown
 *   - 온디맨드 소스(ON_DEMAND_SOURCES: binance/twelvedata)는 호출 보장 하한이 없어
 *     나이로 판정하지 않는다. 마지막 '시도'가 24h 안이면 그 성패로 ok/stale,
 *     넘으면 → idle (상태판 '대기 · 미호출'). 자세한 근거는 _lib/health.js 주석.
 *
 * 조회 전용·민감정보 없음 → 인증 불필요. Redis만 읽고 외부 API는 절대 치지
 * 않는다(health 확인이 시세/뉴스 API 쿼터를 소모하면 안 됨 — 요구사항 6).
 *
 * calendar 유사(pseudo) 행:
 *   시장 캘린더(_lib/macro-calendar.js)는 외부 fetch가 없는 하드코딩 상수라
 *   trackedFetch/Redis 기록층에 잡히지 않는다 → SOURCES에 넣을 수 없다. 대신
 *   getScheduleDepletion()/VERIFIED_AT을 직접 조회해 같은 모양의 행 하나를 만들어
 *   목록 끝에 덧붙인다. 상태판이 sources 배열을 그대로 렌더하므로 프론트 하드코딩
 *   없이 행이 나타난다. kind:'derived'로 trackedFetch 소스와 구분한다.
 *     · 소진 임박(depletion 있음) → 'warn'(노랑, 갱신 필요)
 *     · 그 외                      → 'ok'
 */

import { getHealthSnapshot, storeFingerprint, ENV_TAG, getValidationCounters,
  CONSEC_BLOCK_THRESHOLD, FIELD_STALE_MS } from './_lib/health.js';
import { getScheduleDepletion, VERIFIED_AT } from './_lib/macro-calendar.js';
import { readAudit, buildKasiSource } from './_lib/holiday-audit.js';


const DEPLETION_LABEL = { fomc: 'FOMC', cpi: 'CPI', msci: 'MSCI', earnings: '실적', holidays: '휴장일', bok: '금통위' };

// 'YYYY-MM-DD' → 'M/D'
function monthDay(dateStr) {
  const [, m, d] = String(dateStr).split('-').map(Number);
  return `${m}/${d}`;
}

/**
 * 캘린더 유사 행 — Redis/외부호출 없이 순수 계산이라 실패할 수 없다.
 * note: 상태판 우측 메타 칸에 그대로 출력할 한 줄 요약.
 * (scripts/test-calendar-schedule.js에서 직접 검증하므로 export)
 */
export function buildCalendarSource() {
  const depletion  = getScheduleDepletion();
  const verifiedAt = VERIFIED_AT;
  // 여러 카테고리가 동시에 소진 임박이면 가장 급한 것(daysLeft 오름차순 첫 항목)만
  // 적고 나머지는 "외 N"으로 줄인다 — 메타 칸이 한 줄이라 길면 잘린다.
  const head = depletion[0];
  const note = head
    ? `${DEPLETION_LABEL[head.category] ?? head.category} ${monthDay(head.lastDate)} 이후 없음`
      + (depletion.length > 1 ? ` 외 ${depletion.length - 1}` : '')
    : `${monthDay(Object.values(verifiedAt).sort()[0])} 확인`;

  return {
    source: 'calendar',
    kind: 'derived',                 // trackedFetch 소스가 아님(수집기 없음)
    status: depletion.length > 0 ? 'warn' : 'ok',
    note,
    depletion,
    verifiedAt,
    // 아래는 상태판이 공통으로 읽는 필드 — 캘린더엔 수집 개념이 없어 전부 중립값.
    lastSuccessAt: null, lastFailureAt: null, lastError: null,
    lastErrorCode: null, lastErrorResolved: false,
    consecutiveFailures: 0, todayRate: null, today: { success: 0, failure: 0 },
    todayErrors: {},
  };
}

/**
 * 검사 1 실행 계측 유사 행 — 오늘 몇 건을 검사했고 몇 건을 막았는지.
 * ⚠️ checked=0은 '문제 없음'이 아니라 '검사가 돌지 않았다'는 뜻이라 warn으로 낸다.
 * (scripts/test-value-guard.js에서 직접 검증하므로 export)
 */
export function buildValueGuardSource(counters, now = Date.now()) {
  const scopes = Object.entries(counters?.scopes ?? {});
  const fieldMap = counters?.fields ?? {};
  const checked = scopes.reduce((a, [, c]) => a + (c.checked ?? 0), 0);
  const blocked = scopes.reduce((a, [, c]) => a + (c.blocked ?? 0), 0);
  const reasons = scopes.flatMap(([s, c]) =>
    Object.entries(c.reasons ?? {}).map(([r, n]) => `${s}:${r}×${n}`));
  const lastBlock = scopes.map(([, c]) => c.lastBlock).filter(Boolean)[0] ?? null;

  // ── 필드별 상태 평탄화 — "마지막 실제 갱신"이 멈춘 채 보이는 것이 요점이다.
  // ⚠️ :latest 계열 키는 TTL이 없어 스스로 만료되지 않는다. 차단이 계속되면 **오래된
  //    값이 조용히 계속 서빙되는** 경로가 되므로, 그 사실을 lastOkAt으로 드러낸다.
  const fields = [];
  for (const [scope, byName] of Object.entries(fieldMap)) {
    for (const [name, st] of Object.entries(byName)) {
      const ageMs = st.lastOkAt ? now - Date.parse(st.lastOkAt) : null;
      fields.push({
        scope, field: name, consec: st.consec ?? 0,
        lastOkAt: st.lastOkAt ?? null, lastBlockAt: st.lastBlockAt ?? null,
        reason: st.reason ?? null, detail: st.detail ?? null,
        staleMs: ageMs,
        // 승격 조건 두 축: 연속 횟수(잦은 호출) 또는 마지막 갱신 경과(드문 호출).
        // 호출 주기가 5분(시세)~24시간(macro-history)으로 달라 횟수만으론 "하루 안에
        // 알아챈다"를 보장할 수 없어 시간 축을 함께 둔다.
        sustained: (st.consec ?? 0) >= CONSEC_BLOCK_THRESHOLD ||
                   ((st.consec ?? 0) >= 1 && ageMs != null && ageMs > FIELD_STALE_MS),
      });
    }
  }
  const sustainedFields = fields.filter(f => f.sustained);
  // 전 필드 동시 차단 — 소스 동시 장애보다 **게이트 자체 결함** 가능성이 높다.
  const gateSuspect = scopes.filter(([, c]) => c.allBlockedAt).map(([s]) => s);

  let status, verdict, note;
  if (gateSuspect.length) {
    status = 'down'; verdict = 'gate-suspect';
    note = `전 필드 동시 차단(${gateSuspect.join('·')}) — 게이트 자체 결함 의심`
      + `${lastBlock ? ` · 최근 ${lastBlock}` : ''}`;
  } else if (sustainedFields.length) {
    status = 'down'; verdict = 'sustained';
    const w = sustainedFields[0];
    note = `${w.scope}/${w.field} ${w.consec}회 연속 차단 — 소스 지속 이상 또는 게이트 오류 의심`
      + (sustainedFields.length > 1 ? ` 외 ${sustainedFields.length - 1}` : '')
      + (w.lastOkAt ? ` · 마지막 갱신 ${w.lastOkAt.slice(0, 16)}` : ' · 갱신 이력 없음');
  } else if (checked === 0) {
    status = 'warn'; verdict = 'not-run';
    note = '오늘 검사 0건 — 수집이 없었거나 계측이 끊겼다(통과 아님)';
  } else if (blocked > 0) {
    status = 'warn'; verdict = 'transient';
    note = `일회성 차단 ${blocked}/${checked}건 · ${reasons.join(' ')}${lastBlock ? ` · 최근 ${lastBlock}` : ''}`;
  } else {
    status = 'ok'; verdict = 'clean';
    note = `검사 ${checked}건 전건 통과 (${scopes.map(([s]) => s).join('·')})`;
  }

  return {
    source: 'value-guard', kind: 'derived', status, verdict, note,
    checked, blocked,
    scopes: Object.fromEntries(scopes),
    // 상태판이 "마지막 실제 갱신"을 필드별로 보여줄 재료. 오래된 순으로 정렬해 앞에 둔다.
    fields: fields.sort((a, b) => (b.staleMs ?? -1) - (a.staleMs ?? -1)),
    gateSuspect,
    lastSuccessAt: null, lastFailureAt: null, lastError: null,
    lastErrorCode: null, lastErrorResolved: false,
    consecutiveFailures: 0, todayRate: null, today: { success: 0, failure: 0 }, todayErrors: {},
  };
}

/**
 * 검사 2(상대 타당성) 유사 행 — C(교차소스)·평탄성 결과와 **스킵 사유**를 함께 낸다.
 *
 * ⚠️ 스킵을 별도로 보여주는 것이 이 행의 요점이다. 검사 2는 폐장·기준선을 전제로 하므로
 *    "장중이라 못 했다"와 "검사해서 통과했다"가 섞이면 통과율이 거짓말을 한다.
 *    checked=0인데 skipped만 잔뜩이면 그건 통과가 아니라 **미수행**이다.
 * (scripts/test-relative-guard.js에서 직접 검증하므로 export)
 */
export function buildRelativeGuardSource(counters) {
  const c = counters?.scopes?.relative ?? null;
  const fields = counters?.fields?.relative ?? {};
  if (!c) {
    return relRow('unknown', '검사 2 기록 없음 — 수집이 없었거나 계측이 끊겼다', null);
  }
  const { checked = 0, blocked = 0, skipped = 0, skips = {}, lastBlock = null } = c;
  const skipStr = Object.entries(skips).map(([r, n]) => `${r}×${n}`).join(' ');

  // 연속 위반 승격은 검사 1과 같은 3등급 구조를 그대로 쓴다(어휘·임계 공유).
  const sustained = Object.entries(fields)
    .filter(([, st]) => (st.consec ?? 0) >= CONSEC_BLOCK_THRESHOLD).map(([f]) => f);

  let status, verdict, note;
  if (sustained.length) {
    status = 'down'; verdict = 'sustained';
    note = `${sustained[0]} ${CONSEC_BLOCK_THRESHOLD}회 이상 연속 위반 — 양측 중 한쪽 파서 이상 의심`
      + (sustained.length > 1 ? ` 외 ${sustained.length - 1}` : '')
      + (lastBlock ? ` · ${lastBlock}` : '');
  } else if (checked === 0) {
    status = 'warn'; verdict = 'not-run';
    note = skipped > 0
      ? `검사 0건 · 전부 스킵 ${skipped}건(${skipStr}) — 통과가 아니라 미수행`
      : '검사 2 기록 없음 — 수집이 없었거나 계측이 끊겼다';
  } else if (blocked > 0) {
    status = 'warn'; verdict = 'transient';
    note = `불일치 ${blocked}/${checked}건${lastBlock ? ` · ${lastBlock}` : ''}`
      + (skipped ? ` · 스킵 ${skipped}(${skipStr})` : '');
  } else {
    status = 'ok'; verdict = 'clean';
    note = `검사 ${checked}건 통과${skipped ? ` · 스킵 ${skipped}(${skipStr})` : ''}`;
  }
  return relRow(status, note, { checked, blocked, skipped, skips, verdict, fields });
}

function relRow(status, note, extra) {
  return {
    source: 'relative-guard', kind: 'derived', status, note,
    verdict: extra?.verdict ?? null,
    checked: extra?.checked ?? 0, blocked: extra?.blocked ?? 0,
    skipped: extra?.skipped ?? 0, skips: extra?.skips ?? {},
    lastSuccessAt: null, lastFailureAt: null, lastError: null,
    lastErrorCode: null, lastErrorResolved: false,
    consecutiveFailures: 0, todayRate: null, today: { success: 0, failure: 0 }, todayErrors: {},
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const sources = await getHealthSnapshot();
    sources.push(buildCalendarSource()); // 목록 끝에 유사 행 1개
    // KASI 휴장일 자동대조 유사 행 — Redis에 적재된 마지막 대조 결과만 읽는다(외부 호출 없음).
    // 기록이 없으면 buildKasiSource가 'unknown' 행을 만든다(빈칸으로 사라지지 않게).
    sources.push(buildKasiSource(await readAudit()));
    // 검사 1(절대 타당성) 실행 계측 유사 행 — 차단 건수만 보면 '검사가 아예 안 돈 상태'가
    // '전건 통과'와 같은 초록으로 보인다. checked=0이면 warn으로 드러낸다(KASI 렌즈).
    const counters = await getValidationCounters();
    sources.push(buildValueGuardSource(counters));
    // 검사 2(상대 타당성) — 스킵 사유까지 함께 낸다(장중 미수행이 통과로 보이면 안 됨).
    sources.push(buildRelativeGuardSource(counters));
    // 상태가 있으므로 캐시는 짧게만 — 관측 목적상 최신값이 중요.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      checkedAt: new Date().toISOString(),
      // 이 응답이 "어느 KV를, 어느 환경에서" 읽은 것인지 — 진단 스크립트 출력과
      // 대조해 다른 DB를 보고 있는 상황을 즉시 잡는다(호스트 원문은 노출 안 함).
      storeFp: storeFingerprint(),
      env: ENV_TAG,
      sources,
    });
  } catch (e) {
    console.error('[health] 스냅샷 조회 실패:', e.message);
    return res.status(503).json({ error: 'health 조회 실패(Redis)', details: e.message });
  }
}
