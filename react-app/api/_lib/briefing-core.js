/**
 * api/_lib/briefing-core.js — AI 시장 브리핑 생성/캐시 핵심 로직
 *
 * api/briefing.js(버튼 클릭, 공개 GET)와 api/briefing-cron.js(Vercel Cron,
 * CRON_SECRET 인증)가 공유한다 — 두 경로 모두 동일한 캐시·상한·히스토리
 * 저장 로직을 거치며, cron이라고 해서 특별 취급하지 않는다.
 *
 * ───────────────────────── 비용 정보 ──────────────────────────
 *  모델:  claude-haiku-4-5-20251001  (Anthropic 최저가 모델)
 *  입력:  ~1,000~1,300 토큰 (지표 6종 + 뉴스 8개 헤드라인 + 매크로/캘린더/이슈
 *         압축 컨텍스트(+~300 토큰) + 고정 system 프롬프트)
 *  출력:  ~350~600 토큰   (마크다운 소제목 구조, 500자 내외 한국어 브리핑)
 *  1회:   ~$0.001 안팎  ← 매우 저렴
 * ──────────────────────────────────────────────────────────────
 *
 * 매크로/캘린더/이슈 컨텍스트: api/macro.js·api/issues.js가 이미 Redis에 캐시해둔
 * 결과를 그대로 읽어 재사용한다(FRED·Haiku 재호출 없음 — 비용 추가 없이 맥락만 주입).
 * 셋 중 어느 하나가 없거나 실패해도 해당 부분만 "정보 없음"으로 비우고 나머지로 정상 생성한다.
 *
 * 캐싱: Upstash Redis, KST 시간 단위 버킷(1시간) — 서버리스 콜드 스타트와 무관하게 유지됨.
 *       Redis 연결·조회 실패 시에는 캐시 없이 기존처럼 매번 생성하는 방식으로 폴백한다.
 * 일일 상한: 하루 20회 생성 — 초과 시 새로 생성하지 않고 가장 최근 캐시를 반환한다.
 * 히스토리: 생성 성공 시 briefing:day:{YYYY-MM-DD}에도 저장(그날의 마지막 브리핑, TTL 30일)하고
 *           briefing:days(sorted set)에 날짜를 색인 — 조회는 api/briefing-history.js 참고.
 * 환경변수: ANTHROPIC_API_KEY (필수), KV_REST_API_URL / KV_REST_API_TOKEN (Upstash Redis, 선택 —
 *           없으면 캐시·상한·히스토리 기능 없이 매번 생성만 수행)
 */

import { Redis }             from '@upstash/redis';
import { collectBTC }        from '../_collectors/btc.js';
import { collectUSIndices }  from '../_collectors/us-indices.js';
import { collectKR }         from '../_collectors/kr.js';
import { collectRSSNews }    from '../_collectors/rss.js';
import { getUpcomingEvents } from './macro-calendar.js';

// ── 상수 ──────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL             = 'claude-haiku-4-5-20251001';

// 비용 통제: 출력 최대 1000 토큰 (마크다운 소제목 구조 + 500자 내외 한국어 본문)
const MAX_OUTPUT_TOKENS = 1000;

// 프롬프트에 포함할 뉴스 헤드라인 수
const NEWS_HEADLINES_FOR_PROMPT = 8;

// ── 추가 컨텍스트(매크로/캘린더/이슈) 설정 — 각각 다른 API가 이미 채워둔 캐시를 재사용 ──
const MACRO_CACHE_KEY          = 'macro:v1';        // api/macro.js가 쓰는 캐시 키 그대로 재사용
const ISSUES_LATEST_KEY        = 'issues:latest';   // api/issues.js가 쓰는 최신 캐시 키 그대로 재사용
const CALENDAR_LOOKAHEAD_DAYS  = 14;                // 캘린더 조회 범위
const CALENDAR_MAX_FOR_PROMPT  = 8;                 // 프롬프트에 싣는 최대 이벤트 수(~100토큰 목표)
const ISSUES_MIN_IMPORTANCE    = 2;                 // 이 미만은 프롬프트에서 제외
const ISSUES_MAX_FOR_PROMPT    = 5;                 // 프롬프트에 싣는 최대 이슈 수(~150토큰 목표)

