/**
 * _lib/symbol-map.js — 소스별 심볼 표기 단일 집약 모듈
 *
 * 같은 종목/지수라도 소스마다 심볼 표기가 다르다(네이버 bare 6자리, Daum A접두,
 * Yahoo 접미 .KS/.KQ·지수 ^KS11 …). 변환 규칙이 컬렉터마다 흩어지면 소스가 늘 때마다
 * 곳곳을 고쳐야 하므로, 여기 한 곳에 모아 "새 소스 = case/필드 한 줄 추가"로 끝나게 한다.
 */

// ── 개별 KR 종목(6자리 코드) → 소스별 심볼 ──────────────────────────
// 새 소스는 case 한 줄 추가. Yahoo는 .KS(코스피)/.KQ(코스닥) 시장 접미가 필요해
// market 인자를 받는다(현재 Daum 폴오버엔 불필요 — 미래 확장 대비 시그니처만 확보).
export function krStockSymbol(code, source, market) {
  switch (source) {
    case 'naver': return code;                                   // 005930
    case 'daum':  return `A${code}`;                             // A005930
    case 'yahoo': return `${code}.${market === 'KOSDAQ' ? 'KQ' : 'KS'}`; // 005930.KS (미래)
    default:      return code;
  }
}

// ── KR 지수 → 소스별 심볼 (1차 지수 편 kr.js 하드코딩을 소급 흡수) ───
// kr.js가 이 값을 참조해 buildIndexItem에 naverCode/yahoo를 주입한다.
export const KR_INDEX_SYMBOLS = {
  kospi:  { naverIndex: 'KOSPI',  yahoo: '^KS11' },
  kosdaq: { naverIndex: 'KOSDAQ', yahoo: '^KQ11' },
};
