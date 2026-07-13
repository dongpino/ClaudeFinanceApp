/**
 * api/event-brief.js — 브리핑 이벤트 카드(CPI/FOMC/고용지표)용 "왜 주목받는가" 한줄 맥락
 *
 * GET /api/event-brief?type={cpi|fomc|employment}&date={YYYY-MM-DD}
 *   → 이번 {이벤트}가 왜 특히 주목받는지 2~3문장(한국어)을 Haiku로 생성.
 *     재료: macro:v1(api/macro.js) 스냅샷(기준금리/CPI/실업률) + 다음 FOMC 날짜 +
 *           api/news.js와 동일한 RSS 수집기에서 해당 지표 키워드로 골라낸 헤드라인 3~5건.
 *
 * 캐시 키에 type과 date(쿼리로 받은 이벤트 날짜)를 그대로 넣는다 —
 * macro:eventbrief:v1:{type}:{date}. 날짜가 키에 포함되므로 다음 이벤트(다음 CPI
 * 발표일 등)가 되면 자동으로 새 키가 되어 무효화 로직이 따로 필요 없다. TTL 14일
 * (이벤트 하나가 카드에 노출되는 기간을 넉넉히 덮음).
 *
 * Haiku 호출/JSON 파싱 실패 시 macro-insight.js와 동일하게 캐시를 오염시키지 않고
 * { type, date, context: null }을 200으로 반환한다 — 프론트는 context가 null이면
 * 템플릿 문구만으로 카드를 렌더할 수 있어야 한다(실패 격리).
 *
 * 환경변수: ANTHROPIC_API_KEY(필수 — 없으면 null), KV_REST_API_URL/KV_REST_API_TOKEN
 *           (선택 — 없으면 캐시/상한 없이 매번 새로 생성).
 */

import { Redis } from '@upstash/redis';
import { collectRSSNews } from './_collectors/rss.js';
import { getNextFomcMeeting } from './_lib/macro-calendar.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL             = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 300; // 2~3문장 + JSON 오버헤드
const AI_TIMEOUT_MS     = 15_000;

const MACRO_CACHE_KEY = 'macro:v1'; // api/macro.js가 쓰는 캐시 키 그대로 재사용(FRED 재호출 없음)
const BRIEF_CACHE_TTL_SEC = 14 * 24 * 60 * 60; // 14일

const DAILY_COUNT_TTL_SEC    = 24 * 60 * 60;
const DAILY_GENERATION_LIMIT = 20; // macro-insight.js/briefing-core.js와 동일한 값

const ALLOWED_TYPES = ['cpi', 'fomc', 'employment'];

const EVENT_LABEL = {
  cpi:        'CPI(소비자물가) 발표',
  fomc:       'FOMC 회의',
  employment: '고용지표(실업률) 발표',
};

// 뉴스 헤드라인을 지표별로 골라내기 위한 키워드 — rss.js의 MARKET_KEYWORDS보다 좁게,
// 해당 지표에 직접 관련된 것만.
const EVENT_KEYWORDS = {
  cpi:        ['CPI', '물가', '소비자물가', '인플레이션'],
  fomc:       ['FOMC', '연준', 'Fed', '기준금리', '금리', '파월'],
  employment: ['고용', '실업률', '비농업', '일자리', '고용지표'],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateStr(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// "YYYY-MM-DD" → "7월 14일" (제약: 캐시된 텍스트가 나중에 읽혀도 틀리지 않도록 상대
// 표현 대신 이 절대 표기를 프롬프트에 못박아 둔다)
function formatKoreanMonthDay(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}월 ${d}일`;
}

function kstDateBucket(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}`;
}

// ── Redis 캐시 (macro-insight.js와 동일 패턴: 지연 생성, 실패 시 null 폴백) ──
let redisClient; // undefined: 아직 시도 안 함, null: 생성 실패/키 없음, Redis: 정상

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[event-brief] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — Redis 캐시 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

async function getMacroSnapshot() {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(MACRO_CACHE_KEY);
  } catch (e) {
    console.error('[event-brief] macro:v1 조회 실패:', e.message);
    return null;
  }
}

async function getCachedBrief(key) {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(key);
  } catch (e) {
    console.error('[event-brief] Redis GET 실패 — 캐시 없이 진행:', e.message);
    return null;
  }
}

