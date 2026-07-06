/**
 * api/issues.js — 돌발 이슈 감지·분류 (RSS 헤드라인 → Haiku 분류 → 구조적 이벤트만 추출)
 *
 * 국내 금융(연합/한경) + 코인(CoinDesk) 헤드라인 중 최근 24시간 것을 모아 Haiku에
 * 분류시킨다. "코스피 2% 상승" 같은 단순 시세 등락은 제외하고, 시장 구조에 영향을
 * 주는 이벤트(규제/거래소 사고/대형 상장/실적 서프라이즈/급변 이벤트)만 골라낸다.
 * 평온한 날은 빈 배열이 정상 결과다.
 *
 * ───────────────────────── 비용 정보 ──────────────────────────
 *  모델:  claude-haiku-4-5-20251001 (briefing-core.js와 동일)
 *  출력:  최대 800 토큰(JSON 배열, 이벤트 몇 건 수준)
 * ──────────────────────────────────────────────────────────────
 *
 * 캐싱: Upstash Redis, KST 시간 단위 버킷(1시간) — briefing-core.js와 동일 패턴.
 *       Redis 실패 시에는 캐시 없이 매번 새로 분류하는 방식으로 폴백한다.
 * 일일 상한: 하루 24회 분류 — 초과 시 새로 호출하지 않고 최신 캐시를 반환한다.
 * 환경변수: ANTHROPIC_API_KEY (필수), KV_REST_API_URL / KV_REST_API_TOKEN (선택)
 */

import { Redis } from '@upstash/redis';
import { collectIssueSourceNews } from './_collectors/rss.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL             = 'claude-haiku-4-5-20251001';

const MAX_OUTPUT_TOKENS  = 800;
const HEADLINES_FOR_PROMPT = 30;
const AI_TIMEOUT_MS      = 20_000;

const ALLOWED_CATEGORIES = ['regulation', 'exchange', 'listing', 'earnings', 'macro_shock', 'other_major'];

// ── Redis 캐시/상한 설정 (briefing-core.js와 동일 패턴) ────────
const HOURLY_CACHE_TTL_SEC  = 24 * 60 * 60;      // 시간별 캐시 항목 TTL(24시간)
const DAILY_COUNT_TTL_SEC   = 24 * 60 * 60;      // 일일 카운터 TTL(24시간)
const LATEST_TTL_SEC        = 7 * 24 * 60 * 60;  // "가장 최근 캐시" 보존 기간(7일)
const DAILY_GENERATION_LIMIT = 24;               // 하루 생성 상한
const LATEST_KEY             = 'issues:latest';

// ── 유틸 ──────────────────────────────────────────────────────

function kstHourBucket(date = new Date()) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  return `${y}-${mo}-${dy}-${h}`;
}

function kstDateBucket(date = new Date()) {
  return kstHourBucket(date).slice(0, 10);
}

// ── Redis 클라이언트 (지연 생성, 실패 시 null 폴백 — briefing-core.js와 동일 패턴) ──
let redisClient;

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[issues] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — Redis 캐시 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

async function getCachedIssues(hourKey) {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(hourKey);
  } catch (e) {
    console.error('[issues] Redis GET 실패 — 캐시 없이 진행:', e.message);
    return null;
  }
}

async function getLatestIssues() {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(LATEST_KEY);
  } catch (e) {
    console.error('[issues] Redis latest 조회 실패:', e.message);
    return null;
  }
}

async function getDailyCount(dayKey) {
  const r = getRedis();
  if (!r) return 0;
  try {
    const v = await r.get(dayKey);
    return Number(v) || 0;
  } catch (e) {
    console.error('[issues] Redis 카운터 조회 실패 — 0으로 간주:', e.message);
    return 0;
  }
}

async function persistIssues(hourKey, data) {
  const r = getRedis();
  if (!r) return;
  try {
    await Promise.all([
      r.set(hourKey, data, { ex: HOURLY_CACHE_TTL_SEC }),
      r.set(LATEST_KEY, data, { ex: LATEST_TTL_SEC }),
    ]);
  } catch (e) {
    console.error('[issues] Redis 저장 실패(응답 자체는 정상 반환):', e.message);
  }
}

async function incrementDailyCount(dayKey) {
  const r = getRedis();
  if (!r) return;
  try {
    const n = await r.incr(dayKey);
    if (n === 1) await r.expire(dayKey, DAILY_COUNT_TTL_SEC);
  } catch (e) {
    console.error('[issues] Redis 카운터 증가 실패:', e.message);
  }
}

// ── 프롬프트 ─────────────────────────────────────────────────

