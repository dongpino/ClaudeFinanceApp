/**
 * api/briefing.js — AI 시장 브리핑 서버리스 함수
 *
 * GET /api/briefing
 *   → 6종목 시장 지표 + 한국 경제 뉴스 RSS를 Anthropic AI에게 주고
 *     오늘의 시장 브리핑(한국어)을 생성해 반환.
 *
 * ───────────────────────── 비용 정보 ──────────────────────────
 *  모델:  claude-haiku-4-5-20251001  (Anthropic 최저가 모델)
 *  입력:  ~700~1,000 토큰 (지표 6종 + 뉴스 8개 헤드라인 + 고정 system 프롬프트)
 *  출력:  ~350~600 토큰   (마크다운 소제목 구조, 500자 내외 한국어 브리핑)
 *  1회:   ~$0.001 안팎  ← 매우 저렴
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

// 비용 통제: 출력 최대 1000 토큰 (마크다운 소제목 구조 + 500자 내외 한국어 본문)
const MAX_OUTPUT_TOKENS = 1000;

// 프롬프트에 포함할 뉴스 헤드라인 수
const NEWS_HEADLINES_FOR_PROMPT = 8;

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
// system: 고정된 역할·해석 원칙·출력 형식 (지표 나열이 아니라 지표 간 관계로 해석시킴)
// user:   그날그날 바뀌는 실제 데이터(지표 수치·뉴스 헤드라인)만 담음

function buildSystemPrompt() {
  return `당신은 한국 개인 투자자를 위한 시장 브리핑을 작성하는 애널리스트입니다.

[해석 원칙]
- 지표를 하나씩 개별로 나열하지 말고, 지표들 사이의 관계로 엮어서 해석하십시오.
  예: VIX 상승과 주가지수 하락이 함께 나타나면 위험회피 심리로, 원/달러 상승과 코스피 하락이 겹치면 외국인 수급 이탈 우려로, 비트코인과 나스닥이 동반 하락하면 위험자산 전반의 회피 심리로 엮어서 설명하십시오.
- 제시된 수치는 해석의 근거로만 인용하고, 수치 나열 자체가 목적이 되지 않게 하십시오.
- 뉴스 헤드라인은 지표 움직임과 실제로 연관되는 것 위주로만 언급하고, 무관한 헤드라인은 무시하십시오.
- 확정적 예측이나 매수·매도 같은 투자 조언은 하지 마십시오.

[출력 형식 — 아래 마크다운 구조를 그대로 따르고, 전체 500자 내외로 간결하게 작성]
## 오늘의 핵심
(오늘 시장 분위기를 규정하는 한 줄)

## 지표 해석
(지표 간 관계 중심의 해석, 2~4문장)

## 뉴스 연결
- (지표 움직임과 연관된 뉴스 시사점 1)
- (시사점 2, 필요시 3까지)

## 관전 포인트
- (오늘 또는 내일 주목할 점 1)
- (필요시 2까지)

⚠️ (이 브리핑이 투자 권유가 아니라는 점을 한 문장으로 명시)

반드시 한국어로, 위 형식(제목의 ## 표기, 목록의 - 표기, 마지막 줄의 ⚠️ 표기 포함)을 정확히 지켜 작성하십시오.`;
}

function buildUserPrompt(items, newsItems) {
  const sign = n => (n >= 0 ? '+' : '') + Number(n).toFixed(2);

  const marketSection = items.map(it => {
    const price = it.price != null ? it.price.toLocaleString('en-US') : '?';
    const pct   = it.change_pct != null ? `${sign(it.change_pct)}%` : '?';
    return `- ${it.name}: ${price} (${pct})`;
  }).join('\n');

  const newsSection = newsItems.length > 0
    ? newsItems.map((n, i) => `${i + 1}. [${n.source}] ${n.title}`).join('\n')
    : '(뉴스 RSS 수집 실패 — 시장 지표만으로 해석)';

  return `[시장 지표]
${marketSection}

[경제 뉴스 헤드라인]
${newsSection}

위 데이터를 바탕으로 오늘의 시장 브리핑을 작성하세요.`;
}

// ── Anthropic API 호출 ────────────────────────────────────────

async function callAnthropicAPI(apiKey, systemPrompt, userPrompt) {
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
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
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

  // ── API 키 확인 (fail-fast — 없으면 수집·AI 호출 자체를 하지 않음) ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.',
      hint: 'Vercel Dashboard → 프로젝트 → Settings → Environment Variables에서 추가하세요. 로컬 테스트는 react-app/.env.local 파일을 사용하세요.',
    });
  }

  console.log(`[briefing] Cache MISS — 브리핑 생성 시작 (${fmtKST()})`);
  const startMs = Date.now();

  // ── 시장 데이터 + RSS 병렬 수집 ────────────────────────────
  const [items, newsItems] = await Promise.all([
    collectMarketSnapshot(),
    collectRSSNews(NEWS_HEADLINES_FOR_PROMPT),
  ]);

  if (items.length === 0) {
    return res.status(500).json({
      error: '시장 데이터 수집 실패 — 브리핑을 생성할 수 없습니다.',
    });
  }

  const collectMs = Date.now() - startMs;
  console.log(`[briefing] 데이터 수집 완료 (${(collectMs / 1000).toFixed(1)}s): 지표=${items.length}종 뉴스=${newsItems.length}개`);

  // ── AI 호출 ────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt();
  const userPrompt   = buildUserPrompt(items, newsItems);

  let aiData;
  try {
    aiData = await callAnthropicAPI(apiKey, systemPrompt, userPrompt);
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
