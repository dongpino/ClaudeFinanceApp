/**
 * api/macro-insight.js — 매크로 카드(FOMC/CPI/실업률) 개별 해석 (Haiku 1회 호출)
 *
 * GET /api/macro-insight
 *   → api/macro.js가 이미 채워둔 macro:v1 캐시(FRED 재호출 없음)를 읽어 Haiku에게
 *     세 지표 각각의 짧은 해석을 1회 호출로 받아온다.
 *
 * 응답: { fomc, cpi, unemployment[, krRate] } — 앞 셋은 필수, krRate(한국 기준금리 +
 *      한미 금리차 해석)는 macro:v1에 bok 필드가 있을 때만 함께 생성/반환한다(하위호환:
 *      bok 없는 구 캐시면 3필드 그대로). macro:v1이 아직 없거나 fomc.rate/cpi/unemployment
 *      중 하나라도 없으면(수집 진행 중, 전체 실패 등) 애초에 Haiku를 부르지 않고 null을
 *      반환한다(부분 지표만 있는 경우는 다루지 않음).
 *
 * 캐시 키에 지표 수치 자체를 스냅샷으로 넣는다 — macro:insight:{lower}_{upper}-{cpiYoy}-
 * {unemploymentRate}. 수치가 그대로면(같은 발표 주기 내 재방문) 같은 키로 캐시 HIT,
 * 수치가 바뀌면(새 발표) 키가 통째로 달라져 자동으로 새로 생성된다 — 별도 무효화 로직 불필요.
 * TTL 24시간. Haiku 호출/JSON 파싱이 실패하면 이 함수는 아무 것도 캐시에 쓰지 않고
 * null을 반환한다(briefing-core.js의 "실패를 캐시하지 않는다" 원칙과 동일 — 실패를
 * 캐시하면 TTL이 끝날 때까지 재시도 자체가 막혀버린다).
 *
 * 일일 상한: briefing-core.js와 동일한 패턴(날짜별 카운터, 초과 시 신규 호출 안 함)을
 * 그대로 재사용한다 — 이 엔드포인트는 스냅샷 캐시 덕에 실제로는 "지표가 바뀔 때만"
 * 호출되므로 상한에 걸릴 일이 거의 없지만, 데이터가 요동치는 이상 상황에서의
 * 안전장치로 둔다.
 *
 * 환경변수: ANTHROPIC_API_KEY(필수 — 없으면 null 반환), KV_REST_API_URL/KV_REST_API_TOKEN
 *           (선택 — 없으면 캐시/상한 없이 매번 새로 생성, macro.js와 동일한 폴백 방식).
 */

import { Redis } from '@upstash/redis';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL             = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 500; // 지표당 1~2문장 3개 + JSON 오버헤드 — 넉넉히 잡아도 소액
const AI_TIMEOUT_MS     = 15_000;

const MACRO_CACHE_KEY = 'macro:v1'; // api/macro.js가 쓰는 캐시 키 그대로 재사용(FRED 재호출 없음)
const INSIGHT_CACHE_TTL_SEC = 24 * 60 * 60; // 24시간

const DAILY_COUNT_TTL_SEC    = 24 * 60 * 60;
const DAILY_GENERATION_LIMIT = 20; // briefing-core.js와 동일한 값 — 스냅샷 캐시가 있어 실제로는 거의 도달하지 않음

