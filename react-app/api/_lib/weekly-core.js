/**
 * api/_lib/weekly-core.js — 주간 브리핑 생성 코어 (1단계: 백엔드)
 *
 * 일일 브리핑(api/_lib/briefing-core.js)과 **완전히 분리된 경로**다. 일일이 "그날의 스냅샷
 * 하나"를 해석한다면, 주간은 일별 스냅샷으로는 원리상 볼 수 없는 두 축을 낸다.
 *   (A) 추세와 전환점 — 연속성, 방향 전환, 동력 변화. 원본 시계열(signals:daily)이 재료다.
 *   (B) 예측 대조 — 그 주 일일 브리핑들이 예고한 "관전 포인트"가 실제로 어떻게 됐는지.
 *
 * 생성: 토요일 09:30 KST 크론(api/weekly-cron.js) / 수동 재생성(api/weekly-briefing.js).
 * 모델: Sonnet(claude-sonnet-5). 일일은 Haiku이고 주간만 상위 모델을 쓴다 — 주 1회라
 *       비용 영향이 작고, 추세 해석과 예측 대조는 단순 요약보다 어려운 작업이다.
 *
 * 저장: briefing:week:{YYYY-Www} (ISO 주 번호), 인덱스는 briefing:weeks(별도 zset).
 *
 * ⚠️ briefing:days zset에는 절대 넣지 않는다. api/briefing-history.js:104가 그 zset을
 *    통째로 훑어 날짜 칩 줄을 만들기 때문에, 주간 키를 섞으면 일일 UI가 오염된다.
 *
 * ⚠️ TTL 없음(영구). 일일 아카이브는 30일(briefing-core.js의 DAY_ARCHIVE_TTL_SEC)이지만
 *    주간은 주 1회라 1년에 52건뿐이고, 오래 남을수록 (B) 예측 대조의 재료가 두꺼워진다.
 *
 * 환경변수: ANTHROPIC_API_KEY(필수), KV_REST_API_URL / KV_REST_API_TOKEN(필수 — 시계열과
 *           일일 브리핑을 모두 KV에서 읽으므로 Redis 없이는 생성 자체가 불가능하다).
 */

import { Redis } from '@upstash/redis';
import { getRecentSnapshots } from './significance.js';
import { fmtKST, dayArchiveKey } from './briefing-core.js';

// ── Anthropic 설정 ────────────────────────────────────────────
// 이 프로젝트는 Anthropic 호출을 전부 raw fetch로 한다(briefing-core.js:609, issues.js 등).
// SDK를 여기서만 들이면 호출 방식이 두 갈래가 되므로 기존 관용을 따른다.
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL             = 'claude-sonnet-5';

// ⚠️ Sonnet 5는 thinking 필드를 생략하면 **adaptive thinking이 켜진 상태**가 기본이고,
//    max_tokens는 thinking + 응답 텍스트를 **합쳐서** 제한한다. 일일(Haiku 4.5)의
//    max_tokens=1000 감각으로 잡으면 thinking이 예산을 다 먹고 본문이 중간에 잘린다.
//    실측(2026-W31, 지표 8종 + 일일 브리핑 7건 입력): thinking 약 3,500tok + 본문 약 480tok
//    에서 4000에 걸려 stop_reason=max_tokens로 잘렸다. thinking을 끄는 대신 예산을 늘렸다 —
//    잘린 출력에서도 "월~목 4거래일 연속 급락 후 금요일 반전" 같은 추세 서술이 나왔고,
//    그게 이 브리핑의 존재 이유이므로 사고 과정을 깎을 이유가 없다.
const MAX_OUTPUT_TOKENS = 8000;
const AI_TIMEOUT_MS     = 60_000;   // 일일(20초)보다 길다: 상위 모델 + 더 긴 출력

// ── KV 키 ─────────────────────────────────────────────────────
const WEEK_KEY_PREFIX = 'briefing:week:';
const WEEKS_INDEX_KEY = 'briefing:weeks';       // zset(member=YYYY-Www, score=주 시작일 ts)
const WEEK_COUNT_KEY  = 'briefing:week:count:'; // 수동 재생성 폭주 방지용 일일 카운터
const WEEK_DAILY_LIMIT   = 10;
const WEEK_COUNT_TTL_SEC = 24 * 60 * 60;

