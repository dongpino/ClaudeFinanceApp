/**
 * scripts/test-relative-guard.js — 검사 2a(상대 타당성 — 가격 축) 검증. 네트워크·Redis 없음.
 *
 * 1단계 조사에서 범위를 C(교차소스) + 평탄성으로 좁혔다. 급변·뉴스 교차확인·
 * naver-index 400·저유동성 무변동은 제외했고 그 근거는 relative-guard.js 하단에 있다.
 *
 * 검증 대상:
 *  1. C 3등급 분류 고정 (cross / semi / tauto)
 *  2. 허용 오차 — **절대 오차 설계면 실패하는 반례**(HYPR r2 사례)
 *  3. 폐장 판정 분기 (주말·휴장일·장중·장후)
 *  3b. FX/금리 세션 분리 — us10y 상시 오탐의 회귀 고정
 *  3c. 거래일 파생 — **KST 날짜 ≠ 거래일**(US 폐장 05:00 KST 케이스)
 *  4. 평탄성 N일 경계 + 캔들 부재와의 구분
 *  5. 스킵 3종이 checked와 섞이지 않는가 (조사 말미 지적)
 *  6. 상태판 행 — 전부 스킵이 '통과'로 보이지 않는가
 *
 * 실행: node scripts/test-relative-guard.js
 */
import {
  isMarketClosed, crossTolerance, checkCross, checkFlatness, baselineTooOld,
  runRelativeChecks, FLAT_RUN_THRESHOLD, BASELINE_MAX_AGE_MS,
  tradingDateOf, parseAsOf, prevTradingDay, isTradingDay,
} from '../api/_lib/relative-guard.js';
import { ASSET_META, isFlatExempt } from '../api/_lib/asset-meta.js';
import { readFileSync } from 'node:fs';
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

// ── 3b. FX/금리 세션 분리 (2026-07-30) ─────────────────────────
// ⭐ 이 블록이 us10y 상시 오탐의 회귀 고정이다.
//    [저장소:9072dee8:health:validate:fields:relative@2026-07-30T00:38:40Z]
//    us10y 1.493% 위반 @2026-07-29T22:59:14.826Z = 18:59 ET — 주식은 폐장이지만
//    금리는 거래 중인 구간. US 세션으로 묶여 있어 검사가 돌아 버렸다.
{
  assert(ASSET_META.dxy.market === 'FX',   '3b: dxy는 FX 세션');
  assert(ASSET_META.us10y.market === 'FX', '3b: us10y는 FX 세션');
  // 주식 5종은 US 세션 유지 — 분리가 과하게 번지지 않는지
  for (const id of ['nasdaq', 'dow', 'sp500', 'sox', 'vix']) {
    assert(ASSET_META[id].market === 'US', `3b: ${id}는 US 세션 유지`);
  }
  // 원화 환율은 이번 분리 대상이 아니다(서울 외환시장 정규시간 = KR 주식 세션)
  assert(ASSET_META.usdkrw.market === 'KR' && ASSET_META.jpykrw.market === 'KR',
    '3b: usdkrw·jpykrw는 KR 세션 유지');

  // ⭐ 실측 위반 시각 재현 — 같은 순간에 세션 판정이 갈려야 한다
  const VIOLATION_AT = new Date('2026-07-29T22:59:14.826Z'); // 18:59 ET 수요일
  assert(isMarketClosed('US', VIOLATION_AT).reason === 'after-hours',
    '3b: 그 시각 US(주식)는 폐장 — 종전 판정');
  assert(isMarketClosed('FX', VIOLATION_AT).closed === false,
    '3b: ⭐ 같은 시각 FX(금리)는 거래중 — 이제 C가 돌지 않는다(오탐 차단)');
  const skipped = checkCross(
    { id: 'us10y', price: 4.6697, history: [...hist(29, 4.3, '2026-07-28', 0.01), { date: '2026-07-28', close: 4.6 }] },
    VIOLATION_AT);
  assert(skipped.state === 'skipped' && skipped.reason === 'market-open',
    `3b: ⭐ us10y 1.493% 회차가 스킵된다 (실제: ${JSON.stringify(skipped)})`);

  // 평일 연속 — 주식이 닫힌 시간대 전부 '거래중'이어야 한다
  for (const iso of ['2026-07-29T02:00:00Z', '2026-07-29T12:00:00Z', '2026-07-29T18:00:00Z',
                     '2026-07-30T04:00:00Z']) {
    assert(isMarketClosed('FX', new Date(iso)).closed === false, `3b: 평일 ${iso}는 FX 거래중`);
  }
  // 주말만 폐장 — 토요일 종일
  assert(isMarketClosed('FX', new Date('2026-08-01T12:00:00Z')).reason === 'weekend',
    '3b: 토요일 08:00 ET는 FX 폐장');
  assert(isMarketClosed('FX', new Date('2026-08-02T18:00:00Z')).reason === 'weekend',
    '3b: 일요일 14:00 ET(재개 전)는 FX 폐장');
  // ⚠️ 비대칭의 회귀 — 일요일 재개(17:00 ET) 이후를 폐장으로 잡으면 오탐이 난다
  assert(isMarketClosed('FX', new Date('2026-08-02T22:00:00Z')).closed === false,
    '3b: ⭐ 일요일 18:00 ET(재개 후)는 거래중 — 폐장으로 잡으면 금요일 캔들과 대조해 오탐');
  // 미 증시 휴장일은 FX 폐장으로 보지 않는다(의도적 커버리지 포기)
  assert(isMarketClosed('FX', new Date('2026-07-03T18:00:00Z')).closed === false,
    '3b: 7/3 미 증시 휴장일에도 FX는 폐장으로 보지 않는다');
}

