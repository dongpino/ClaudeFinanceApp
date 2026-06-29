/**
 * api/briefing.js — AI 시장 브리핑 서버리스 함수
 *
 * GET /api/briefing
 *   → 6종목 시장 지표 + 한국 경제 뉴스 RSS를 Anthropic AI에게 주고
 *     오늘의 시장 브리핑(한국어)을 생성해 반환.
 *
 * ───────────────────────── 비용 정보 ──────────────────────────
 *  모델:  claude-haiku-4-5-20251001  (Anthropic 최저가 모델)
 *  입력:  ~1,000~1,500 토큰 (지표 6종 + 뉴스 15개 헤드라인 포함)
 *  출력:  ~200~350 토큰   (3~5문장 한국어 브리핑)
 *  1회:   ~$0.0004~$0.0008  (≈ 0.05~0.1원)  ← 매우 저렴
 *  주의:  자동 호출 절대 금지 — 반드시 버튼 클릭 시에만 호출
 * ──────────────────────────────────────────────────────────────
 *
 * 캐싱: 인메모리 20분 (콜드 스타트 시 초기화됨)
 * 환경변수: ANTHROPIC_API_KEY (필수) — Vercel Dashboard에서 설정
 */

import { collectBTC }       from './_collectors/btc.js';
import { collectUSIndices } from './_collectors/us-indices.js';
import { collectKR }        from './_collectors/kr.js';
import { collectRSSNews }   from './_collectors/rss.js';

// ── 상수 ──────────────────────────────────────────────────────

const BRIEFING_CACHE_TTL_MS = 20 * 60 * 1000;  // 20분 캐시
const ANTHROPIC_API_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION     = '2023-06-01';
const MODEL                 = 'claude-haiku-4-5-20251001';

// 비용 통제: 출력 최대 400 토큰 ≈ 3~5문장 (초과 시 강제 종료)
const MAX_OUTPUT_TOKENS = 400;

// AI 요청 타임아웃: Vercel 서버리스 최대 실행 시간 고려
const AI_TIMEOUT_MS = 20_000;

// ── 캐시 ──────────────────────────────────────────────────────

let briefingCache = null;  // { data: {...}, timestamp: number }

// ── 유틸 ──────────────────────────────────────────────────────

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

// ── 시장 데이터 수집 ──────────────────────────────────────────

const ITEM_ORDER = ['nasdaq', 'dow', 'kospi', 'btc', 'vix', 'usdkrw'];

async function collectMarketSnapshot() {
  const [usResult, btcResult, krResult] = await Promise.allSettled([
    collectUSIndices({ include90d: false }),
    collectBTC({ include90d: false }),
    collectKR({ include90d: false }),
  ]);

  const byId = {};
  for (const result of [usResult, btcResult, krResult]) {
    if (result.status === 'fulfilled') {
      const arr = Array.isArray(result.value) ? result.value : [result.value];
      for (const it of arr) { if (it?.id) byId[it.id] = it; }
    }
  }

  return ITEM_ORDER.filter(id => byId[id]).map(id => byId[id]);
}

// ── 프롬프트 생성 ──────────────────────────────────────────────

function buildPrompt(items, newsItems) {
  const sign = n => (n >= 0 ? '+' : '') + Number(n).toFixed(2);

  const marketSection = items.map(it => {
    const price = it.price != null ? it.price.toLocaleString('en-US') : '?';
    const pct   = it.change_pct != null ? `${sign(it.change_pct)}%` : '?';
    return `- ${it.name}: ${price} (${pct})`;
  }).join('\n');

  const newsSection = newsItems.length > 0
    ? `\n최근 경제 뉴스 헤드라인:\n` +
      newsItems.map((n, i) => `${i + 1}. [${n.source}] ${n.title}`).join('\n')
    : '\n(※ 뉴스 RSS 수집 실패 — 시장 지표만으로 브리핑)';

  return `당신은 객관적인 금융 시장 분석가입니다. 아래 시장 데이터와 뉴스 헤드라인을 바탕으로 오늘의 시장 브리핑을 한국어로 작성하세요.

[시장 현황]
${marketSection}
${newsSection}

[작성 규칙]
- 3~5문장으로 간결하게 작성
- 수치를 근거로 사실 위주로 서술 (예: "나스닥은 X% 하락했으며")
- 투자 권유, 매수/매도 조언, 과도한 단정 금지
- 독자가 오늘 시장 흐름을 빠르게 파악할 수 있도록 작성
- 헤더나 목록 없이 자연스러운 문단 형식으로 작성`;
}

// ── Anthropic API 호출 ────────────────────────────────────────

async function callAnthropicAPI(apiKey, prompt) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method:  'POST',
      signal:  ctrl.signal,
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${errBody}`);
    }

    return await res.json();

  } finally {
    clearTimeout(tid);
  }
}

// ── 메인 핸들러 ───────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── 캐시 확인 ──────────────────────────────────────────────
  if (briefingCache && Date.now() - briefingCache.timestamp < BRIEFING_CACHE_TTL_MS) {
    const ageMin = ((Date.now() - briefingCache.timestamp) / 60_000).toFixed(1);
    console.log(`[briefing] Cache HIT (age=${ageMin}분)`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({ ...briefingCache.data, cached: true });
  }

  // ── API 키 확인 ────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.',
      hint: 'Vercel Dashboard → 프로젝트 → Settings → Environment Variables에서 추가하세요. 로컬 테스트는 react-app/.env 파일을 사용하세요.',
    });
  }

  console.log(`[briefing] Cache MISS — 브리핑 생성 시작 (${fmtKST()})`);
  const startMs = Date.now();

  // ── 시장 데이터 + RSS 병렬 수집 ────────────────────────────
  const [items, newsItems] = await Promise.all([
    collectMarketSnapshot(),
    collectRSSNews(15),
  ]);

  if (items.length === 0) {
    return res.status(500).json({
      error: '시장 데이터 수집 실패 — 브리핑을 생성할 수 없습니다.',
    });
  }

  const collectMs = Date.now() - startMs;
  console.log(`[briefing] 데이터 수집 완료 (${(collectMs / 1000).toFixed(1)}s): 지표=${items.length}종 뉴스=${newsItems.length}개`);

  // ── AI 호출 ────────────────────────────────────────────────
  const prompt = buildPrompt(items, newsItems);

  let aiData;
  try {
    aiData = await callAnthropicAPI(apiKey, prompt);
  } catch (e) {
    console.error(`[briefing] Anthropic API 실패: ${e.message}`);
    return res.status(500).json({
      error: `AI 브리핑 생성 실패: ${e.message}`,
    });
  }

  // ── 응답 파싱 ──────────────────────────────────────────────
  const briefingText = aiData?.content?.[0]?.text ?? '';
  const usage        = aiData?.usage ?? {};
  const totalMs      = Date.now() - startMs;

  console.log(
    `[briefing] 완료 (${(totalMs / 1000).toFixed(1)}s)  ` +
    `input=${usage.input_tokens ?? '?'}tok  output=${usage.output_tokens ?? '?'}tok  ` +
    `뉴스=${newsItems.length}개  지표=${items.length}종`
  );

  const data = {
    briefing:     briefingText,
    generated_at: fmtKST(),
    market_count: items.length,
    news_count:   newsItems.length,
    news_sources: [...new Set(newsItems.map(n => n.source))],
    usage: {
      model:         MODEL,
      input_tokens:  usage.input_tokens  ?? null,
      output_tokens: usage.output_tokens ?? null,
    },
    cached: false,
  };

  briefingCache = { data, timestamp: Date.now() };

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(data);
}
