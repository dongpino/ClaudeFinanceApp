/**
 * 타임프레임 데이터 수집/변환 검증 스크립트
 * node scripts/test-tf-data.js
 *
 * 검증 항목:
 *   1. BTC 각 타임프레임(1m~1d): Binance klines 수집 — 봉 수, OHLC 정상 여부
 *   2. 전 종목 주봉 변환: 일봉 250일 → 주봉, 일관성 검증
 *   3. 종목별 지원 타임프레임 목록 출력
 */

import { fetchBTCByTF, BTC_INTRADAY_TFS } from '../api/_collectors/btc-intraday.js';
import {
  fetchLongBTC, fetchLongNasdaq, fetchLongDow,
  fetchLongVIX, fetchLongKOSPI, fetchLongUSDKRW,
} from '../api/_collectors/analysis-long.js';
import { toWeekly } from '../api/_collectors/weekly-transform.js';

function pad(str, n) { return String(str).padEnd(n); }
function rpad(str, n) { return String(str).padStart(n); }

// ─────────────────────────────────────────────────────────
// 1. BTC 타임프레임별 수집 검증
// ─────────────────────────────────────────────────────────

console.log('\n══ 1. BTC 타임프레임별 수집 검증 ══════════════════════════════════════\n');

const btcRows = [];

