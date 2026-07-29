/**
 * scripts/test-kasi-audit.js — KASI 휴장일 자동대조 판정층 검증(고정 픽스처, 네트워크 없음).
 *
 * 회귀가 외부를 때리면 테스트가 공공데이터포털 사정에 묶인다. 그래서 2026-07-29에 실제로
 * 받은 응답을 scripts/fixtures/kasi-restde.json에 박아 두고 **판정 로직만** 검증한다.
 * 네트워크 왕복은 _collectors/kasi-holidays.js가 담당하며 여기서는 부르지 않는다.
 *
 * 검증 대상:
 *  1. 객체/배열 정규화 — item이 1건이면 배열이 아니라 객체로 온다(실측 함정)
 *  2. 3갈래 판정      — 누락 / KRX 고유(화이트리스트) / 오탑재
 *  3. 소진 3축        — 표 커버리지·KASI 커버리지(자동검증 불가 연도)·키 만료
 *  4. 상태판 유사 행  — 기록 없음/실패/정상 각각의 status·note
 *
 * 실행: node scripts/test-kasi-audit.js
 */
import { readFileSync } from 'node:fs';
import {
  normalizeKasiItems, compareHolidays, auditCoverage, buildKasiSource,
  tableYears, KRX_ONLY_MMDD, KASI_KEY_EXPIRES,
} from '../api/_lib/holiday-audit.js';
import { MARKET_HOLIDAYS } from '../api/_lib/macro-calendar.js';

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', msg); } }

const fx = JSON.parse(readFileSync(new URL('./fixtures/kasi-restde.json', import.meta.url), 'utf8'));
const items2026 = normalizeKasiItems(fx.years['2026']);
const items2027 = normalizeKasiItems(fx.years['2027']);
const allItems  = [...items2026, ...items2027];

// ── 1. 객체/배열 정규화 ────────────────────────────────────────
{
  // 배열 케이스
  assert(items2026.length === 22, `1: 2026 정규화 22건 (실제: ${items2026.length})`);
  assert(items2027.length === 24, `1: 2027 정규화 24건 (실제: ${items2027.length})`);
  assert(items2026.every(i => /^\d{4}-\d{2}-\d{2}$/.test(i.date)), '1: locdate → YYYY-MM-DD 변환');

  // ⚠️ 단일 item = 객체. 여기서 깨지면 그 달이 통째로 빈 채 "일치"로 보고된다.
  const single = normalizeKasiItems(fx.singleItem);
  assert(single.length === 1, `1: 단일 item(객체)도 1건으로 정규화 (실제: ${single.length})`);
  assert(single[0].date === '2026-07-17' && single[0].name === '제헌절' && single[0].isHoliday === 'Y',
    `1: 단일 item 내용 (실제: ${JSON.stringify(single[0])})`);

  // 방어 — 빈 응답/이상 형식은 조용히 0건(경보 아님)
  assert(normalizeKasiItems({}).length === 0, '1: 빈 body → 0건');
  assert(normalizeKasiItems({ items: { item: [{ locdate: 'bad' }] } }).length === 0, '1: 형식 이상 항목은 버림');
}

// ── 2. 3갈래 판정 ──────────────────────────────────────────────
{
  const years = ['2026', '2027'];
  const r = compareHolidays(allItems, years);

  // 2026-07-29 실측 결과 그대로여야 한다: 누락 0, 오탑재 0, KRX 고유는 12-31 두 건.
  assert(r.missing.length === 0, `2: 누락 0건 (실제: ${JSON.stringify(r.missing)})`);
  assert(r.extra.length === 0, `2: 오탑재 0건 (실제: ${JSON.stringify(r.extra)})`);
  assert(r.krxOnly.length === 2 && r.krxOnly.every(x => x.date.endsWith('12-31')),
    `2: KRX 고유 2건(12-31) (실제: ${JSON.stringify(r.krxOnly)})`);
  assert(r.matched === 46, `2: 일치 46건 (실제: ${r.matched})`);

  // 오늘 정정한 4건이 KASI로도 확인되는지 — 이 대조의 존재 이유다.
  const kasiDates = new Set(allItems.map(i => i.date));
  for (const d of ['2026-07-17', '2027-07-17', '2027-07-19', '2027-05-03']) {
    assert(kasiDates.has(d), `2: KASI가 ${d}를 공휴일로 반환`);
  }
  // 반증 — 제3자 달력이 실었던 현충일 대체(2027-06-07)는 KASI에도 없어야 한다.
  assert(!kasiDates.has('2027-06-07'), '2: 2027-06-07은 KASI에도 없음(현충일 대체 오류 확인)');

  // 누락 검출 반증 — 표에서 제헌절을 빼면 missing으로 잡혀야 한다.
  const holed = { ...MARKET_HOLIDAYS.KR }; delete holed['2026-07-17'];
  const r2 = compareHolidays(allItems, years, holed);
  assert(r2.missing.length === 1 && r2.missing[0].date === '2026-07-17',
    `2: 표에서 빼면 누락으로 검출 (실제: ${JSON.stringify(r2.missing)})`);
  assert(r2.missing[0].kasiName === '제헌절', '2: 누락 항목에 KASI 명칭 동봉');

  // 오탑재 검출 반증 — 화이트리스트 밖 가짜 휴장일을 넣으면 extra로 잡힌다.
  const fake = { ...MARKET_HOLIDAYS.KR, '2026-07-20': '가짜 휴장일' };
  const r3 = compareHolidays(allItems, years, fake);
  assert(r3.extra.length === 1 && r3.extra[0].date === '2026-07-20',
    `2: 화이트리스트 밖은 오탑재로 검출 (실제: ${JSON.stringify(r3.extra)})`);

  // 화이트리스트가 실제로 오탑재를 가려 주는지(12-31이 extra로 새지 않는지)
  assert(KRX_ONLY_MMDD.includes('12-31'), '2: 화이트리스트에 12-31');
  assert(r.krxOnly.length + r.extra.length === 2, '2: 표에 있고 KASI에 없는 건 전부 12-31뿐');

  // 명칭 차이는 판정에 쓰지 않는다 — 24건이 나와도 누락/오탑재는 0이어야 한다.
  assert(r.nameDiffs.length === 24, `2: 명칭 차이 24건(참고용) (실제: ${r.nameDiffs.length})`);
  assert(r.missing.length === 0 && r.extra.length === 0, '2: 명칭 차이가 경보로 새지 않음');

  // isHoliday !== 'Y'는 공휴일이 아니다(getHoliDeInfo 혼용 대비)
  const withN = [...allItems, { date: '2026-07-20', name: '아무날', isHoliday: 'N' }];
  assert(compareHolidays(withN, years).missing.length === 0, '2: isHoliday=N은 누락으로 세지 않음');
}