function kstDateBucket(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}`;
}

// ── Redis 캐시 (macro.js/briefing-core.js와 동일 패턴: 지연 생성, 실패 시 null 폴백) ──
let redisClient; // undefined: 아직 시도 안 함, null: 생성 실패/키 없음, Redis: 정상

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[macro-insight] KV_REST_API_URL/KV_REST_API_TOKEN 없음 — Redis 캐시 비활성화');
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
    console.error('[macro-insight] macro:v1 조회 실패:', e.message);
    return null;
  }
}

async function getCachedInsight(key) {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(key);
  } catch (e) {
    console.error('[macro-insight] Redis GET 실패 — 캐시 없이 진행:', e.message);
    return null;
  }
}

async function setCachedInsight(key, data) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, data, { ex: INSIGHT_CACHE_TTL_SEC });
  } catch (e) {
    console.error('[macro-insight] Redis 저장 실패(응답 자체는 정상 반환):', e.message);
  }
}

async function getDailyCount(dayKey) {
  const r = getRedis();
  if (!r) return 0;
  try {
    const v = await r.get(dayKey);
    return Number(v) || 0;
  } catch (e) {
    console.error('[macro-insight] Redis 카운터 조회 실패 — 0으로 간주:', e.message);
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
    console.error('[macro-insight] Redis 카운터 증가 실패:', e.message);
  }
}

// 캐시 키에 지표 수치 자체를 스냅샷으로 새긴다 — 요구사항 그대로
// "macro:insight:{미금리}-{cpi}-{실업률}[-kr{한국금리}]" 형태(미 금리는 상/하단을 _로
// 묶어 한 세그먼트로). 한국 기준금리가 있으면 한·미 금리 값이 모두 키에 박혀, 둘 중
// 어느 쪽이 바뀌어도(한국은행 or FOMC 결정) 키가 달라져 한미 금리차 해석이 자동으로
// 새로 생성된다 — 별도 무효화 로직 불필요. bok가 없으면 기존 3지표 키 그대로(하위호환).
function snapshotKey(macro) {
  const rate = `${macro.fomc.rate.lower}_${macro.fomc.rate.upper}`;
  const bok = macro.bok?.rate != null ? `-kr${macro.bok.rate}` : '';
  return `macro:insight:${rate}-${macro.cpi.yoy}-${macro.unemployment.rate}${bok}`;
}

// ── 프롬프트 ──────────────────────────────────────────────────
// hasBok: 한국 기준금리(+한미 금리차) 해석까지 요청하는지. macro.bok가 있을 때만 켜서
// 출력 형식·제약·입력 섹션을 4번째 지표까지 확장한다(없으면 기존 3지표 그대로 — 하위호환).
function buildSystemPrompt(hasBok) {
  const outputFormat = hasBok
    ? `{"fomc": "...", "cpi": "...", "unemployment": "...", "krRate": "..."}`
    : `{"fomc": "...", "cpi": "...", "unemployment": "..."}`;
  const krConstraint = hasBok
    ? `\n- krRate 항목은 예외적으로 "한국 기준금리"와 "한미 정책금리차" 두 가지를 함께 다뤄도 됩니다(그 둘은 하나의 주제로 봅니다). 단, 금리차가 환율·자본유출입에 미칠 영향을 단정하거나 예측하지 말고, 제공된 실제 수치에 근거한 사실 서술에 그치십시오.
- 한미 금리차를 언급할 때는 반드시 입력에 제공된 '상단 기준'/'하단 기준' %p 수치를 그대로 인용하십시오(대표값은 상단 기준). 미국 목표범위 상·하단의 중앙값·평균처럼 제공되지 않은 새 기준이나 수치를 직접 만들어 계산하지 마십시오.`
    : '';
  return `당신은 한국 개인 투자자를 위해 개별 경제지표를 짧게 해설하는 애널리스트입니다.

[제약]
- 각 지표에 대해 정확히 1~2문장, 한국어로 작성하십시오.
- 각 해석은 그 지표의 현재 수준·최근 추세·다음 예정 이벤트(제공된 경우)만 다루십시오.
- 다른 지표를 언급하거나 여러 지표를 연결해서 해석하지 마십시오 — 각 지표는 완전히 독립적으로 서술하십시오.${krConstraint}
- 금리 인하·동결·인상 전망 등 통화정책 방향에 대한 결론이나 예측을 내리지 마십시오. 사실 서술에 그치십시오.
- 확정적 시장 예측이나 매수·매도 같은 투자 조언을 하지 마십시오.
- 제공되지 않은 수치나 사건을 추측하거나 만들어내지 마십시오. 특히 금리차 등 수치는 반드시 제공된 값만 쓰고 직접 재계산하거나 바꾸지 마십시오.
- "내일", "N일 후", "이번 주"처럼 캐시된 뒤 시간이 지나면 틀려지는 상대적 날짜 표현을 쓰지 마십시오. 다음 발표·회의 일정을 언급할 필요가 있으면 "다음 발표를 앞두고"처럼 날짜에 의존하지 않는 표현만 사용하십시오.
- 수치를 단순히 반복해서 서술하지 마십시오. 해당 수치가 추세상 어느 위치인지(상승·하락·횡보), 역사적으로 높은·낮은·중립적인 수준인지 등 맥락과 의미 위주로 서술하십시오.