async function setCachedBrief(key, context) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, context, { ex: BRIEF_CACHE_TTL_SEC });
  } catch (e) {
    console.error('[event-brief] Redis 저장 실패(응답 자체는 정상 반환):', e.message);
  }
}

async function getDailyCount(dayKey) {
  const r = getRedis();
  if (!r) return 0;
  try {
    const v = await r.get(dayKey);
    return Number(v) || 0;
  } catch (e) {
    console.error('[event-brief] Redis 카운터 조회 실패 — 0으로 간주:', e.message);
    return 0;
  }
}

async function incrementDailyCount(dayKey) {
  const r = getRedis();
  if (!r) return;
  try {
    const n = await r.incr(dayKey);
    if (n === 1) await r.expire(dayKey, DAILY_COUNT_TTL_SEC);
  } catch (e) {
    console.error('[event-brief] Redis 카운터 증가 실패:', e.message);
  }
}

// 최신순 정렬 후 지표 키워드로 필터링해 3~5건만 추림. 관련 기사가 없으면 빈 배열
// (프롬프트에서 "관련 뉴스 없음"으로 처리 — Haiku가 없는 기사를 지어내지 않도록 한다).
function pickRelevantNews(items, type) {
  const keywords = EVENT_KEYWORDS[type] ?? [];
  const sorted = [...items].sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const matched = sorted.filter(it => {
    const text = `${it.title} ${it.summary}`;
    return keywords.some(kw => text.includes(kw));
  });
  return matched.slice(0, 5);
}

// ── 프롬프트 ──────────────────────────────────────────────────
function buildSystemPrompt() {
  return `당신은 한국 개인 투자자를 위해 다가오는 경제 이벤트가 왜 주목받는지 짧게 설명하는 애널리스트입니다.

[제약]
- 정확히 2~3문장, 한국어로 작성하십시오.
- "시장이 주목하는 이유"를 설명하는 데 집중하십시오 — 이벤트 결과를 예측하거나 투자 방향(매수·매도, 금리 인하·동결·인상 전망)을 단정하지 마십시오.
- "내일", "이번 주", "곧", "다가오는" 등 캐시된 뒤 시간이 지나면 틀려지는 상대적 시간 표현을 절대 쓰지 마십시오. 날짜를 언급해야 하면 반드시 절대 표기(예: "7월 14일")만 사용하십시오.
- 제공된 수치(기준금리, CPI, 실업률 등)를 단순히 다시 나열하지 마십시오. 그 수치가 왜 이번 이벤트를 특별히 만드는지, 맥락과 의미 위주로 서술하십시오.
- 제공되지 않은 수치나 뉴스, 사건을 추측하거나 만들어내지 마십시오. 관련 뉴스가 없다고 제공되면 뉴스를 언급하지 마십시오.

[출력 형식]
아래 JSON 형식으로만 응답하십시오. 그 외 어떤 텍스트도, 마크다운 코드펜스(\`\`\`)도, 서두 인사말도 포함하지 말고 JSON 객체 하나만 반환하십시오:
{"context": "..."}`;
}

function buildUserPrompt({ type, date, macro, news }) {
  const label = EVENT_LABEL[type];
  const absDate = formatKoreanMonthDay(date);

  const rateLine = macro?.fomc?.rate
    ? `현재 기준금리 목표범위: ${macro.fomc.rate.lower}~${macro.fomc.rate.upper}%`
    : '현재 기준금리 정보 없음';
  const cpiLine = macro?.cpi
    ? `최근 CPI: YoY ${macro.cpi.yoy}%, 전월비 ${macro.cpi.mom > 0 ? '+' : ''}${macro.cpi.mom}% (기준월 ${macro.cpi.refMonth})`
    : '최근 CPI 정보 없음';
  const unemploymentLine = macro?.unemployment
    ? `최근 실업률: ${macro.unemployment.rate}% (기준월 ${macro.unemployment.refMonth})`
    : '최근 실업률 정보 없음';
  const nextFomc = getNextFomcMeeting();
  const nextFomcLine = nextFomc
    ? `다음 FOMC 회의: ${nextFomc.start}~${nextFomc.end}`
    : '다음 FOMC 회의 정보 없음';

  const newsLines = news.length > 0
    ? news.map((n, i) => `${i + 1}. ${n.title}`).join('\n')
    : '관련 뉴스 없음';

  return `[이번 이벤트]
${label} — 날짜: ${absDate}

[현재 매크로 스냅샷]
${rateLine}
${cpiLine}
${unemploymentLine}
${nextFomcLine}

[관련 최신 뉴스 헤드라인]
${newsLines}

이번 ${label}(${absDate})가 왜 특히 주목받는지 지정된 JSON 형식으로 작성하세요.`;
}

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