// AI 요청 타임아웃: Vercel 서버리스 최대 실행 시간 고려
const AI_TIMEOUT_MS = 20_000;

// ── Redis 캐시/상한 설정 ─────────────────────────────────────
const HOURLY_CACHE_TTL_SEC = 24 * 60 * 60;       // 시간별 캐시 항목 TTL(24시간)
const DAILY_COUNT_TTL_SEC  = 24 * 60 * 60;       // 일일 카운터 TTL(24시간)
const LATEST_TTL_SEC       = 7 * 24 * 60 * 60;   // "가장 최근 캐시" 보존 기간(여유있게 7일)
const DAILY_GENERATION_LIMIT = 20;               // 하루 생성 상한
const LATEST_KEY             = 'briefing:latest';

// ── 히스토리(일별 아카이브) 설정 ───────────────────────────────
// briefing:day:{YYYY-MM-DD} — 그날의 마지막 브리핑(같은 날 재생성되면 덮어씀), TTL 30일.
// briefing:days              — sorted set(member=날짜, score=타임스탬프)으로 날짜 인덱스 관리.
//                               api/briefing-history.js가 목록 조회 시점에 30일 지난 멤버를 정리한다.
const DAY_ARCHIVE_TTL_SEC = 30 * 24 * 60 * 60;   // 일별 아카이브 TTL(30일)
const DAYS_INDEX_KEY      = 'briefing:days';

// ── 유틸 ──────────────────────────────────────────────────────

export function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

// "YYYY-MM-DD-HH" (KST) — 시간별 캐시 키 버킷
function kstHourBucket(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  return `${y}-${mo}-${dy}-${h}`;
}

// "YYYY-MM-DD" (KST) — 일일 카운터 키
function kstDateBucket(date = new Date()) {
  return kstHourBucket(date).slice(0, 10);
}

// ── Redis 클라이언트 (지연 생성, 환경변수 없으면 null → 호출부에서 폴백) ──
let redisClient;   // undefined: 아직 시도 안 함, null: 생성 실패/키 없음, Redis: 정상

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[briefing] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — Redis 캐시 비활성화');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

// 아래 Redis 헬퍼들은 모두 실패 시 예외를 던지지 않고 로그만 남긴 뒤
// "캐시가 없는 것처럼" 동작하는 값을 반환한다(장애 시 기능이 죽지 않게).

async function getCachedBriefing(hourKey) {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(hourKey);
  } catch (e) {
    console.error('[briefing] Redis GET 실패 — 캐시 없이 진행:', e.message);
    return null;
  }
}

async function getLatestBriefing() {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(LATEST_KEY);
  } catch (e) {
    console.error('[briefing] Redis latest 조회 실패:', e.message);
    return null;
  }
}

// api/macro.js가 저장해둔 매크로 스냅샷을 그대로 읽는다(FRED 재호출 없음).
// 캐시가 없거나(TTL 만료, macro.js 미호출 등) Redis 자체가 없으면 null — 호출부가 "정보 없음"으로 처리.
async function getCachedMacro() {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(MACRO_CACHE_KEY);
  } catch (e) {
    console.error('[briefing] 매크로 캐시 조회 실패 — 컨텍스트 없이 진행:', e.message);
    return null;
  }
}

// api/issues.js가 저장해둔 최신 이슈 분류 결과를 그대로 읽는다(Haiku 재호출 없음).
async function getCachedIssuesLatest() {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(ISSUES_LATEST_KEY);
  } catch (e) {
    console.error('[briefing] 이슈 캐시 조회 실패 — 컨텍스트 없이 진행:', e.message);
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
    console.error('[briefing] Redis 카운터 조회 실패 — 0으로 간주:', e.message);
    return 0;
  }
}

