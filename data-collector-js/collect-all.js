/**
 * collect-all.js — 6종목 전체 수집 통합 진입점
 *
 * fetch-btc.js, fetch-us-indices.js, fetch-kr.js의 수집 함수를 병렬 실행하여
 * Python market_check.py와 동일한 구조의 market_data.json을 생성한다.
 *
 * 종목 순서 (Python 기준): 나스닥, 다우, 코스피, BTC, VIX, 원/달러
 *
 * 에러 격리 정책 (Python과 동일):
 *   - 3개 그룹(US 지수, BTC, KR 지표)을 Promise.allSettled로 병렬 실행
 *   - 한 그룹 전체 실패 → 해당 종목들만 items에서 제외, 나머지 정상 저장
 *   - history/history_90d 개별 실패 → 빈 배열로 대체, 종목 자체는 포함
 *   - updated_at은 성공/실패 무관하게 기록
 *
 * 실행: node collect-all.js
 * 출력: data-collector-js/market_data.json  (React 앱용 최종 파일 경로는 아래 참고)
 *
 * Node 18+ (ES module, built-in fetch)
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { collectBTC }        from './fetch-btc.js';
import { collectUSIndices }  from './fetch-us-indices.js';
import { collectKR }         from './fetch-kr.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────
// 유틸 (각 파일과 동일)
// ──────────────────────────────────────────────────────
function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

// ──────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log('  전체 6종목 수집 (JS — Python market_check.py 이식)');
  console.log(`  조회 시각: ${fmtKST()}`);
  console.log('='.repeat(60));
  console.log('(3개 그룹 병렬 수집 — 로그가 섞일 수 있음)\n');

  // ── 3그룹 병렬 실행 ─────────────────────────────────
  const [usResult, btcResult, krResult] = await Promise.allSettled([
    collectUSIndices(),   // → [nasdaq, dow, vix]
    collectBTC(),         // → item
    collectKR(),          // → [kospi, krw]
  ]);

  // ── 결과 수집 (실패 그룹은 에러 로그 + 제외) ────────
  const itemsById  = {};
  const failedGroups = [];

  const processResult = (label, result) => {
    if (result.status === 'fulfilled') {
      const arr = Array.isArray(result.value) ? result.value : [result.value];
      for (const it of arr) {
        if (it && it.id) itemsById[it.id] = it;
      }
    } else {
      failedGroups.push(label);
      console.error(`\n[실패] ${label}: ${result.reason?.message ?? result.reason}`);
    }
  };

  processResult('US 지수 (나스닥·다우·VIX)', usResult);
  processResult('BTC',                       btcResult);
  processResult('KR 지표 (코스피·원달러)',    krResult);

  // ── items 순서: Python 기준 (나스닥, 다우, 코스피, BTC, VIX, 원/달러) ──
  const ORDER = ['nasdaq', 'dow', 'kospi', 'btc', 'vix', 'usdkrw'];
  const items = ORDER.filter(id => itemsById[id]).map(id => itemsById[id]);

  const updated_at = fmtKST();
  const output = { updated_at, items };

  // ── 저장 ────────────────────────────────────────────
  const outPath = join(__dirname, 'market_data.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');

  // ── 최종 요약 ────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log('  수집 결과 요약');
  console.log('='.repeat(60));

  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
  for (const it of items) {
    const pStr = it.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cStr = sign(it.change);
    const pctStr = (it.change_pct >= 0 ? '+' : '') + it.change_pct.toFixed(4) + '%';
    console.log(`  ${it.name.padEnd(18)} ${pStr.padStart(12)}  ${cStr.padStart(10)} (${pctStr})  [${it.source}]`);
    console.log(`    hist=${it.history.length}pt  hist_90d=${it.history_90d.length}d  ohlc=${it.ohlc_available}  as_of=${it.as_of}`);
  }

  console.log();
  if (failedGroups.length === 0) {
    console.log(`  전체 ${items.length}/6 종목 수집 완료  (${elapsed}s)`);
  } else {
    console.warn(`  수집 완료: ${items.length}/6 종목  실패 그룹: ${failedGroups.join(', ')}  (${elapsed}s)`);
  }
  console.log(`  updated_at: ${updated_at}`);
  console.log(`  [저장] ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
