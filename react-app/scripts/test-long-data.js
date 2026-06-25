/**
 * 분석 탭 장기 데이터 소스 검증 스크립트
 * node scripts/test-long-data.js
 *
 * 각 종목별 250일 히스토리 확보 가능 여부, 소스, 수집 시간을 측정한다.
 */

import {
  fetchLongBTC,
  fetchLongNasdaq,
  fetchLongDow,
  fetchLongVIX,
  fetchLongKOSPI,
  fetchLongUSDKRW,
} from '../api/_collectors/analysis-long.js';

const TARGETS = [
  { id: 'btc',    label: 'BTC',    fn: fetchLongBTC    },
  { id: 'nasdaq', label: '나스닥', fn: fetchLongNasdaq },
  { id: 'dow',    label: '다우',   fn: fetchLongDow    },
  { id: 'vix',    label: 'VIX',   fn: fetchLongVIX    },
  { id: 'kospi',  label: '코스피', fn: fetchLongKOSPI  },
  { id: 'usdkrw', label: '원달러', fn: fetchLongUSDKRW },
];

const rows = [];

console.log('── 장기 데이터 수집 검증 시작 ──────────────────────\n');

for (const { id, label, fn } of TARGETS) {
  process.stdout.write(`${label} 수집 중...`);
  const t0 = Date.now();
  try {
    const { history, ohlc_available, source } = await fn();
    const elapsed  = ((Date.now() - t0) / 1000).toFixed(1);
    const days     = history.length;
    const earliest = history[0]?.date ?? '-';
    const latest   = history[history.length - 1]?.date ?? '-';
    // 응답 크기 추정 (JSON 직렬화)
    const sizeKB   = (JSON.stringify(history).length / 1024).toFixed(1);
    rows.push({ id, label, days, earliest, latest, ohlc: ohlc_available, source, elapsed, sizeKB, ok: true });
    console.log(` ✅  ${days}일  (${elapsed}s  ${sizeKB}KB)`);
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    rows.push({ id, label, days: 0, error: e.message, elapsed, ok: false });
    console.log(` ❌  실패: ${e.message}  (${elapsed}s)`);
  }
}

// ── 요약 표 ───────────────────────────────────────────────
console.log('\n── 결과 요약 ────────────────────────────────────────────────────────────');
console.log(
  '종목    │ 확보일수 │ MA100 │ MA200 │ OHLC │ 응답크기 │ 시간  │ 소스'
);
console.log(
  '────────┼──────────┼───────┼───────┼──────┼──────────┼───────┼────────────────────'
);
for (const r of rows) {
  if (!r.ok) {
    console.log(
      `${r.label.padEnd(6)}  │ 실패      │   -   │   -   │  -   │    -     │ ${r.elapsed}s │ ${(r.error ?? '').slice(0, 30)}`
    );
  } else {
    const ma100 = r.days >= 100 ? '  ✅  ' : '  ❌  ';
    const ma200 = r.days >= 200 ? '  ✅  ' : '  ❌  ';
    const ohlc  = r.ohlc ? ' ✅  ' : '  -  ';
    console.log(
      `${r.label.padEnd(6)}  │  ${String(r.days).padStart(4)}일  │${ma100}│${ma200}│${ohlc}│ ${String(r.sizeKB + 'KB').padStart(7)}  │ ${r.elapsed}s │ ${r.source}`
    );
  }
}
console.log('────────────────────────────────────────────────────────────────────────');

// MA200 불가 종목 경고
const noMA200 = rows.filter(r => r.ok && r.days < 200);
const noMA100 = rows.filter(r => r.ok && r.days < 100);
const failed  = rows.filter(r => !r.ok);

if (failed.length)  console.log(`\n⚠️  수집 실패: ${failed.map(r => r.label).join(', ')}`);
if (noMA200.length) console.log(`⚠️  MA200 불가 (200일 미만): ${noMA200.map(r => `${r.label}(${r.days}일)`).join(', ')}`);
if (noMA100.length) console.log(`⚠️  MA100 불가 (100일 미만): ${noMA100.map(r => `${r.label}(${r.days}일)`).join(', ')}`);

if (!failed.length && !noMA200.length) {
  console.log('\n✅  전 종목 250일 이상 확보 — MA100/MA200 모두 대응 가능');
}