[출력 형식]
아래 JSON 형식으로만 응답하십시오. 그 외 어떤 텍스트도, 마크다운 코드펜스(\`\`\`)도, 서두 인사말도 포함하지 말고 JSON 객체 하나만 반환하십시오:
${outputFormat}`;
}

function buildUserPrompt(macro, hasBok) {
  const { fomc, cpi, unemployment } = macro;
  const fomcNext = fomc.next
    ? `다음 회의: ${fomc.next.start}~${fomc.next.end}(D-${fomc.next.dDay})`
    : '다음 회의 정보 없음';
  const cpiNext = cpi.next
    ? `다음 발표: ${cpi.next.date} ${cpi.next.kstTime}(D-${cpi.next.dDay})`
    : '다음 발표 정보 없음';
  const cpiTrend = Array.isArray(cpi.trend) && cpi.trend.length > 0
    ? cpi.trend.map(t => t.yoy).join(', ')
    : '추세 데이터 없음';
  // unemployment.history는 macro.js가 이 필드를 추가하기 전에 저장된 캐시(macro:v1이
  // TTL 만료 전이거나 latest 승계본)에는 없을 수 있다 — optional 처리, 없으면 CPI와
  // 마찬가지로 "추세 데이터 없음"으로 대체하고 나머지 파이프라인은 그대로 동작한다.
  const unemploymentTrend = Array.isArray(unemployment.history) && unemployment.history.length > 0
    ? unemployment.history.map(h => h.rate).join(', ')
    : '추세 데이터 없음';

  return `[FOMC 기준금리]
현재 목표범위: ${fomc.rate.lower}~${fomc.rate.upper}% (기준일 ${fomc.rate.asOf})
${fomcNext}

[CPI(소비자물가, YoY)]
최근 수치: ${cpi.yoy}% (전월비 ${cpi.mom > 0 ? '+' : ''}${cpi.mom}%, 기준월 ${cpi.refMonth})
최근 12개월 YoY 추세(오래된순): ${cpiTrend}
${cpiNext}

[실업률]
최근 수치: ${unemployment.rate}% (기준월 ${unemployment.refMonth})
최근 12개월 추세(오래된순): ${unemploymentTrend}
${hasBok ? '\n' + buildBokSection(macro) + '\n' : ''}
위 ${hasBok ? '네' : '세'} 지표 각각에 대해 지정된 JSON 형식으로 해석을 작성하세요.`;
}

