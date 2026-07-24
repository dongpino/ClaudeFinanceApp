/**
 * 한국 기준금리 / 한미 금리차 인사이트(krRate) E2E 검증 — 실 API 호출.
 *   cd react-app && node scripts/test-bok-insight.mjs
 *   (.env.local 필요: FRED_API_KEY / BOK_ECOS_API_KEY / ANTHROPIC_API_KEY / KV_REST_API_*)
 *
 * 실제 핸들러(api/macro.js → api/macro-insight.js)를 직접 호출해 FRED+ECOS+Haiku+Redis를
 * 그대로 태운다(vercel dev 불필요). 검증 항목:
 *   1. macro.js가 bok(현재값·직전변경·history)을 페이로드에 싣는지
 *   2. macro-insight.js가 krRate(hasBok 경로)를 생성하는지
 *   3. [ASSERTION] krRate 문장에 등장하는 모든 숫자가 '주입된 값'에만 속하는지 —
 *      한국금리·미국 상/하단·한미 금리차(상/하단)·직전변경 폭/날짜·최근 추세값·"12"(개월)만
 *      허용하고, 모델이 지어낸 수치(예: 중앙값 3.625%, 재계산 0.875%p)가 하나라도 있으면
 *      실패(exit 1). %·%p·개월 등 단위는 숫자 판정에서 제외(숫자 토큰만 대조).
 *
 * 캐시된 krRate가 있으면 그 값을 검증한다(스냅샷 키가 금리값을 담고 있어, 현재 금리로
 * 생성된 캐시본이면 허용 수치 집합과 일치함). 새 프롬프트 출력을 강제로 보려면 먼저
 * 해당 macro:insight:...-kr* 키를 지운 뒤 실행할 것.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env.local 로드(이미 있는 env는 덮지 않음)
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { default: macroHandler }   = await import('../api/macro.js');
const { default: insightHandler } = await import('../api/macro-insight.js');

function mockRes() {
  return {
    _status: 200, _json: null, _headers: {},
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
    setHeader(k, v) { this._headers[k] = v; },
  };
}

const round2 = n => Math.round(n * 100) / 100;
let failed = false;
const fail = msg => { console.error(`\n❌ FAIL: ${msg}`); failed = true; };
const ok   = msg => console.log(`✅ ${msg}`);

// ── 1) macro ────────────────────────────────────────────────
const r1 = mockRes();
await macroHandler({ method: 'GET', query: {} }, r1);
const macro = r1._json;
if (!macro?.bok?.rate) { fail('macro.bok가 없음 — bok 수집 실패'); process.exit(1); }
if (!macro?.fomc?.rate) { fail('macro.fomc.rate가 없음'); process.exit(1); }
const bok = macro.bok, fr = macro.fomc.rate;
ok(`macro.bok = ${bok.rate}% (기준일 ${bok.asOf}), 직전변경 ${bok.lastChange ? `${bok.lastChange.date} ${bok.lastChange.deltaPp}%p ${bok.lastChange.direction}` : '없음'}`);
ok(`macro.fomc.rate = ${fr.lower}~${fr.upper}%`);

// ── 2) macro-insight ────────────────────────────────────────
const r2 = mockRes();
await insightHandler({ method: 'GET' }, r2);
const insight = r2._json;
const krRate = insight?.krRate;
console.log(`\n[X-Cache: ${r2._headers['X-Cache']}]`);
if (!krRate) { fail('krRate가 생성되지 않음(hasBok 경로 미작동)'); process.exit(1); }
ok('krRate 생성됨');
console.log('\n── krRate 원문 ──\n' + krRate + '\n');

// ── 3) ASSERTION: krRate의 모든 숫자가 주입값에만 속하는가 ────────────
// 허용 숫자 집합을 buildBokSection이 주입하는 값 그대로 구성(수치는 magnitude로 비교 —
// 추출 정규식이 부호를 분리하므로 절대값 기준).
const allowed = new Set();
const add = (...xs) => xs.forEach(x => { if (Number.isFinite(x)) allowed.add(round2(Math.abs(x))); });
add(bok.rate, fr.lower, fr.upper);
add(round2(bok.rate - fr.upper), round2(bok.rate - fr.lower)); // 금리차 상/하단(부호무시)
if (bok.lastChange) {
  add(bok.lastChange.deltaPp, bok.lastChange.prevRate);
  const [y, mo, d] = bok.lastChange.date.split('-').map(Number);
  add(y, mo, d); // "2026년"/"7월 16일"
}
for (const h of (bok.history ?? [])) add(h.close); // 최근 추세값
add(12); // "12개월"

// 숫자 토큰만 추출(콤마 천단위·단위 문자는 제외, 소수 허용)
const tokens = krRate.match(/\d+(?:\.\d+)?/g) ?? [];
const offenders = [];
for (const t of tokens) {
  const n = round2(Math.abs(parseFloat(t)));
  if (!allowed.has(n)) offenders.push(t);
}
console.log('추출 숫자:', tokens.join(', ') || '(없음)');
console.log('허용 집합:', [...allowed].sort((a, b) => a - b).join(', '));
if (offenders.length) {
  fail(`krRate에 주입되지 않은 숫자 등장: ${offenders.join(', ')} (모델이 지어냈거나 재계산)`);
} else {
  ok('krRate의 모든 숫자가 주입값에만 속함(지어낸 수치 없음)');
}

// 부가 점검(경고만): 상대 시간 표현 흔적
if (/최근\s*인상|근래\s*인상/.test(krRate)) {
  console.warn('⚠️  경고: 변경 시점을 "최근/근래 인상"으로 표현 — 절대 날짜 사용 권장(assertion 대상 아님)');
}

console.log(failed ? '\n=== 결과: FAIL ===' : '\n=== 결과: PASS ===');
process.exit(failed ? 1 : 0);