// 분봉/시간봉 (btc-intraday.js)
for (const tf of BTC_INTRADAY_TFS) {
  process.stdout.write(`  BTC ${tf.padEnd(3)} 수집 중...`);
  const t0 = Date.now();
  try {
    const { history, ohlc_available, source } = await fetchBTCByTF(tf);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const first   = history[0];
    const last    = history[history.length - 1];

    // 시각 포맷 (Unix seconds → ISO)
    const firstTs = new Date(first.time * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    const lastTs  = new Date(last.time  * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

    // OHLC 정상 여부: open>0, high>=open, low<=open, close>0
    const ohlcOk = history.every(
      r => r.open > 0 && r.high >= r.low && r.high > 0 && r.close > 0
    );
    const timeAsc = history.every((r, i) => i === 0 || r.time > history[i - 1].time);

    btcRows.push({ tf, count: history.length, ohlc: ohlc_available, ohlcOk, timeAsc, firstTs, lastTs, elapsed, ok: true });
    console.log(` ✅  ${history.length}봉  (${elapsed}s)`);
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    btcRows.push({ tf, ok: false, error: e.message, elapsed });
    console.log(` ❌  ${e.message}  (${elapsed}s)`);
  }
}

// 일봉 (analysis-long.js)
{
  process.stdout.write(`  BTC 1d  수집 중...`);
  const t0 = Date.now();
  try {
    const { history, ohlc_available } = await fetchLongBTC();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const first   = history[0];
    const last    = history[history.length - 1];
    const ohlcOk  = history.every(r => r.open > 0 && r.high >= r.low && r.close > 0);
    btcRows.push({
      tf: '1d', count: history.length, ohlc: ohlc_available, ohlcOk,
      timeAsc: true, firstTs: first.date, lastTs: last.date, elapsed, ok: true,
    });
    console.log(` ✅  ${history.length}봉  (${elapsed}s)`);
  } catch (e) {
    btcRows.push({ tf: '1d', ok: false, error: e.message, elapsed: ((Date.now() - t0)/1000).toFixed(1) });
    console.log(` ❌  ${e.message}`);
  }
}

console.log('\n  타임프레임  │ 봉 수 │ OHLC │ 값정상 │ 시간오름 │ 첫 봉                │ 마지막 봉');
console.log('  ───────────┼───────┼──────┼────────┼──────────┼─────────────────────┼─────────────────────');
for (const r of btcRows) {
  if (!r.ok) {
    console.log(`  ${pad(r.tf,10)}│  ERR  │  -   │   -    │    -     │ ${r.error?.slice(0, 40)}`);
  } else {
    console.log(
      `  ${pad(r.tf,10)}│ ${rpad(r.count,5)} │ ${r.ohlc ? ' ✅  ' : '  -  '} │ ${r.ohlcOk ? '  ✅   ' : '  ❌  '} │ ${r.timeAsc ? '   ✅    ' : '   ❌   '} │ ${pad(r.firstTs, 21)}│ ${r.lastTs}`
    );
  }
}

// ─────────────────────────────────────────────────────────
// 2. 주봉 변환 검증 (전 종목)
// ─────────────────────────────────────────────────────────

console.log('\n\n══ 2. 주봉 변환 검증 (250일 → 주봉) ═══════════════════════════════════\n');

const DAILY_TARGETS = [
  { id: 'btc',    label: 'BTC',    fn: fetchLongBTC,    ohlcSrc: true,  weekDays: 7 },
  { id: 'nasdaq', label: '나스닥', fn: fetchLongNasdaq, ohlcSrc: false, weekDays: 5 },
  { id: 'dow',    label: '다우',   fn: fetchLongDow,    ohlcSrc: false, weekDays: 5 },
  { id: 'vix',    label: 'VIX',   fn: fetchLongVIX,    ohlcSrc: false, weekDays: 5 },
  { id: 'kospi',  label: '코스피', fn: fetchLongKOSPI,  ohlcSrc: false, weekDays: 5 },
  { id: 'usdkrw', label: '원달러', fn: fetchLongUSDKRW, ohlcSrc: false, weekDays: 5 },
];

const weeklyRows = [];

for (const { id, label, fn, ohlcSrc, weekDays } of DAILY_TARGETS) {
  process.stdout.write(`  ${label.padEnd(5)} 일봉 수집 + 주봉 변환 중...`);
  const t0 = Date.now();
  try {
    const { history: daily, source } = await fn();
    const weekly  = toWeekly(daily, ohlcSrc);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // 일관성 검증 1: 주봉 종가 = 그 주 마지막 일봉 종가
    // BTC(weekDays=7)는 월~일, 주식(weekDays=5)은 월~금으로 주 경계 결정
    let consistent = true;
    for (const wk of weekly) {
      const monDate  = wk.date;
      const monD     = new Date(monDate + 'T00:00:00Z');
      // 다음 주 월요일 미만까지 = 해당 주 전체 (주말 포함 7일, 또는 5일)
      const nextMon  = new Date(monD.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
      const wkDays   = daily.filter(d => d.date >= monDate && d.date < nextMon);
      if (wkDays.length === 0) continue;
      const expectedClose = wkDays[wkDays.length - 1].close;
      if (Math.abs(wk.close - expectedClose) > 0.01) {
        consistent = false;
        break;
      }
    }

    // 일관성 검증 2: 주봉 날짜 오름차순
    const dateAsc = weekly.every((w, i) => i === 0 || w.date > weekly[i - 1].date);

    // 일관성 검증 3: 주봉 OHLC high >= low
    const ohlcValid = weekly.every(w => w.high >= w.low && w.close > 0 && w.open > 0);

    const expectedWeeks = Math.round(daily.length / weekDays);

    weeklyRows.push({
      label, dailyCnt: daily.length, weeklyCnt: weekly.length,
      expectedWeeks, consistent, dateAsc, ohlcValid,
      firstWeek: weekly[0]?.date, lastWeek: weekly[weekly.length - 1]?.date,
      ohlcSrc, elapsed, ok: true,
    });
    console.log(` ✅  ${daily.length}일 → ${weekly.length}주봉  (${elapsed}s)`);
  } catch (e) {
    weeklyRows.push({ label, ok: false, error: e.message });
    console.log(` ❌  ${e.message}`);
  }
}

console.log('\n  종목   │ 일봉  │ 주봉  │ 예상주 │ 종가일치 │ 날짜↑ │ OHLC정상 │ OHLC출처 │ 첫 주봉    │ 마지막 주봉');
console.log('  ───────┼───────┼───────┼────────┼──────────┼───────┼──────────┼──────────┼────────────┼────────────');
for (const r of weeklyRows) {
  if (!r.ok) {
    console.log(`  ${pad(r.label, 6)} │  ERR  │       │        │          │       │          │          │ ${r.error?.slice(0, 30)}`);
  } else {
    console.log(
      `  ${pad(r.label, 6)} │ ${rpad(r.dailyCnt, 5)} │ ${rpad(r.weeklyCnt, 5)} │ ~${rpad(r.expectedWeeks, 4)} │ ${r.consistent ? '   ✅    ' : '   ❌    '} │ ${r.dateAsc ? '  ✅  ' : '  ❌  '} │ ${r.ohlcValid ? '   ✅    ' : '   ❌    '} │ ${r.ohlcSrc ? '실제OHLC ' : 'close기반'} │ ${r.firstWeek} │ ${r.lastWeek}`
    );
  }
}

// ─────────────────────────────────────────────────────────
// 3. 종목별 지원 타임프레임 매트릭스
// ─────────────────────────────────────────────────────────

console.log('\n\n══ 3. 종목별 지원 타임프레임 ═══════════════════════════════════════════\n');

const ALL_TFS    = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
const SUPPORTED  = {
  btc:    ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'],
  nasdaq: ['1d', '1w'],
  dow:    ['1d', '1w'],
  vix:    ['1d', '1w'],
  kospi:  ['1d', '1w'],
  usdkrw: ['1d', '1w'],
};
const LABELS = { btc:'BTC', nasdaq:'나스닥', dow:'다우', vix:'VIX', kospi:'코스피', usdkrw:'원달러' };

const header = `  ${'종목'.padEnd(6)} │ ` + ALL_TFS.map(tf => tf.padEnd(4)).join(' │ ');
console.log(header);
console.log('  ' + '─'.repeat(6) + '─┼─' + ALL_TFS.map(() => '─'.repeat(4)).join('─┼─'));
for (const [id, tfs] of Object.entries(SUPPORTED)) {
  const row = ALL_TFS.map(tf => (tfs.includes(tf) ? ' ✅ ' : '  - ')).join(' │ ');
  console.log(`  ${pad(LABELS[id], 6)} │ ${row}`);
}

// ─────────────────────────────────────────────────────────
// 최종 요약
// ─────────────────────────────────────────────────────────

const btcFailed    = btcRows.filter(r => !r.ok);
const btcBadOHLC   = btcRows.filter(r => r.ok && !r.ohlcOk);
const weeklyFailed = weeklyRows.filter(r => !r.ok);
const inconsistent = weeklyRows.filter(r => r.ok && !r.consistent);

console.log('\n\n══ 최종 요약 ═══════════════════════════════════════════════════════════\n');
if (!btcFailed.length && !btcBadOHLC.length && !weeklyFailed.length && !inconsistent.length) {
  console.log('  ✅  전 항목 통과 — BTC 분봉/시간봉 수집 정상, 주봉 변환 일관성 확인');
} else {
  if (btcFailed.length)    console.log(`  ❌  BTC 수집 실패: ${btcFailed.map(r => r.tf).join(', ')}`);
  if (btcBadOHLC.length)   console.log(`  ❌  BTC OHLC 이상: ${btcBadOHLC.map(r => r.tf).join(', ')}`);
  if (weeklyFailed.length) console.log(`  ❌  주봉 변환 실패: ${weeklyFailed.map(r => r.label).join(', ')}`);
  if (inconsistent.length) console.log(`  ❌  주봉 일관성 오류: ${inconsistent.map(r => r.label).join(', ')}`);
}
console.log('');