// ── 3c. 거래일(trading date) 파생 ──────────────────────────────
// ⭐ **KST 날짜 ≠ 거래일**의 회귀 고정. [B](검사 2b)가 이 함수를 전제로 설계된다.
{
  const kstDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);

  // ⭐ US 폐장 16:00 ET = 05:00 KST **다음날** — 지시된 그 케이스
  const AT_CLOSE = new Date('2026-07-29T20:00:00Z');  // 16:00 EDT 수 = 05:00 KST 목
  assert(kstDate(AT_CLOSE) === '2026-07-30', '3c: 그 순간의 KST 날짜는 07-30');
  const tdClose = tradingDateOf('nasdaq', AT_CLOSE);
  assert(tdClose.date === '2026-07-29',
    `3c: ⭐ 거래일은 07-29 — KST 날짜와 하루 갈린다 (실제: ${JSON.stringify(tdClose)})`);
  assert(tdClose.date !== kstDate(AT_CLOSE), '3c: ⭐ 두 값이 실제로 다름을 명시적으로 고정');
  assert(tdClose.basis === 'after-close', `3c: basis=after-close (실제: ${tdClose.basis})`);

  // 실측 위반 회차도 같은 구간 — price는 07-29 종가였다
  const tdViol = tradingDateOf('vix', new Date('2026-07-29T22:59:14.826Z'));
  assert(tdViol.date === '2026-07-29' && tdViol.basis === 'after-close',
    `3c: 위반 회차(18:59 ET) 거래일=07-29 (실제: ${JSON.stringify(tdViol)})`);
  // 그 회차 history[-1]은 07-28이었다 → 전 거래일 = 오정렬 검출의 재료
  assert(prevTradingDay('2026-07-29', 'US') === '2026-07-28',
    '3c: 07-29의 전 거래일은 07-28 — 오정렬 판정의 기준');
  // 거래일 판정 자체 — 주말/휴장일 표가 둘 다 반영되는가
  assert(isTradingDay('2026-07-29', 'US') === true,  '3c: 07-29(수)는 거래일');
  assert(isTradingDay('2026-08-01', 'US') === false, '3c: 08-01(토)은 비거래일');
  assert(isTradingDay('2026-07-03', 'US') === false, '3c: 미 휴장일은 비거래일');
  assert(isTradingDay('2026-07-17', 'KR') === false, '3c: 제헌절은 KR 비거래일');
  // ⚠️ holidayKey=null(continuous)은 **주말만** 본다 — FX가 증시 휴장일에 쉬지 않는 근거
  assert(isTradingDay('2026-07-03', null) === true,
    '3c: continuous 세션은 증시 휴장일을 거래일로 본다(FX 설계와 일치)');
  assert(prevTradingDay('2026-07-06', null) === '2026-07-03',
    '3c: continuous의 전 거래일은 휴장일을 건너뛰지 않는다');

  // 개장 전 — 전 거래일
  const tdPre = tradingDateOf('nasdaq', new Date('2026-07-29T12:00:00Z')); // 08:00 ET 수
  assert(tdPre.date === '2026-07-28' && tdPre.basis === 'pre-open',
    `3c: 개장 전은 전 거래일 (실제: ${JSON.stringify(tdPre)})`);
  // 장중 — 진행 중인 그 날
  const tdIn = tradingDateOf('nasdaq', new Date('2026-07-29T18:00:00Z')); // 14:00 ET 수
  assert(tdIn.date === '2026-07-29' && tdIn.basis === 'intraday', '3c: 장중은 그 날');

  // 휴장일·주말은 전 거래일로 물러난다
  const tdHol = tradingDateOf('nasdaq', new Date('2026-07-03T18:00:00Z')); // 미 휴장(금)
  assert(tdHol.date === '2026-07-02' && tdHol.basis === 'non-trading-day',
    `3c: 미 휴장일은 전 거래일 (실제: ${JSON.stringify(tdHol)})`);
  const tdSat = tradingDateOf('nasdaq', new Date('2026-08-01T18:00:00Z'));
  assert(tdSat.date === '2026-07-31', '3c: 토요일은 직전 금요일');

  // KR 세션 — 15:30 KST 이후는 그 날, 09:00 전은 전 거래일
  assert(tradingDateOf('kospi', new Date('2026-07-29T08:00:00Z')).date === '2026-07-29',
    '3c: 17:00 KST는 그 날이 거래일');
  assert(tradingDateOf('kospi', new Date('2026-07-28T23:00:00Z')).date === '2026-07-28',
    '3c: 08:00 KST(개장 전)는 전 거래일');
  // 제헌절(2026-07-17, 금) — 휴장일 표가 거래일 파생에도 반영되는가
  assert(tradingDateOf('kospi', new Date('2026-07-17T08:00:00Z')).date === '2026-07-16',
    '3c: 제헌절은 전 거래일(07-16) — 휴장일 표 원본 하나를 공유');

  // FX 세션 — 평일은 그 날, 주말은 직전 금요일
  assert(tradingDateOf('us10y', new Date('2026-07-29T22:59:14.826Z')).date === '2026-07-29',
    '3c: FX 평일 거래일');
  const fxSun = tradingDateOf('dxy', new Date('2026-08-02T22:00:00Z')); // 일 18:00 ET(재개 후)
  assert(fxSun.date === '2026-07-31' && fxSun.basis === 'continuous-weekend',
    `3c: ⭐ 일요일 재개 후에도 완결된 거래일은 금요일 (실제: ${JSON.stringify(fxSun)})`);
  // isMarketClosed와 답이 갈리는 게 정상 — 서로 다른 질문이다
  assert(isMarketClosed('FX', new Date('2026-08-02T22:00:00Z')).closed === false
      && fxSun.basis === 'continuous-weekend',
    '3c: "거래중"과 "완결된 거래일"은 별개 질문 — 답이 갈려도 모순 아님');

  // 크립토 — 세션 경계가 없어 UTC 날짜
  const tdBtc = tradingDateOf('btc', new Date('2026-07-29T22:00:00Z'));
  assert(tdBtc.date === '2026-07-29' && tdBtc.basis === 'utc-date', '3c: 크립토는 UTC 날짜');

  // as_of 문자열 파싱 — 홈 아이템이 실제로 쓰는 형식
  assert(parseAsOf('2026-07-30 08:51 KST').toISOString() === '2026-07-29T23:51:00.000Z',
    '3c: "YYYY-MM-DD HH:mm KST" 파싱(+09:00 고정)');
  assert(tradingDateOf('vix', '2026-07-30 08:51 KST').date === '2026-07-29',
    '3c: ⭐ 실제 as_of 문자열로도 거래일 07-29 — [B]가 이 형태로 호출한다');
  assert(parseAsOf('말도 안 되는 값') === null, '3c: 해석 불가는 null');
  assert(tradingDateOf('vix', '말도 안 되는 값').basis === 'unparsable-asof',
    '3c: 해석 불가는 basis로 드러낸다(조용히 오늘로 떨어지지 않음)');
  assert(tradingDateOf('없는항목', new Date()).basis === 'unknown-market',
    '3c: 미지의 id는 unknown-market');
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

