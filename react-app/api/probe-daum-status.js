/**
 * api/probe-daum-status.js — [임시] Daum marketStatus 장전 토큰 캡처 (Vercel Cron 전용)
 *
 * vercel.json crons "40 23 * * 0-5"(UTC) = **08:40 KST 월~토**.
 *   · 평일 08:40 = 정규장(09:00) 전 20분 → 장전 토큰이 나오는 유일한 시간대
 *   · 토요일 08:40 = 휴장 토큰(평일 장전과 같은 값인지 다른 값인지가 관건)
 * 사람이 매일 그 시각에 앱을 열어 확인하던 일을 크론으로 옮긴 것이다.
 *
 * ⚠️ 은퇴 조건 — 이건 영구 기능이 아니라 조사 장치다.
 *   **2026-09-14 애프터마켓(16~20시) 시행 후 신규 토큰 캡처가 끝나면** 은퇴시킨다:
 *     ① 이 크론(vercel.json 항목 포함) + api/probe-backup.js를 **동시에 은퇴**
 *     ② probe-backup.js도 같은 성격의 임시 조사 엔드포인트라 따로 남겨 둘 이유가 없다
 *   ⚠️ 2026-07-29 변경: 종전 조건은 "DAUM_STATUS_MAP 완성"이었으나 **성립하지 않는다**.
 *      거래시간 연장(2026-09-14 애프터마켓, 2027년말 프리마켓)으로 상태 토큰이 다시
 *      늘어나므로, 지금 표를 채워도 9월에 곧바로 불완전해진다. 그래서 은퇴 시점을
 *      "표 완성"이 아니라 "제도 변경 후 재캡처 완료"에 건다.
 *   Redis 키는 마지막 쓰기 +7일에 스스로 사라지므로(probe-store.js TTL) 잔여물 없음.
 *
 * GET /api/probe-daum-status          — Cron(Authorization: Bearer CRON_SECRET)
 * GET /api/probe-daum-status?key=…    — 수동 캡처(DEBUG_SIGNALS_KEY)
 * GET /api/probe-daum-status?key=…&view=1 — 쌓인 결과 조회(호출 안 함, Redis만 읽음)
 *
 * ── 분리 규율 ────────────────────────────────────────────────────────
 * 수집 파이프라인과 완전히 분리된 경로다. daum-stock.js를 import하지 않고(그 함수는
 * trackedFetch를 타서 health를 오염시킨다) 순수 fetch로 같은 엔드포인트를 직접 친다.
 * 실패해도 저장만 안 될 뿐 어떤 수집 경로에도 영향이 없고, 실패 사실 자체를 그날
 * 필드에 남긴다 — "크론이 안 돌았다"와 "돌았는데 소스가 실패했다"는 다른 사건이라
 * 빈칸으로 두면 사후에 구분할 수 없다.
 */

import { saveProbe, readProbe, kstDate, kstStamp, etStamp, isAuthorized } from './_lib/probe-store.js';

const KEY = 'probe:daum-status';

// 삼성전자 — 거래정지/상폐 위험이 사실상 없어 "토큰만 보려는" 관측 대상으로 가장 안전하다.
const SYMBOL = 'A005930';
const URL = `https://finance.daum.net/api/quotes/${SYMBOL}?summary=false&changeStatistics=true`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
  // 종목별 Referer가 없으면 403 (daum-stock.js와 동일 조건).
  Referer: `https://finance.daum.net/quotes/${SYMBOL}`,
};
const TIMEOUT_MS = 8000;

// 캡처 1회 — 절대 throw하지 않고 결과 객체로 회수한다(에러도 그날의 데이터).
async function capture() {
  const at = new Date();
  // 시각은 UTC(at) + KST + ET 세 벌로 남긴다 — ET는 이 프로브의 관심사가 아니지만,
  // 두 프로브의 기록 형식을 같게 두면 나중에 한 눈으로 대조된다(probe-store.etStamp 주석 참조).
  const base = { at: at.toISOString(), kst: kstStamp(at), et: etStamp(at), symbol: SYMBOL };
  try {
    const res = await fetch(URL, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ...base, ok: false, httpStatus: res.status, token: null };
    const j = await res.json();
    return {
      ...base,
      ok: true,
      httpStatus: res.status,
      // ⚠️ 정규화·판정 금지 — DAUM_STATUS_MAP을 통과시키지 않은 **원문 토큰** 그대로다.
      // 정규화를 거치면 미지 토큰이 null로 뭉개져 이 프로브의 목적 자체가 사라진다.
      token: j?.marketStatus ?? null,
      // 토큰과 함께 보면 "그 시각 시세가 전일 것인지 당일 것인지"가 드러난다.
      tradeTime: j?.tradeTime ?? null,
      tradeDate: j?.tradeDate ?? null,
    };
  } catch (e) {
    return { ...base, ok: false, httpStatus: 0, token: null, error: `${e.name}: ${e.message}` };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!isAuthorized(req)) return res.status(403).json({ error: '접근 권한 없음' });

  res.setHeader('Cache-Control', 'no-store');

  if (req.query?.view === '1') {
    const rows = await readProbe(KEY);
    return res.status(200).json({ key: KEY, count: rows.length, rows });
  }

  const field  = kstDate();
  const result = await capture();
  const saved  = await saveProbe(KEY, field, result);
  console.log(`[probe-daum-status] ${field} token=${result.token ?? '(none)'} saved=${saved}`);

  // 소스 실패해도 200 — 크론의 성패는 "기록을 남겼는가"이지 "Daum이 응답했는가"가 아니다.
  // (실패 사실은 위에서 그날 필드에 그대로 저장했다.)
  return res.status(200).json({ key: KEY, field, saved, result });
}
