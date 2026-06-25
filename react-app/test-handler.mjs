/**
 * test-handler.mjs — serverless handler를 HTTP 없이 로컬 테스트
 * 실행: node react-app/api/test-handler.mjs
 *       또는 (react-app/api/ 에서) node test-handler.mjs
 */
import handler from './market-data.js';

const headers = {};
const mockRes = {
  _status: 200,
  status(code)           { this._status = code; return this; },
  setHeader(k, v)        { headers[k] = v; },
  json(data) {
    console.log('\n' + '='.repeat(60));
    console.log(`  HTTP ${this._status}  X-Cache=${headers['X-Cache'] ?? '-'}`);
    console.log('='.repeat(60));

    if (data.error) {
      console.error(`  [오류] ${data.error}`);
      if (data.details) console.error(`  [상세] ${data.details}`);
      return this;
    }

    console.log(`  updated_at: ${data.updated_at}`);
    console.log(`  items: ${data.items.length}종목`);
    console.log();

    const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);
    const ids  = data.items.map(it => it.id);
    console.log(`  순서: ${ids.join(' → ')}`);
    console.log();

    for (const it of data.items) {
      const p   = it.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const pct = (it.change_pct >= 0 ? '+' : '') + it.change_pct.toFixed(4) + '%';
      console.log(`  ${it.id.padEnd(8)} ${p.padStart(12)}  ${sign(it.change).padStart(10)} (${pct})  [${it.source}]`);
      console.log(`           hist=${it.history.length}pt  hist_90d=${it.history_90d.length}d  ohlc=${it.ohlc_available}  as_of=${it.as_of}`);
    }

    // 구조 검증
    const ORDER   = ['nasdaq', 'dow', 'kospi', 'btc', 'vix', 'usdkrw'];
    const orderOK = ids.join(',') === ORDER.filter(id => ids.includes(id)).join(',');
    const allFields = data.items.every(it =>
      ['id','name','symbol','price','prev_close','change','change_pct',
       'direction','source','as_of','category','history','ohlc_available','history_90d'
      ].every(f => f in it)
    );

    console.log('\n  [검증]');
    console.log(`  종목 수:  ${data.items.length === 6 ? '✓' : '✗'} ${data.items.length}/6`);
    console.log(`  순서:     ${orderOK ? '✓' : '✗'} (나스닥→다우→코스피→BTC→VIX→원달러)`);
    console.log(`  필드 구조: ${allFields ? '✓' : '✗'} (14개 필드 전부 존재)`);

    return this;
  },
};

const mockReq = { method: 'GET' };
const start   = Date.now();

console.log('='.repeat(60));
console.log('  /api/market-data 핸들러 로컬 테스트');
console.log('='.repeat(60));
console.log('(1차 요청 — Cache MISS 예상)\n');

await handler(mockReq, mockRes);
const elapsed1 = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n  1차 요청 소요: ${elapsed1}s`);

// 2차 요청: 캐시 HIT 확인
console.log('\n' + '-'.repeat(60));
console.log('(2차 요청 — Cache HIT 예상)\n');
const start2 = Date.now();
await handler(mockReq, mockRes);
const elapsed2 = ((Date.now() - start2) / 1000).toFixed(2);
console.log(`\n  2차 요청 소요: ${elapsed2}s  (캐시 HIT이면 거의 0s)`);
