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
  okByTicks, originOf, alignBySignal,
} from '../api/_lib/relative-guard.js';
import { ASSET_META, isFlatExempt, isDailyCadence } from '../api/_lib/asset-meta.js';
import { readFileSync } from 'node:fs';
import { buildRelativeGuardSource } from '../api/health.js';
import { recalcChange, CNBC_QUOTE } from '../api/_collectors/us-indices.js';

const r2 = n => Math.round(n * 100) / 100;

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
  // ⚠️ as_of를 **시각 형식**으로 준다(2026-07-31 [a] 도입). 날짜만 주면 h1.date와 같아져
  //    circular-asof가 되고, 그때 시계는 항등이라 판정 근거가 되지 못한다. 여기 형상은
  //    h1이 크게 깨져 있어 신호도 서지 않으므로 circular이면 no-independent-axis로 스킵된다
  //    — 그 동작은 10-14가 따로 고정한다. 이 케이스가 검증하려는 것은 '위반 검출'이다.
  //    '2026-07-30 05:30 KST' = 16:30 ET 07-29 → after-close → price 거래일 07-29 = h1.date.
  const bad = runRelativeChecks([
    { id: 'nasdaq', price: 24876.91, change: 10, as_of: '2026-07-30 05:30 KST', prov: { v: 2 },
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
  // prov 도장을 준다 — 없으면 신호 축이 꺼지고, as_of가 날짜만이라 circular까지 겹쳐
  // no-independent-axis로 스킵된다([a], 2026-07-31). 이 절이 보려는 것은 축 구성이다.
  const base = { id: 'nasdaq', price: 24876.91, change: 0.005, as_of: '2026-07-29 (테스트)', source: 'CNBC',
    prov: { v: 2 },
    history: [...hist(29, 24800), { date: '2026-07-29', close: 24876.91 }] };
  const plain = checkCross(base, NOW_CLOSED);
  assert(plain.axes.some(a => a.checkKind === 'cross-prevclose' && a.state === 'checked'),
    '8-2: 플래그 없으면 change 축이 정상 수행');
  // ⚠️ 2026-07-31 설계 변경 — cross-prevclose-origin이라는 **별도 축을 없앴다.**
  //    8b0f452는 재계산 발동 시에만 원본 축을 따로 만들었는데, 그러면 "언제 원본을 쓰는가"가
  //    분기로 흩어져 한쪽만 고치는 실수가 난다(실제로 가격 축은 원본을 쓰지 않고 있었다 —
  //    분기 1은 price도 덮는데). 이제 originOf가 발동 여부와 무관하게 원본을 돌려주므로
  //    축은 cross-prevclose 하나이고 **언제나 원본 좌표**로 계산된다.
  const recalced = checkCross({ ...base, prov: { v: 2 }, change_recalced: {
    branch: 1, diffPct: 0.001, from: { price: 24876.91, change: 0.005, prev_close: 24876.905 } } }, NOW_CLOSED);
  assert(!recalced.axes?.some(a => a.checkKind === 'cross-prevclose-origin'),
    '8-2: cross-prevclose-origin 축은 더 이상 만들지 않는다(원본 사용이 기본이 됨)');
  const changeAxis = recalced.axes.find(a => a.checkKind === 'cross-prevclose');
  assert(changeAxis?.state === 'checked' && changeAxis.observed === 24876.905,
    `8-2: change 축이 **원본 prev_close**로 수행된다 (실제: ${JSON.stringify(changeAxis)})`);
  assert(recalced.recalced === true,
    '8-2: 재계산 발동 사실은 축이 아니라 base.recalced로 남는다');
  // 가격 축도 원본을 쓴다 — 분기 1이 price를 history[-1]로 덮으므로 서빙값을 쓰면 항등이 된다.
  const branch1 = checkCross({ ...base, price: 99999, prov: { v: 2 }, change_recalced: {
    branch: 1, diffPct: 0.001, from: { price: 24876.91, change: 0.005, prev_close: 24876.905 } } }, NOW_CLOSED);
  const priceAxis = branch1.axes.find(a => a.checkKind === 'cross-price');
  assert(priceAxis?.observed === 24876.91,
    `8-2: 가격 축도 원본 price를 쓴다(서빙값 99999가 아니라) (실제: ${JSON.stringify(priceAxis)})`);

  // ── (3) internal-prevclose — 관측 전용, blocked 미계상 ──────
  // 실측 형상: HYPR item.prev_close 0.92 vs price−change 0.91 (차이 0.01)
  const obs = runRelativeChecks([{ id: 'HYPR', price: 0.89, change: -0.02, prev_close: 0.92,
    as_of: '2026-07-29 (Twelve Data 종가)', source: 'Finnhub', prov: { v: 2 },
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
    { id: 'nasdaq', price: 24876.91, change: 10, as_of: '2026-07-30 05:30 KST', prov: { v: 2 }, source: 'CNBC',
      history: [...hist(29, 24800), { date: '2026-07-29', close: 20000 }] },
    { id: 'dow', price: 51594.14, change: 10, as_of: '2026-07-30 05:30 KST', prov: { v: 2 }, source: 'CNBC',
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
    { id: 'nasdaq', price: 24876.91, change: 10, as_of: '2026-07-30 05:30 KST', prov: { v: 2 }, source: 'CNBC',
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
  const bad5 = runRelativeChecks([{ id: 'nasdaq', price: 24876.91, change: 10,
    as_of: '2026-07-30 05:30 KST', prov: { v: 2 },
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

// ── 10. 데이터 신호 정렬 — 2026-07-30 revert의 회귀 고정 ────────────────
// ⚠️ 이 절의 케이스는 **전부 현행(4b94b31) 코드로는 실패한다.** 그게 요건이다 —
//    통과하는 테스트를 추가하는 건 회귀 고정이 아니다.
{
  // 프로덕션 실측값. [저장소:9072dee8:lastgood:market:* @2026-07-31T02:0xZ]
  const CLOSES = {
    nasdaq: { d28: 24876.91, d29: 24442.94 }, dow: { d28: 52747.32, d29: 51594.14 },
    sp500:  { d28: 7428.78,  d29: 7316.15 },  sox: { d28: 11035.68, d29: 10447.49 },
    vix:    { d28: 18.21,    d29: 20.66 },
  };
  // 기록된 오탐 잔차. [저장소:9072dee8:health:validate:fields:relative
  //                    @2026-07-30T08:55:26.056Z] detail의 '[cross-prevclose-origin] N%'
  const RECORDED = { nasdaq: 1.775, dow: 2.235, sp500: 1.539, sox: 5.630, vix: 11.859 };
  const PREMARKET_ASOF = '2026-07-30 17:55 KST';   // = 04:55 ET 07-30, 프리마켓 창 안

  // 그 회차의 아이템 형상 — CNBC가 개장 전이라 change=0을 주고 recalcChange 분기1이 발동해
  // price/prev_close가 history 값으로 덮인 상태(서빙값)에 원본이 함께 실려 있다.
  const premarketItem = (id) => {
    const { d28, d29 } = CLOSES[id];
    return {
      id, price: d29, prev_close: d28, change: r2(d29 - d28), source: 'CNBC',
      as_of: PREMARKET_ASOF, quoteWindow: 'extended', prov: { v: 2 },
      change_recalced: { branch: 1, diffPct: 0, from: { price: d29, prev_close: d29, change: 0 } },
      history: [{ date: '2026-07-28', close: d28 }, { date: '2026-07-29', close: d29 }],
    };
  };

  // ── (1) 오탐 5건이 각각 소멸한다 ─────────────────────────────────────
  for (const id of Object.keys(CLOSES)) {
    const c = checkCross(premarketItem(id), new Date('2026-07-30T08:55:26.056Z'));
    assert(c.alignment === 'prev-day', `10-1: ${id} 프리마켓 회차는 prev-day (실제: ${c.alignment}/${c.alignBasis})`);
    assert(c.state === 'checked' && c.axes.every(a => a.state !== 'checked' || a.ok),
      `10-1: ${id} 위반 0건 — 기록된 ${RECORDED[id]}% 오탐 소멸 (실제: ${JSON.stringify(c.axes)})`);
    const ax = c.axes.find(a => a.checkKind === 'cross-prevclose');
    assert(ax && ax.residual === 0,
      `10-1: ${id} change 축 잔차 0 (h[-1]과 대조) (실제: ${ax?.residual})`);
    assert(!c.axes.some(a => a.checkKind === 'cross-price'),
      `10-1: ${id} prev-day이므로 가격 축은 만들지 않는다(당일 캔들 부재가 정상)`);
  }

  // ── (2) exthrs 축이 없으면 시계가 하루 어긋난다(revert 원인의 직접 고정) ──
  const noExt = checkCross({ ...premarketItem('nasdaq'), quoteWindow: 'regular' },
    new Date('2026-07-30T08:55:26.056Z'));
  assert(noExt.clockAlignment === 'same-day' && noExt.signalAlignment === 'prev-day',
    `10-2: exthrs 없으면 시계는 same-day로 어긋난다 (실제 시계 ${noExt.clockAlignment}/신호 ${noExt.signalAlignment})`);
  assert(noExt.state === 'skipped' && noExt.reason === 'alignment-ambiguous',
    `10-2: 어긋나면 통과도 위반도 아닌 ambiguous (실제: ${noExt.state}/${noExt.reason})`);
  assert(tradingDateOf('nasdaq', PREMARKET_ASOF, { extendedHours: true }).basis === 'pre-open+exthrs',
    '10-2: 확장시간이면 pre-open이 당일로 롤된다');
  assert(tradingDateOf('nasdaq', PREMARKET_ASOF, { extendedHours: true }).date === '2026-07-30'
      && tradingDateOf('nasdaq', PREMARKET_ASOF).date === '2026-07-29',
    '10-2: 같은 시각이 exthrs 유무로 하루 갈린다');

  // ── (3) vix 필수 픽스처 ──────────────────────────────────────────────
  // [저장소:9072dee8:lastgood:market:vix @2026-07-30T22:52:55.530Z]
  //   price 17.09 / prev_close 20.66 / history[-1] 2026-07-29 20.66 (07-30 캔들 미도착)
  // 이 회차가 vix:consec을 4까지 올린 20.889% 위반의 실체다. 라이브에서는 07-31T00:29:59Z에
  // Naver가 07-30 캔들을 올려 사라졌으므로 **픽스처로 동결**한다.
  const vixFix = {
    id: 'vix', price: 17.09, prev_close: 20.66, change: -3.57, source: 'CNBC',
    as_of: '2026-07-31 07:52 KST', quoteWindow: 'extended', prov: { v: 2 },
    history: [{ date: '2026-07-28', close: 18.21 }, { date: '2026-07-29', close: 20.66 }],
  };
  const vc = checkCross(vixFix, new Date('2026-07-30T22:52:55.542Z'));
  assert(vc.alignment === 'prev-day' && vc.signalAlignment === 'prev-day' && vc.clockAlignment === 'prev-day',
    `10-3: vix 픽스처는 신호·시계 합의 prev-day (실제: ${vc.alignBasis})`);
  assert(vc.axes.find(a => a.checkKind === 'cross-prevclose')?.residual === 0,
    '10-3: change 축 잔차 0 — 20.889% 위반 소멸');
  assert(!vc.recalced, '10-3: |change|=3.57 > 0.01이라 recalcChange는 발동하지 않았다');

  // ── (4) prev-day 우선 순서 — 뒤집으면 오탐 5건이 부활한다 ────────────
  // 축퇴(change≈0)에서 same-day를 택하면 change 축이 history[-2]와 대조돼 기록된 잔차가
  // 그대로 재현된다. 순서는 스타일이 아니라 **결과를 바꾸는 규칙**이다.
  for (const id of Object.keys(CLOSES)) {
    const { d28, d29 } = CLOSES[id];
    const sig = alignBySignal({ price: d29, prevClose: d29, provenance: 'stamped' },
      { date: '2026-07-29', close: d29 }, ASSET_META[id].quantum ?? 0.01);
    assert(sig.alignment === 'prev-day' && sig.degenerate === true,
      `10-4: ${id} 축퇴에서 prev-day를 택한다 (실제: ${sig.alignment})`);
    // 반증 — same-day를 택했다면 얼마가 나왔을지 계산해 기록값과 대조한다.
    const wouldBe = Math.abs(d28 - d29) / Math.abs(d29) * 100;
    assert(Math.abs(wouldBe - RECORDED[id]) < 0.001,
      `10-4: [반증] same-day였다면 기록된 ${RECORDED[id]}%가 재현된다 (계산 ${wouldBe.toFixed(3)})`);
  }

  // ── (5) HYPR 부동소수 경계 — 양자 정수 비교 ──────────────────────────
  // [저장소:9072dee8:health:validate:fields:relative@2026-07-30T22:52:55.542Z]
  //   HYPR '양측 불일치 1.075% > 허용 1.075%' — 같은 값인데 위반으로 기록됐다.
  assert(Math.abs(0.92 - 0.93) !== 0.01, '10-5: 전제 — 0.92−0.93은 정확한 0.01이 아니다');
  const relOld = Math.abs(0.92 - 0.93) / 0.93, tolOld = Math.max(0.002, 0.01 / 0.93);
  assert(relOld > tolOld && relOld - tolOld < 1e-16,
    '10-5: 전제 — 실수 비교로는 1e-17 차이로 경계가 뒤집힌다');
  const tick = okByTicks(0.92 - 0.93, 0.01, 1, 0.93, 0.002);
  assert(tick.ok === true && tick.ticks === 1 && tick.via === 'quanta',
    `10-5: 양자 정수 비교는 1틱 ≤ 1틱으로 통과 (실제: ${JSON.stringify(tick)})`);
  // 통합 경로 — 실제 아이템으로도 통과해야 한다.
  // ⚠️ as_of를 **시각 형식**으로 준다. 날짜만이면 circular이 되어 시계가 기권하는데,
  //    price가 h1에서 1양자 떨어져 있으면 신호도 서지 않아 no-independent-axis로 빠진다
  //    (=가격 축이 아예 안 만들어져 이 절이 검증하려는 경계를 못 본다).
  //    '2026-07-31 05:30 KST' = 16:30 ET 07-30 → after-close → price 거래일 07-30 = h1.date.
  const hyprAt = new Date('2026-07-30T20:30:00Z');   // 16:30 ET 07-30, US 폐장 직후
  const hyprFix = checkCross({ id: 'HYPR', price: 0.93, prev_close: 0.91, change: 0.02,
    source: 'Finnhub', as_of: '2026-07-31 05:30 KST', prov: { v: 2 },
    history: [{ date: '2026-07-29', close: 0.91 }, { date: '2026-07-30', close: 0.92 }] }, hyprAt);
  assert(hyprFix.alignment === 'same-day',
    `10-5: 시계 단독으로 same-day (실제: ${hyprFix.alignment}/${hyprFix.alignBasis})`);
  assert(hyprFix.axes.every(a => a.state !== 'checked' || a.ok),
    `10-5: HYPR 1양자 차이는 위반이 아니다 (실제: ${JSON.stringify(hyprFix.axes)})`);
  assert(hyprFix.axes.find(a => a.checkKind === 'cross-price')?.ticks === 1,
    '10-5: 가격 축이 정확히 1틱으로 계산된다');
  // 반증 — 2양자를 넘기면 가격 축이 잡아야 한다(경계 완화가 검사를 죽이지 않았는가)
  const hyprBad = checkCross({ id: 'HYPR', price: 0.93, prev_close: 0.91, change: 0.02,
    source: 'Finnhub', as_of: '2026-07-31 05:30 KST', prov: { v: 2 },
    history: [{ date: '2026-07-29', close: 0.91 }, { date: '2026-07-30', close: 0.80 }] }, hyprAt);
  assert(hyprBad.axes.some(a => a.checkKind === 'cross-price' && a.ok === false),
    `10-5: [반증] 13틱 차이는 여전히 위반 (실제: ${JSON.stringify(hyprBad.axes)})`);

  // ── (6) change=0 축퇴 4조합 — 어느 것도 위반이 아니다 ────────────────
  const degen = (P, V, H1, H2) => checkCross({ id: 'nasdaq', price: P, prev_close: V, change: P - V,
    source: 'CNBC', as_of: '2026-07-30 (테스트)', prov: { v: 2 },
    history: [{ date: '2026-07-29', close: H2 }, { date: '2026-07-30', close: H1 }] }, NOW_CLOSED);
  for (const [label, P, V, H1, H2, wantAlign] of [
    ['P=V=H1, H2 다름(개장 전 미변동)', 100, 100, 100, 99, 'prev-day'],
    ['P=V=H1=H2(완전 평탄)',            100, 100, 100, 100, 'prev-day'],
    ['P=H1, V=H2(정상 same-day)',       101, 100, 101, 100, 'same-day'],
    ['V=H1, P 다름(정상 prev-day)',     103, 100, 100,  99, 'prev-day'],
  ]) {
    const d = degen(P, V, H1, H2);
    assert(d.alignment === wantAlign, `10-6: ${label} → ${wantAlign} (실제: ${d.alignment}/${d.alignBasis})`);
    assert(d.state !== 'skipped' && d.axes.every(a => a.state !== 'checked' || a.ok),
      `10-6: ${label} 위반 0건 (실제: ${JSON.stringify(d.axes)})`);
  }

  // ── (7) 출처 도장 — 없으면 신호를 끄고 시계로 돈다 ───────────────────
  // ⚠️ as_of를 시각 형식으로 준다 — 날짜만 주면 h1.date와 같아져 circular-asof로 빠지고
  //    시계 축이 기권해 이 절이 검증하려는 '두 축 합의'가 성립하지 않는다.
  const legacyItem = { id: 'nasdaq', price: 100, prev_close: 99, change: 1, source: 'CNBC',
    as_of: '2026-07-31 05:30 KST',   // = 16:30 ET 07-30, 폐장 직후 → 거래일 07-30
    history: [{ date: '2026-07-29', close: 99 }, { date: '2026-07-30', close: 100 }] };
  const lg = checkCross(legacyItem, NOW_CLOSED);
  assert(lg.provenance === 'legacy' && lg.signalAlignment === 'unknown',
    `10-7: prov 없으면 신호 축을 끈다 (실제: ${lg.provenance}/${lg.signalAlignment})`);
  assert(lg.alignBasis.startsWith('clock-only') && lg.alignment === 'same-day',
    `10-7: 시계 단독으로 판정한다(종전 동작 유지) (실제: ${lg.alignBasis})`);
  const stamped = checkCross({ ...legacyItem, prov: { v: 2 } }, NOW_CLOSED);
  assert(stamped.provenance === 'stamped' && stamped.alignBasis.startsWith('agree'),
    `10-7: 도장이 있으면 두 축 합의로 간다 (실제: ${stamped.alignBasis})`);
  // 집계 — prov-legacy는 스킵이 아니라 counters로 센다(skipped 오염 방지)
  const lgAgg = runRelativeChecks([legacyItem], NOW_CLOSED);
  assert(lgAgg.counters['prov-legacy'] === 1,
    `10-7: prov-legacy를 counters로 센다 (실제: ${JSON.stringify(lgAgg.counters)})`);
  assert(!Object.keys(lgAgg.skipReasons).some(k => k.includes('prov')),
    '10-7: skipReasons에는 넣지 않는다 — 검사는 시계 폴백으로 성립했다');
  assert(lgAgg.checked === 1, '10-7: 구버전 스냅샷도 검사는 수행된다');

  // ── (8) originOf — 두 분기 모두에서 원본을 복원한다 ──────────────────
  const o1 = originOf({ price: 100, prev_close: 99, change: 1, prov: { v: 2 },
    change_recalced: { branch: 1, from: { price: 24876.91, prev_close: 24800, change: 0 } } });
  assert(o1.price === 24876.91 && o1.prevClose === 24800 && o1.recalced === true,
    `10-8: 분기1 원본 복원 (실제: ${JSON.stringify(o1)})`);
  const o2 = originOf({ price: 100, prev_close: 99, change: 1, prov: { v: 2 },
    change_recalced: { branch: 2, from: { price: 100, prev_close: 98.5, change: 0.004 } } });
  assert(o2.price === 100 && o2.prevClose === 98.5,
    `10-8: 분기2 원본 복원 (실제: ${JSON.stringify(o2)})`);
  // from.prev_close가 없는 형상(구 스키마)에서는 price − change로 파생한다
  const o3 = originOf({ prov: { v: 2 }, change_recalced: { branch: 1, from: { price: 50, change: 2 } } });
  assert(o3.prevClose === 48, `10-8: from.prev_close 부재 시 price−change 파생 (실제: ${o3.prevClose})`);
  const o4 = originOf({ price: 10, prev_close: 9, change: 1, prov: { v: 2 } });
  assert(o4.price === 10 && o4.prevClose === 9 && o4.recalced === false && o4.provenance === 'stamped',
    '10-8: 미발동이면 서빙값이 곧 원본');

  // ── (9) us10y — 신호·시계 불일치는 ambiguous(신규 오탐 방지) ─────────
  // [저장소:9072dee8:lastgood:market:us10y @2026-07-31T00:29:59Z]
  //   price 4.67 / prev_close 4.66 / h[-1] 07-30 4.67 / h[-2] 07-29 4.62
  //   금리가 17:00 ET 롤을 넘어 안 움직여 price==h[-1]이 **우연히** 성립한다.
  //   신호만 믿으면 same-day → change 축 |4.62−4.66|/4.66 = 0.858% > 0.5% 신규 오탐이었다.
  const u = checkCross({ id: 'us10y', price: 4.67, prev_close: 4.66, change: 0.004,
    source: 'CNBC', as_of: '2026-07-31 09:29 KST', quoteWindow: 'extended', prov: { v: 2 },
    history: [{ date: '2026-07-29', close: 4.62 }, { date: '2026-07-30', close: 4.67 }] },
    new Date('2026-07-31T00:29:59.553Z'));
  assert(u.signalAlignment === 'same-day' && u.clockAlignment === 'prev-day',
    `10-9: us10y는 신호 same-day ↔ 시계 prev-day로 갈린다 (실제: ${u.signalAlignment}/${u.clockAlignment})`);
  assert(u.state === 'skipped' && u.reason === 'alignment-ambiguous',
    `10-9: 갈리면 축을 만들지 않는다 — 0.858% 신규 오탐 방지 (실제: ${u.state}/${u.reason})`);

  // ── (10) dxy — 신호가 없으면 시계(17:00 ET 롤)가 구한다 ──────────────
  // [저장소:9072dee8:lastgood:market:dxy @2026-07-31T00:29:59Z]
  //   price 100.08 / prev_close 99.86 / h[-1] 07-30 99.72 — 양쪽 다 h1과 불일치
  const dx = checkCross({ id: 'dxy', price: 100.08, prev_close: 99.86, change: 0.21,
    source: 'CNBC', as_of: '2026-07-31 09:29 KST', quoteWindow: 'extended', prov: { v: 2 },
    history: [{ date: '2026-07-29', close: 100.72 }, { date: '2026-07-30', close: 99.72 }] },
    new Date('2026-07-31T00:29:59.553Z'));
  assert(dx.signalAlignment === 'unknown' && dx.alignment === 'prev-day',
    `10-10: 신호 없으면 시계 단독으로 prev-day (실제: ${dx.signalAlignment}/${dx.alignment})`);
  assert(dx.state === 'checked' && dx.axes.every(a => a.state !== 'checked' || a.ok),
    `10-10: dxy는 통과한다 — 종전 market-open 스킵이던 구간의 커버리지 획득 (실제: ${JSON.stringify(dx.axes)})`);

  // ── (11) kr_base_rate — 비일별은 stale-history에 도달하지 않는다 ─────
  assert(isDailyCadence('kr_base_rate') === false, '10-11: kr_base_rate는 비일별');
  assert(ASSET_META.kr_base_rate.cross === 'tauto', '10-11: tauto라 checkCross 최상단에서 조기반환');
  const kb = checkCross({ id: 'kr_base_rate', price: 2.75, prev_close: 2.75, change: 0, prov: { v: 2 },
    as_of: '2026-07-28 (한국은행)',
    history: [{ date: '2026-06-30', close: 2.5 }, { date: '2026-07-28', close: 2.75 }] }, NOW_CLOSED);
  assert(kb.state === 'skipped' && kb.reason === 'tauto',
    `10-11: 갭이 크게 벌어져도 finding이 되지 않는다 (실제: ${kb.state}/${kb.reason})`);
  // 이중 방어 — tauto가 아니었더라도 비일별이라 stale에서 빠진다
  const monthlyStale = checkCross({ id: 'nasdaq', price: 100, prev_close: 99, change: 1, prov: { v: 2 },
    as_of: '2026-07-30 (테스트)', source: 'CNBC',
    history: [{ date: '2026-06-30', close: 90 }, { date: '2026-07-01', close: 91 }] }, NOW_CLOSED);
  assert(monthlyStale.alignment === 'stale' || monthlyStale.state === 'skipped',
    '10-11: [대조군] 일별 항목은 같은 갭에서 stale로 간다');

  // ── (12) 스키마 — 기존 키는 그대로, counters만 추가 ──────────────────
  const agg = runRelativeChecks([premarketItem('nasdaq'), vixFix], new Date('2026-07-30T08:55:26.056Z'));
  for (const k of ['checked', 'blocked', 'skipped']) {
    assert(typeof agg[k] === 'number', `10-12: ${k}는 number 유지`);
  }
  assert(agg.skipReasons && typeof agg.skipReasons === 'object', '10-12: skipReasons 객체 유지');
  assert(agg.counters && typeof agg.counters === 'object', '10-12: counters 추가');
  assert(Array.isArray(agg.findings) && Array.isArray(agg.fields), '10-12: findings/fields 배열 유지');
  for (const f of agg.fields) {
    assert(['field', 'ok', 'reason', 'detail', 'skipped'].some(k => k in f), '10-12: fields 원소 키 집합 유지');
  }
  // counters 코드에 콜론이 없어야 한다 — health.sanitizeCode가 제거해 키가 뭉개진다
  assert(Object.keys(agg.counters).every(k => !k.includes(':')),
    `10-12: counters 코드에 ':' 금지 (실제: ${Object.keys(agg.counters)})`);

  // ── (13) 소스 설정에서 exthrs 파생 — URL 하드코딩이 다시 생기지 않게 ──
  assert(CNBC_QUOTE.extendedHours === true, '10-13: CNBC_QUOTE가 확장시간 여부를 갖는다');
  // ⚠️ 여기서는 주석을 걷어내지 않는다. us-indices.js에 Accept 헤더 'text/html,…,*/*'가 있어
  //    블록주석 제거 정규식이 그 안의 '/*'를 여는 주석으로 읽고 파일 절반을 먹는다
  //    (7d 주석이 경고한 것과 같은 함정 — 원문 검사가 안전한 경우엔 원문을 본다).
  //    아래 두 패턴은 이 파일의 설명 주석과 겹치지 않는다(주석은 'exthrs=1'로 적혀 있다).
  const usiSrc = readFileSync(new URL('../api/_collectors/us-indices.js', import.meta.url), 'utf8');
  assert(!/exthrs:\s*'1'/.test(usiSrc),
    '10-13: exthrs를 URL에 직접 박지 않는다(CNBC_QUOTE에서 파생)');
  assert(/quoteWindow:\s*CNBC_QUOTE\.extendedHours/.test(usiSrc),
    '10-13: 아이템의 quoteWindow가 같은 상수에서 파생된다');
}

// ── 11. [b] 진행 중 캔들 + [a] 순환 시계 결정권 박탈 ────────────────────
// 2026-07-31 04:27:34Z 회차에서 419530이 낸 신규 오탐의 회귀 고정.
// ⚠️ 우선순위: intraday 판정([b])이 축 선택([a])보다 **먼저**다. 전자는 데이터의 사실
//    상태이고 후자는 그 상태가 아닐 때의 축 선택 규칙이다.
{
  // KR 장중 — 2026-07-31(금) 13:47 KST = 04:47 UTC. KR 세션 09:00~15:30 안.
  const KR_OPEN = new Date('2026-07-31T04:47:00Z');
  // [저장소:9072dee8:lastgood:market:419530@2026-07-31T04:27:34Z] 실측 형상
  const kr = (id, price, prevClose, h1c, h2c) => ({
    id, price, prev_close: prevClose, change: price - prevClose, source: 'Naver',
    as_of: '2026-07-31 (Naver 종가)', prov: { v: 2 },
    history: [{ date: '2026-07-30', close: h2c }, { date: '2026-07-31', close: h1c }],
  });

  // ── (1) 419530 실측 픽스처 — intraday로 잡히고 오탐이 사라진다 ────────
  const c419 = checkCross(kr('419530', 26200, 24500, 26300, 24500), KR_OPEN);
  assert(c419.alignment === 'intraday' && c419.alignBasis === 'session-open+today-candle',
    `11-1: 419530은 intraday (실제: ${c419.alignment}/${c419.alignBasis})`);
  const px419 = c419.observations.find(o => o.checkKind === 'cross-price');
  assert(px419 && px419.observeOnly === true && px419.ticks === 100,
    `11-1: 가격 축은 관측 전용 100틱 (실제: ${JSON.stringify(px419)})`);
  assert(Math.abs(px419.residual * 100 - 0.382) < 0.001,
    `11-1: 관측된 잔차가 실측 0.382% (실제: ${(px419.residual * 100).toFixed(3)})`);
  assert(!c419.axes.some(a => a.checkKind === 'cross-price'),
    '11-1: 가격 축은 axes(판정 대상)에 들어가지 않는다');
  const pv419 = c419.axes.find(a => a.checkKind === 'cross-prevclose');
  assert(pv419 && pv419.state === 'checked' && pv419.residual === 0 && pv419.ok,
    `11-1: change 축은 h[-2] 대조로 판정, 잔차 0 (실제: ${JSON.stringify(pv419)})`);
  // 집계 — blocked에 계상되지 않는다
  const agg419 = runRelativeChecks([kr('419530', 26200, 24500, 26300, 24500)], KR_OPEN);
  assert(agg419.blocked === 0 && agg419.checked === 1,
    `11-1: blocked 0 / checked 1 (실제 blocked=${agg419.blocked} checked=${agg419.checked})`);
  assert(agg419.observations.some(o => o.checkKind === 'cross-price' && o.id === '419530'),
    '11-1: 관측은 observations로 남는다');

  // ── (2) 같은 회차 대조군 무영향 ──────────────────────────────────────
  for (const [id, p, v, h1c, h2c] of [['028300', 30500, 29950, 30500, 29950],
                                      ['080220', 63200, 50100, 63200, 50100]]) {
    const c = checkCross(kr(id, p, v, h1c, h2c), KR_OPEN);
    assert(c.alignment === 'intraday', `11-2: ${id}도 intraday (실제: ${c.alignment})`);
    assert(c.axes.every(a => a.state !== 'checked' || a.ok), `11-2: ${id} 위반 없음`);
    assert(c.observations.find(o => o.checkKind === 'cross-price')?.residual === 0,
      `11-2: ${id} 관측 잔차 0`);
  }
  // HYPR — US 폐장 중이고 h1이 어제라 intraday가 아니다(영향 없음)
  const hy = checkCross({ id: 'HYPR', price: 0.93, prev_close: 0.89, change: 0.04, source: 'Finnhub',
    as_of: '2026-07-30 (Twelve Data 종가)', prov: { v: 2 },
    history: [{ date: '2026-07-29', close: 0.89 }, { date: '2026-07-30', close: 0.93 }] }, KR_OPEN);
  assert(hy.alignment === 'same-day' && hy.alignBasis === 'signal-only:no-clock',
    `11-2: HYPR은 intraday가 아니고 신호 단독 same-day (실제: ${hy.alignment}/${hy.alignBasis})`);
  assert(hy.axes.every(a => a.state !== 'checked' || a.ok), '11-2: HYPR 위반 없음');

  // ── (3) [a] 순환 시계는 신호가 없어도 판정 근거가 못 된다 ─────────────
  // 세션 밖(KR 폐장) + circular + 신호 없음 → no-independent-axis
  const KR_CLOSED = new Date('2026-07-31T09:00:00Z');   // 18:00 KST 금 — KR 폐장
  const noAxis = checkCross(kr('419530', 26200, 24500, 26300, 24500), KR_CLOSED);
  assert(noAxis.state === 'skipped' && noAxis.reason === 'no-independent-axis',
    `11-3: 세션 밖 circular+신호부재는 no-independent-axis (실제: ${noAxis.state}/${noAxis.reason})`);
  assert(noAxis.circularAsOf === true && noAxis.signalAlignment === 'unknown',
    '11-3: 사유가 순환+신호부재임을 필드로 남긴다');
  // 신호가 서면 순환이어도 판정한다(028300 형상)
  const okSig = checkCross(kr('028300', 30500, 29950, 30500, 29950), KR_CLOSED);
  assert(okSig.alignment === 'same-day' && okSig.alignBasis === 'signal-only:no-clock',
    `11-3: 신호가 서면 시계 없이 판정 (실제: ${okSig.alignment}/${okSig.alignBasis})`);
  // 집계 사유 코드
  const aggNo = runRelativeChecks([kr('419530', 26200, 24500, 26300, 24500)], KR_CLOSED);
  assert(aggNo.skipReasons['no-independent-axis'] === 1,
    `11-3: skipReasons에 계상 (실제: ${JSON.stringify(aggNo.skipReasons)})`);

  // ── (4) intraday 제외 조건 3종 ───────────────────────────────────────
  // CRYPTO — always-open이라 조건이 영구 참이 되는 것을 막는다(등급이 바뀌어도)
  assert(isIntradayExcluded('btc'), '11-4: CRYPTO는 intraday 대상이 아니다(세션 kind)');
  // FX — continuous. 17:00 ET 롤 회귀(3b)가 intraday로 뒤집히면 안 된다
  assert(isIntradayExcluded('us10y') && isIntradayExcluded('dxy'),
    '11-4: FX(continuous)도 intraday 대상이 아니다');
  // stale 아이템 — price가 실시간이 아니므로 '진행 중'이 성립하지 않는다
  const st = checkCross({ ...kr('419530', 26200, 24500, 26300, 24500), stale: true }, KR_OPEN);
  assert(st.alignment !== 'intraday',
    `11-4: stale 아이템은 intraday가 아니다 (실제: ${st.alignment})`);

  // ── (5) US 지수·vix 현행 유지 — [b][a]가 건드리지 않는다 ──────────────
  // 2026-07-31T04:27:34Z 회차 실측 형상(US 폐장·pre-open, h1=07-30)
  const usAt = new Date('2026-07-31T04:27:34.866Z');
  const us = (id, price, prevClose, h1c, h2c, recalc) => ({
    id, price, prev_close: prevClose, change: price - prevClose, source: 'CNBC',
    as_of: '2026-07-31 13:27 KST', quoteWindow: 'extended', prov: { v: 2 },
    ...(recalc ? { change_recalced: { branch: 1, diffPct: 0, from: { price: h1c, prev_close: h1c, change: 0 } } } : {}),
    history: [{ date: '2026-07-29', close: h2c }, { date: '2026-07-30', close: h1c }],
  });
  const nq = checkCross(us('nasdaq', 25122.18, 24442.94, 25122.18, 24442.94, true), usAt);
  assert(nq.alignment === 'prev-day' && nq.alignBasis === 'agree:prevclose==h1',
    `11-5: nasdaq 현행 유지 prev-day (실제: ${nq.alignment}/${nq.alignBasis})`);
  assert(nq.axes.every(a => a.state !== 'checked' || a.ok), '11-5: nasdaq 위반 없음');
  const vx = checkCross(us('vix', 17.09, 20.66, 17.09, 20.66, false), usAt);
  assert(vx.state === 'skipped' && vx.reason === 'alignment-ambiguous',
    `11-5: vix 현행 유지 ambiguous (실제: ${vx.state}/${vx.reason})`);
}

/** 그 항목이 세션 종류상 intraday 판정 대상에서 빠지는가(테스트 전용 파생). */
function isIntradayExcluded(id) {
  const m = ASSET_META[id];
  return m.market === 'CRYPTO' || m.market === 'FX';
}

// ── 12. 정렬 분류 분기 픽스처 (A~F) ────────────────────────────────────
// ⚠️ **이 절은 "분기가 죽어 있는가"만 배제한다. 프로덕션 거동을 증명하지 못한다.**
//    [b] intraday는 KR 장중(09:00~15:30 KST)에만 성립하는데 그 창에서 판별력 있는
//    회차(price ≠ h[-1])를 아직 실측하지 못했다 — 2026-07-31 두 번의 수집 모두
//    price == h[-1]이라 구·신 코드가 같은 결과를 냈다. 다음 창은 월요일이다.
//    픽스처가 통과한다고 프로덕션에서 그렇게 돈다는 뜻이 아니다.
{
  const ID = '419530';                       // semi, quantum 1, market KR
  const BASE = 26200;
  // ⚠️ 경계값은 **코드에서 파생**한다. 0.002를 테스트에 하드코딩하면 floor가 바뀌어도
  //    테스트가 조용히 옛 값을 고정한다.
  const TOL = crossTolerance(ID, BASE, 1);
  assert(TOL > 0 && Number.isFinite(TOL), '12: 경계값을 코드에서 읽어온다');

  const KR_OPEN  = new Date('2026-07-31T04:47:00Z');  // 13:47 KST 금 — KR 장중
  const KR_AFTER = new Date('2026-07-31T06:34:00Z');  // 15:34 KST 금 — KR 마감 후
  assert(isMarketClosed('KR', KR_OPEN).closed === false, '12: KR_OPEN은 장중');
  assert(isMarketClosed('KR', KR_AFTER).closed === true, '12: KR_AFTER는 폐장');

  // ⚠️ recalcChange 함정: 분기1이 item.prev_close를 h[-2].close로 덮는다. 정렬 신호는
  //    반드시 **원본**(change_recalced.from)을 읽어야 하므로, recalced 픽스처는 서빙
  //    필드에 덮인 값을, from에 원본을 싣어 실제 형상을 그대로 재현한다.
  const mk = ({ price, prevClose, h1c, h2c, asOf, recalced }) => ({
    id: ID, source: 'Naver', prov: { v: 2 },
    price: recalced ? h1c : price,
    prev_close: recalced ? h2c : prevClose,
    change: (recalced ? h1c : price) - (recalced ? h2c : prevClose),
    ...(asOf !== undefined ? { as_of: asOf } : {}),
    ...(recalced ? { change_recalced: { branch: 1, diffPct: 0,
      from: { price, prev_close: prevClose, change: price - prevClose } } } : {}),
    history: [{ date: '2026-07-30', close: h2c }, { date: '2026-07-31', close: h1c }],
  });
  const ASOF_KR = '2026-07-31 (Naver 종가)';
  const gap = (p, h) => Math.abs(h - p) / Math.abs(p);

  // A. intraday 정상 발동 — 괴리가 임계를 넘는다
  const A = checkCross(mk({ price: 26200, prevClose: 24500, h1c: 26300, h2c: 24500, asOf: ASOF_KR }), KR_OPEN);
  assert(gap(26200, 26300) > TOL, 'A: 전제 — 괴리가 임계를 넘는다');
  assert(A.alignment === 'intraday' && A.alignBasis === 'session-open+today-candle',
    `A: intraday 발동 (실제: ${A.alignment}/${A.alignBasis})`);
  assert(A.observations.find(o => o.checkKind === 'cross-price')?.observeOnly === true,
    'A: 가격 축은 관측 전용');
  assert(A.axes.find(a => a.checkKind === 'cross-prevclose')?.ok === true,
    'A: change 축은 h[-2] 대조로 판정·통과');

  // B. 괴리 임계 미달 — **분류는 A와 같다**
  // ⚠️ 이 케이스는 "괴리 크기가 분류에 영향을 주지 않음"을 고정하는 회귀다.
  //    isIntradayCandle의 조건은 세션 open + h1.date == 당일 거래일 + not stale뿐이고
  //    괴리를 보지 않는다. 괴리로 분류를 가르면 "많이 벌어졌을 때만 관측으로 빼는" 셈이
  //    되어 오탐 억제라는 목적 자체가 무너진다(2026-07-31 확정, 괴리 임계 도입 안 함).
  const B = checkCross(mk({ price: 26200, prevClose: 24500, h1c: 26226, h2c: 24500, asOf: ASOF_KR }), KR_OPEN);
  assert(gap(26200, 26226) < TOL, 'B: 전제 — 괴리가 임계 미만');
  assert(B.alignment === 'intraday', `B: 괴리가 작아도 분류는 동일하게 intraday (실제: ${B.alignment})`);
  assert(B.alignment === A.alignment, 'B: 괴리 크기가 분류를 바꾸지 않는다');

  // C. 장 마감 후 — A와 같은 값, 시각만 다르다
  const C = checkCross(mk({ price: 26200, prevClose: 24500, h1c: 26300, h2c: 24500, asOf: ASOF_KR }), KR_AFTER);
  assert(C.alignment !== 'intraday', `C: 폐장 후에는 intraday가 아니다 (실제: ${C.alignment})`);
  // 위반도 통과도 아닌 **미수행**이다 — circular(as_of가 h1.date 파생) + 신호 부재이므로.
  assert(C.state === 'skipped' && C.reason === 'no-independent-axis',
    `C: no-independent-axis로 스킵 (실제: ${C.state}/${C.reason})`);
  assert((C.axes ?? []).length === 0, 'C: 축을 만들지 않는다');

  // D. 축퇴 + 당일 캔들 — **수정 완료(2026-08-03).** 종전 KNOWN DEFECT의 회귀 고정.
  //
  //   수정 전 거동: alignment='intraday'(정상)인데 cross-prevclose가 **위반**을 냈다.
  //     원본 prev_close == price == h[-1](오늘 진행 중 종가)라 prev_close에 정보가 없는데,
  //     intraday 분기가 신호를 무시하고 무조건 h[-2](어제 종가)를 기준선으로 썼다.
  //     잔차 = 그날의 등락폭 = |24500-26300|/26300 = 6.845%가 되어 오탐 5건과 **구조가
  //     같은 유형**이었다. 그 값은 아래 반증 단언으로 계속 고정한다 — 수정이 풀리면
  //     정확히 그 숫자가 되살아나므로, 사라진 값을 적어 두는 것이 회귀 방어가 된다.
  //
  //   수정: 축퇴이면서 기준선이 h[-2]인 구간(same-day·intraday)에서는 축을 만들지 않고
  //     'degenerate-baseline'으로 스킵한다. 정보 없는 값에 남의 세션을 끼워 넣는 것은
  //     폴백이 아니라 기준선 날조이므로, 통과도 위반도 아닌 **미수행**으로 떨어뜨린다.
  //   ⚠️ **분류(alignment)는 건드리지 않았다** — 축퇴여도 intraday가 나오는 것이 정상이고
  //     prev_close에 의존하는 축만 성립 불가다. 분류와 축의 분리가 이 수정의 요점이다.
  //   ⚠️ prev-day 축퇴(기준선 h[-1])는 **범위 밖**이다. 잔차가 항상 0이라 날조가 아니라
  //     동어반복이고 위반을 만들지 않는다 — 10-1이 그 거동을 '잔차 0'으로 고정한다.
  const D = checkCross(mk({ price: 26300, prevClose: 26300, h1c: 26300, h2c: 24500,
    asOf: ASOF_KR, recalced: true }), KR_OPEN);
  assert(D.alignment === 'intraday', `D: 축퇴여도 분류는 intraday (실제: ${D.alignment})`);
  assert(D.degenerate === true, 'D: degenerate는 alignment 값이 아니라 별도 플래그다');
  assert(D.signalAlignment === 'prev-day', 'D: 신호는 prev-day를 가리킨다(원본 prev_close == h[-1])');
  const dPrev = D.axes.find(a => a.checkKind === 'cross-prevclose');
  assert(dPrev?.state === 'skipped' && dPrev.reason === 'degenerate-baseline',
    `D: change 축은 판정하지 않고 degenerate-baseline으로 스킵 (실제: ${JSON.stringify(dPrev)})`);
  assert(dPrev.ok === undefined && dPrev.residual === undefined,
    'D: 스킵 축은 통과도 위반도 아니다 — ok·residual을 싣지 않는다');
  // 반증 — 수정이 풀려 h[-2]를 기준선으로 되쓰면 이 잔차가 부활한다. 6.845%.
  assert(Math.abs(Math.abs(24500 - 26300) / 26300 - 0.0684410646387833) < 1e-12,
    'D: 날조 시 잔차는 그날 등락폭(6.845%)이었다 — 부활 시 대조할 기준값');
  assert(D.axes.every(a => a.state !== 'checked' || a.ok),
    'D: 축퇴 구간에서 위반이 나오지 않는다(오탐 소멸)');
  // 분류 계수는 축 스킵과 무관하게 살아 있어야 한다 — 항등식의 근거.
  assert(runRelativeChecks([mk({ price: 26300, prevClose: 26300, h1c: 26300, h2c: 24500,
    asOf: ASOF_KR, recalced: true })], KR_OPEN).counters['align-intraday'] === 1,
    'D: 축이 스킵돼도 align-intraday는 계수된다(분류와 축의 분리)');

  // E. price == h[-1], as_of 생략
  // ⚠️ as_of를 생략해도 "시계 정보 미제공"이 되지 않는다 — checkCross가 item.as_of ?? now로
  //    **now를 대신 쓴다.** 그래서 시계가 살아 있고(circular=false) 두 축이 합의한다.
  const E = checkCross(mk({ price: 26300, prevClose: 24500, h1c: 26300, h2c: 24500, asOf: undefined }), KR_AFTER);
  assert(E.alignment === 'same-day' && E.alignBasis === 'agree:price==h1',
    `E: 신호·시계 합의 same-day (실제: ${E.alignment}/${E.alignBasis})`);
  assert(E.circularAsOf === false, 'E: as_of 생략은 now로 대체되므로 circular이 아니다');

  // F. signal-only:no-clock — 시계가 항등이라 기권하고 신호가 단독 판정
  //    실측 형상: [저장소:9072dee8:lastgood:market:419530@2026-07-31T06:34:51Z]
  //      price 27200 / h[-1] 2026-07-31 27200 / as_of '2026-07-31 (Naver 종가)' (마감 후)
  const F = checkCross(mk({ price: 27200, prevClose: 24500, h1c: 27200, h2c: 24500, asOf: ASOF_KR }), KR_AFTER);
  assert(F.circularAsOf === true, 'F: as_of가 h[-1].date에서 파생돼 circular');
  assert(F.alignment === 'same-day' && F.alignBasis === 'signal-only:no-clock',
    `F: 시계 기권, 신호 단독 판정 (실제: ${F.alignment}/${F.alignBasis})`);
  assert(F.axes.every(a => a.state !== 'checked' || a.ok), 'F: 위반 없음');
}

// ── 13. align 분류 계수 계열 + 항등식 ──────────────────────────────────
{
  const ALIGN_VALUES = ['same-day', 'prev-day', 'intraday', 'stale', 'ambiguous', 'unknown'];

  // (a) 코드가 대입하는 alignment 값이 위 6종을 벗어나지 않는가 — 원문 대조
  const guardSrc = readFileSync(new URL('../api/_lib/relative-guard.js', import.meta.url), 'utf8');
  const body = guardSrc.slice(guardSrc.indexOf('export function checkCross('));
  const literals = [...body.matchAll(/alignment = '([a-z-]+)'/g)].map(m => m[1]);
  for (const v of literals) assert(ALIGN_VALUES.includes(v), `13a: 리터럴 대입 '${v}'가 6종 안에 있다`);
  // 동적 대입(alignment = clock / sig.alignment)의 가능값도 6종 안이어야 한다
  const clockLits = [...body.matchAll(/clock = '([a-z-]+)'/g)].map(m => m[1]);
  for (const v of clockLits) assert(ALIGN_VALUES.includes(v), `13a: clock 값 '${v}'가 6종 안에 있다`);

  // (b) ⚠️ **alignment 대입 이전에 조기반환을 추가하지 말 것**을 고정한다.
  //     분모(정렬 판정 도달 수)가 조용히 줄면 항등식은 계속 성립하면서 의미만 사라진다.
  const prefix = body.slice(0, body.search(/alignment = /));
  const earlyReasons = [...prefix.matchAll(/return \{ state: 'skipped', reason: '([a-z-]+)' \}/g)].map(m => m[1]).sort();
  const EXPECTED_EARLY = ['no-baseline', 'no-grade', 'no-meta', 'tauto', 'tautological'];
  assert(JSON.stringify(earlyReasons) === JSON.stringify(EXPECTED_EARLY),
    `13b: alignment 대입 이전 조기반환은 5종 고정 (실제: ${JSON.stringify(earlyReasons)})`);

  // (c) 항등식 — sum(align-6종) == 정렬 판정 도달 수. degenerate는 오버레이라 제외.
  const NOW_KR_OPEN = new Date('2026-07-31T04:47:00Z');
  const hh = (n, base, endDate, step = 1) => hist(n, base, endDate, step);
  const items = [
    // 정렬 판정에 도달하는 것들
    { id: 'nasdaq', price: 100, prev_close: 99, change: 1, source: 'CNBC', prov: { v: 2 },
      as_of: '2026-07-31 05:30 KST', history: [{ date: '2026-07-29', close: 99 }, { date: '2026-07-30', close: 100 }] },
    { id: '419530', price: 26200, prev_close: 24500, change: 1700, source: 'Naver', prov: { v: 2 },
      as_of: '2026-07-31 (Naver 종가)',
      history: [{ date: '2026-07-30', close: 24500 }, { date: '2026-07-31', close: 26300 }] },
    { id: 'vix', price: 17.09, prev_close: 20.66, change: -3.57, source: 'CNBC', prov: { v: 2 },
      quoteWindow: 'extended', as_of: '2026-07-31 07:52 KST',
      history: [{ date: '2026-07-28', close: 18.21 }, { date: '2026-07-29', close: 20.66 }] },
    // 조기반환으로 빠지는 것들(분모에서 제외돼야 한다)
    { id: 'btc', price: 64379, history: hh(30, 60000, '2026-07-30') },        // tauto
    { id: 'kospi', price: 5663, prev_close: 5600, change: 63, history: hh(30, 5600, '2026-07-30') }, // tautological
  ];
  const agg = runRelativeChecks(items, NOW_KR_OPEN);
  let reached = 0;
  for (const it of items) if (checkCross(it, NOW_KR_OPEN).alignment !== undefined) reached++;
  const sum = ALIGN_VALUES.reduce((a, v) => a + (agg.counters[`align-${v}`] ?? 0), 0);
  assert(reached === 3, `13c: 정렬 판정 도달 수 3(조기반환 2건 제외) (실제: ${reached})`);
  assert(sum === reached, `13c: ⭐ 항등식 sum(align-6종)=${sum} == 도달 수 ${reached}`);
  assert(!('align-degenerate' in agg.counters) || true, '13c: degenerate는 합산에서 제외(오버레이)');
  const overlaySum = sum + (agg.counters['align-degenerate'] ?? 0);
  assert(overlaySum >= sum, '13c: 오버레이를 더하면 도달 수를 넘을 수 있다 — 그래서 분할이 아니다');

  // (d) 키 이름 규칙 — sanitizeCode를 통과해도 뭉개지지 않아야 한다
  const sanitize = s => String(s).trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'unknown';
  for (const v of ALIGN_VALUES) {
    const code = `align-${v}`;
    assert(sanitize(code) === code, `13d: '${code}'는 sanitizeCode를 그대로 통과한다`);
  }
  assert(sanitize('align:same-day') !== 'align:same-day',
    '13d: [반증] 콜론 표기는 뭉개진다 — 그래서 하이픈을 쓴다');
  for (const k of Object.keys(agg.counters)) {
    assert(!k.includes(':'), `13d: counters 코드에 콜론 금지 (실제: ${k})`);
  }

  // (e) 기록 지점이 하나인가 — runRelativeChecks 안에서 align- 계수가 1곳에서만 일어난다
  const runBody = guardSrc.slice(guardSrc.indexOf('export function runRelativeChecks('));
  const tallySites = [...runBody.matchAll(/tally\(`align-\$\{/g)].length;
  assert(tallySites === 1, `13e: align 분류 계수 지점은 1곳 (실제: ${tallySites}곳)`);
}

console.log(`\n${fail === 0 ? '✓ 전체 통과' : '✗ 실패 있음'} — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
