/**
 * api/probe-cnbc-format.js — [임시] CNBC last_timedate 형식 캡처 (Vercel Cron 전용)
 *
 * 목적: 날짜형/시각형이 **장중에 실제로 바뀌는지**를 원문으로 확인한다.
 *   CNBC quote의 last_timedate는 종목·시점에 따라 두 모양으로 온다.
 *     시각형 "5:15 PM EDT"      — 그 시각의 체결/갱신 시점
 *     날짜형 "07/28/26 EDT"     — 날짜만, 시각 없음
 *   as_of를 "형식=신호"로 쓰는 설계(날짜형이면 전일 종가로 간주 등)가 성립하려면,
 *   같은 종목이 장중에는 시각형으로 바뀐다는 것이 전제다. 그 전제를 실측으로 깬다/세운다.
 *
 * ⚠️ 판정 로직 없음 — 원문 그대로 적재만 한다. 형식 분류·"이건 전일값" 같은 해석을
 *    여기 넣으면, 나중에 설계를 판정할 때 쓸 원자료가 이미 그 해석에 물든 상태가 된다.
 *    판정은 며칠치가 쌓인 뒤 사람이 한다.
 *
 * ⚠️ 은퇴 예정 — 조사 장치다. 형식 게이트 판정이 끝나면 이 크론(vercel.json 항목 포함)을
 *    삭제한다. probe-daum-status.js/probe-backup.js와 같은 성격이며, Redis 키는 마지막
 *    쓰기 +7일에 스스로 사라진다(probe-store.js TTL).
 *
 * ── 스케줄: vercel.json crons "0 14 * * 1-5"(UTC) = 23:00 KST 월~금 ─────
 * ⚠️ 요청은 "23:00 KST 화~토"였는데 **월~금으로 바꿔 넣었다**. 23:00 KST는 ET 같은 날
 *    오전이라(KST-13h, 서머타임 기준) 요일이 밀리지 않는다:
 *      월 23:00 KST = 월 10:00 EDT(장중) … 금 23:00 KST = 금 10:00 EDT(장중)
 *      토 23:00 KST = 토 10:00 EDT → **휴장**(수확 0), 대신 화~토로 잡으면 월요일 장을 통째로 놓친다.
 *    "= 미국 장중"이라는 목적에 맞는 요일 집합은 월~금이다. 토요일 휴장 표본이 굳이
 *    필요하면 "0 14 * * 1-6"으로 한 글자만 고치면 된다.
 * ⚠️ 서머타임: 14:00 UTC는 EDT(여름) 10:00 = 장중이지만, EST(겨울, 대략 11월 초부터)엔
 *    09:00 = **개장 30분 전**이라 장중 표본이 아니게 된다. 겨울까지 끌고 갈 일이 생기면
 *    "0 15 * * 1-5"(EST 10:00 / EDT 11:00 — 연중 장중)로 옮길 것.
 *
 * GET /api/probe-cnbc-format          — Cron(Authorization: Bearer CRON_SECRET)
 * GET /api/probe-cnbc-format?key=…    — 수동 캡처(DEBUG_SIGNALS_KEY)
 * GET /api/probe-cnbc-format?key=…&view=1 — 쌓인 결과 조회(호출 안 함, Redis만 읽음)
 *
 * ── 분리 규율 ────────────────────────────────────────────────────────
 * _collectors/us-indices.js를 import하지 않는다 — 그쪽 fetch는 trackedFetch라 프로브
 * 트래픽이 health의 cnbc 집계에 섞인다(관측 대상 오염). 순수 fetch로 같은 엔드포인트를
 * 직접 친다. 대가로 심볼 목록이 us-indices.js와 이중화되는데, 이 파일은 곧 은퇴할
 * 조사 장치라 드리프트 수명이 짧다(항구 코드였다면 export해서 공유하는 쪽이 맞다).
 */

import { saveProbe, readProbe, kstDate, kstStamp, isAuthorized } from './_lib/probe-store.js';

const KEY = 'probe:cnbc-format';

// us-indices.js collectUSIndices와 같은 7종. 관심은 날짜형으로 관측된 5종
// (.IXIC/.DJI/.SPX/.SOX/.VIX)이지만, 대조군 없이는 "장중이라 바뀐 것"과 "원래 그런 종목"이
// 구분되지 않으므로 US10Y/.DXY까지 전 종목을 그대로 담는다.
const SYMBOLS = '.IXIC|.DJI|.VIX|US10Y|.DXY|.SPX|.SOX';
const QUERY = new URLSearchParams({
  symbols: SYMBOLS, requestMethod: 'itv',
  noform: '1', partnerId: '2', fund: '1', exthrs: '1', output: 'json', events: '0',
});
const URL = `https://quote.cnbc.com/quote-html-webservice/quote.htm?${QUERY}`;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};
const TIMEOUT_MS = 9000;

// 캡처 1회 — 절대 throw하지 않고 결과 객체로 회수한다(에러도 그날의 데이터).
async function capture() {
  const at = new Date();
  const base = { at: at.toISOString(), kst: kstStamp(at) };
  try {
    const res = await fetch(URL, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ...base, ok: false, httpStatus: res.status, quotes: [] };
    const j = await res.json();
    const list = j?.ITVQuoteResult?.ITVQuote;
    if (!Array.isArray(list) || list.length === 0) {
      return { ...base, ok: false, httpStatus: res.status, quotes: [], error: '응답 형식 오류(ITVQuote 없음)' };
    }
    return {
      ...base,
      ok: true,
      httpStatus: res.status,
      // 원문 3필드만, 가공 없이. last도 함께 두는 이유: 형식이 안 바뀌었을 때 "값 자체는
      // 갱신됐는가"가 곧 형식 신호의 반증이 된다(날짜형인데 값이 움직이면 형식≠신선도).
      quotes: list.map(q => ({
        symbol:       q?.symbol ?? null,
        last_timedate: q?.last_timedate ?? null,
        curmktstatus:  q?.curmktstatus ?? null,
        last:          q?.last ?? null,
      })),
    };
  } catch (e) {
    return { ...base, ok: false, httpStatus: 0, quotes: [], error: `${e.name}: ${e.message}` };
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
  console.log(`[probe-cnbc-format] ${field} quotes=${result.quotes.length} saved=${saved} `
    + result.quotes.map(q => `${q.symbol}=${q.last_timedate}`).join(' '));

  // 소스 실패해도 200 — 크론의 성패는 "기록을 남겼는가"다(실패 사실도 그날 필드에 저장됨).
  return res.status(200).json({ key: KEY, field, saved, result });
}
