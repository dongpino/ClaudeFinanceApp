/**
 * scripts/test-relative-guard.js — 검사 2(상대 타당성) 검증. 네트워크·Redis 없음.
 *
 * 1단계 조사에서 범위를 C(교차소스) + 평탄성으로 좁혔다. 급변·뉴스 교차확인·
 * naver-index 400·저유동성 무변동은 제외했고 그 근거는 relative-guard.js 하단에 있다.
 *
 * 검증 대상:
 *  1. C 3등급 분류 고정 (cross / semi / tauto)
 *  2. 허용 오차 — **절대 오차 설계면 실패하는 반례**(HYPR r2 사례)
 *  3. 폐장 판정 분기 (주말·휴장일·장중·장후)
 *  4. 평탄성 N일 경계 + 캔들 부재와의 구분
 *  5. 스킵 3종이 checked와 섞이지 않는가 (조사 말미 지적)
 *  6. 상태판 행 — 전부 스킵이 '통과'로 보이지 않는가
 *
 * 실행: node scripts/test-relative-guard.js
 */
import {
  isMarketClosed, crossTolerance, checkCross, checkFlatness, baselineTooOld,
  runRelativeChecks, FLAT_RUN_THRESHOLD, BASELINE_MAX_AGE_MS,
} from '../api/_lib/relative-guard.js';
import { ASSET_META } from '../api/_lib/asset-meta.js';
import { buildRelativeGuardSource } from '../api/health.js';

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', msg); } }

// 헬퍼 — 최근 n일 history(끝이 today). 값이 다르면 평탄성에 걸리지 않는다.
const hist = (n, base, endDate = '2026-07-29', step = 1) =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.parse(`${endDate}T00:00:00Z`) - (n - 1 - i) * 86400000).toISOString().slice(0, 10),
    close: base + i * step,
  }));
const NOW_CLOSED = new Date('2026-07-29T08:00:00Z'); // 17:00 KST 수요일 = KR 장후, US 04:00 ET 장전
const NOW_KR_OPEN = new Date('2026-07-29T02:00:00Z'); // 11:00 KST 수요일 = KR 장중

// ── 1. C 3등급 분류 ────────────────────────────────────────────
{
  const g = id => ASSET_META[id]?.cross;
  for (const id of ['nasdaq', 'dow', 'sp500', 'sox', 'vix', 'dxy', 'us10y']) {
    assert(g(id) === 'cross', `1: ${id}는 cross(price=CNBC, history=Naver/FRED/CBOE)`);
  }
  for (const id of ['kospi', 'kosdaq', 'usdkrw', 'jpykrw']) {
    assert(g(id) === 'semi', `1: ${id}는 semi(같은 소스 다른 엔드포인트)`);
  }
  for (const id of ['btc', 'eth', 'dominance', 'feargreed', 'kr_base_rate']) {
    assert(g(id) === 'tauto', `1: ${id}는 tauto(동어반복 — C 제외)`);
  }
  // tauto는 폐장이든 아니든 검사하지 않는다
  const r = checkCross({ id: 'btc', price: 64379, history: hist(30, 60000) }, NOW_CLOSED);
  assert(r.state === 'skipped' && r.reason === 'tauto', `1: tauto는 스킵 (실제: ${JSON.stringify(r)})`);
}

// ── 2. 허용 오차 — 절대 오차 반례 ──────────────────────────────
{
  // ⚠️ 이 블록이 "절대 오차 금지"의 근거다. 같은 절대 임계 0.01을 두 자산에 적용하면:
  //    nasdaq(24,876) → 상대 4e-7 로 정상적인 교차소스 차이(실측 dxy 0.079%)까지 위반 처리
  //    HYPR(0.92)     → 상대 1.09% 까지 눈감음
  //    같은 숫자가 네 자릿수 넘게 다른 엄격도를 갖는다.
  const ABS = 0.01;
  const nasdaqResidualAbs = 24876.91 * 0.0008;   // 0.08% — 실측 범위의 정상 교차 차이
  assert(nasdaqResidualAbs > ABS,
    `2: [반례] 절대 0.01 기준이면 nasdaq의 정상 차이(${nasdaqResidualAbs.toFixed(2)})가 위반이 된다`);
  const hyprResidualAbs = 0.92 * 0.009;           // 0.9% — 저가주에서 명백히 큰 상대 차이
  assert(hyprResidualAbs < ABS,
    `2: [반례] 같은 절대 기준이 HYPR에서는 0.9% 차이를 통과시킨다(${hyprResidualAbs.toFixed(4)})`);

  // 상대+양자화 설계는 둘 다 올바르게 처리한다
  assert(0.0008 <= crossTolerance('nasdaq', 24876.91), '2: 상대 기준은 nasdaq 0.08%를 통과시킨다');
  assert(0.009 <= crossTolerance('HYPR', 0.92),
    `2: HYPR는 양자화(0.01/0.92=1.09%)가 지배해 0.9%가 허용 범위 (허용 ${(crossTolerance('HYPR', 0.92) * 100).toFixed(2)}%)`);
  // 양자화가 지배하는지 — 저가일수록 허용이 커져야 한다
  assert(crossTolerance('HYPR', 0.92) > crossTolerance('nasdaq', 24876.91),
    '2: 저가 자산의 허용 오차가 더 크다(양자화 지배)');
  // us10y 산정 근거: 0.01/4.61 = 0.217% — 실측 잔차와 일치. 바닥(0.5%)이 이를 덮는다.
  assert(Math.abs(0.01 / 4.61 - 0.00217) < 1e-4, '2: us10y 양자화 산정 = 실측 잔차 0.217%');
  assert(crossTolerance('us10y', 4.61) >= 0.00217, '2: us10y 허용이 실측 잔차 이상');
}

