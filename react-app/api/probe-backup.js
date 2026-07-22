/**
 * api/probe-backup.js — [임시] 네이버 백업 소스 Vercel 접근성 프로브
 *
 * ⚠ 임시 조사용 엔드포인트. 백업 소스(Daum/Yahoo)가 Vercel 데이터센터 IP에서
 * 실제로 열리는지 확인하기 위한 1회성 프로브다(한경 교훈: 로컬 200 ≠ Vercel 200).
 * 조사 종료 후 삭제 예정.
 *
 * GET /api/probe-backup?key=<DEBUG_SIGNALS_KEY>
 *   → Daum quote/chart/코스닥 + Yahoo 지수(^KS11/^KQ11)를 서버에서 순차 fetch,
 *     각 항목의 HTTP 상태·기대 JSON 여부·핵심 필드 존재·소요(ms) + 소스별 판정 반환.
 *
 * DEBUG_SIGNALS_KEY 환경변수로만 보호(debug-signals.js와 동일 패턴) — 무키 접근 403.
 * health 오염 방지 위해 trackedFetch가 아닌 순수 fetch 사용(프로브 트래픽은 상태판에
 * 집계되면 안 됨).
 */

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

    return res.status(200).json({
      checkedAt: new Date().toISOString(),
      region: process.env.VERCEL_REGION ?? '(unknown)',
      verdict,
      results: [a, b, c, d, e],
    });
  } catch (err) {
    console.error('[probe-backup] 실패:', err.message);
    return res.status(500).json({ error: '프로브 실패', details: err.message });
  }
}
