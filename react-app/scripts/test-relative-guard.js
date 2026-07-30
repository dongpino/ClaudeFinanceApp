/**
 * scripts/test-relative-guard.js — 검사 2a(상대 타당성 — 가격 축) 검증. 네트워크·Redis 없음.
 *
 * 1단계 조사에서 범위를 C(교차소스) + 평탄성으로 좁혔다. 급변·뉴스 교차확인·
 * naver-index 400·저유동성 무변동은 제외했고 그 근거는 relative-guard.js 하단에 있다.
 *
 * 검증 대상:
 *  1. C 4등급 분류 고정 (cross / semi / tauto / tautological)
 *  2. 허용 오차 — **절대 오차 설계면 실패하는 반례**(HYPR r2 사례)
 *  3. 폐장 판정 분기 (주말·휴장일·장중·장후)
 *  1b. 항등(tautological) 강등 — 사유를 tauto와 구분해 센다
 *  3b. FX/금리 세션 분리 — us10y 상시 오탐의 회귀 고정
 *  3c. 거래일 파생 — **KST 날짜 ≠ 거래일**(US 폐장 05:00 KST 케이스)
 *  3d. 날짜만 있는 asOf — 시각 해석 시 하루 밀림 + 런타임 TZ 의존
 *  4. 평탄성 N일 경계 + 캔들 부재와의 구분
 *  5. 스킵 3종이 checked와 섞이지 않는가 (조사 말미 지적)
 *  6. 상태판 행 — 전부 스킵이 '통과'로 보이지 않는가
 *  8. [B] 승인 조건 회귀 — 거래일 갭·recalcChange·관측 전용 축·source-suspect·스키마 무변경
 *  9. recalcChange 서빙 값·동작 무변경(플래그는 추가 전용)
 *
 * 실행: node scripts/test-relative-guard.js
 */
import {
  isMarketClosed, crossTolerance, checkCross, checkFlatness,
  runRelativeChecks, FLAT_RUN_THRESHOLD, STALE_TRADING_DAY_GAP,
  tradingDateOf, parseAsOf, asOfTradingDate, prevTradingDay, nextTradingDay,
  isTradingDay, tradingDaysBetween, holidayKeyOf,
} from '../api/_lib/relative-guard.js';
import { ASSET_META, isFlatExempt, isDailyCadence } from '../api/_lib/asset-meta.js';
import { readFileSync } from 'node:fs';
import { buildRelativeGuardSource } from '../api/health.js';
import { recalcChange } from '../api/_collectors/us-indices.js';

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', msg); } }

// 헬퍼 — 최근 n일 history(끝이 today). 값이 다르면 평탄성에 걸리지 않는다.
const hist = (n, base, endDate = '2026-07-29', step = 1) =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.parse(`${endDate}T00:00:00Z`) - (n - 1 - i) * 86400000).toISOString().slice(0, 10),
    close: base + i * step,
  }));
// ⚠️ 2026-07-30: 거래일 정렬이 들어오면서 '지금'이 픽스처의 endDate와 맞아야 한다.
//    이 시각(16:30 ET 수)은 US=after-close, KR=pre-open(다음날 05:30 KST), FX=평일 롤 전이라
//    **세 세션 모두 거래일이 2026-07-29**로 일치한다 — hist()의 기본 endDate와 같다.
const NOW_CLOSED = new Date('2026-07-29T20:30:00Z');
const NOW_KR_OPEN = new Date('2026-07-29T02:00:00Z'); // 11:00 KST 수요일 = KR 장중
const NOW_US_OPEN = new Date('2026-07-29T18:00:00Z'); // 14:00 ET 수요일 = US 장중

// ── 1. C 3등급 분류 ────────────────────────────────────────────
{
  const g = id => ASSET_META[id]?.cross;
  for (const id of ['nasdaq', 'dow', 'sp500', 'sox', 'vix', 'dxy', 'us10y']) {
    assert(g(id) === 'cross', `1: ${id}는 cross(price=CNBC, history=Naver/FRED/CBOE)`);
  }
  // ⚠️ semi는 **엔드포인트가 실제로 다른** 것만 남는다(2026-07-30 강등 후).
  for (const id of ['419530', '028300', '080220', 'HYPR']) {
    assert(g(id) === 'semi', `1: ${id}는 semi(quote↔history 엔드포인트가 다름)`);
  }
  for (const id of ['btc', 'eth', 'dominance', 'feargreed', 'kr_base_rate']) {
    assert(g(id) === 'tauto', `1: ${id}는 tauto(같은 벤더 — 서로를 반증 못 함)`);
  }
  // ⭐ 항등 강등 4종 — 같은 응답의 같은 행이라 잔차가 정의상 0
  for (const id of ['kospi', 'kosdaq', 'usdkrw', 'jpykrw']) {
    assert(g(id) === 'tautological', `1: ${id}는 tautological(같은 응답 같은 행 — 잔차 정의상 0)`);
  }
  // tauto는 폐장이든 아니든 검사하지 않는다
  const r = checkCross({ id: 'btc', price: 64379, history: hist(30, 60000) }, NOW_CLOSED);
  assert(r.state === 'skipped' && r.reason === 'tauto', `1: tauto는 스킵 (실제: ${JSON.stringify(r)})`);
}