// ── 3. 폐장 판정 분기 ──────────────────────────────────────────
{
  assert(isMarketClosed('KR', new Date('2026-07-25T02:00:00Z')).reason === 'weekend', '3: 토요일=weekend');
  assert(isMarketClosed('KR', new Date('2026-07-17T02:00:00Z')).reason === 'holiday', '3: 제헌절=holiday');
  assert(isMarketClosed('KR', NOW_KR_OPEN).closed === false, '3: 11:00 KST 평일=개장');
  assert(isMarketClosed('KR', NOW_CLOSED).reason === 'after-hours', '3: 17:00 KST=장후');
  assert(isMarketClosed('US', new Date('2026-07-29T18:00:00Z')).closed === false, '3: 14:00 ET 평일=개장');
  assert(isMarketClosed('US', new Date('2026-07-03T18:00:00Z')).reason === 'holiday', '3: 7/3 미국 휴장');
  assert(isMarketClosed('CRYPTO').closed === false, '3: 크립토는 폐장 없음');

  // 장중이면 C를 아예 하지 않는다(장중 불일치는 정상이라 검사가 성립하지 않음)
  const open = checkCross({ id: 'kospi', price: 5663, history: hist(30, 5600) }, NOW_KR_OPEN);
  assert(open.state === 'skipped' && open.reason === 'market-open', '3: 장중이면 C 스킵');
}

// ── 4. 평탄성 N일 경계 ─────────────────────────────────────────
{
  assert(FLAT_RUN_THRESHOLD === 7, '4: 임계 7일');
  const flatN = n => [...hist(30 - n, 100), ...Array.from({ length: n }, (_, i) => ({
    date: `2026-07-${String(20 + i).padStart(2, '0')}`, close: 999 }))];

  assert(checkFlatness({ id: 'kospi', history: flatN(6) }).ok === true, '4: 6일 연속은 통과(경계 미만)');
  const at7 = checkFlatness({ id: 'kospi', history: flatN(7) });
  assert(at7.ok === false && at7.run === 7, `4: 7일 연속은 위반 (실제 run=${at7.run})`);
  assert(at7.from && at7.to, '4: 위반 구간의 날짜 범위를 함께 보고(연휴와 구분 재료)');

  // ⚠️ 캔들 부재(휴장)와 동일값 반복의 구분 — 배열에 없는 날은 세지 않는다.
  const withGap = [{ date: '2026-09-23', close: 100 }, { date: '2026-09-28', close: 100 }];
  const gap = checkFlatness({ id: 'kospi', history: withGap });
  assert(gap.state === 'skipped' && gap.reason === 'short-history',
    '4: 캔들이 적으면(연휴로 빠짐) 평탄성 판정을 하지 않는다');

  // 개별 종목은 제외 — 저유동성·거래정지를 판정할 수단이 없다
  assert(checkFlatness({ id: 'HYPR', history: flatN(10) }).reason === 'single-name',
    '4: 개별 종목은 평탄성 제외(오탐 불가 구간)');
  assert(checkFlatness({ id: '080220', history: flatN(10) }).reason === 'single-name', '4: 코스닥 종목도 제외');
}