// [한국 기준금리 / 한미 금리차] 섹션 — 한국 현재값 + 직전 변경 + 최근 12개월 계단형
// 추세 + 미국 목표범위 + 금리차(한국−미국)를 상/하단 모두 실제 수치로 미리 계산해 넣는다.
// 모델이 직접 재계산하지 않도록 값을 완제품으로 제공한다(system prompt의 "제공된 값만
// 쓰라"와 짝을 이룸).
function buildBokSection(macro) {
  const { bok, fomc } = macro;
  const lc = bok.lastChange
    ? `직전 변경: ${bok.lastChange.date} ${bok.lastChange.deltaPp > 0 ? '+' : ''}${bok.lastChange.deltaPp}%p (${bok.lastChange.direction === 'up' ? '인상' : '인하'})`
    : '직전 변경: 최근 24개월 내 변경 없음';
  // history는 월별 [{date, close}] — 최근 12개만 오래된순으로.
  const trend = Array.isArray(bok.history) && bok.history.length > 0
    ? bok.history.slice(-12).map(h => h.close).join(', ')
    : '추세 데이터 없음';
  // 금리차는 소수 2자리 고정 문자열로 박아, 모델이 자체 계산할 여지를 없앤다(미국은
  // 단일 금리가 아니라 목표범위라 상/하단 둘 다 제공하되 '상단 기준'을 대표값으로 명시).
  const fmt = n => (Math.round(n * 100) / 100).toFixed(2);
  const spreadUpper = fmt(bok.rate - fomc.rate.upper); // 한국 − 미국 상단(대표값)
  const spreadLower = fmt(bok.rate - fomc.rate.lower); // 한국 − 미국 하단
  return `[한국 기준금리 / 한미 금리차]
한국 기준금리(한국은행): ${bok.rate}% (기준일 ${bok.asOf})
${lc}
최근 12개월 추세(오래된순): ${trend}
미국 기준금리 목표범위: ${fomc.rate.lower}~${fomc.rate.upper}% (기준일 ${fomc.rate.asOf})
한미 정책금리차(한국 기준금리 − 미국 목표범위, 음수 = 한국이 낮음):
  · 대표값(상단 기준): ${spreadUpper}%p
  · 하단 기준: ${spreadLower}%p
이 두 %p 수치만 사용하고, 중앙값 등 다른 기준을 새로 만들지 마십시오.`;
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
function parseInsightJSON(text, hasBok) {
  let s = text.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) s = fenced[1].trim();
  const parsed = JSON.parse(s); // 실패 시 호출부의 try/catch로 전파
  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof parsed.fomc !== 'string' || !parsed.fomc.trim() ||
    typeof parsed.cpi !== 'string' || !parsed.cpi.trim() ||
    typeof parsed.unemployment !== 'string' || !parsed.unemployment.trim()
  ) {
    throw new Error('응답 JSON에 fomc/cpi/unemployment 문자열이 모두 있어야 함');
  }
  // krRate는 hasBok일 때만 필수 — 없으면 전체를 실패 처리해 캐시하지 않고 재시도를 남긴다.
  if (hasBok && (typeof parsed.krRate !== 'string' || !parsed.krRate.trim())) {
    throw new Error('응답 JSON에 krRate 문자열이 있어야 함(bok 요청 시)');
  }
  const out = { fomc: parsed.fomc.trim(), cpi: parsed.cpi.trim(), unemployment: parsed.unemployment.trim() };
  if (hasBok) out.krRate = parsed.krRate.trim();
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  res.setHeader('Cache-Control', 'no-store');

  const macro = await getMacroSnapshot();
  // 세 지표가 모두 있어야 해석을 생성한다 — 하나라도 없으면(수집 진행 중, 부분 장애
  // 등) 조용히 null(1단계 범위 — 부분 지표 대응은 나중 단계).
  if (!macro?.fomc?.rate || !macro?.cpi || !macro?.unemployment) {
    res.setHeader('X-Cache', 'SKIP');
    return res.status(200).json(null);
  }

  const hasBok = macro.bok?.rate != null; // 한국 기준금리(+한미 금리차) 해석까지 요청할지
  const key = snapshotKey(macro);

  const cached = await getCachedInsight(key);
  if (cached) {
    console.log(`[macro-insight] Redis 캐시 HIT (${key}) — Anthropic 호출 없음`);
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    console.warn('[macro-insight] ANTHROPIC_API_KEY 없음 — null 반환');
    res.setHeader('X-Cache', 'SKIP');
    return res.status(200).json(null);
  }

  const dayKey = `macro:insight:count:${kstDateBucket()}`;
  const dailyCount = await getDailyCount(dayKey);
  if (dailyCount >= DAILY_GENERATION_LIMIT) {
    console.warn(`[macro-insight] 일일 생성 상한(${DAILY_GENERATION_LIMIT}) 도달 — Anthropic 호출 없음, null 반환`);
    res.setHeader('X-Cache', 'LIMIT');
    return res.status(200).json(null);
  }

  console.log(`[macro-insight] Redis 캐시 MISS (${key}) — Haiku 호출`);
  let aiData;
  try {
    aiData = await callAnthropicAPI(apiKey, buildSystemPrompt(hasBok), buildUserPrompt(macro, hasBok));
  } catch (e) {
    console.error('[macro-insight] Anthropic API 실패 — 캐시하지 않고 null 반환:', e.message);
    res.setHeader('X-Cache', 'ERROR');
    return res.status(200).json(null);
  }

  const rawText = aiData?.content?.[0]?.text ?? '';
  let insight;
  try {
    insight = parseInsightJSON(rawText, hasBok);
  } catch (e) {
    console.error('[macro-insight] JSON 파싱 실패 — 캐시하지 않고 null 반환:', e.message, '| raw:', rawText.slice(0, 200));
    res.setHeader('X-Cache', 'ERROR');
    return res.status(200).json(null);
  }

  // 성공했을 때만 캐시/카운터에 반영한다 — 실패를 캐시하면 TTL 동안 재시도가 막힌다.
  await setCachedInsight(key, insight);
  await incrementDailyCount(dayKey);

  const usage = aiData?.usage ?? {};
  console.log(
    `[macro-insight] 생성 완료 (${key})  input=${usage.input_tokens ?? '?'}tok  output=${usage.output_tokens ?? '?'}tok`
  );

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(insight);
}