// 주간 프롬프트에 싣는 지표 — 코스피/코스닥/환율/나스닥/필라델피아반도체/VIX(브리핑 6종)에
// 위험자산·금리 맥락 2종을 더한 8종. 18종 전부를 5일치 시계열로 실으면 프롬프트가 지표
// 나열로 뒤덮여 "추세" 서술이 묻힌다.
// market: 거래일 수를 시장별로 세기 위한 구분. 휴장은 시장마다 다르다 — 제헌절(2026-07-17)은
// 국내만 휴장이라 그 주 코스피는 4거래일, 나스닥은 5거래일이었다(실측). 하나의 숫자로 합치면
// (max를 쓰든 min을 쓰든) 한쪽 휴장이 지워진다.  fx/crypto는 거래 달력이 달라 계수에서 뺀다.
const WEEKLY_SERIES = [
  { id: 'kospi',  name: '코스피',            market: 'kr' },
  { id: 'kosdaq', name: '코스닥',            market: 'kr' },
  { id: 'usdkrw', name: '원/달러',           market: 'fx' },
  { id: 'nasdaq', name: '나스닥',            market: 'us' },
  { id: 'sox',    name: '필라델피아 반도체',  market: 'us' },
  { id: 'vix',    name: 'VIX',              market: 'us' },
  { id: 'btc',    name: '비트코인',          market: 'crypto' },
  { id: 'us10y',  name: '미국 10년물',       market: 'us' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Redis ─────────────────────────────────────────────────────
let redisClient;
function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error('[weekly] KV_REST_API_URL/KV_REST_API_TOKEN 없음');
    redisClient = null;
  } else {
    redisClient = new Redis({ url, token });
  }
  return redisClient;
}

// ── 날짜 유틸 ─────────────────────────────────────────────────
// 프로젝트 공통 관용: "KST 날짜"는 UTC 자정 Date로 표현하고 getUTC*로만 읽는다.
// (significance.js:91 kstMidnightScore와 같은 사고방식)

/** 지금 시각의 KST 달력 날짜를 UTC 자정 Date로 */
function kstTodayUTC(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()));
}

function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { return new Date(d.getTime() + n * DAY_MS); }

/**
 * ISO 8601 주 번호. 주는 **월요일에 시작**하고, 1주차는 **그 해 첫 목요일이 속한 주**다.
 * 그래서 주 번호의 연도(isoYear)는 달력 연도와 다를 수 있다 — 2027-01-01(금)은 2026-W53에
 * 속한다. 연말연시에 키가 어긋나지 않도록 목요일 기준으로 연도를 뽑는다.
 */
function isoWeekParts(dateUTC) {
  const t = new Date(dateUTC.getTime());
  const dayNum = (t.getUTCDay() + 6) % 7;          // 월=0 … 일=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3);        // 그 주의 목요일
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));   // 1월 4일은 항상 1주차에 속한다
  const jan4Thu = new Date(jan4.getTime());
  jan4Thu.setUTCDate(jan4Thu.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((t.getTime() - jan4Thu.getTime()) / (7 * DAY_MS));
  return { isoYear, week };
}