function buildSystemPrompt() {
  return `당신은 금융·코인 뉴스 헤드라인에서 "시장 구조에 영향을 주는 이벤트"만 선별하는 필터입니다.

[선별 기준 — 아래에 해당하는 것만 골라내고, 그 외에는 전부 무시하십시오]
- regulation: SEC 등 금융당국의 규제·소송·조사·제재
- exchange: 거래소 해킹, 상장폐지, 출금 중단 등 거래소 관련 사고·이슈
- listing: 대형 자산의 신규 상장, 주요 지수 편입·제외
- earnings: 주요 기업의 실적 서프라이즈(시장 예상치를 크게 상회·하회)
- macro_shock: 시장 전반에 충격을 준 급변 이벤트(전쟁, 정책 급변, 시스템 리스크 등)
- other_major: 위에 안 맞지만 시장 구조적으로 중요한 기타 이벤트

단순 시세 등락 기사("코스피 2% 상승", "비트코인 5만달러 돌파" 같은 가격 움직임 자체를 다루는 기사)는
절대 포함하지 마십시오. 위 카테고리에 해당하는 기사가 없으면 빈 배열을 출력하십시오 — 평온한
날은 비어있는 게 정상입니다. 억지로 채우지 마십시오.

[출력 형식]
설명, 인사말, 마크다운 코드블록 없이 아래 JSON 배열만 출력하십시오:
[{"category": "regulation", "title_ko": "한국어 한 줄 요약(30자 내외)", "importance": 2, "source_hint": "매체명 또는 원문 제목 일부"}]

- category는 위 6개 값 중 하나만 사용
- importance: 3=시장 전체에 즉각 영향 가능, 2=해당 섹터·자산에 중요, 1=참고할 만한 수준
- 반드시 유효한 JSON 배열만 출력(순수 JSON, 다른 텍스트 없이)`;
}

function buildUserPrompt(headlines) {
  const list = headlines
    .map((h, i) => `${i + 1}. [${h.source}] ${h.title}`)
    .join('\n');
  return `아래 최근 24시간 헤드라인 중에서 시장 구조적 이벤트만 선별해 JSON 배열로 출력하세요.\n\n${list}`;
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

// 모델 응답 텍스트 → 이슈 배열. 코드펜스가 섞여 나올 가능성에 대비해 벗겨내고,
// 파싱 실패나 형식이 어긋난 항목은 조용히 걸러낸다(빈 배열로 안전하게 폴백).
function parseIssues(text) {
  try {
    const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(it =>
        it && typeof it.title_ko === 'string' && it.title_ko.trim() &&
        ALLOWED_CATEGORIES.includes(it.category) &&
        Number.isInteger(it.importance) && it.importance >= 1 && it.importance <= 3
      )
      .map(it => ({
        category:    it.category,
        title_ko:    it.title_ko.trim(),
        importance:  it.importance,
        source_hint: typeof it.source_hint === 'string' ? it.source_hint.trim() : '',
      }));
  } catch (e) {
    console.warn('[issues] JSON 파싱 실패 — 빈 배열로 폴백:', e.message);
    return [];
  }
}

// ── 핸들러 ─────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const hourKey    = `issues:${kstHourBucket()}`;
  const dateBucket = kstDateBucket();
  const dayKey     = `issues:count:${dateBucket}`;

  const cached = await getCachedIssues(hourKey);
  if (cached) {
    console.log(`[issues] Redis 캐시 HIT (${hourKey}) — Anthropic 호출 없음`);
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({ ...cached, cached: true });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  const dailyCount = await getDailyCount(dayKey);
  if (dailyCount >= DAILY_GENERATION_LIMIT) {
    console.warn(`[issues] 일일 생성 상한(${DAILY_GENERATION_LIMIT}) 도달 — 최신 캐시로 대체`);
    const latest = await getLatestIssues();
    if (latest) {
      res.setHeader('X-Cache', 'LIMIT');
      return res.status(200).json({ ...latest, cached: true, limited: true });
    }
    return res.status(429).json({ error: '오늘 분류 한도에 도달했고, 표시할 캐시도 없습니다.' });
  }

  const startMs = Date.now();
  console.log(`[issues] Redis 캐시 MISS (${hourKey}) — 이슈 분류 시작`);

  try {
    const headlines = await collectIssueSourceNews(HEADLINES_FOR_PROMPT);

    if (headlines.length === 0) {
      const data = { issues: [], generated_at: new Date().toISOString(), headline_count: 0, cached: false };
      await persistIssues(hourKey, data);
      await incrementDailyCount(dayKey);
      res.setHeader('X-Cache', 'MISS');
      return res.status(200).json(data);
    }

    const systemPrompt = buildSystemPrompt();
    const userPrompt    = buildUserPrompt(headlines);
    const aiData = await callAnthropicAPI(apiKey, systemPrompt, userPrompt);
    const text   = aiData?.content?.[0]?.text ?? '[]';
    const issues = parseIssues(text);
    const usage  = aiData?.usage ?? {};

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
      `[issues] 완료 (${elapsed}s) 헤드라인=${headlines.length}개 → 이슈=${issues.length}건  ` +
      `input=${usage.input_tokens ?? '?'}tok output=${usage.output_tokens ?? '?'}tok`
    );

    const data = {
      issues,
      generated_at: new Date().toISOString(),
      headline_count: headlines.length,
      cached: false,
    };

    await persistIssues(hourKey, data);
    await incrementDailyCount(dayKey);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (e) {
    console.error('[issues] 분류 실패:', e.message);
    return res.status(500).json({ error: '이슈 분류 실패', details: e.message });
  }
}