// ── 5. 스킵이 checked와 섞이지 않는가 ──────────────────────────
{
  // (a) 낡은 기준선 — checked로 세면 'checked>0 = 검사 유효'가 깨진다
  const oldHist = hist(30, 100, '2026-07-01');   // 마지막 캔들이 28일 전
  const stale = baselineTooOld({ history: oldHist }, NOW_CLOSED);
  assert(stale.stale === true, '5: 28일 전 기준선은 낡음');
  assert(BASELINE_MAX_AGE_MS === 3 * 86400000, '5: 기준선 나이 임계 3일');

  const r = runRelativeChecks([{ id: 'nasdaq', price: 24876, history: oldHist }], NOW_CLOSED);
  assert(r.checked === 0 && r.skipped === 1, `5: 낡은 기준선은 skipped (checked=${r.checked})`);
  assert(r.skipReasons['stale-baseline'] === 1, `5: 사유가 stale-baseline (실제: ${JSON.stringify(r.skipReasons)})`);

  // (b) 기준선 없음
  const none = runRelativeChecks([{ id: 'nasdaq', price: 24876, history: [] }], NOW_CLOSED);
  assert(none.checked === 0 && none.skipReasons['no-baseline'] === 1, '5: 기준선 없음도 skipped');

  // (c) 장중 — C만 스킵되고 평탄성(일봉 기반)은 그대로 돈다.
  //     ⚠️ 스킵을 **검사 단위**로 세는 이유가 여기다. 항목 단위로 세면 평탄성이 돌았다는
  //     이유로 'C를 못 했다'는 사실이 통째로 사라진다.
  const open = runRelativeChecks([{ id: 'kospi', price: 5663, history: hist(30, 5600) }], NOW_KR_OPEN);
  assert(open.skipReasons['market-open'] === 1,
    `5: 장중이면 C가 market-open으로 스킵 (실제: ${JSON.stringify(open.skipReasons)})`);
  assert(open.checked === 1, '5: 그래도 평탄성은 돌았으므로 항목은 checked');
  assert(open.skipped === 1, '5: 스킵은 검사 단위로 1건');

  // (d) 정상 — 폐장 + 신선한 기준선이면 checked
  const good = runRelativeChecks([
    { id: 'nasdaq', price: 24876.91, history: hist(30, 24800) },
  ], NOW_CLOSED);
  assert(good.checked === 1, `5: 폐장+신선 기준선이면 checked (실제 ${good.checked})`);

  // (e) 위반 검출 — history[-1]이 price와 크게 어긋나면 blocked
  const bad = runRelativeChecks([
    { id: 'nasdaq', price: 24876.91, history: [...hist(29, 24800), { date: '2026-07-29', close: 20000 }] },
  ], NOW_CLOSED);
  assert(bad.checked === 1 && bad.blocked === 1, '5: 교차 불일치 검출');
  assert(bad.findings[0].kind === 'cross', '5: findings에 kind=cross');
  // ⚠️ 중립 문구 — 어느 쪽이 틀렸는지 단정하지 않는다
  assert(bad.findings[0].detail.includes('양측 불일치'),
    `5: 문구가 중립적("양측 불일치") (실제: ${bad.findings[0].detail})`);
  assert(!/price 오류|history 오류/.test(bad.findings[0].detail), '5: 한쪽을 범인으로 단정하지 않음');
}

// ── 6. 상태판 행 ───────────────────────────────────────────────
{
  const none = buildRelativeGuardSource({ scopes: {}, fields: {} });
  assert(none.status === 'unknown', '6: 기록 없으면 unknown');

  // ⭐ 전부 스킵인데 checked=0 — 통과로 보이면 안 된다
  const allSkip = buildRelativeGuardSource({
    scopes: { relative: { checked: 0, blocked: 0, skipped: 20, skips: { 'market-open': 20 }, reasons: {} } },
    fields: {},
  });
  assert(allSkip.status === 'warn' && allSkip.verdict === 'not-run',
    `6: 전부 스킵은 warn/not-run (실제: ${allSkip.status}/${allSkip.verdict})`);
  assert(allSkip.note.includes('통과가 아니라 미수행'), `6: 문구로 명시 (실제: ${allSkip.note})`);
  assert(allSkip.note.includes('market-open×20'), '6: 스킵 사유 분포 노출');

  const clean = buildRelativeGuardSource({
    scopes: { relative: { checked: 7, blocked: 0, skipped: 13, skips: { tauto: 5, 'market-open': 8 }, reasons: {} } },
    fields: {},
  });
  assert(clean.status === 'ok' && clean.checked === 7, '6: 검사 성립분이 있으면 ok');
  assert(clean.note.includes('스킵 13'), '6: 통과여도 스킵 건수를 함께 보여줌');

  const viol = buildRelativeGuardSource({
    scopes: { relative: { checked: 7, blocked: 1, skipped: 0, skips: {}, reasons: {},
      lastBlock: 'nasdaq 양측 불일치 19.6% > 허용 0.5%' } },
    fields: {},
  });
  assert(viol.status === 'warn' && viol.verdict === 'transient', '6: 불일치는 warn/transient');
  assert(viol.note.includes('양측 불일치'), '6: 중립 문구가 상태판까지 전달');

  // 연속 위반 → 검사 1과 같은 3등급 승격
  const sust = buildRelativeGuardSource({
    scopes: { relative: { checked: 7, blocked: 1, skipped: 0, skips: {}, reasons: {}, lastBlock: 'nasdaq …' } },
    fields: { relative: { nasdaq: { consec: 3 } } },
  });
  assert(sust.status === 'down' && sust.verdict === 'sustained', '6: 3회 연속은 down/sustained');
  assert(sust.note.includes('한쪽 파서 이상 의심'), '6: 승격 문구도 중립(양측 중 한쪽)');
}

console.log(`\n${fail === 0 ? '✓ 전체 통과' : '✗ 실패 있음'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