// 모델이 지침을 어기고 ```json ... ``` 코드펜스나 앞뒤 텍스트를 붙이는 경우까지
// 방어적으로 벗겨내고 파싱한다 — 그래도 실패하면 호출부가 null 처리한다.
function parseBriefJSON(text) {
  let s = text.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) s = fenced[1].trim();
  const parsed = JSON.parse(s); // 실패 시 호출부의 try/catch로 전파
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.context !== 'string' || !parsed.context.trim()) {
    throw new Error('응답 JSON에 context 문자열이 있어야 함');
  }
  return parsed.context.trim();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  res.setHeader('Cache-Control', 'no-store');

  const { type, date } = req.query;

  if (!ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({ error: `type은 ${ALLOWED_TYPES.join('|')} 중 하나여야 합니다` });
  }
  if (typeof date !== 'string' || !isValidDateStr(date)) {
    return res.status(400).json({ error: 'date는 YYYY-MM-DD 형식의 유효한 날짜여야 합니다' });
  }

  const key = `macro:eventbrief:v1:${type}:${date}`;

  const cached = await getCachedBrief(key);
  if (cached) {
    console.log(`[event-brief] Redis 캐시 HIT (${key}) — Anthropic 호출 없음`);
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({ type, date, context: cached });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    console.warn('[event-brief] ANTHROPIC_API_KEY 없음 — null 반환');
    res.setHeader('X-Cache', 'SKIP');
    return res.status(200).json({ type, date, context: null });
  }

  const dayKey = `macro:eventbrief:count:${kstDateBucket()}`;
  const dailyCount = await getDailyCount(dayKey);
  if (dailyCount >= DAILY_GENERATION_LIMIT) {
    console.warn(`[event-brief] 일일 생성 상한(${DAILY_GENERATION_LIMIT}) 도달 — Anthropic 호출 없음, null 반환`);
    res.setHeader('X-Cache', 'LIMIT');
    return res.status(200).json({ type, date, context: null });
  }

  const macro = await getMacroSnapshot();
  const allNews = await collectRSSNews(30).catch(e => {
    console.error('[event-brief] RSS 수집 실패 — 뉴스 없이 진행:', e.message);
    return [];
  });
  const news = pickRelevantNews(allNews, type);

  console.log(`[event-brief] Redis 캐시 MISS (${key}) — Haiku 호출`);
  let aiData;
  try {
    aiData = await callAnthropicAPI(apiKey, buildSystemPrompt(), buildUserPrompt({ type, date, macro, news }));
  } catch (e) {
    console.error('[event-brief] Anthropic API 실패 — 캐시하지 않고 null 반환:', e.message);
    res.setHeader('X-Cache', 'ERROR');
    return res.status(200).json({ type, date, context: null });
  }

  const rawText = aiData?.content?.[0]?.text ?? '';
  let context;
  try {
    context = parseBriefJSON(rawText);
  } catch (e) {
    console.error('[event-brief] JSON 파싱 실패 — 캐시하지 않고 null 반환:', e.message, '| raw:', rawText.slice(0, 200));
    res.setHeader('X-Cache', 'ERROR');
    return res.status(200).json({ type, date, context: null });
  }

  // 성공했을 때만 캐시/카운터에 반영한다 — 실패를 캐시하면 TTL 동안 재시도가 막힌다.
  await setCachedBrief(key, context);
  await incrementDailyCount(dayKey);

  const usage = aiData?.usage ?? {};
  console.log(
    `[event-brief] 생성 완료 (${key})  input=${usage.input_tokens ?? '?'}tok  output=${usage.output_tokens ?? '?'}tok`
  );

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json({ type, date, context });
}
