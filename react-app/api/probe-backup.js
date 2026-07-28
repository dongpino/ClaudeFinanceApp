/**
 * api/probe-backup.js — [임시] 외부 소스 Vercel 접근성 프로브
 *
 * ⚠ 임시 조사용 엔드포인트. 외부 소스가 Vercel 데이터센터 IP에서 실제로 열리는지
 * 확인하기 위한 프로브다(한경 교훈: 로컬 200 ≠ Vercel 200). 조사 종료 후 삭제 예정.
 *
 * GET /api/probe-backup?key=<DEBUG_SIGNALS_KEY>
 *   → [백업 소스] Daum quote/chart/코스닥 + Yahoo 지수(^KS11/^KQ11) 순차 fetch,
 *     각 항목의 HTTP 상태·기대 JSON 여부·핵심 필드 존재·소요(ms) + 소스별 판정.
 *   → [RSS 4종] 각 피드를 RSS_ATTEMPTS회 연속 호출해 성공률·평균 지연·에러 cause
 *     분포 + 회차별 개별 결과 반환.
 *
 * RSS 섹션 목적(2026-07-28): rss-yna가 7/24까지 100%였다가 7/25부터 ~20%로
 * 계단식 하락했는데 로컬에선 90%가 나온다. 이 격차가 Vercel egress IP축인지
 * 확인하려면 "프로덕션이 실제로 보내는 그 요청"을 Vercel에서 쏴 봐야 한다.
 * 그래서 URL/헤더/타임아웃을 rss.js에서 import해 쓴다(복제하면 드리프트 발생).
 *
 * 회차별 결과를 남기는 이유: 1회차만 실패하고 2~5회차가 성공하면 커넥션 수립
 * 단계(TLS/handshake/최초 소켓) 문제고, 산발적이면 다른 축(레이트리밋·LB 특정
 * 노드·패킷 유실)이다. 총계만 보면 이 둘이 구분되지 않는다.
 *
 * DEBUG_SIGNALS_KEY 환경변수로만 보호(debug-signals.js와 동일 패턴) — 무키 접근 403.
 * health 오염 방지 위해 trackedFetch/fetchFeed가 아닌 순수 fetch 사용(프로브
 * 트래픽은 상태판에 집계되면 안 됨).
 */

import { classifyError, classifySource } from './_lib/health.js';
import { RSS_FEEDS, COINDESK_FEED, RSS_HEADERS, FETCH_TIMEOUT_MS } from './_collectors/rss.js';

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

// 단일 프로브 — 절대 throw하지 않고 결과 객체로 회수(에러도 데이터).
async function probe(label, url, { headers = {}, timeout = 9000, extract } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
    const ms  = Date.now() - t0;
    const ct  = res.headers.get('content-type') || '';
    const server = res.headers.get('cf-ray') ? 'cloudflare' : (res.headers.get('server') || '(none)');
    const text = await res.text();
    let json = null, isJson = false;
    if (/json/i.test(ct)) { try { json = JSON.parse(text); isJson = true; } catch { /* not json */ } }
    let fields = null;
    if (isJson && extract) { try { fields = extract(json); } catch (e) { fields = { extractError: e.message }; } }
    return {
      label, url, status: res.status, ms,
      contentType: ct.split(';')[0], server, isJson,
      fields,
      ...(isJson ? {} : { bodySample: text.slice(0, 150).replace(/\s+/g, ' ') }),
    };
  } catch (e) {
    return { label, url, status: 0, ms: Date.now() - t0, error: `${e.name}: ${e.message}` };
  }
}

// ── RSS 반복 프로브 ─────────────────────────────────────────────────
const RSS_ATTEMPTS = 5;
const WARM_GAP_MS  = 200;      // 웜: 커넥션 재사용 구간 — 상대 서버 부담/버스트 오탐 방지
// 콜드(?cold=1): 실제 수집기의 조건 재현. 브리핑 크론은 하루 몇 번, 서로 몇 시간 떨어져
// 도는 "콜드 단발 호출"이라 커넥션이 항상 새로 맺힌다. 웜 프로브(200ms 간격)는 2회차부터
// 소켓을 재사용해 버려서 그 조건을 전혀 재현하지 못한다 — 로컬 웜 100% vs 프로덕션 20%
// 격차의 유력 후보가 정확히 이 지점이다.
//   · 30초 간격  → undici 기본 keepAliveTimeout(4초)을 훌쩍 넘겨 소켓이 이미 닫힘
//   · connection: close → 응답 후 즉시 종료를 명시(undici가 수용함을 실측 확인)
// 두 장치를 겹쳐 "매 호출 새 커넥션"을 보장한다.
const COLD_GAP_MS  = 30_000;
const rssSleep = ms => new Promise(r => setTimeout(r, ms));