async function persistBriefing(hourKey, data) {
  const r = getRedis();
  if (!r) return;
  try {
    await Promise.all([
      r.set(hourKey, data, { ex: HOURLY_CACHE_TTL_SEC }),
      r.set(LATEST_KEY, data, { ex: LATEST_TTL_SEC }),
    ]);
  } catch (e) {
    console.error('[briefing] Redis 저장 실패(응답 자체는 정상 반환):', e.message);
  }
}

async function incrementDailyCount(dayKey) {
  const r = getRedis();
  if (!r) return;
  try {
    const n = await r.incr(dayKey);
    if (n === 1) await r.expire(dayKey, DAILY_COUNT_TTL_SEC); // 오늘 첫 생성일 때만 TTL 설정
  } catch (e) {
    console.error('[briefing] Redis 카운터 증가 실패:', e.message);
  }
}

// 일별 아카이브 저장 + 날짜 인덱스(zadd) 갱신 — 같은 날 재생성되면 덮어써서
// "그날의 마지막 브리핑"만 남는다. 히스토리 기능 전용이라 실패해도 기존
// 시간별 캐시(persistBriefing)와 무관하게 동작해야 하므로 별도 호출로 분리.
async function persistDayArchive(dateBucket, data) {
  const r = getRedis();
  if (!r) return;
  try {
    await Promise.all([
      r.set(`briefing:day:${dateBucket}`, data, { ex: DAY_ARCHIVE_TTL_SEC }),
      r.zadd(DAYS_INDEX_KEY, { score: Date.now(), member: dateBucket }),
    ]);
  } catch (e) {
    console.error('[briefing] 일별 아카이브 저장 실패:', e.message);
  }
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

// ── 추가 컨텍스트 압축(매크로/캘린더/이슈) ──────────────────────
// 각각 실패/부재 시 null을 반환 — 호출부(buildUserPrompt)가 "정보 없음"으로 대체한다.

// 매크로 스냅샷 → 한 줄 압축(~50토큰): "기준금리 X~Y%, CPI YoY Z%(전월비 ..., 기준월), 실업률 ..."
function buildMacroContext(macro) {
  if (!macro) return null;
  const parts = [];
  if (macro.fomc?.rate) {
    parts.push(`기준금리 ${macro.fomc.rate.lower}~${macro.fomc.rate.upper}%`);
  }
  if (macro.cpi) {
    const mom = macro.cpi.mom;
    const momStr = mom != null ? `${mom >= 0 ? '+' : ''}${mom}%` : '?';
    parts.push(`CPI YoY ${macro.cpi.yoy}%(전월비 ${momStr}, ${macro.cpi.refMonth} 기준)`);
  }
  if (macro.unemployment) {
    parts.push(`실업률 ${macro.unemployment.rate}%(${macro.unemployment.refMonth})`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

// D-day 표기: 오늘=D-0(오늘), 미래=D-n, 진행 중(FOMC 이틀 회의 등 dDay<0)=진행중
function formatDday(dDay) {
  if (dDay < 0) return '진행중';
  if (dDay === 0) return 'D-0(오늘)';
  return `D-${dDay}`;
}

// 캘린더 이벤트 라벨 — macro-calendar.js가 칩용으로 이미 만들어둔 shortLabel을 재사용하되
// CPI/선물옵션만기처럼 지역 구분이 의미 있는 카테고리만 국가명을 붙인다.
function calendarEventLabel(ev) {
  if (ev.category === 'cpi')    return `미국 ${ev.shortLabel}`;
  if (ev.category === 'expiry') return `${ev.region === 'KR' ? '한국' : '미국'} ${ev.shortLabel}`;
  return ev.shortLabel;
}

// 향후 N일 이벤트 → D-day 목록(~100토큰, 최대 CALENDAR_MAX_FOR_PROMPT건)
function buildCalendarContext(events) {
  if (!events || events.length === 0) return null;
  return events
    .slice(0, CALENDAR_MAX_FOR_PROMPT)
    .map(ev => `- ${calendarEventLabel(ev)} ${formatDday(ev.dDay)}`)
    .join('\n');
}

const ISSUE_CATEGORY_LABEL = {
  regulation:  '규제',
  exchange:    '거래소',
  listing:     '상장',
  earnings:    '실적',
  macro_shock: '매크로충격',
  other_major: '기타',
};

// 이슈 캐시 → importance 2 이상만, 최대 ISSUES_MAX_FOR_PROMPT건(~150토큰)
function buildIssuesContext(issuesData) {
  const list = (issuesData?.issues ?? [])
    .filter(it => it.importance >= ISSUES_MIN_IMPORTANCE)
    .slice(0, ISSUES_MAX_FOR_PROMPT);
  if (list.length === 0) return null;
  return list
    .map(it => `- [${ISSUE_CATEGORY_LABEL[it.category] ?? it.category}] ${it.title_ko}`)
    .join('\n');
}

// ── 프롬프트 생성 ──────────────────────────────────────────────
// system: 고정된 역할·해석 원칙·출력 형식 (지표 나열이 아니라 지표 간 관계로 해석시킴)
// user:   그날그날 바뀌는 실제 데이터(지표 수치·뉴스 헤드라인·매크로/캘린더/이슈 컨텍스트)만 담음

function buildSystemPrompt() {
  return `당신은 한국 개인 투자자를 위한 시장 브리핑을 작성하는 애널리스트입니다.

[해석 원칙]
- 지표를 하나씩 개별로 나열하지 말고, 지표들 사이의 관계로 엮어서 해석하십시오.
  예: VIX 상승과 주가지수 하락이 함께 나타나면 위험회피 심리로, 원/달러 상승과 코스피 하락이 겹치면 외국인 수급 이탈 우려로, 비트코인과 나스닥이 동반 하락하면 위험자산 전반의 회피 심리로 엮어서 설명하십시오.
- 제시된 수치는 해석의 근거로만 인용하고, 수치 나열 자체가 목적이 되지 않게 하십시오.
- 뉴스 헤드라인은 지표 움직임과 실제로 연관되는 것 위주로만 언급하고, 무관한 헤드라인은 무시하십시오.
- 확정적 예측이나 매수·매도 같은 투자 조언은 하지 마십시오.

[컨텍스트 활용 원칙]
- 매크로/캘린더/이슈는 참고 배경일 뿐, 시장 움직임과 무관하면 언급하지 마십시오.
- D-0(당일) 이벤트는 오늘의 핵심이나 지표 해석에, D-3 이내 이벤트는 관전 포인트에 반영하십시오.
- 이슈가 뉴스 헤드라인과 겹치면 한 번만 언급하십시오.

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

function buildUserPrompt(items, newsItems, macroContext, calendarContext, issuesContext) {
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

[매크로 배경]
${macroContext ?? '정보 없음'}

[다가오는 이벤트 (${CALENDAR_LOOKAHEAD_DAYS}일 이내)]
${calendarContext ?? '정보 없음'}

[최근 이슈]
${issuesContext ?? '정보 없음'}

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

// ── 핵심 로직 ────────────────────────────────────────────────
// 호출자(api/briefing.js, api/briefing-cron.js)는 req/res를 몰라도 되도록
// { status, cacheStatus, body } 형태로 결과를 반환한다 — cacheStatus는
// X-Cache 헤더용('HIT'|'MISS'|'LIMIT'), 에러 응답이면 null.

export async function getOrGenerateBriefing() {
  const hourKey    = `briefing:${kstHourBucket()}`;
  const dateBucket = kstDateBucket();
  const dayKey     = `briefing:count:${dateBucket}`;

  // ── 서버 캐시 확인 (KST 시간 단위 버킷) ──────────────────────
  const cached = await getCachedBriefing(hourKey);
  if (cached) {
    console.log(`[briefing] Redis 캐시 HIT (${hourKey}) — Anthropic 호출 없음`);
    return { status: 200, cacheStatus: 'HIT', body: { ...cached, cached: true } };
  }

  // ── API 키 확인 (fail-fast — 없으면 수집·AI 호출 자체를 하지 않음) ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    return {
      status: 500,
      cacheStatus: null,
      body: {
        error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.',
        hint: 'Vercel Dashboard → 프로젝트 → Settings → Environment Variables에서 추가하세요. 로컬 테스트는 react-app/.env.local 파일을 사용하세요.',
      },
    };
  }

  // ── 일일 생성 상한 확인 ──────────────────────────────────────
  const dailyCount = await getDailyCount(dayKey);
  if (dailyCount >= DAILY_GENERATION_LIMIT) {
    console.warn(`[briefing] 일일 생성 상한(${DAILY_GENERATION_LIMIT}) 도달(${dayKey}) — 최신 캐시로 대체, Anthropic 호출 없음`);
    const latest = await getLatestBriefing();
    if (latest) {
      return { status: 200, cacheStatus: 'LIMIT', body: { ...latest, cached: true, limited: true } };
    }
    return {
      status: 429,
      cacheStatus: null,
      body: { error: '오늘 생성 한도에 도달했고, 표시할 캐시된 브리핑도 없습니다. 잠시 후 다시 시도해주세요.' },
    };
  }

  console.log(`[briefing] Redis 캐시 MISS (${hourKey}) — 브리핑 생성 시작 (${fmtKST()})`);
  const startMs = Date.now();

  // ── 시장 데이터 + RSS + 매크로/이슈 캐시 병렬 수집 ───────────
  // 매크로/이슈는 각각 api/macro.js, api/issues.js가 채워둔 Redis 캐시를 읽기만 하므로
  // FRED·Haiku 재호출이 없다 — 실패해도(캐시 없음 등) null로 조용히 폴백한다.
  const [items, newsItems, macroCached, issuesCached] = await Promise.all([
    collectMarketSnapshot(),
    collectRSSNews(NEWS_HEADLINES_FOR_PROMPT),
    getCachedMacro(),
    getCachedIssuesLatest(),
  ]);

  if (items.length === 0) {
    return {
      status: 500,
      cacheStatus: null,
      body: { error: '시장 데이터 수집 실패 — 브리핑을 생성할 수 없습니다.' },
    };
  }

  const calendarEvents   = getUpcomingEvents(CALENDAR_LOOKAHEAD_DAYS);
  const macroContext     = buildMacroContext(macroCached);
  const calendarContext  = buildCalendarContext(calendarEvents);
  const issuesContext    = buildIssuesContext(issuesCached);

  const collectMs = Date.now() - startMs;
  console.log(
    `[briefing] 데이터 수집 완료 (${(collectMs / 1000).toFixed(1)}s): 지표=${items.length}종 뉴스=${newsItems.length}개  ` +
    `매크로=${macroContext ? 'OK' : '없음'} 캘린더=${calendarContext ? calendarEvents.length + '건' : '없음'} 이슈=${issuesContext ? 'OK' : '없음'}`
  );

  // ── AI 호출 ────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt();
  const userPrompt   = buildUserPrompt(items, newsItems, macroContext, calendarContext, issuesContext);

  let aiData;
  try {
    aiData = await callAnthropicAPI(apiKey, systemPrompt, userPrompt);
  } catch (e) {
    console.error(`[briefing] Anthropic API 실패: ${e.message}`);
    return { status: 500, cacheStatus: null, body: { error: `AI 브리핑 생성 실패: ${e.message}` } };
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

  // Redis 저장 + 일일 카운터 증가 + 일별 아카이브(히스토리용) — 생성에 성공했을 때만 수행한다.
  await persistBriefing(hourKey, data);
  await incrementDailyCount(dayKey);
  await persistDayArchive(dateBucket, data);

  return { status: 200, cacheStatus: 'MISS', body: data };
}