// ── 7. 평탄성 면제 파생(cadence/type) ──────────────────────────
// ⚠️ 종전에는 정책금리가 stale-baseline이라는 **다른 이유로 우연히** 빠지고 있었다.
//    history가 일별로 바뀌면 즉시 상시 오탐이 되는 상태였다 — 그 우연을 규칙으로 대체한다.
{
  // (a) 지시된 4건이 자동 면제되는가 — 항목별 boolean 플래그 없이 cadence/type만으로
  for (const [id, why] of [
    ['kr_base_rate', 'policy_rate'], ['fomc.rate', 'policy_rate'], ['bok', 'policy_rate'],
    ['cpi', 'cadence-monthly'], ['unemployment', 'cadence-monthly'],
  ]) {
    const e = isFlatExempt(id);
    assert(e.exempt === true && e.reason === why,
      `7a: ${id} 자동 면제(사유=${why}) (실제: ${JSON.stringify(e)})`);
  }

  // (b) 대조군 — 일별 시세는 면제되면 안 된다(면제가 과하게 번지지 않는지)
  for (const id of ['kospi', 'nasdaq', 'usdkrw', 'btc', 'dominance', 'feargreed', 'us10y']) {
    assert(isFlatExempt(id).exempt === false, `7b: ${id}는 평탄성 검사 대상`);
  }
  assert(isFlatExempt('없는항목').exempt === false, '7b: 미지의 id는 면제하지 않음');

  // (c) ⭐ baselineTooOld와 **무관하게** 면제되는가 — 기준선을 오늘로 둬 stale을 배제한다
  const today = new Date().toISOString().slice(0, 10);
  const fresh = Array.from({ length: 24 }, (_, i) => ({
    date: i === 23 ? today : `2025-${String((i % 12) + 1).padStart(2, '0')}-01`, close: 2.75 }));
  assert(baselineTooOld({ history: fresh }).stale === false, '7c: 이 데이터는 stale-baseline이 아니다');
  const ex = checkFlatness({ id: 'kr_base_rate', history: fresh });
  assert(ex.state === 'skipped' && ex.reason === 'flat-exempt:policy_rate',
    `7c: 기준선이 신선해도 정책금리는 면제 (실제: ${JSON.stringify(ex)})`);
  // 반증 — 같은 데이터를 kospi로 주면 24일 연속 동일값이라 위반이어야 한다
  const kos = checkFlatness({ id: 'kospi', history: fresh });
  assert(kos.state === 'checked' && kos.ok === false && kos.run === 24,
    `7c: [반증] 면제 대상이 아니면 같은 데이터가 위반 (실제: ${JSON.stringify(kos)})`);

  // (d) 항목별 수동 boolean 플래그가 다시 생기지 않았는지(단일 원본 파생 원칙)
  //     ⚠️ 주석은 걷어내고 본다 — asset-meta.js의 설명문이 "flatExempt: true를 쓰지 않는다"
  //     라고 그 이름을 언급하고 있어서, 원문 그대로 검사하면 설명이 위반으로 잡힌다
  //     (test-probe-capture의 trackedFetch 검사와 같은 함정).
  const metaSrc = readFileSync(new URL('../api/_lib/asset-meta.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert(!/flatExempt\s*:/.test(metaSrc), '7d: flatExempt 수동 플래그를 쓰지 않는다(파생만)');
  // 파생 근거가 실제로 메타에 적혀 있는지(규칙이 읽을 재료가 있는가)
  assert(/cadence:\s*MONTHLY/.test(metaSrc) && /type:\s*POLICY_RATE/.test(metaSrc),
    '7d: cadence/type이 메타에 명시돼 있다');
}

console.log(`\n${fail === 0 ? '✓ 전체 통과' : '✗ 실패 있음'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