// 콜드 모드는 라운드당 최대 (피드수 × 타임아웃)이 걸릴 수 있어 함수 실행 한도(300s)에
// 부딪힐 수 있다. 남은 시간이 모자라면 라운드를 더 돌지 않고 거기까지를 결과로 낸다
// (조용한 절단 금지 — 응답에 실제 수행 라운드 수를 명시한다).
const COLD_DEADLINE_MS = 210_000;

// 회차 시퀀스에서 실패 패턴을 읽는다. 총계만으론 구분 안 되는 축을 가른다.
function detectPattern(attempts) {
  const fails = attempts.filter(a => !a.ok);
  if (fails.length === 0) return 'all-ok';
  if (fails.length === attempts.length) return 'all-fail';
  if (fails.length === 1 && fails[0].i === 1) return 'first-only(커넥션 수립 단계 의심)';
  if (fails.every(a => a.i === 1 || a.i === 2)) return 'early-only(웜업 구간 의심)';
  return 'sporadic(레이트리밋/LB노드/패킷유실 등 다른 축)';
}

// 단발 시도. rss.js의 fetchFeedOnce와 동일 조건(헤더/타임아웃)을 쓰되 health는 절대
// 건드리지 않는다(프로브 트래픽이 상태판에 집계되면 안 됨).
async function probeAttempt(url, { cold }) {
  const headers = cold ? { ...RSS_HEADERS, connection: 'close' } : RSS_HEADERS;
  const t0 = Date.now();
  try {
    const res  = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const buf  = await res.arrayBuffer();
    const ct   = (res.headers.get('content-type') || '').split(';')[0];
    const server = res.headers.get('cf-ray') ? 'cloudflare' : (res.headers.get('server') || '(none)');
    return {
      ok: res.ok, status: res.status, ms: Date.now() - t0, bytes: buf.byteLength, contentType: ct, server,
      ...(res.ok ? {} : { code: `http-${res.status}` }),
    };
  } catch (e) {
    // undici는 원인을 cause에 숨긴다 — health 히스토그램과 같은 어휘로 정규화한다.
    return {
      ok: false, status: 0, ms: Date.now() - t0,
      error: `${e.name}: ${e.message}`,
      causeCode: e.cause?.code ?? null,
      code: classifyError(e),
    };
  }
}

/**
 * 라운드 로빈 실행 — 라운드마다 전 피드를 1회씩 돌고, 라운드 사이에만 간격을 둔다.
 * 피드별로 5회를 연속 돌리면 콜드(30초)에서 총 소요가 피드 수만큼 배가돼 함수 한도를
 * 넘는다. 피드는 서로 다른 호스트라 커넥션 풀이 분리돼 있어 라운드 로빈이 같은 피드의
 * "시도 간 간격"을 그대로 보장한다.
 */
async function runRssRounds(feeds, { cold }) {
  const perFeed = new Map(feeds.map(f => [f.url, []]));
  const startedAt = Date.now();
  const gap = cold ? COLD_GAP_MS : WARM_GAP_MS;
  let rounds = 0;

  for (let round = 1; round <= RSS_ATTEMPTS; round++) {
    for (const f of feeds) {
      perFeed.get(f.url).push({ i: round, ...(await probeAttempt(f.url, { cold })) });
    }
    rounds = round;
    if (round === RSS_ATTEMPTS) break;
    // 남은 시간이 모자라면 여기서 멈춘다(절단 사실은 응답에 그대로 표기).
    if (cold && Date.now() - startedAt + gap > COLD_DEADLINE_MS) break;
    await rssSleep(gap);
  }
  return { rounds, perFeed };
}

