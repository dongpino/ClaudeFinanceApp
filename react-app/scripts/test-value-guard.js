/**
 * scripts/test-value-guard.js — 검사 1(절대 타당성) 검증. 네트워크 없음.
 *
 * 1단계 조사에서 시세류(last-good.js)는 이미 8종 주입을 전부 막고 있었고 **macro만
 * 뚫려 있었다**(newValue != null이면 무조건 :latest 승격). 그 시험을 macro 경로에도
 * 그대로 걸어 같은 수준을 보장한다.
 *
 * 검증 대상:
 *  1. 메타 파생 동일성 — NON_PRICE_UNITS / FALLBACK_IDS가 종전 하드코딩과 같은가(전환 실수 방지)
 *  2. 주입 매트릭스   — 8종 × (시세류 대표 / macro / kr_base_rate)
 *  3. 정의역 충돌 해소 — feargreed=0·dominance=0이 이제 통과하는가
 *  4. 음수 허용       — us10y·kr_base_rate 음수, CPI YoY 음수(디플레)가 통과하는가
 *  5. 실행 가시성     — checked=0이 '통과'가 아니라 warn으로 보이는가
 *
 * 실행: node scripts/test-value-guard.js
 */
import { ASSET_META, NON_PRICE_UNITS, FALLBACK_IDS, validateLevel, validateMacroField }
  from '../api/_lib/asset-meta.js';
import { buildValueGuardSource } from '../api/health.js';

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', msg); } }

// 1단계 주입 시험과 **동일한 8종** — 여기가 바뀌면 시세류/macro 비교가 성립하지 않는다.
const INJECT = {
  'null': null, 'undefined': undefined, 'NaN': NaN, '0': 0,
  '음수': -100, '""': '', '"N/A"': 'N/A', 'Infinity': Infinity,
};

// ── 1. 메타 파생 동일성 ────────────────────────────────────────
{
  // 종전 src/components/MarketCard.jsx 하드코딩
  const LEGACY_NON_PRICE = ['percent', 'pct_pt', 'score'];
  assert([...NON_PRICE_UNITS].sort().join(',') === LEGACY_NON_PRICE.slice().sort().join(','),
    `1: NON_PRICE_UNITS 파생이 종전과 동일 (실제: ${[...NON_PRICE_UNITS]})`);

  // 종전 api/market-data.js 하드코딩 + 이번에 편입한 kr_base_rate
  const LEGACY_FALLBACK = ['kospi', 'kosdaq', 'usdkrw', 'jpykrw', 'dominance', 'feargreed',
    'nasdaq', 'dow', 'sp500', 'sox', 'vix', 'us10y', 'dxy', 'btc', 'eth',
    'HYPR', '419530', '028300', '080220'];
  const derived = [...FALLBACK_IDS].sort();
  const expected = [...LEGACY_FALLBACK, 'kr_base_rate'].sort();
  assert(derived.join(',') === expected.join(','),
    `1: FALLBACK_IDS 파생 = 종전 19종 + kr_base_rate (누락: ${expected.filter(x => !derived.includes(x))} / 추가: ${derived.filter(x => !expected.includes(x))})`);
  assert(FALLBACK_IDS.has('kr_base_rate'), '1: kr_base_rate 편입(종전 유일한 검증 사각)');
  assert(FALLBACK_IDS.size === 20, `1: 홈 20종 전부 커버 (실제: ${FALLBACK_IDS.size})`);
  // 메타에 없는데 홈에 뜨는 항목이 생기면 기본 규칙(가격류)으로 새는 것 — dxy 누락 사고 재발 방지.
  for (const id of expected) assert(ASSET_META[id], `1: ASSET_META에 ${id} 존재`);
}

