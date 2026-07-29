/**
 * scripts/audit-holidays.js — 휴장일 표를 **우리 수집 데이터로** 감사한다(수동 실행, 네트워크 사용).
 *
 * 왜 있는가: 2026-07-29 감사에서 제헌절(2026-07-17)이 표에 통째로 빠져 있던 것을 찾아낸
 * 방법이 바로 이것이다. 제3자 달력을 읽은 게 아니라, 우리가 이미 쓰는 수집 경로의 일봉에
 * 그날 캔들이 없다는 사실로 휴장을 실증했다. 그 절차를 코드로 남겨 재현 가능하게 한다.
 *
 * ⚠️ **이 감사는 과거만 본다.** 아직 오지 않은 날은 캔들이 없는 게 당연하므로 미래 항목의
 *    오류는 원리적으로 잡지 못한다. 미래분의 방어선은 원문(조문·월력요항·NYSE)뿐이다.
 *    실제로 같은 감사에서 발견한 누락 4건 중 실측이 잡은 건 2026-07-17 1건이고,
 *    2027 3건은 전부 「관공서의 공휴일에 관한 규정」 조문에서 나왔다.
 *
 * ⚠️ 회귀 테스트(test-calendar-schedule.js)는 이 스크립트를 부르지 않는다 — 매 실행마다
 *    외부를 때리면 테스트가 네트워크와 상대 서버 사정에 묶인다. 대신 이 스크립트가 만든
 *    스냅샷(scripts/fixtures/kr-trading-days.json)을 오프라인으로 대조한다.
 *
 * 실행:
 *   node scripts/audit-holidays.js            # 감사만(스냅샷 미갱신)
 *   node scripts/audit-holidays.js --update   # 감사 + 스냅샷 갱신
 *
 * 수신 구간은 소스가 주는 만큼(현재 네이버 지수 5페이지 = 약 300거래일, 2025-05-08~)이고,
 * 표 대조는 AUDIT_FROM(2026-01-01) 이후만 한다. 그 앞 2025년분은 대조 대상이 아니라
 * **연말 폐장일 관행 사례**(2025-12-31이 평일인데 휴장)를 회귀에 남기기 위한 보관 구간이다.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKET_HOLIDAYS } from '../api/_lib/macro-calendar.js';

const args    = process.argv.slice(2);
const doUpdate = args.includes('--update');
// 표(MARKET_HOLIDAYS)가 2026부터라 대조는 2026 이후만 한다. 그 앞 구간(네이버가 주는
// 2025년분)은 대조 대상이 아니라 **폐장일 관행 사례** 보관용이다 — 2025-12-31이 평일인데
// 휴장이었다는 실측이 회귀에 들어간다(연말 폐장일 [관행추정] 등급의 유일한 실측 근거).
const AUDIT_FROM = '2026-01-01';

const SNAPSHOT = new URL('./fixtures/kr-trading-days.json', import.meta.url);

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const dow = d => WD[new Date(`${d}T00:00:00Z`).getUTCDay()];
const isWeekend = d => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());

async function getJSON(url, headers = UA) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// 소스 3종 — kr.js/daum-stock.js가 실제로 쓰는 경로 그대로다. 한 소스의 결측이 휴장으로
// 오인되지 않게 지수 2개 + 개별종목 1개를 서로 다른 호스트에서 받아 교차한다.
async function naverIndex(code) {
  const out = new Set();
  for (let page = 1; page <= 5; page++) {
    const rows = await getJSON(`https://m.stock.naver.com/api/index/${code}/price?pageSize=60&page=${page}`);
    for (const r of rows) if (r.localTradedAt) out.add(String(r.localTradedAt).slice(0, 10));
  }
  return out;
}
async function daumStock(sym) {
  const d = await getJSON(`https://finance.daum.net/api/charts/${sym}/days?limit=250&adjusted=true`, {
    ...UA, Referer: `https://finance.daum.net/quotes/${sym}`, 'X-Requested-With': 'XMLHttpRequest',
  });
  return new Set((d.data ?? []).map(r => String(r.date).slice(0, 10)));
}

const SOURCES = [
  { key: 'naver-kospi',  load: () => naverIndex('KOSPI') },
  { key: 'naver-kosdaq', load: () => naverIndex('KOSDAQ') },
  { key: 'daum-005930',  load: () => daumStock('A005930') },
];

const results = await Promise.all(SOURCES.map(async s => {
  try { return { ...s, days: await s.load() }; }
  catch (e) { console.warn(`  ⚠️ ${s.key} 실패(제외): ${e.message}`); return { ...s, days: new Set() }; }
}));

const ok = results.filter(r => r.days.size > 50);
if (ok.length === 0) { console.error('❌ 사용 가능한 소스가 없다 — 감사 중단'); process.exit(1); }

// 합집합을 거래일로 본다: 한 소스에만 있어도 그날 시장은 열렸다(결측 ≠ 휴장).
const trading = new Set();
for (const r of ok) for (const d of r.days) trading.add(d);
const days = [...trading].sort();
const coverageStart = days[0], coverageEnd = days[days.length - 1];
// 대조 시작점은 표 커버리지와 맞춘다. coverageStart(네이버가 주는 2025년분)부터 훑으면
// 표에 없는 2025년 공휴일이 전부 "누락"으로 잡히는 거짓 경보가 된다.
const auditStart = coverageStart > AUDIT_FROM ? coverageStart : AUDIT_FROM;

console.log(`\n소스 ${ok.length}/${SOURCES.length}종 사용 — ${ok.map(r => `${r.key}(${r.days.size})`).join(' ')}`);
console.log(`거래일 ${days.length}일, 수신 구간 ${coverageStart} ~ ${coverageEnd} / 대조 구간 ${auditStart} ~ ${coverageEnd}`);

// ── 표와 대조 ────────────────────────────────────────────────
const table = MARKET_HOLIDAYS.KR;
const missing = [];  // 평일인데 캔들 없음 + 표에도 없음 = 누락
for (let t = Date.parse(`${auditStart}T00:00:00Z`); t <= Date.parse(`${coverageEnd}T00:00:00Z`); t += 86400000) {
  const d = new Date(t).toISOString().slice(0, 10);
  if (isWeekend(d) || trading.has(d) || table[d]) continue;
  missing.push(d);
}
const inRange = Object.keys(table).filter(d => d >= auditStart && d <= coverageEnd).sort();
const extra   = inRange.filter(d => trading.has(d));   // 표에 있는데 그날 거래됨 = 오탑재

console.log(`\n✅ 표와 일치(휴장 실측) ${inRange.length - extra.length}건`);
console.log(`⚠️ 누락 ${missing.length}건 — ${missing.map(d => `${d}(${dow(d)})`).join(', ') || '(없음)'}`);
console.log(`⚠️ 오탑재 ${extra.length}건 — ${extra.map(d => `${d}(${dow(d)}) ${table[d]}`).join(', ') || '(없음)'}`);
console.log('\n※ 이 감사는 과거만 본다. 미래 항목 오류는 잡지 못한다 — 원문 등급이 유일한 방어선이다.');

// ── 스냅샷 갱신 ──────────────────────────────────────────────
if (doUpdate) {
  let prev = null;
  try { prev = JSON.parse(readFileSync(SNAPSHOT, 'utf8')); } catch { /* 최초 생성 */ }
  // append-only 계약: 지난 구간은 절대 바뀌지 않아야 한다. 바뀌면 소스 쪽 사고이므로 멈춘다.
  if (prev) {
    const lost = prev.tradingDays.filter(d => !trading.has(d));
    if (lost.length) {
      console.error(`\n❌ 스냅샷 갱신 중단 — 기존 거래일 ${lost.length}건이 사라졌다: ${lost.slice(0, 5).join(', ')}`);
      console.error('   append-only여야 한다. 소스 응답이 이상하거나 과거가 정정된 것이니 사람이 확인할 것.');
      process.exit(1);
    }
  }
  mkdirSync(dirname(fileURLToPath(SNAPSHOT)), { recursive: true });
  const payload = {
    _note: '휴장일 표 오프라인 회귀용 거래일 스냅샷. scripts/audit-holidays.js --update 로만 갱신한다.',
    _appendOnly: '지난 연도는 불변, 당해 연도만 뒤로 늘어난다. 기존 날짜가 사라지면 갱신이 중단된다.',
    _limitation: '과거 구간 전용 근거다. 미래 항목 오류는 이 파일로 잡을 수 없다.',
    _auditFromWhy: 'auditFrom 이전 구간(2025년분)은 표 대조 대상이 아니다 — 표가 2026부터라 '
      + '대조하면 2025 공휴일이 전부 거짓 누락으로 잡힌다. 그 구간은 연말 폐장일 관행 사례'
      + '(2025-12-31이 평일인데 휴장)를 보관하는 용도다.',
    market: 'KR',
    sources: ok.map(r => r.key),
    capturedAt: new Date().toISOString().slice(0, 10),
    coverageStart, coverageEnd, auditFrom: AUDIT_FROM,
    tradingDays: days,
  };
  writeFileSync(SNAPSHOT, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n스냅샷 갱신: ${fileURLToPath(SNAPSHOT)} (${days.length}일, ~${coverageEnd})`);
}

process.exit(missing.length || extra.length ? 1 : 0);