function summarizeFeed({ url, source }, sourceKey, attempts) {
  const okAttempts = attempts.filter(a => a.ok);
  const errors = {};
  for (const a of attempts) if (!a.ok) errors[a.code] = (errors[a.code] ?? 0) + 1;

  return {
    source: sourceKey,
    label: source,
    url,
    attempts: attempts.length,
    okCount: okAttempts.length,
    rate: attempts.length ? Math.round((okAttempts.length / attempts.length) * 100) / 100 : null,
    avgMs: okAttempts.length ? Math.round(okAttempts.reduce((s, a) => s + a.ms, 0) / okAttempts.length) : null,
    bytes: okAttempts[0]?.bytes ?? null,
    server: okAttempts[0]?.server ?? null,
    errors,
    // 'O'=성공 'X'=실패, 1회차부터 순서대로 — 눈으로 패턴이 바로 보이게.
    sequence: attempts.map(a => (a.ok ? 'O' : 'X')).join(''),
    pattern: detectPattern(attempts),
    attemptDetail: attempts,
  };
}

// Yahoo: query1 실패(에러/비200) 시 query2로 재시도.
async function probeYahoo(label, symbolEnc) {
  const path = `/v8/finance/chart/${symbolEnc}?interval=1d&range=5d`;
  const extract = j => {
    const m = j?.chart?.result?.[0]?.meta ?? null;
    return {
      hasMeta: !!m,
      price: m?.regularMarketPrice ?? null,
      prevClose: m?.chartPreviousClose ?? null,
      marketState: m?.marketState ?? null,
      exchange: m?.exchangeName ?? null,
      dataDelayedBy: m?.exchangeDataDelayedBy ?? null,
      hasPrice: typeof m?.regularMarketPrice === 'number',
    };
  };
  const r1 = await probe(`${label} (query1)`, `https://query1.finance.yahoo.com${path}`, { headers: UA, extract });
  if (r1.status === 200 && r1.isJson) return r1;
  const r2 = await probe(`${label} (query2 재시도)`, `https://query2.finance.yahoo.com${path}`, { headers: UA, extract });
  return { ...r2, query1Fallback: { status: r1.status, ms: r1.ms, error: r1.error ?? null } };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const expected = process.env.DEBUG_SIGNALS_KEY;
  const provided = req.query?.key;
  if (!expected || provided !== expected) {
    return res.status(403).json({ error: '접근 권한 없음' });
  }

  // ?cold=1 — RSS 구간을 콜드 커넥션 조건으로 실행(수집기의 단발 호출 재현).
  const cold = req.query?.cold === '1' || req.query?.cold === 'true';

  const daumH     = { ...UA, Referer: 'https://finance.daum.net/' };
  const daumChartH = { ...UA, Referer: 'https://finance.daum.net/quotes/A005930', 'X-Requested-With': 'XMLHttpRequest' };

  const daumQuoteExtract = j => ({
    market: j.market ?? null,
    hasTradePrice: typeof j.tradePrice === 'number',
    tradePrice: j.tradePrice ?? null,
    changeRate: j.changeRate ?? null,
    accTradeVolume: j.accTradeVolume ?? null,
    hasMarketStatus: 'marketStatus' in (j || {}),
    marketStatus: j.marketStatus ?? null,
    tradeTime: j.tradeTime ?? null,
  });

  try {
    // 순차 실행 — 프로브라 병렬 이점보다 결과 순서·부하 분산이 낫다.
    const a = await probe('a. Daum 삼성전자 quote (A005930)',
      'https://finance.daum.net/api/quotes/A005930?summary=false&changeStatistics=true',
      { headers: daumH, extract: daumQuoteExtract });

    const b = await probe('b. Daum 삼성 일봉 chart (A005930, limit=30)',
      'https://finance.daum.net/api/charts/A005930/days?limit=30&adjusted=true',
      { headers: daumChartH, extract: j => ({
        rows: Array.isArray(j.data) ? j.data.length : 0,
        firstDate: j.data?.[0]?.date ?? null,
        hasOHLCV: !!(j.data?.[0] && 'openingPrice' in j.data[0] && 'highPrice' in j.data[0]
          && 'lowPrice' in j.data[0] && 'tradePrice' in j.data[0] && 'candleAccTradeVolume' in j.data[0]),
      }) });

    const c = await probe('c. Daum HLB 코스닥 quote (A028300)',
      'https://finance.daum.net/api/quotes/A028300?summary=false',
      { headers: daumH, extract: daumQuoteExtract });

    const d = await probeYahoo('d. Yahoo 지수 KOSPI ^KS11', '%5EKS11');
    const e = await probeYahoo('e. Yahoo 지수 KOSDAQ ^KQ11', '%5EKQ11');

    // ── 판정 요약 ──
    const daumOk  = a.status === 200 && a.isJson && a.fields?.hasTradePrice
                    && c.status === 200 && c.isJson && c.fields?.hasTradePrice;
    const daumChartOk = b.status === 200 && b.isJson && b.fields?.hasOHLCV;
    const yahooKs = d.status === 200 && d.isJson && d.fields?.hasPrice;
    const yahooKq = e.status === 200 && e.isJson && e.fields?.hasPrice;

    const verdict = {
      daum_stock:  daumOk ? 'USABLE (종목 quote 200+필드)' : 'BLOCKED/실패',
      daum_chart:  daumChartOk ? 'USABLE (일봉 OHLCV 200)' : 'BLOCKED/실패',
      yahoo_index: (yahooKs || yahooKq) ? `USABLE (^KS11:${yahooKs?'ok':'x'} / ^KQ11:${yahooKq?'ok':'x'})` : 'BLOCKED/미도달',
      note: '로컬 결과와 비교할 것 — 로컬✓/Vercel✗ 또는 그 반대 가능(한경 교훈).',
    };

    // ── RSS 4종 반복 프로브 ──
    // 라운드 내에서는 피드를 순차로 — 동시에 쏘면 우리 쪽 커넥션 경합이 변수로 섞여
    // IP축 판정이 흐려진다.
    const feeds = [...RSS_FEEDS, COINDESK_FEED];
    const { rounds, perFeed } = await runRssRounds(feeds, { cold });
    const rssResults = feeds.map(f =>
      summarizeFeed(f, classifySource(f.url) ?? f.url, perFeed.get(f.url)));

    const worst = rssResults.reduce((w, r) => (r.rate < w.rate ? r : w), rssResults[0]);
    const othersAllOk = rssResults.filter(r => r !== worst).every(r => r.rate === 1);

    const rssVerdict = {
      mode: cold ? 'cold (매 호출 새 커넥션 — 수집기 조건 재현)' : 'warm (커넥션 재사용)',
      summary: rssResults.map(r => `${r.source} ${r.sequence} ${Math.round(r.rate * 100)}%`).join(' | '),
      worst: `${worst.source} ${Math.round(worst.rate * 100)}% (${worst.pattern})`,
      // 한 피드만 저하 + 나머지 전부 정상이면 우리 쪽 egress 공통 문제가 아니다.
      axis: worst.rate === 1 ? '전 피드 정상 — 이 시점엔 재현 안 됨'
        : othersAllOk ? `${worst.source}만 저하 — 공통 egress 문제가 아니라 해당 호스트 축(IP 평판/레이트리밋/상대 인프라)`
        : '복수 피드 저하 — Vercel egress 공통 축 의심',
      coldHypothesis: cold
        ? '이 모드에서만 저하가 재현되면 콜드 커넥션 가설 확정(웜에선 소켓 재사용으로 가려짐)'
        : '?cold=1 로 재호출해 콜드 조건과 비교할 것',
      note: `rss.js와 동일 조건(헤더/타임아웃 ${FETCH_TIMEOUT_MS}ms).`,
    };

    return res.status(200).json({
      checkedAt: new Date().toISOString(),
      region: process.env.VERCEL_REGION ?? '(unknown)',
      verdict,
      results: [a, b, c, d, e],
      rss: {
        cold,
        attemptsPlanned: RSS_ATTEMPTS,
        // 콜드는 함수 한도 때문에 조기 종료될 수 있다 — 실제 수행 라운드를 밝힌다.
        roundsCompleted: rounds,
        truncated: rounds < RSS_ATTEMPTS,
        gapMs: cold ? COLD_GAP_MS : WARM_GAP_MS,
        timeoutMs: FETCH_TIMEOUT_MS,
        verdict: rssVerdict,
        results: rssResults,
      },
    });
  } catch (err) {
    console.error('[probe-backup] 실패:', err.message);
    return res.status(500).json({ error: '프로브 실패', details: err.message });
  }
}