// ── 2. 주입 매트릭스 ───────────────────────────────────────────
{
  // (a) 시세류 대표 — kospi(가격류)
  for (const [label, v] of Object.entries(INJECT)) {
    assert(!validateLevel('kospi', v).ok, `2a: kospi에 ${label} 주입 → 차단`);
  }
  assert(validateLevel('kospi', 2500).ok, '2a: kospi 정상값 통과');

  // (b) macro — cpi.yoy. **1단계에서 이 경로만 뚫려 있었다.**
  //     단 0과 음수는 CPI YoY에서 정상값이라 통과해야 한다(디플레·보합).
  for (const [label, v] of Object.entries(INJECT)) {
    const r = validateMacroField('cpi', { yoy: v, mom: 0.1 });
    const shouldPass = (label === '0' || label === '음수');
    assert(r.ok === shouldPass,
      `2b: macro cpi.yoy에 ${label} 주입 → ${shouldPass ? '통과(변동률은 0·음수 정상)' : '차단'} (실제 ok=${r.ok} ${r.reason ?? ''})`);
  }
  // 서브필드 누락(스키마 변경 신호)도 막는다
  assert(!validateMacroField('cpi', { yoy: 2.4 }).ok, '2b: mom 누락 → 차단(스키마 변경 감지)');
  assert(!validateMacroField('fomc.rate', { upper: 5.5 }).ok, '2b: lower 누락 → 차단');
  assert(validateMacroField('fomc.rate', { upper: 5.5, lower: 5.25 }).ok, '2b: 정상 목표범위 통과');
  assert(!validateMacroField('bok', { rate: 'N/A' }).ok, '2b: bok rate 문자열 → 차단');
  assert(validateMacroField('bok', { rate: 2.5 }).ok, '2b: bok 정상 통과');
  // 실업률은 레벨값이라 음수가 비정상
  assert(!validateMacroField('unemployment', { rate: -1 }).ok, '2b: 실업률 음수 → 차단');

  // (c) kr_base_rate — 종전 무검증 통과였던 경로
  //     ⚠️ 음수 주입값(-100)은 "음수라서"가 아니라 **정의역(-10~30) 밖이라** 차단된다.
  //        정책금리의 음수 자체는 정상이므로 그건 아래에서 -0.1로 따로 확인한다.
  for (const [label, v] of Object.entries(INJECT)) {
    const r = validateLevel('kr_base_rate', v);
    const shouldPass = (label === '0');   // 0%는 실재했던 정책금리
    assert(r.ok === shouldPass,
      `2c: kr_base_rate에 ${label} 주입 → ${shouldPass ? '통과(0% 실재)' : '차단'} (실제 ok=${r.ok} ${r.reason ?? ''})`);
  }
  assert(validateLevel('kr_base_rate', -0.1).ok, '2c: 정책금리 -0.1%는 통과(음수 자체는 정상)');
  assert(validateLevel('kr_base_rate', -100).reason === 'below-min',
    '2c: -100은 음수라서가 아니라 정의역 밖이라 차단');
  assert(!validateLevel('kr_base_rate', 99).ok, '2c: kr_base_rate 99% → 차단(상한 30)');
}

// ── 3. 정의역 충돌 해소 ────────────────────────────────────────
{
  // 종전 공통 규칙 price>0이 정상값 0을 폴백으로 밀어내던 지점.
  assert(validateLevel('feargreed', 0).ok, '3: feargreed=0 통과(하한 0 포함 — 충돌 해소)');
  assert(validateLevel('dominance', 0).ok, '3: dominance=0 통과');
  assert(validateLevel('feargreed', 100).ok, '3: feargreed=100 통과(상한 포함)');
  assert(!validateLevel('feargreed', 101).ok, '3: feargreed=101 차단(정의역 초과)');
  assert(!validateLevel('dominance', 100.5).ok, '3: dominance=100.5 차단');
  assert(!validateLevel('feargreed', -1).ok, '3: feargreed=-1 차단');
  // 가격류는 여전히 0 배제(파서 실패의 가장 흔한 표현)
  assert(!validateLevel('btc', 0).ok, '3: 가격류 0은 여전히 차단');
}

// ── 4. 음수 허용 ───────────────────────────────────────────────
{
  assert(validateLevel('us10y', -0.5).ok, '4: us10y 음수 통과(마이너스 금리 실재)');
  assert(validateLevel('kr_base_rate', -0.1).ok, '4: 정책금리 음수 통과');
  assert(!validateLevel('us10y', -50).ok, '4: us10y -50%는 차단(상식 밖)');
  assert(validateMacroField('cpi', { yoy: -0.8, mom: -0.2 }).ok, '4: CPI 디플레(음수) 통과');
  assert(!validateMacroField('cpi', { yoy: 500, mom: 0 }).ok, '4: CPI YoY 500%는 차단');
  // 변동 축(change/change_pct)은 검사 1의 범위가 아니다 — 여기서 판정하지 않음을 명시.
  assert(ASSET_META.kospi.kind === 'price', '4: 검사 1은 레벨값만 — change 축은 검사 2 재료');
}

// ── 5. 실행 가시성(0건 수행 ≠ 통과) ────────────────────────────
{
  const none = buildValueGuardSource({});
  assert(none.status === 'warn', '5: checked=0은 warn(통과 아님)');
  assert(none.note.includes('검사 0건'), `5: 0건임을 문구로 (실제: ${none.note})`);

  const clean = buildValueGuardSource({ market: { checked: 20, blocked: 0, reasons: {}, lastBlock: null } });
  assert(clean.status === 'ok' && clean.checked === 20, '5: 전건 통과는 ok');

  const blocked = buildValueGuardSource({
    macro: { checked: 4, blocked: 1, reasons: { nan: 1 }, lastBlock: 'cpi yoy=null' },
  });
  assert(blocked.status === 'warn', '5: 차단이 있으면 warn');
  assert(blocked.note.includes('차단 1/4') && blocked.note.includes('nan'),
    `5: 차단 건수·사유·최근 내용 노출 (실제: ${blocked.note})`);
  assert(blocked.note.includes('cpi yoy=null'), '5: 어느 필드가 어떤 값이라 거부됐는지');

  // 여러 지점 합산
  const both = buildValueGuardSource({
    market: { checked: 20, blocked: 0, reasons: {}, lastBlock: null },
    macro:  { checked: 4, blocked: 0, reasons: {}, lastBlock: null },
  });
  assert(both.checked === 24 && both.status === 'ok', '5: 지점별 합산');
}

console.log(`\n${fail === 0 ? '✓ 전체 통과' : '✗ 실패 있음'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
