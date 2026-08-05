/**
 * scripts/test-parity.js — 주가 패리티 계산 회귀 테스트
 *
 * 표시 계층(DetailPage)은 브라우저 없이 확인할 수 없지만, "얼마로 찍히나"와 "언제 숨기나"는
 * 순수 함수라 여기서 고정된다. 특히 **미입력을 0%로 만들지 않는다**는 규칙이 핵심이다 —
 * 0%는 전액 손실과 구분되지 않는다.
 *
 * 실행: node scripts/test-parity.js
 */

import { parityPercent, parityDirection } from '../src/parity.js';

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${label}`); }
}

// ── (1) 계산 ─────────────────────────────────────────────────────────
{
  assert(parityPercent(180, 100) === 180, '1-1: 현재가가 평단의 1.8배면 180%');
  assert(parityPercent(100, 100) === 100, '1-2: 평단과 같으면 100%(본전)');
  assert(parityPercent(50, 100) === 50,   '1-3: 반토막이면 50%');
  assert(parityPercent(0, 100) === 0,     '1-4: 실제로 0원이면 0% (미입력과 다른 사건)');
  // 통화 환산 없음 — 같은 통화라는 전제(편집 패널이 통화를 표시하며 입력받는다)
  assert(parityPercent(0.98, 0.5) === 196, '1-5: USD 소수 가격도 같은 식');
  assert(parityPercent(25913.85, 20000) === 130, '1-6: KRW 대형 수치');
}

// ── (2) 반올림 — 정수 % ──────────────────────────────────────────────
{
  // 3/8 = 0.375 → 37.5%는 이진 부동소수로 **정확히** 표현되는 값이라 반올림 규칙을
  // 그대로 시험할 수 있다(1.005 같은 값은 애초에 100.49999…로 저장돼 시험이 성립하지 않는다).
  assert(parityPercent(3, 8) === 38, '2-1: 37.5%는 38%로 올린다(JS Math.round는 .5를 올림)');
  assert(parityPercent(1, 3) === 33, '2-2: 33.33%는 33%로 내린다');
  assert(Number.isInteger(parityPercent(123.456, 78.9)), '2-3: 항상 정수');
}

// ── (3) 미입력·비정상 입력은 **null**(0이 아니다) ────────────────────
{
  assert(parityPercent(180, null) === null,      '3-1: 평단가 미입력이면 null');
  assert(parityPercent(180, undefined) === null, '3-2: undefined도 null');
  assert(parityPercent(180, 0) === null,         '3-3: 0으로 나누지 않는다');
  assert(parityPercent(180, -10) === null,       '3-4: 음수 평단가는 성립하지 않는다');
  assert(parityPercent(180, NaN) === null,       '3-5: NaN 평단가');
  assert(parityPercent(null, 100) === null,      '3-6: 현재가가 없으면 null');
  assert(parityPercent(NaN, 100) === null,       '3-7: NaN 현재가');
  assert(parityPercent(undefined, undefined) === null, '3-8: 둘 다 없음');
  // 0과 null을 절대 섞지 않는다 — 이 테스트가 이번 요구의 핵심 규칙이다
  assert(parityPercent(180, null) !== 0, '3-9: 미입력을 0으로 만들지 않는다');
}

// ── (4) 방향 — 기준선은 100%다 ───────────────────────────────────────
{
  assert(parityDirection(180) === 'up',    '4-1: 100 초과는 up');
  assert(parityDirection(99)  === 'down',  '4-2: 100 미만은 down');
  assert(parityDirection(100) === 'flat',  '4-3: 정확히 100은 flat(본전)');
  assert(parityDirection(0)   === 'down',  '4-4: 0%는 down (전액 손실)');
  assert(parityDirection(null) === null,   '4-5: 값이 없으면 방향도 없다');
  assert(parityDirection(NaN)  === null,   '4-6: NaN 방어');
  // 등락률과 기준선이 다르다는 것을 고정한다(0이 아니라 100)
  assert(parityDirection(1) === 'down', '4-7: 1%는 상승이 아니라 하락 방향이다');
}

console.log(fail === 0 ? `✓ 전체 통과 — pass ${pass}, fail ${fail}` : `✗ 실패 — pass ${pass}, fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