/** ISO 주 라벨 "YYYY-Www" */
export function isoWeekLabel(dateUTC) {
  const { isoYear, week } = isoWeekParts(dateUTC);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** 그 날짜가 속한 ISO 주의 월요일 */
function isoMondayOf(dateUTC) {
  return addDays(dateUTC, -((dateUTC.getUTCDay() + 6) % 7));
}

/** "YYYY-Www" → 그 주의 월요일(UTC 자정 Date). 형식이 틀리면 null */
export function mondayOfWeekLabel(label) {
  const m = /^(\d{4})-W(\d{2})$/.exec(label ?? '');
  if (!m) return null;
  const isoYear = Number(m[1]), week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Monday = addDays(jan4, -((jan4.getUTCDay() + 6) % 7));
  const monday = addDays(jan4Monday, (week - 1) * 7);
  // 53주가 없는 해에 W53을 넣으면 다음 해로 넘어간다 — 되짚어 검증한다.
  return isoWeekLabel(monday) === label ? monday : null;
}

export function weekArchiveKey(label) { return `${WEEK_KEY_PREFIX}${label}`; }

// ── (A) 시계열 수집 ───────────────────────────────────────────
//
// ⚠️ 스냅샷 날짜 D의 값은 **직전 거래일 종가**다(30/30 실측 확정, 2026-08-07).
//    signals:daily는 08:30 KST 크론이 쌓는데 그 시각엔 KR장이 열리기 전이고 미국장은
//    이미 닫혀 있다. 그래서 "화요일 스냅샷 = 월요일 종가", "토요일 스냅샷 = 금요일 종가".
//    한 칸 밀림을 반영해 이렇게 자른다:
//      · 기준선(주 시작 직전 종가) = **월요일** 스냅샷 (= 지난 금요일 종가)
//      · 그 주 월~금 종가          = **화~토** 스냅샷 (라벨 = 스냅샷 날짜 − 1일)
//    화−1=월 … 토−1=금 으로 정확히 맞아떨어진다.
//
// ⚠️ 주간 등락을 change_pct **합산으로 구하면 안 된다.** 각 스냅샷의 change_pct는 하루치
//    이고, 토요일 스냅샷의 prev_close는 목요일 종가라 그 값은 금요일 하루치다. 합산은
//    복리도 무시하고 휴장일 반복분을 중복으로 더한다. 그래서 양 끝 종가로 직접 계산한다:
//        주간 등락 = (토요일 스냅샷 종가 − 월요일 스냅샷 종가) / 월요일 스냅샷 종가 × 100
//    = (그 주 마지막 거래일 종가 − 그 주 첫 거래일 직전 종가) / 후자
//
// 휴장 판정: 새 거래일이 열리면 price와 prev_close가 **함께** 한 칸씩 밀린다. 둘 다
// 직전 스냅샷과 같으면 그 사이에 세션이 없었다는 뜻이다(주말·휴장). 종가가 우연히 같아도
// prev_close까지 같을 수는 없으므로 가격 비교만 하는 것보다 견고하다.

function sameSession(a, b) {
  return a && b && a.price === b.price && a.prev_close === b.prev_close;
}

async function collectWeekSeries(monday) {
  const today = kstTodayUTC();
  // 요청 일수: 목표 주 월요일까지 닿게 하되 보존 한도(30일) 안에서. 달력일 기준이므로
  // 토요일 정시 실행이면 6일(월~토), 지난 주를 재생성하면 자동으로 더 넓게 잡는다.
  const spanDays = Math.round((today.getTime() - monday.getTime()) / DAY_MS) + 1;
  const days = Math.min(30, Math.max(6, spanDays));

  const snaps = await getRecentSnapshots(days);
  // timestamp는 fmtKST() 형식("YYYY-MM-DD HH:MM KST") — 앞 10자가 KST 달력 날짜다.
  const byDate = new Map();
  for (const s of snaps ?? []) {
    const d = typeof s?.timestamp === 'string' ? s.timestamp.slice(0, 10) : null;
    if (d) byDate.set(d, s);
  }

  const pick = n => byDate.get(ymd(addDays(monday, n))) ?? null;
  const baseline = pick(0);                       // 월요일 스냅샷
  const rawWeek  = [1, 2, 3, 4, 5].map(pick);     // 화~토 스냅샷

  const indicatorOf = (snap, id) => {
    const it = snap?.indicators?.find(x => x.id === id);
    return it && it.fetched ? it : null;
  };

  const series = [];
  for (const { id, name, market } of WEEKLY_SERIES) {
    const base = indicatorOf(baseline, id);
    const points = [];
    let prevKept = base;
    for (let i = 0; i < rawWeek.length; i++) {
      const cur = indicatorOf(rawWeek[i], id);
      if (!cur) continue;
      // 직전 채택분과 (price, prev_close)가 같으면 새 세션이 아니다 → 휴장으로 보고 버린다.
      if (sameSession(cur, prevKept)) continue;
      points.push({
        date:  ymd(addDays(monday, i)),           // 스냅샷 날짜 − 1일 = 실제 거래일
        close: cur.price,
        dayPct: cur.change_pct,
      });
      prevKept = cur;
    }
    if (!base || points.length === 0) continue;

    const last = points[points.length - 1];
    series.push({
      id, name, market,
      baselineClose: base.price,                  // 주 시작 직전 종가
      lastClose:     last.close,
      // ★ 직접 계산 — change_pct 합산이 아니다(위 주석 참고)
      weekPct: base.price ? ((last.close - base.price) / base.price) * 100 : null,
      points,
    });
  }

  // 시장별 거래일 수. 같은 시장 안에서는 지표끼리 달력이 같으므로 최대값을 쓴다
  // (한 지표가 수집 실패한 날이 있어도 시장 전체의 거래일 수는 보존된다).
  const countFor = m => Math.max(0, ...series.filter(s => s.market === m).map(s => s.points.length));
  const tradingDays = { kr: countFor('kr'), us: countFor('us') };
  return { series, tradingDays, baselineDate: ymd(monday) };
}

// ── (B) 지난 관전 포인트 추출 ─────────────────────────────────
// 저장된 브리핑은 구조화된 필드가 아니라 마크다운 한 덩어리다(briefing 문자열). 형식은
// 일일 system 프롬프트(briefing-core.js:566-568)가 고정하고 있어 정규식으로 잘리지만,
// 형식이 흔들린 날을 대비해 **전문 폴백**을 둔다 — 7일 전문이 약 5K 토큰이라 분량이
// 병목이 아니므로, 파싱 실패 시 통째로 넘기는 편이 그 날을 통째로 버리는 것보다 낫다.

function extractSection(text, heading) {
  if (typeof text !== 'string') return null;
  const re = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n⚠️|$)`);
  const m = re.exec(text);
  const body = m?.[1]?.trim();
  return body ? body : null;
}

async function collectLastWeekWatchpoints(monday) {
  const r = getRedis();
  if (!r) return { entries: [], extracted: 0, fallback: 0, found: 0 };

  const dates = Array.from({ length: 7 }, (_, i) => ymd(addDays(monday, i))); // 월~일
  const rows = await Promise.all(dates.map(async d => {
    try {
      const [morning, manual] = await Promise.all([
        r.get(dayArchiveKey(d, 'morning')),
        r.get(dayArchiveKey(d, 'manual')),
      ]);
      const entry = morning ?? manual ?? null;
      return { date: d, briefing: entry?.briefing ?? null };
    } catch (e) {
      console.error(`[weekly] ${d} 일일 브리핑 조회 실패:`, e.message);
      return { date: d, briefing: null };
    }
  }));

  const entries = [];
  let extracted = 0, fallback = 0, found = 0;
  for (const { date, briefing } of rows) {
    if (!briefing) continue;
    found++;
    const watch = extractSection(briefing, '관전 포인트');
    const news  = extractSection(briefing, '뉴스 연결');
    if (watch) {
      extracted++;
      entries.push({ date, watch, news, whole: null });
    } else {
      fallback++;
      entries.push({ date, watch: null, news, whole: briefing });
    }
  }
  return { entries, extracted, fallback, found };
}

// ── 프롬프트 ──────────────────────────────────────────────────

function buildWeeklySystemPrompt() {
  return `당신은 한국 개인 투자자를 위한 **주간** 시장 브리핑을 작성하는 애널리스트입니다.

[이 브리핑의 존재 이유]
매일 나가는 일일 브리핑이 이미 있습니다. 그러므로 하루치 스냅샷만 봐도 알 수 있는 것을
다시 쓰면 이 브리핑은 가치가 없습니다. 하루치로는 원리상 볼 수 없는 것만 쓰십시오.
- 연속성: 며칠 연속 같은 방향인가
- 전환점: 주 중 어느 시점에 방향이 바뀌었는가
- 동력 변화: 주 초와 주 후반의 상승/하락 동력이 다른가

[해석 원칙]
- [주간 시계열]의 일별 종가 흐름을 근거로 서술하십시오. 주간 등락률은 이미 계산해 두었으니
  그대로 인용하고, 일별 등락률을 더해서 주간 등락을 다시 만들지 마십시오.
- 지표를 하나씩 나열하지 말고 지표 간 관계로 엮으십시오.
- 거래일 수는 시장마다 다르게 적혀 있습니다. 5일보다 적으면 그 시장에 휴장이 있었다는
  뜻이고, 국내와 미국이 다르면 한쪽만 쉰 것입니다. 흐름 해석에 필요할 때만 언급하십시오.
- 확정적 예측이나 매수·매도 같은 투자 조언은 하지 마십시오.
- 제공된 데이터에 없는 수치나 사건을 만들어내지 마십시오. 모르면 언급하지 마십시오.

[지난 관전 포인트 점검 원칙]
- [지난 관전 포인트]는 그 주 일일 브리핑들이 예고한 확인 사항입니다. 각 항목이 실제로
  어떻게 됐는지 [주간 시계열]과 대조해 "예고 → 실제" 형태로 되짚으십시오.
- 맞았으면 맞았다고, 빗나갔으면 빗나갔다고 쓰십시오. 데이터로 판정할 수 없는 항목은
  판정할 수 없다고 밝히십시오. 유리한 것만 골라 쓰지 마십시오.
- 원문 전체가 실린 날짜는 관전 포인트 섹션 추출에 실패한 경우입니다. 본문에서 해당
  내용을 직접 찾아 쓰십시오.

[출력 형식 — 아래 마크다운 구조를 그대로 따르고, 전체 1000자 내외]
## 이번 주 요약
(이번 주를 규정하는 1~2문장)

## 추세와 전환점
(연속성·방향 전환·동력 변화 중심, 3~5문장)

## 지난주 관전 포인트 점검
- (예고했던 것 → 실제로 어떻게 됐는지 1)
- (2, 필요시 3까지)

## 다음 주 관전 포인트
- (다음 주 주목할 점 1)
- (2, 필요시 3까지)

⚠️ (이 브리핑이 투자 권유가 아니라는 점을 한 문장으로 명시)

반드시 한국어로, 위 형식(제목의 ## 표기, 목록의 - 표기, 마지막 줄의 ⚠️ 표기 포함)을
정확히 지켜 작성하십시오.`;
}

function sign(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(2); }

function buildWeeklyUserPrompt({ label, weekStart, weekEnd, tradingDays, series, watch }) {
  const seriesSection = series.length > 0
    ? series.map(s => {
        const path = s.points.map(p => `${p.date.slice(5)} ${p.close}`).join(' → ');
        return `- ${s.name}: 주간 ${sign(s.weekPct)}% (주 시작 직전 종가 ${s.baselineClose} → 주 마지막 거래일 종가 ${s.lastClose})\n  일별: ${path}`;
      }).join('\n')
    : '(시계열 없음)';

  const watchSection = watch.entries.length > 0
    ? watch.entries.map(e => {
        if (e.watch) {
          const news = e.news ? `\n  [그날의 뉴스 연결]\n${e.news.replace(/^/gm, '  ')}` : '';
          return `[${e.date}] 관전 포인트\n${e.watch.replace(/^/gm, '  ')}${news}`;
        }
        return `[${e.date}] (관전 포인트 섹션 추출 실패 — 그날 브리핑 전문)\n${e.whole.replace(/^/gm, '  ')}`;
      }).join('\n\n')
    : '(그 주에 저장된 일일 브리핑이 없습니다)';

  return `[대상 주] ${label} (${weekStart} ~ ${weekEnd}, 월~금)
[거래일 수] 국내 ${tradingDays.kr}일 / 미국 ${tradingDays.us}일

[주간 시계열] — 주간 등락률은 양 끝 종가로 직접 계산한 값입니다
${seriesSection}

[지난 관전 포인트] — 이 주의 일일 브리핑들이 예고했던 확인 사항
${watchSection}

위 데이터를 바탕으로 이번 주 주간 브리핑을 작성하세요.`;
}

// ── Anthropic 호출 ────────────────────────────────────────────
// 일일의 callAnthropicAPI()는 model/max_tokens를 상수로 박아 쓰므로 재사용하려면 그 함수를
// 고쳐야 한다. 일일 경로를 건드리지 않기 위해 여기에 주간 전용으로 따로 둔다.
async function callAnthropicWeekly(apiKey, systemPrompt, userPrompt) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: ctrl.signal,
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

// ── 저장 ──────────────────────────────────────────────────────
async function persistWeekly(label, monday, data) {
  const r = getRedis();
  if (!r) return;
  try {
    // TTL 없음 — 주 1회라 1년 52건이고, 오래 남을수록 (B)의 재료가 두꺼워진다.
    // 일일 아카이브(30일 TTL)와 의도적으로 다르다.
    await r.set(weekArchiveKey(label), data);
    // 인덱스는 briefing:days가 아니라 전용 zset. briefing-history.js:104가 briefing:days를
    // 통째로 훑어 일일 날짜 칩을 만들기 때문에 섞으면 그 UI가 오염된다.
    await r.zadd(WEEKS_INDEX_KEY, { score: monday.getTime(), member: label });
    console.log(`[weekly] 저장 완료 (${label})`);
  } catch (e) {
    console.error('[weekly] 저장 실패(응답 자체는 정상 반환):', e.message);
  }
}

async function incrementWeeklyCount(dayKey) {
  const r = getRedis();
  if (!r) return 0;
  try {
    const n = await r.incr(dayKey);
    if (n === 1) await r.expire(dayKey, WEEK_COUNT_TTL_SEC);
    return n;
  } catch (e) {
    console.error('[weekly] 카운터 증가 실패:', e.message);
    return 0;
  }
}

// ── 조회 ──────────────────────────────────────────────────────
export async function getWeeklyBriefing(label) {
  const r = getRedis();
  if (!r) return null;
  try {
    return await r.get(weekArchiveKey(label));
  } catch (e) {
    console.error('[weekly] 조회 실패:', e.message);
    return null;
  }
}

export async function listWeeklyLabels() {
  const r = getRedis();
  if (!r) return [];
  try {
    return (await r.zrange(WEEKS_INDEX_KEY, 0, -1, { rev: true })) ?? [];
  } catch (e) {
    console.error('[weekly] 목록 조회 실패:', e.message);
    return [];
  }
}

// ── 핵심 ──────────────────────────────────────────────────────
/**
 * 주간 브리핑 생성. 호출부(weekly-cron.js / weekly-briefing.js)가 req/res를 몰라도 되도록
 * { status, body } 형태로 돌려준다.
 *
 * @param {string=} weekLabel  대상 주("YYYY-Www"). 생략하면 오늘(KST)이 속한 ISO 주.
 * @param {boolean=} force     이미 저장된 주도 다시 생성한다(기본은 기존본 반환).
 */
export async function generateWeeklyBriefing({ weekLabel = null, force = false } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { status: 500, body: { error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.' } };
  }

  const monday = weekLabel ? mondayOfWeekLabel(weekLabel) : isoMondayOf(kstTodayUTC());
  if (!monday) {
    return { status: 400, body: { error: '잘못된 주 형식입니다 (YYYY-Www)' } };
  }
  const label     = isoWeekLabel(monday);
  const weekStart = ymd(monday);
  const weekEnd   = ymd(addDays(monday, 4)); // 금요일

  if (!force) {
    const existing = await getWeeklyBriefing(label);
    if (existing) {
      console.log(`[weekly] 캐시 HIT (${label})`);
      return { status: 200, body: { ...existing, cached: true } };
    }
  }

  const dayKey = `${WEEK_COUNT_KEY}${ymd(kstTodayUTC())}`;
  const count  = await incrementWeeklyCount(dayKey);
  if (count > WEEK_DAILY_LIMIT) {
    console.warn(`[weekly] 일일 생성 상한(${WEEK_DAILY_LIMIT}) 초과 — 생성 거부`);
    const existing = await getWeeklyBriefing(label);
    if (existing) return { status: 200, body: { ...existing, cached: true, limited: true } };
    return { status: 429, body: { error: `주간 브리핑 일일 생성 상한(${WEEK_DAILY_LIMIT}회)에 도달했습니다.` } };
  }

  console.log(`[weekly] 생성 시작 ${label} (${weekStart}~${weekEnd}) — ${fmtKST()}`);
  const startMs = Date.now();

  const [{ series, tradingDays }, watch] = await Promise.all([
    collectWeekSeries(monday),
    collectLastWeekWatchpoints(monday),
  ]);

  if (series.length === 0 && watch.entries.length === 0) {
    return {
      status: 503,
      body: { error: '해당 주의 시계열과 일일 브리핑이 모두 없어 주간 브리핑을 만들 수 없습니다.' },
    };
  }

  const systemPrompt = buildWeeklySystemPrompt();
  const userPrompt   = buildWeeklyUserPrompt({ label, weekStart, weekEnd, tradingDays, series, watch });

  console.log(
    `[weekly] 입력 준비 (${((Date.now() - startMs) / 1000).toFixed(1)}s): ` +
    `시계열 ${series.length}종 / 거래일 국내 ${tradingDays.kr}일·미국 ${tradingDays.us}일 / ` +
    `관전포인트 추출 ${watch.extracted}건 · 폴백 ${watch.fallback}건 (일일 브리핑 ${watch.found}건)`
  );

  let apiResponse;
  try {
    apiResponse = await callAnthropicWeekly(apiKey, systemPrompt, userPrompt);
  } catch (e) {
    const msg = e.name === 'AbortError' ? `AI 응답 시간 초과(${AI_TIMEOUT_MS / 1000}초)` : e.message;
    console.error('[weekly] Anthropic 호출 실패:', msg);
    return { status: 502, body: { error: `주간 브리핑 생성 실패: ${msg}` } };
  }

  // ⚠️ content[0]을 그냥 읽으면 안 된다. Sonnet 5는 thinking 필드를 생략하면 adaptive
  //    thinking이 켜지므로 content[0]이 thinking 블록이고 .text는 undefined다 — 일일
  //    (Haiku 4.5, thinking 없음)에서 통하던 briefing-core.js:770의 content[0].text 패턴을
  //    그대로 옮기면 "AI 응답이 비어 있습니다"로 죽는다(실측). 텍스트 블록만 골라 잇는다.
  const blocks       = Array.isArray(apiResponse?.content) ? apiResponse.content : [];
  const briefingText = blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('').trim();
  const usage        = apiResponse?.usage ?? {};
  const stopReason   = apiResponse?.stop_reason ?? null;
  if (!briefingText) {
    return { status: 502, body: { error: 'AI 응답이 비어 있습니다.' } };
  }
  // max_tokens에 걸리면 마지막 섹션이 잘린다 — 조용히 넘어가지 않도록 로그와 응답에 남긴다.
  if (stopReason === 'max_tokens') {
    console.warn(`[weekly] ⚠️ 출력이 max_tokens(${MAX_OUTPUT_TOKENS})에서 잘렸습니다.`);
  }

  const data = {
    // 일일(briefing-core.js:789-801)과 같은 뼈대
    briefing:     briefingText,
    generated_at: fmtKST(),
    market_count: series.length,
    usage: {
      model:         MODEL,
      input_tokens:  usage.input_tokens  ?? null,
      output_tokens: usage.output_tokens ?? null,
    },
    cached: false,
    // ── 주간 고유 필드 ──
    week:            label,
    week_start:      weekStart,
    week_end:        weekEnd,
    trading_days:    tradingDays,       // { kr, us } — 휴장은 시장마다 다르므로 한 숫자로 합치지 않는다
    watch_extracted: watch.extracted,   // 관전 포인트 정규식 추출 성공 건수
    watch_fallback:  watch.fallback,    // 추출 실패 → 전문 폴백 건수
    briefings_found: watch.found,       // 그 주에 저장돼 있던 일일 브리핑 수
    stop_reason:     stopReason,
    week_changes:    series.map(s => ({
      id: s.id, name: s.name, market: s.market,
      week_pct:  s.weekPct == null ? null : Math.round(s.weekPct * 100) / 100,
      baseline:  s.baselineClose,
      last:      s.lastClose,
      sessions:  s.points.length,
    })),
  };

  console.log(
    `[weekly] 생성 완료 (${((Date.now() - startMs) / 1000).toFixed(1)}s): ` +
    `input=${usage.input_tokens ?? '?'}tok output=${usage.output_tokens ?? '?'}tok stop=${stopReason} ` +
    `blocks=[${blocks.map(b => b?.type).join(',')}]`
  );

  await persistWeekly(label, monday, data);
  return { status: 200, body: data };
}
