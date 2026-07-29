/**
 * api/_lib/holiday-audit.js — 휴장일 표 ↔ KASI 특일정보 자동 대조 (로드맵 ③ 검사 4)
 *
 * 왜 있는가: MARKET_HOLIDAYS는 수동 상수이고, 2026-07-29 감사에서 **제도 변경으로 인한
 * 누락 4건**(제헌절 2건·대체공휴일 2건)이 나왔다. depletion은 "표가 마르는 것"만 잡고
 * "제도가 바뀌는 것"은 못 잡는다 — 커버리지 수평선이 움직이지 않기 때문이다.
 * KASI(한국천문연구원 특일 정보, 공공데이터포털)를 **미래 구간의 자동 대조 소스**로 붙여
 * 그 사각을 메운다. 자체실측(과거 전용)과 정확히 반대편을 담당한다.
 *
 * ── 이 모듈의 규율 ───────────────────────────────────────────────────
 *  · 순수 로직 + Redis I/O만. 네트워크는 _collectors/kasi-holidays.js가 담당한다
 *    (회귀 테스트가 고정 픽스처로 판정 로직만 검증할 수 있게 분리했다).
 *  · 모든 함수는 throw하지 않는다. KASI 실패가 수집 파이프라인에 전파되면 안 된다
 *    (health 기록층과 동일한 fire-and-forget 규율).
 *  · **판정은 날짜로만 한다.** 명칭은 표기 관례가 달라 2026-07-29 실측에서 24건이
 *    어긋났다(예: 표 "삼일절 대체공휴일" vs KASI "대체공휴일(삼일절)", "신정" vs "1월1일",
 *    "성탄절" vs "기독탄신일", 연휴 3일을 KASI는 모두 "추석"). 전부 같은 날을 가리키는
 *    표기 차이라 명칭 불일치를 경보로 올리면 상시 빨간불이 된다 → 참고용으로만 저장한다.
 */

import { Redis } from '@upstash/redis';
import { MARKET_HOLIDAYS } from './macro-calendar.js';

/** Redis 키 — TTL 없음(마지막 대조 결과는 계속 보여야 상태판이 성립) */
export const AUDIT_KEY = 'holiday-audit:kasi';

/**
 * KRX 고유 휴장일 화이트리스트 — 'MM-DD' 형식.
 *
 * 근거: KRX 고유 휴장일. 거래소 규정이라 관공서 공휴일 소스에 나타나지 않음.
 *       2026-07-29 실측으로 [B](표에 있는데 KASI에 없음)가 정확히 이 집합임을 확인
 *       (2026-12-31·2027-12-31 두 건뿐, 그 외 0건).
 * ⚠️ 여기 넣는다는 건 "KASI에 없어도 정상"이라고 선언하는 것이다. 근거 없이 늘리면
 *    진짜 오탑재를 이 배열이 덮어 버린다 — 추가할 때마다 실측 근거를 함께 적을 것.
 */
export const KRX_ONLY_MMDD = ['12-31'];

/** 서비스 키 만료일 — 만료로 조용히 401이 되는 경로를 depletion으로 드러낸다. */
export const KASI_KEY_EXPIRES = '2028-07-29';

/** 키 만료 경고 임계(일). 갱신 신청에 시간이 걸리므로 넉넉히 잡는다. */
const KEY_EXPIRY_WARN_DAYS = 90;

// ── Redis (health.js/probe-store.js와 동일 패턴: 지연 생성, 실패 시 null) ──
let redisClient;
function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) { console.warn('[holiday-audit] KV 미설정 — 적재 비활성화'); redisClient = null; }
  else redisClient = new Redis({ url, token });
  return redisClient;
}

function todayKST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * KASI 응답 본문 → 날짜 맵. **item이 1건이면 배열이 아니라 객체로 온다**(2026-07 실측:
 * `"item":{...}`) — 정규화하지 않고 map을 돌리면 그 달만 조용히 비는 함정이다.
 * @param {object} body response.body
 * @returns {Array<{date: string, name: string, isHoliday: string}>}
 */