// ── 3. 소진 3축 ────────────────────────────────────────────────
{
  const ours = tableYears();
  assert(ours.join(',') === '2026,2027', `3: 대조 연도는 표를 따라감 (실제: ${ours})`);

  // ① 정상 — KASI가 두 해 모두 덮으면 자동검증 불가 연도 없음
  const okCov = auditCoverage(['2026', '2027'], MARKET_HOLIDAYS.KR, '2026-07-29');
  assert(okCov.unverifiableYears.length === 0, '3: 전 연도 커버 시 자동검증 불가 없음');
  assert(okCov.warnings.length === 0, `3: 경고 없음 (실제: ${okCov.warnings})`);
  assert(okCov.kasiEnd === '2027' && okCov.tableEnd === '2027-12-31', '3: 커버리지 끝 보고');

  // ② KASI가 우리 표보다 짧아지는 경우 — **조용히 통과시키면 안 된다**
  const shortCov = auditCoverage(['2026'], MARKET_HOLIDAYS.KR, '2026-07-29');
  assert(shortCov.unverifiableYears.join(',') === '2027', '3: 미커버 연도 식별');
  assert(shortCov.warnings.some(w => w.includes('자동검증 불가')), '3: 자동검증 불가 경고');

  // ③ 키 만료 — 만료 90일 전부터 경고, 만료일 자체는 상수로 고정
  assert(KASI_KEY_EXPIRES === '2028-07-29', '3: 키 만료일 상수');
  const farCov  = auditCoverage(['2026', '2027'], MARKET_HOLIDAYS.KR, '2027-01-01');
  assert(!farCov.warnings.some(w => w.includes('키 만료')), '3: 만료 1년 전엔 경고 없음');
  const nearCov = auditCoverage(['2026', '2027'], MARKET_HOLIDAYS.KR, '2028-06-01');
  assert(nearCov.warnings.some(w => w.includes('키 만료')), '3: 만료 58일 전엔 경고');
  assert(nearCov.keyDaysLeft === 58, `3: 잔여일 계산 (실제: ${nearCov.keyDaysLeft})`);
}

// ── 4. 상태판 유사 행 ──────────────────────────────────────────
{
  const none = buildKasiSource(null);
  assert(none.source === 'kasi-audit' && none.kind === 'derived', '4: 행 식별자');
  assert(none.status === 'unknown' && none.note.includes('기록 없음'), '4: 기록 없으면 unknown + 사유');

  const failed = buildKasiSource({ checkedAt: 'T', ok: false, error: 'HTTP 401 …' });
  assert(failed.status === 'down' && failed.note.includes('401'), '4: 호출 실패는 down + 원인');

  const clean = buildKasiSource({
    checkedAt: 'T', ok: true,
    result: { matched: 46, missing: [], extra: [], krxOnly: [{ date: '2026-12-31' }, { date: '2027-12-31' }] },
    coverage: { warnings: [] },
  });
  assert(clean.status === 'ok' && clean.note.includes('일치 46건'), `4: 정상은 ok + 요약 (실제: ${clean.note})`);

  const warned = buildKasiSource({
    checkedAt: 'T', ok: true,
    result: { matched: 45, missing: [{ date: '2026-07-17' }], extra: [], krxOnly: [] },
    coverage: { warnings: [] },
  });
  assert(warned.status === 'warn' && warned.note.includes('누락 1'), '4: 누락이 있으면 warn');

  const covWarn = buildKasiSource({
    checkedAt: 'T', ok: true,
    result: { matched: 46, missing: [], extra: [], krxOnly: [] },
    coverage: { warnings: ['KASI 미커버 2027 — 자동검증 불가'] },
  });
  assert(covWarn.status === 'warn' && covWarn.note.includes('자동검증 불가'),
    '4: 대조는 깨끗해도 커버리지 경고면 warn(조용한 통과 금지)');
}

console.log(`\n${fail === 0 ? '✓ 전체 통과' : '✗ 실패 있음'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