// ── 1b. 항등(tautological) 강등 — 사유를 tauto와 구분해 센다 ────
// ⭐ 근거는 소스 구조다(kr.js:45-62 / :134-176 — 현재가와 history가 같은 응답의 같은 행).
//    실측 확인 [계산@2026-07-30T01:49:26Z 프로덕션 9072dee8]:
//      kospi 5663.24 / kosdaq 662.68 / usdkrw 1446 / jpykrw 884.76
//      네 항목 모두 price−history[-1] = 0.00000000, prevClose−history[-2] = 0.00000000
{
  for (const id of ['kospi', 'kosdaq', 'usdkrw', 'jpykrw']) {
    const c = checkCross({ id, price: 100, history: hist(30, 90) }, NOW_CLOSED);
    assert(c.state === 'skipped' && c.reason === 'tautological',
      `1b: ${id}는 tautological로 스킵 (실제: ${JSON.stringify(c)})`);
  }
  // 사유가 tauto와 섞이지 않는가 — btc 계열과 원인이 다르므로 집계도 갈려야 한다
  const agg = runRelativeChecks([
    { id: 'kospi',  price: 100,   history: hist(30, 90) },
    { id: 'usdkrw', price: 1446,  history: hist(30, 1400) },
    { id: 'btc',    price: 64379, history: hist(30, 60000) },
    { id: 'nasdaq', price: 24876.91, history: hist(30, 24800) },
  ], NOW_CLOSED);
  assert(agg.skipReasons.tautological === 2,
    `1b: ⭐ 항등 2건이 tautological로 집계 (실제: ${JSON.stringify(agg.skipReasons)})`);
  assert(agg.skipReasons.tauto === 1, '1b: btc는 여전히 tauto — 사유가 섞이지 않는다');

  // ⭐ 항등 통과가 더는 "교차 검사 통과"로 보이지 않는다.
  //    단 항목은 평탄성이 유효하므로 checked에 남는다 — 그건 실제로 수행한 검사다.
  const kospiOnly = runRelativeChecks([{ id: 'kospi', price: 100, history: hist(30, 90) }], NOW_CLOSED);
  assert(kospiOnly.checked === 1, '1b: kospi는 평탄성이 유효하므로 checked 유지');
  assert(kospiOnly.skipReasons.tautological === 1, '1b: 그러나 C축은 tautological로 스킵 노출');
  assert(kospiOnly.blocked === 0, '1b: 항등이 위반으로 잡히지도 않는다');

  // 대조군 — 코스닥 3종은 엔드포인트가 달라 semi 유지, 실제로 검사가 돈다
  const kq = checkCross({ id: '080220', price: 55100, history: [...hist(29, 54000, '2026-07-28', 10), { date: '2026-07-28', close: 55100 }] }, NOW_CLOSED);
  assert(kq.state === 'checked' && kq.grade === 'semi',
    `1b: 080220은 semi로 실제 검사 (실제: ${JSON.stringify(kq)})`);
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

  // ⭐ 2026-07-30: **폐장 판정은 더 이상 C의 실행 조건이 아니다.** 거래일 정렬이 대신한다.
  //    장중에는 당일 캔들이 없어 가격 축이 성립하지 않을 뿐이고, change 축은 그대로 돈다.
  const open = checkCross({ id: '080220', price: 55100, change: 100, as_of: '2026-07-29 (테스트)',
    history: [...hist(29, 54000, '2026-07-28', 10), { date: '2026-07-28', close: 55000 }] }, NOW_KR_OPEN);
  assert(open.state === 'checked' && open.alignment === 'prev-day',
    `3: ⭐ 장중에도 C가 돈다(정렬 prev-day) (실제: ${JSON.stringify(open)})`);
  assert(open.axes.every(a => a.checkKind !== 'cross-price'),
    '3: 당일 캔들이 없으므로 가격 축은 만들지 않는다');
  assert(open.axes.some(a => a.checkKind === 'cross-prevclose' && a.ok),
    '3: change 축은 성립하고 통과한다');
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
  // ⚠️ 원화 환율은 KR 세션 유지 — 근거는 시장 거래시간이 아니라 **소스 발행 캘린더**다.
  //    [자체실측] history_90d 2026-03-19~07-29 구간 평일 KR 공휴일 5건 전부 캔들 없음(0/5).
  //    아래 항등 강등으로 C가 아예 돌지 않아 폐장 판정이 결과에 영향을 주지도 않는다.
  assert(ASSET_META.usdkrw.market === 'KR' && ASSET_META.jpykrw.market === 'KR',
    '3b: usdkrw·jpykrw는 KR 세션 유지');

  // ⭐ 실측 위반 시각 재현 — 같은 순간에 세션 판정이 갈려야 한다
  const VIOLATION_AT = new Date('2026-07-29T22:59:14.826Z'); // 18:59 ET 수요일
  assert(isMarketClosed('US', VIOLATION_AT).reason === 'after-hours',
    '3b: 그 시각 US(주식)는 폐장 — 종전 판정');
  assert(isMarketClosed('FX', VIOLATION_AT).closed === false,
    '3b: 같은 시각 FX(금리)는 거래중');

  // ⭐ 그 회차의 실측 형상으로 재현 — 17:00 ET 롤 덕에 price 거래일이 07-30이 되고
  //    history[-1](07-29)은 전 거래일이 된다 → 가격 축 부재 + change 축 통과.
  //    [원문 FRED DGS10 @2026-07-30] 07-28=4.61, 07-29 미발행. Naver 07-29=4.62가
  //    CNBC prev_close 4.62와 일치 → CNBC price 4.6697은 이미 07-30 세션 값이다.
  const real = checkCross({
    id: 'us10y', price: 4.6697, change: 0.051, as_of: '2026-07-30 08:51 KST',
    source: 'CNBC',
    history: [...hist(29, 4.3, '2026-07-28', 0.01), { date: '2026-07-29', close: 4.62 }],
  }, VIOLATION_AT);
  assert(real.priceDate === '2026-07-30' && real.alignment === 'prev-day',
    `3b: ⭐ 17:00 ET 롤로 price 거래일=07-30, 정렬=prev-day (실제: ${JSON.stringify({d:real.priceDate,a:real.alignment})})`);
  assert(real.axes.every(a => a.checkKind !== 'cross-price'),
    '3b: 07-30 캔들이 없으므로 가격 축 부재 — 1.071%/1.493% 대조가 애초에 만들어지지 않는다');
  const pc = real.axes.find(a => a.checkKind === 'cross-prevclose');
  assert(pc && pc.ok && pc.residual < 0.001,
    `3b: ⭐ change 축은 통과(prevClose 4.6187 ↔ 4.62) (실제: ${JSON.stringify(pc)})`);

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
  // FX 평일, 17:00 ET 롤 **전**
  const fxPre = tradingDateOf('us10y', new Date('2026-07-29T16:00:00Z')); // 12:00 ET 수
  assert(fxPre.date === '2026-07-29' && fxPre.basis === 'continuous-weekday',
    `3c: FX 롤 전은 그 날 (실제: ${JSON.stringify(fxPre)})`);
  // ⭐ 17:00 ET 롤 **후** — value date가 다음 거래일로 넘어간다([E] 근거)
  const fxPost = tradingDateOf('us10y', new Date('2026-07-29T22:59:14.826Z')); // 18:59 ET 수
  assert(fxPost.date === '2026-07-30' && fxPost.basis === 'continuous-rolled',
    `3c: ⭐ FX 롤 후는 다음 거래일 (실제: ${JSON.stringify(fxPost)})`);
  // 롤이 주말을 건너뛴다 — 금요일 롤 후는 폐장 구간이므로 금요일(마지막 완결 거래일)
  const fxFri = tradingDateOf('dxy', new Date('2026-07-31T22:00:00Z')); // 18:00 ET 금
  assert(fxFri.date === '2026-07-31' && fxFri.basis === 'continuous-weekend',
    `3c: 금요일 17:00 ET 이후는 거래 정지 구간 → 그 금요일이 거래일 (실제: ${JSON.stringify(fxFri)})`);
  // 토요일 — 마지막 완결 거래일
  assert(tradingDateOf('dxy', new Date('2026-08-01T12:00:00Z')).date === '2026-07-31',
    '3c: 토요일은 직전 금요일');
  // ⭐ 일요일 재개(17:00 ET) 후 — 새 주의 첫 value date
  const fxSun = tradingDateOf('dxy', new Date('2026-08-02T22:00:00Z')); // 일 18:00 ET
  assert(fxSun.date === '2026-08-03' && fxSun.basis === 'continuous-rolled',
    `3c: ⭐ 일요일 재개 후는 월요일 value date (실제: ${JSON.stringify(fxSun)})`);
  // 일요일 재개 전 — 아직 금요일
  assert(tradingDateOf('dxy', new Date('2026-08-02T18:00:00Z')).date === '2026-07-31',
    '3c: 일요일 재개 전은 직전 금요일');

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

// ── 3d. 날짜만 있는 asOf — 시각으로 해석하면 하루 밀린다 ────────
// ⭐ 실측 프로덕션 asOf 계열이 두 종류다. 날짜만인 쪽을 Date.parse에 넘기면 V8이 괄호를
//    주석으로 무시하고 **로컬 자정**으로 읽어, 런타임 TZ에 따라 답이 달라졌다:
//      TZ=Asia/Seoul → 2026-07-28(pre-open)   TZ=UTC → 2026-07-29(intraday)
//    로컬 개발기와 Vercel이 다른 거래일을 내는 상태였다.
{
  const FORMS = [
    ['2026-07-29 (Naver 종가)',      'kospi'],
    ['2026-07-29 (Naver 환율)',      'usdkrw'],
    ['2026-07-29 (Twelve Data 종가)', 'HYPR'],
    ['2026-07-29 (ECB 기준환율)',     'usdkrw'],
  ];
  for (const [asOf, id] of FORMS) {
    assert(asOfTradingDate(asOf) === '2026-07-29', `3d: "${asOf}" → 날짜만으로 인식`);
    const td = tradingDateOf(id, asOf);
    assert(td.date === '2026-07-29' && td.basis === 'asof-date',
      `3d: ⭐ ${id} 거래일 = 소스가 준 날짜 그대로 (실제: ${JSON.stringify(td)})`);
  }
  // 시각이 있는 형식은 날짜만으로 오인되지 않는다(세션 규칙을 계속 타야 한다)
  assert(asOfTradingDate('2026-07-30 08:51 KST') === null, '3d: 시각 있는 형식은 null');
  assert(tradingDateOf('vix', '2026-07-30 08:51 KST').basis === 'after-close',
    '3d: 시각 있는 형식은 세션 규칙을 탄다');
  // ⭐ TZ 무관 — parseAsOf가 날짜만인 경우 UTC 자정으로 고정한다
  assert(parseAsOf('2026-07-29 (Naver 종가)').toISOString() === '2026-07-29T00:00:00.000Z',
    '3d: ⭐ 날짜만 asOf는 UTC 자정 고정(런타임 TZ에 흔들리지 않음)');
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
  // (a) ⭐ 낡은 history는 **스킵이 아니라 finding**이다(2026-07-30 전환).
  //     종전 baselineTooOld는 벽시계 3일로 스킵해서, 검사가 잡아야 할 파서 동결을 버렸다.
  const oldHist = hist(30, 100, '2026-07-01');   // 마지막 캔들이 2026-07-01
  const r = runRelativeChecks([
    { id: 'nasdaq', price: 24876, as_of: '2026-07-29 (테스트)', history: oldHist }], NOW_CLOSED);
  assert(r.checked === 1, `5: ⭐ 낡은 history도 checked로 센다(검사를 수행했다) (실제 ${r.checked})`);
  assert(r.blocked === 1, `5: ⭐ 그리고 blocked — 파서 동결 증상을 검출한다 (실제 ${r.blocked})`);
  assert(r.findings[0].kind === 'stale-history', `5: kind=stale-history (실제 ${r.findings[0].kind})`);
  assert(r.findings[0].gap >= STALE_TRADING_DAY_GAP, `5: 거래일 갭이 임계 이상 (실제 ${r.findings[0].gap})`);
  assert(r.findings[0].detail.includes('거래일'), '5: 문구가 거래일 기준임을 밝힌다');
  assert(!('stale-baseline' in r.skipReasons), '5: stale-baseline 스킵 사유는 더 이상 없다');

  // ⭐ 연휴 오작동 회귀 — 벽시계로는 3일을 넘지만 거래일 갭은 1(정상 prev-day)
  //    2026-07-16(목) 캔들 + price 거래일 2026-07-20(월). 사이의 07-17은 제헌절 휴장.
  const holiHist = [...hist(29, 100, '2026-07-15'), { date: '2026-07-16', close: 130 }];
  const holi = runRelativeChecks([
    { id: '080220', price: 130, change: 0, as_of: '2026-07-20 (테스트)', history: holiHist }], NOW_CLOSED);
  assert(holi.findings.every(f => f.kind !== 'stale-history'),
    `5: ⭐ 연휴를 건너뛴 1거래일 갭은 stale이 아니다 (실제: ${JSON.stringify(holi.findings)})`);

  // (b) 기준선 없음 — 유일하게 남은 스킵
  const none = runRelativeChecks([{ id: 'nasdaq', price: 24876, history: [] }], NOW_CLOSED);
  assert(none.checked === 0 && none.skipReasons['no-baseline'] === 1, '5: 기준선 없음은 skipped 유지');

  // (c) 장중 — C만 스킵되고 평탄성(일봉 기반)은 그대로 돈다.
  //     ⚠️ 스킵을 **검사 단위**로 세는 이유가 여기다. 항목 단위로 세면 평탄성이 돌았다는
  //     이유로 'C를 못 했다'는 사실이 통째로 사라진다.
  // ⚠️ KR 세션으로는 이 케이스를 만들 수 없다(2026-07-30 강등 후) — KR 항목 중 C가 도는
  //    것은 코스닥 3종뿐이고 그것들은 singleName이라 평탄성에서도 빠진다. 즉 "C만 스킵,
  //    평탄성은 수행"이 성립하는 조합이 KR에는 없다. US 세션 항목으로 검증한다.
  //  ⭐ 2026-07-30 전환: **시계 게이팅을 없앴다.** 장중에도 C가 돈다 — 당일 캔들이 없으면
  //     가격 축이 성립하지 않을 뿐이고 change 축은 그대로 성립한다.
  const open = runRelativeChecks([{ id: 'nasdaq', price: 24829, change: 29,
    as_of: '2026-07-29 (테스트)',
    history: [...hist(29, 24700, '2026-07-28', 10), { date: '2026-07-28', close: 24800 }] }], NOW_US_OPEN);
  assert(!('market-open' in open.skipReasons),
    `5: ⭐ market-open 스킵이 더는 없다 (실제: ${JSON.stringify(open.skipReasons)})`);
  assert(open.checked === 1, '5: 장중에도 검사가 수행된다');

  // (d) 정상 — 폐장 + 신선한 기준선이면 checked
  const good = runRelativeChecks([
    { id: 'nasdaq', price: 24876.91, change: 10, as_of: '2026-07-29 (테스트)',
      history: [...hist(29, 24800), { date: '2026-07-29', close: 24876.91 }] },
  ], NOW_CLOSED);
  assert(good.checked === 1, `5: 폐장+신선 기준선이면 checked (실제 ${good.checked})`);

  // (e) 위반 검출 — history[-1]이 price와 크게 어긋나면 blocked
  const bad = runRelativeChecks([
    { id: 'nasdaq', price: 24876.91, change: 10, as_of: '2026-07-29 (테스트)',
      history: [...hist(29, 24800), { date: '2026-07-29', close: 20000 }] },
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

// ── 8. [B] 승인 조건 회귀 ──────────────────────────────────────
// 1) stale 거래일 갭  2) recalcChange 무변경 + 원본 검사  3) internal-prevclose 미계상
// 4) allBlockedAt 원인 다양성 + source-suspect  5) Redis 스키마·집계 방식 무변경
{
  // ── (1) 거래일 갭 유틸 ─────────────────────────────────────
  assert(STALE_TRADING_DAY_GAP === 2, '8-1: stale 임계 = 거래일 갭 2');
  assert(tradingDaysBetween('2026-07-28', '2026-07-29', 'US') === 1, '8-1: 연속 거래일 갭 1');
  assert(tradingDaysBetween('2026-07-16', '2026-07-20', 'KR') === 1,
    '8-1: 제헌절(07-17)+주말을 건너뛰면 갭 1 — 벽시계 4일이지만 거래일 1');
  assert(tradingDaysBetween('2026-07-16', '2026-07-20', 'US') === 2,
    '8-1: 같은 구간이 US 달력에서는 갭 2(07-17이 US 거래일)');
  assert(tradingDaysBetween('2026-07-29', '2026-07-28', 'US') === null, '8-1: 역순은 null(정렬 이상)');
  assert(holidayKeyOf('US') === 'US' && holidayKeyOf('KR') === 'KR', '8-1: intraday는 휴장일표 사용');
  assert(holidayKeyOf('FX') === null, '8-1: continuous는 휴장일표 없음(주말만)');
  assert(nextTradingDay('2026-07-31', null) === '2026-08-03', '8-1: 금요일 다음 거래일은 월요일');
  // 비일별 항목은 stale 판정에서 제외 — 현재 C 대상에 없지만 규칙으로 먼저 막는다
  const CROSS_ELIGIBLE = Object.entries(ASSET_META)
    .filter(([, m]) => m.cross === 'cross' || m.cross === 'semi').map(([id]) => id);
  for (const id of CROSS_ELIGIBLE) {
    assert(isDailyCadence(id) === true,
      `8-1: C 대상 ${id}는 일별이어야 한다 — 비일별이 편입되면 stale이 상시 오탐이 된다`);
  }

  // ── (2) recalcChange — 발동 시 change 축은 항등 스킵 + 원본 별도 검사 ──
  const base = { id: 'nasdaq', price: 24876.91, change: 0.005, as_of: '2026-07-29 (테스트)', source: 'CNBC',
    history: [...hist(29, 24800), { date: '2026-07-29', close: 24876.91 }] };
  const plain = checkCross(base, NOW_CLOSED);
  assert(plain.axes.some(a => a.checkKind === 'cross-prevclose' && a.state === 'checked'),
    '8-2: 플래그 없으면 change 축이 정상 수행');
  const recalced = checkCross({ ...base, change_recalced: {
    branch: 1, diffPct: 0.001, from: { price: 24876.91, change: 0.005, prev_close: 24876.905 } } }, NOW_CLOSED);
  const skippedAxis = recalced.axes.find(a => a.checkKind === 'cross-prevclose');
  assert(skippedAxis?.state === 'skipped' && skippedAxis.reason === 'recalced',
    `8-2: 재계산 발동 항목의 change 축은 recalced로 스킵 (실제: ${JSON.stringify(skippedAxis)})`);
  assert(recalced.axes.some(a => a.checkKind === 'cross-prevclose-origin' && a.state === 'checked'),
    '8-2: 대신 원본값으로 별도 검사(cross-prevclose-origin)가 만들어진다');
  // 원본 change가 잘못 0이면 원본 검사가 잡는다.
  // ⚠️ 전 거래일 종가를 크게 떼어 놓아야 검출이 성립한다 — change=0이 만드는 오차는
  //    "그 날의 실제 변동폭"이고, 그게 허용(0.5%)보다 작으면 원리적으로 못 잡는다(미커버 ②와 같은 한계).
  const wrongZero = checkCross({ ...base,
    history: [...hist(28, 24000, '2026-07-27'), { date: '2026-07-28', close: 24000 },
              { date: '2026-07-29', close: 24876.91 }],
    change_recalced: {
      branch: 1, diffPct: 0.001, from: { price: 24876.91, change: 0, prev_close: 24876.91 } } }, NOW_CLOSED);
  const origAxis = wrongZero.axes.find(a => a.checkKind === 'cross-prevclose-origin');
  assert(origAxis && origAxis.ok === false,
    `8-2: 원본 change가 0이면 원본 축이 위반으로 잡는다 (실제: ${JSON.stringify(origAxis)})`);

  // ── (3) internal-prevclose — 관측 전용, blocked 미계상 ──────
  // 실측 형상: HYPR item.prev_close 0.92 vs price−change 0.91 (차이 0.01)
  const obs = runRelativeChecks([{ id: 'HYPR', price: 0.89, change: -0.02, prev_close: 0.92,
    as_of: '2026-07-29 (Twelve Data 종가)', source: 'Finnhub',
    history: [...hist(29, 0.8, '2026-07-28', 0.004), { date: '2026-07-29', close: 0.89 }] }], NOW_CLOSED);
  const ip = obs.observations.find(o => o.checkKind === 'internal-prevclose');
  assert(ip && Math.abs(ip.diff - 0.01) < 1e-9,
    `8-3: 내부 불일치 0.01을 관측한다 (실제: ${JSON.stringify(ip)})`);
  assert(ip.observeOnly === true, '8-3: observeOnly 표시');
  assert(obs.blocked === 0, `8-3: blocked에 계상하지 않는다 (실제 ${obs.blocked})`);
  assert(!obs.findings.some(f => f.checkKind === 'internal-prevclose'),
    '8-3: findings에도 섞이지 않는다(별도 observations 배열)');

  // ── (4) 원인 다양성 + source-suspect ────────────────────────
  const sameSrc = runRelativeChecks([
    { id: 'nasdaq', price: 24876.91, change: 10, as_of: '2026-07-29 (t)', source: 'CNBC',
      history: [...hist(29, 24800), { date: '2026-07-29', close: 20000 }] },
    { id: 'dow', price: 51594.14, change: 10, as_of: '2026-07-29 (t)', source: 'CNBC',
      history: [...hist(29, 51000), { date: '2026-07-29', close: 40000 }] },
  ], NOW_CLOSED);
  assert(sameSrc.blocked === 2 && sameSrc.blockDiversity.sources === 1,
    `8-4: 단일 소스 동시 차단 (실제: ${JSON.stringify(sameSrc.blockDiversity)})`);
  assert(sameSrc.blockDiversity.soleSource === 'CNBC', '8-4: soleSource로 벤더를 특정');
  const gate = buildRelativeGuardSource({
    scopes: { relative: { checked: 2, blocked: 2, skipped: 0, skips: {}, reasons: {},
      sourceSuspectAt: '2026-07-30T00:00:00Z', sourceSuspect: 'CNBC', lastBlock: 'nasdaq …' } },
    fields: {},
  });
  assert(gate.verdict === 'source-suspect' && gate.note.includes('CNBC'),
    `8-4: 상태판이 source-suspect로 갈라 표시 (실제: ${gate.verdict} / ${gate.note})`);
  assert(gate.note.includes('게이트 결함이 아니라'), '8-4: 게이트 결함으로 오인하지 않음을 문구로 명시');
  const gateReal = buildRelativeGuardSource({
    scopes: { relative: { checked: 2, blocked: 2, skipped: 0, skips: {}, reasons: {},
      allBlockedAt: '2026-07-30T00:00:00Z', lastBlock: 'x' } }, fields: {},
  });
  assert(gateReal.verdict === 'gate-suspect', '8-4: 원인이 갈리면 여전히 gate-suspect');

  // ── (5) Redis 스키마·집계 방식 무변경 ───────────────────────
  const r5 = runRelativeChecks([
    { id: 'nasdaq', price: 24876.91, change: 10, as_of: '2026-07-29 (t)', source: 'CNBC',
      history: [...hist(29, 24800), { date: '2026-07-29', close: 24876.91 }] },
    { id: 'btc', price: 64379, history: hist(30, 60000) },
  ], NOW_CLOSED);
  for (const k of ['checked', 'blocked', 'skipped']) {
    assert(typeof r5[k] === 'number', `8-5: ${k}는 여전히 number`);
  }
  assert(r5.skipReasons && typeof r5.skipReasons === 'object', '8-5: skipReasons는 여전히 객체');
  // fields 원소 스키마 — persistValidation이 f.field/f.ok/f.reason/f.detail만 읽는다
  const OK_KEYSETS = ['detail,field,ok,reason', 'field,ok,skipped'];
  for (const f of r5.fields) {
    const keys = Object.keys(f).sort().join(',');
    assert(OK_KEYSETS.includes(keys), `8-5: fields 원소 키가 종전과 동일 (실제: ${keys})`);
  }
  // 축 정보는 findings에 추가만 됐다(기존 키 id/kind/detail 유지)
  const bad5 = runRelativeChecks([{ id: 'nasdaq', price: 24876.91, change: 10, as_of: '2026-07-29 (t)',
    source: 'CNBC', history: [...hist(29, 24800), { date: '2026-07-29', close: 20000 }] }], NOW_CLOSED);
  const fnd = bad5.findings[0];
  for (const k of ['id', 'kind', 'detail']) assert(k in fnd, `8-5: findings에 기존 키 ${k} 유지`);
  for (const k of ['checkKind', 'priceDate', 'historyDate', 'priceSource']) {
    assert(k in fnd, `8-5: findings에 ${k} 추가`);
  }
  assert(fnd.detail.includes('양측 불일치'), '8-5: 중립 문구 유지');
  assert(fnd.priceDate === '2026-07-29' && fnd.historyDate === '2026-07-29', '8-5: 날짜 2종이 실려 나온다');
}

// ── 9. recalcChange — 서빙 값·동작 무변경 회귀 ─────────────────
// ⚠️ [B]에서 플래그(change_recalced)를 **추가만** 했다. 아래는 그 추가가 서빙 값이나
//    분기 판단을 건드리지 않았음을 값으로 고정한다. 검사 2a가 이 함수의 발동 여부로
//    change 축 판정을 바꾸므로, 동작이 조용히 달라지면 검사 결과도 조용히 달라진다.
{
  const mk = (over = {}) => ({
    id: 'nasdaq', unit: undefined, price: 24876.91, prev_close: 24876.90,
    change: 0.005, change_pct: 0.0001, direction: 'up',
    history: [{ date: '2026-07-28', close: 24800 }, { date: '2026-07-29', close: 24876.90 }],
    ...over,
  });

  // (a) 조기 반환 3종 — 값·플래그 둘 다 손대지 않는다
  const pct = mk({ unit: 'percent' });
  recalcChange(pct);
  assert(pct.price === 24876.91 && pct.change === 0.005, '9a: unit=percent는 조기 반환(값 불변)');
  assert(pct.change_recalced === undefined, '9a: 조기 반환이면 플래그도 없다');

  const big = mk({ change: 5 });
  recalcChange(big);
  assert(big.price === 24876.91 && big.change === 5, '9a: |change|>0.01은 조기 반환');
  assert(big.change_recalced === undefined, '9a: 플래그 없음');

  const noHist = mk({ history: [{ date: '2026-07-29', close: 24876.90 }] });
  recalcChange(noHist);
  assert(noHist.price === 24876.91 && noHist.change_recalced === undefined, '9a: history<2도 조기 반환');

  // (b) 분기 1 — diffPct < 0.05 → price/prev를 history 값으로 교체
  //     |24876.91 − 24876.90| / 24876.90 × 100 = 0.00004% < 0.05 → 분기 1
  const b1 = mk();
  recalcChange(b1);
  assert(b1.price === 24876.9, `9b: [분기1] price = history[-1] (실제 ${b1.price})`);
  assert(b1.prev_close === 24800, `9b: [분기1] prev_close = history[-2] (실제 ${b1.prev_close})`);
  assert(b1.change === 76.9, `9b: [분기1] change = 24876.9 − 24800 (실제 ${b1.change})`);
  assert(b1.direction === 'up', '9b: [분기1] direction 재산출');
  assert(b1.change_recalced.branch === 1, '9b: [분기1] 플래그 branch=1');
  assert(b1.change_recalced.from.price === 24876.91 && b1.change_recalced.from.change === 0.005,
    '9b: 원본이 덮이기 **전** 값으로 보존된다');
  assert(b1.change_recalced.from.prev_close === 24876.90, '9b: 원본 prev_close도 보존');

  // (c) 분기 2 — diffPct >= 0.05 → price 유지, prev만 history[-1]로
  const b2 = mk({ price: 25000, history: [{ date: '2026-07-28', close: 24800 }, { date: '2026-07-29', close: 24000 }] });
  recalcChange(b2);
  assert(b2.price === 25000, `9c: [분기2] price 유지 (실제 ${b2.price})`);
  assert(b2.prev_close === 24000, `9c: [분기2] prev_close = history[-1] (실제 ${b2.prev_close})`);
  assert(b2.change === 1000, `9c: [분기2] change = 25000 − 24000 (실제 ${b2.change})`);
  assert(b2.change_recalced.branch === 2, '9c: [분기2] 플래그 branch=2');
  assert(b2.change_recalced.from.price === 25000, '9c: 원본 price 보존');

  // (d) 플래그를 제거하면 나머지 필드가 종전 구조와 **정확히 같은 키 집합**인가
  const b3 = mk();
  recalcChange(b3);
  delete b3.change_recalced;
  const expected = Object.keys(mk()).sort().join(',');
  assert(Object.keys(b3).sort().join(',') === expected,
    `9d: 플래그 외에 새 필드가 생기지 않았다 (실제: ${Object.keys(b3).sort().join(',')})`);
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

  // (c) ⭐ history 나이와 **무관하게** 면제되는가 — 기준선을 오늘로 둬 낡음을 배제한다
  const today = new Date().toISOString().slice(0, 10);
  const fresh = Array.from({ length: 24 }, (_, i) => ({
    date: i === 23 ? today : `2025-${String((i % 12) + 1).padStart(2, '0')}-01`, close: 2.75 }));
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