export function normalizeKasiItems(body) {
  const raw = body?.items?.item;
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  for (const it of arr) {
    const s = String(it?.locdate ?? '');
    if (!/^\d{8}$/.test(s)) continue;               // 형식 이상은 조용히 버린다(경보 아님)
    out.push({
      date: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`,
      name: String(it?.dateName ?? ''),
      isHoliday: String(it?.isHoliday ?? ''),
    });
  }
  return out;
}

/** 우리 표가 덮는 연도 목록(문자열, 오름차순) — 대조 대상 연도는 표를 따라간다. */
export function tableYears(table = MARKET_HOLIDAYS.KR) {
  return [...new Set(Object.keys(table).map(d => d.slice(0, 4)))].sort();
}

/**
 * 3갈래 판정. **날짜 기준**이며 명칭은 참고 필드로만 싣는다.
 *   · KASI 有 / 표 無                    → missing  (누락 경보)
 *   · 표 有 / KASI 無 / 화이트리스트 有   → krxOnly  (정상)
 *   · 표 有 / KASI 無 / 화이트리스트 無   → extra    (오탑재 경보)
 *
 * @param {Array<{date,name,isHoliday}>} kasiItems  normalizeKasiItems 결과(여러 해 합침)
 * @param {string[]} years  대조할 연도(KASI가 실제로 응답한 연도만 넣을 것)
 * @param {object} [table]  기본값 MARKET_HOLIDAYS.KR
 */
export function compareHolidays(kasiItems, years, table = MARKET_HOLIDAYS.KR) {
  const inYears = d => years.includes(d.slice(0, 4));
  // isHoliday !== 'Y'는 공휴일이 아니다(문서상 getHoliDeInfo에는 N이 섞여 온다).
  const kasi = new Map(kasiItems.filter(i => i.isHoliday === 'Y' && inYears(i.date)).map(i => [i.date, i.name]));
  const tableDates = Object.keys(table).filter(inYears).sort();

  const missing = [...kasi.keys()].filter(d => !table[d]).sort()
    .map(d => ({ date: d, kasiName: kasi.get(d) }));

  const krxOnly = [], extra = [];
  for (const d of tableDates) {
    if (kasi.has(d)) continue;
    const row = { date: d, tableName: table[d] };
    (KRX_ONLY_MMDD.includes(d.slice(5)) ? krxOnly : extra).push(row);
  }

  // 명칭 차이 — 판정에 쓰지 않는다. 사람이 나중에 볼 참고 자료로만 남긴다.
  const nameDiffs = tableDates.filter(d => kasi.has(d) && kasi.get(d) !== table[d])
    .map(d => ({ date: d, tableName: table[d], kasiName: kasi.get(d) }));

  return {
    years,
    matched: tableDates.length - krxOnly.length - extra.length,
    missing, krxOnly, extra, nameDiffs,
  };
}

/**
 * 소진 감시 3축 — 하나라도 걸리면 상태판이 노랑이 된다.
 *   ① 우리 표 커버리지 끝    (기존 getScheduleDepletion의 holidays 축과 같은 성격)
 *   ② KASI 커버리지 끝       — KASI도 유한하다. 2026-07-29 실측: 2028 부분(19건), 2029 0건.
 *      우리 표가 KASI보다 멀리 가면 그 연도는 **자동검증 불가**다. 조용히 통과시키면
 *      "대조 통과"가 "대조할 데이터가 없었다"를 덮는다 — 그게 이 축을 따로 둔 이유다.
 *   ③ 서비스 키 만료         — 만료되면 401이 되고, 그 401은 "일치 0건"처럼 보인다.
 *
 * @param {string[]} kasiYears  KASI가 실제로 데이터를 준 연도(0건 연도는 제외해서 넘길 것)
 */
export function auditCoverage(kasiYears, table = MARKET_HOLIDAYS.KR, today = todayKST()) {
  const ours = tableYears(table);
  const tableEnd = Object.keys(table).sort().at(-1) ?? null;
  const kasiEnd = kasiYears.length ? kasiYears.slice().sort().at(-1) : null;
  // 우리 표에는 있는데 KASI가 못 덮는 연도 = 자동검증 불가
  const unverifiableYears = ours.filter(y => !kasiYears.includes(y));
  const keyDaysLeft = daysBetween(today, KASI_KEY_EXPIRES);

  const warnings = [];
  if (unverifiableYears.length) {
    warnings.push(`KASI 미커버 ${unverifiableYears.join('·')} — 자동검증 불가`);
  }
  if (keyDaysLeft <= KEY_EXPIRY_WARN_DAYS) {
    warnings.push(`KASI 키 만료 D-${keyDaysLeft}(${KASI_KEY_EXPIRES})`);
  }
  return { tableEnd, kasiEnd, ourYears: ours, kasiYears, unverifiableYears, keyDaysLeft, warnings };
}

/** 적재 — 절대 throw하지 않는다. @returns {Promise<boolean>} 저장 성공 여부 */
export async function saveAudit(payload) {
  const r = getRedis();
  if (!r) return false;
  try { await r.set(AUDIT_KEY, JSON.stringify(payload)); return true; }
  catch (e) { console.warn(`[holiday-audit] 적재 실패 — 무시: ${e.message}`); return false; }
}

/** 조회 — 절대 throw하지 않는다. 없거나 실패면 null. */
export async function readAudit() {
  const r = getRedis();
  if (!r) return null;
  try {
    const v = await r.get(AUDIT_KEY);
    if (!v) return null;
    return typeof v === 'string' ? JSON.parse(v) : v;
  } catch (e) { console.warn(`[holiday-audit] 조회 실패 — 무시: ${e.message}`); return null; }
}

/**
 * 상태판 유사 행(kind:'derived') — buildCalendarSource와 같은 규약.
 * 대조 자체가 안 돌았으면 'unknown'으로 두고 note에 그 사실을 적는다(빈칸 금지).
 */
export function buildKasiSource(audit) {
  if (!audit) {
    return kasiRow('unknown', 'KASI 대조 기록 없음 — 크론 미실행 또는 KV 미설정', null);
  }
  if (!audit.ok) {
    return kasiRow('down', `KASI 호출 실패: ${String(audit.error ?? '원인 미상').slice(0, 60)}`, audit);
  }
  const { missing = [], extra = [], krxOnly = [] } = audit.result ?? {};
  const warn = audit.coverage?.warnings ?? [];
  const parts = [];
  if (missing.length) parts.push(`누락 ${missing.length}`);
  if (extra.length)   parts.push(`오탑재 ${extra.length}`);
  const status = (missing.length || extra.length) ? 'warn' : (warn.length ? 'warn' : 'ok');
  const note = parts.length
    ? `${parts.join('·')} (${[...missing, ...extra].slice(0, 2).map(x => x.date).join(', ')}…)`
    : warn.length ? warn.join(' / ')
    : `일치 ${audit.result?.matched ?? 0}건 · KRX고유 ${krxOnly.length}건`;
  return kasiRow(status, note, audit);
}

function kasiRow(status, note, audit) {
  return {
    source: 'kasi-audit',
    kind: 'derived',
    status, note,
    checkedAt: audit?.checkedAt ?? null,
    result: audit?.result ?? null,
    coverage: audit?.coverage ?? null,
    // 상태판 공통 필드 — 수집 개념이 없어 중립값(buildCalendarSource와 동일).
    lastSuccessAt: audit?.ok ? audit.checkedAt : null,
    lastFailureAt: audit && !audit.ok ? audit.checkedAt : null,
    lastError: audit?.ok ? null : (audit?.error ?? null),
    lastErrorCode: null, lastErrorResolved: false,
    consecutiveFailures: 0, todayRate: null, today: { success: 0, failure: 0 },
    todayErrors: {},
  };
}
