/**
 * _collectors/rss.js — 금융시장 뉴스 RSS 수집
 *
 * 방법 A: 증시·마켓 전용 피드로 교체
 *   - 연합뉴스 마켓+ (market.xml)      — 증시·특징주 위주, 시장 전용도 ~90%
 *   - 아시아경제 증권 (rss/stock.htm)  — 증권 섹션 전용, 특징주·공시 위주
 *   - 이데일리 증권 (stock_news.xml)   — 증권 섹션 전용(주식/펀드 카테고리)
 *
 * ※ 한국경제(feed/finance)는 제거 — Cloudflare Bot Fight Mode가 Vercel/AWS
 *   데이터센터 IP를 UA와 무관하게 하드 403으로 차단(본섭 /api/health rss-hankyung
 *   lastSuccessAt=null, lastError=HTTP 403 실측). 로컬/외부에선 200이라 UA 대응
 *   (ff9faa0)으로는 못 뚫는 IP축 차단으로 확정 → 비-Cloudflare 증권 피드 2종으로 대체.
 *
 * 방법 B: 키워드 필터
 *   - 제목+요약에 시장 키워드가 하나라도 포함된 기사만 통과
 *   - 안전장치: 필터 후 MIN_AFTER_FILTER건 미만이면 원본(필터 전) 기사를 보충
 *
 * graceful fallback: 한 피드 실패해도 나머지 결과 반환
 */

import { recordSuccess, recordFailure, classifySource } from '../_lib/health.js';

const RSS_FEEDS = [
  { url: 'https://www.yna.co.kr/rss/market.xml',       source: '연합뉴스 마켓' },  // 마켓+ 전용
  { url: 'https://www.asiae.co.kr/rss/stock.htm',      source: '아시아경제 증권' }, // 증권 섹션 전용(비-CF)
  // 이데일리는 https 인증서가 깨져 있어(rss.edaily.co.kr TLS 실패) http로 받는다.
  // 서버 사이드 fetch라 브라우저 mixed-content 제약 없음. IIS·비-Cloudflare라 Vercel 저위험.
  { url: 'http://rss.edaily.co.kr/stock_news.xml',     source: '이데일리 증권' },   // 증권 섹션 전용(비-CF)
];

// 공통 요청 헤더 — UA는 정직한 앱 식별자("Bot" 문자열 없음, 브라우저 위장 아님).
// 예전 UA 'MarketBriefBot/1.0'의 "Bot" 토큰이 Cloudflare Bot Fight Mode를 자극한 전례가
// 있어 "Bot" 제거 + 일반 헤더 보강 유지. (한국경제는 UA와 무관한 IP축 하드 403이라 이
// 헤더로도 못 뚫려 제거됐지만, 남은 비-CF 피드에도 정직한 UA 원칙은 그대로 적용한다.)
const RSS_HEADERS = {
  'User-Agent':      'MarketBrief/1.0',
  'Accept':          'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

// 403(차단)/429(레이트리밋)는 일시적일 수 있어 1회만 백오프 재시도(Retry-After 존중).
const RETRY_STATUSES  = new Set([403, 429]);
const RETRY_BASE_MS   = 700;   // Retry-After 없을 때 기본 대기(지수 백오프의 1스텝)
const RETRY_MAX_WAIT_MS = 2500; // 함수 지연 폭주 방지 상한

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retry-After: 초(숫자) 또는 HTTP-date 둘 다 허용, 상한 클램프. 없으면 null.
function parseRetryAfter(res) {
  const ra = res.headers?.get?.('retry-after');
  if (!ra) return null;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs * 1000), RETRY_MAX_WAIT_MS);
  const dateMs = Date.parse(ra);
  if (!Number.isNaN(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), RETRY_MAX_WAIT_MS);
  return null;
}

// Cloudflare 챌린지 등 "200인데 XML이 아닌" 응답 감지 — content-type이 html이거나
// 본문이 <!doctype html>/<html>로 시작하면 RSS가 아니다(파서엔 0건이라 조용히 성공처럼
// 보이던 health 사각을 실패로 집계하기 위함, 요구사항 3).
function isChallengeHtml(contentType, body) {
  if (/html/i.test(contentType || '')) return true;
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body || '');
}

// 코인 뉴스 — 돌발 이슈 감지(api/issues.js)용. 리다이렉트(308) 있지만 fetch가 기본으로 따라감.
// 실측(2026-07-06): 200 OK, 최신 항목 정상 수집 확인.
const COINDESK_FEED = { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' };

const FETCH_TIMEOUT_MS  = 6_000;
const MAX_ITEMS_PER_FEED = 12;  // 피드당 최대 12개 → 폴백 채움용 구기사 확보
const MIN_AFTER_FILTER  = 8;    // 필터 후 이 수 미만이면 원본 기사로 보충

// ── 방법 B: 시장 키워드 목록 ─────────────────────────────────
const MARKET_KEYWORDS = [
  '코스피', '코스닥', '증시', '증권', '주가', '주식', '상장', '상장폐지',
  '환율', '원/달러', '외환', '달러', '엔화', '위안',
  '금리', '연준', 'Fed', '기준금리', '국채', '채권',
  '나스닥', '다우', 'S&P', '뉴욕증시', '미증시',
  '비트코인', '이더리움', '가상화폐', '가상자산', '크립토',
  '목표가', '실적', '매출', '영업이익', '순이익',
  '매수', '매도', '배당', 'ETF', '펀드', '선물', '옵션',
  '급등', '급락', '강세', '약세', '반등', '하락', '상승',
  '시총', '시가총액', '공모', 'IPO', '스팩',
  '리포트', '투자의견', '증권사', '자산운용',
];

// ── 방법 B-2: 비시장 블랙리스트 (제목만 검사, loose하게 적용) ────
// "확실히 무관한 것"만 포함 — 애매하면 넣지 않는다.
const BLACKLIST_KEYWORDS = [
  // 문화·행사
  '영화제', '영화펀드', '아시아영화펀드', '축제', '전시회', '박람회',
  // 사회공헌
  '상생기금', '상생협력재단', '농어촌상생', '봉사', '기부', '후원',
  // 공모전 ('공모'/IPO와 구분)
  '공모전',
  // 비시장 환경 토픽
  '탄소크레딧',
];

// 제목에 이 강한 시장 키워드가 하나라도 있으면 블랙리스트 무시 → 시장 기사 보호 우선
const STRONG_MARKET_OVERRIDE = [
  '코스피', '코스닥', '증시', '주가', '목표가', '상장', '상장폐지',
  '급등', '급락', '급반등', '매수', '매도',
  '환율', '금리', '연준', 'Fed',
  '나스닥', '다우', 'S&P',
];

function passesMarketFilter(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  return MARKET_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

function passesBlacklist(title) {
  const t = title.toLowerCase();
  // 강한 시장 키워드 있으면 블랙리스트 무시 (진짜 시장 기사 보호)
  if (STRONG_MARKET_OVERRIDE.some(kw => t.includes(kw.toLowerCase()))) return true;
  // 확실히 비시장 신호가 제목에 있으면 제외
  if (BLACKLIST_KEYWORDS.some(kw => t.includes(kw.toLowerCase()))) return false;
  return true;
}

// ── XML 파싱 유틸 ─────────────────────────────────────────────

function extractImage(block) {
  // <enclosure url="..." type="image/...">
  const encTag = /<enclosure\b[^>]*>/i.exec(block);
  if (encTag) {
    const t = encTag[0];
    if (/type=["']image/i.test(t)) {
      const m = /url=["']([^"']+)["']/i.exec(t);
      if (m) return m[1];
    }
  }
  // <media:thumbnail url="...">
  const mtTag = /<media:thumbnail\b[^>]*>/i.exec(block);
  if (mtTag) {
    const m = /url=["']([^"']+)["']/i.exec(mtTag[0]);
    if (m) return m[1];
  }
  // <media:content url="..." type="image/...">
  const mcRe = /<media:content\b[^>]*>/ig;
  let mc;
  while ((mc = mcRe.exec(block)) !== null) {
    const t = mc[0];
    if (/type=["']image/i.test(t)) {
      const m = /url=["']([^"']+)["']/i.exec(t);
      if (m) return m[1];
    }
  }
  return '';
}

function extractTag(block, tag) {
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const normalRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const cdata = cdataRe.exec(block);
  if (cdata) return cdata[1].trim();
  const normal = normalRe.exec(block);
  return normal ? normal[1].trim() : '';
}

function cleanText(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

function parseRSSItems(xml, source) {
  const items  = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < MAX_ITEMS_PER_FEED) {
    const block   = m[1];
    const title   = cleanText(extractTag(block, 'title'));
    const summary = cleanText(extractTag(block, 'description'));
    const pubDate = extractTag(block, 'pubDate');
    const link    = extractTag(block, 'link') || extractTag(block, 'guid');
    const image   = extractImage(block);
    if (title.length > 3) {
      items.push({ title, summary, pubDate, link, source, image });
    }
  }
  return items;
}

// ── 피드 1개 수집 ─────────────────────────────────────────────

// 단일 시도(자체 타임아웃). health 기록은 fetchFeed가 검증까지 마친 뒤 직접 한다 —
// trackedFetch(res.ok 기준 자동 기록)로는 "200인데 챌린지 HTML"을 실패로 못 잡기 때문.
async function fetchFeedOnce(url) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: RSS_HEADERS });
  } finally {
    clearTimeout(tid);
  }
}

async function fetchFeed({ url, source }) {
  const src = classifySource(url); // 'rss-yna' | 'rss-asiae' | 'rss-edaily' | 'rss-coindesk' | null
  try {
    let res = await fetchFeedOnce(url);

    // 403/429 → 1회 백오프 재시도(Retry-After 존중). 1차 실패는 그대로 기록(정직한 신호).
    if (RETRY_STATUSES.has(res.status)) {
      const wait = parseRetryAfter(res) ?? RETRY_BASE_MS;
      console.warn(`[rss] ${source} HTTP ${res.status} — ${wait}ms 후 1회 재시도`);
      recordFailure(src, new Error(`HTTP ${res.status}`));
      await sleep(wait);
      res = await fetchFeedOnce(url);
    }

    if (!res.ok) {
      recordFailure(src, new Error(`HTTP ${res.status}`));
      throw new Error(`HTTP ${res.status}`);
    }

    const contentType = res.headers.get('content-type') || '';
    const xml = await res.text();
    if (isChallengeHtml(contentType, xml)) {
      recordFailure(src, new Error(`non-XML 응답(${contentType || '?'}) — 챌린지 의심`));
      throw new Error(`non-XML 응답 — 챌린지 의심`);
    }

    recordSuccess(src);
    const items = parseRSSItems(xml, source);
    console.log(`[rss] ${source}: ${items.length}개 수집`);
    return items;
  } catch (e) {
    // 네트워크/타임아웃 계열(위에서 아직 기록 안 한 경로)만 여기서 실패 기록 — 이미
    // recordFailure한 HTTP/챌린지 케이스는 내가 던진 Error라 이름이 달라 중복 안 된다.
    if (e.name === 'AbortError' || e.name === 'TypeError') recordFailure(src, e);
    console.warn(`[rss] ${source} 실패 (${e.message}) — 스킵`);
    return [];
  }
}

// ── 공개 API ──────────────────────────────────────────────────

/**
 * @param {number} maxTotal 반환할 최대 뉴스 수 (기본 15)
 * @returns {Promise<Array<{title, summary, pubDate, link, source}>>}
 */
export async function collectRSSNews(maxTotal = 15) {
  const results = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  const deduplicated = deduplicateByTitle(all);

  // 방법 B: whitelist 필터
  const whitelisted = deduplicated.filter(it => passesMarketFilter(it.title, it.summary));
  // 방법 B-2: blacklist 필터 (제목만, 강한 시장 키워드 있으면 보호)
  const filtered = whitelisted.filter(it => passesBlacklist(it.title));

  const dropped = whitelisted.length - filtered.length;
  console.log(`[rss] whitelist: ${deduplicated.length}건 → ${whitelisted.length}건 / blacklist: -${dropped}건 → ${filtered.length}건`);

  // 안전장치: 필터 후 기사가 너무 적으면 whitelist 통과 기사로 보충
  let final;
  if (filtered.length >= MIN_AFTER_FILTER) {
    final = filtered;
  } else {
    const filteredTitles = new Set(filtered.map(it => it.title.slice(0, 30)));
    const supplement = whitelisted
      .filter(it => !filteredTitles.has(it.title.slice(0, 30)))
      .slice(0, MIN_AFTER_FILTER - filtered.length);
    final = [...filtered, ...supplement];
    console.log(`[rss] blacklist fallback: ${filtered.length}건 → 보충 후 ${final.length}건`);
  }

  console.log(`[rss] 최종 ${final.length}건 반환 (피드 ${RSS_FEEDS.length}개)`);
  return final.slice(0, maxTotal);
}

/**
 * 돌발 이슈 감지(api/issues.js)용 — 국내 금융(연합/아경/이데일리) + 코인(CoinDesk) 원시 헤드라인.
 * collectRSSNews()와 달리 한국어 시장 키워드 whitelist/blacklist를 적용하지 않는다
 * (CoinDesk는 영문이라 한국어 키워드로 걸러지면 전부 탈락하고, 어차피 이 용도는
 * Haiku 분류 자체가 필터 역할을 하므로 사전 키워드 필터가 불필요/유해함).
 * 최근 24시간 이내 기사만, 최신순으로 최대 maxTotal건 반환.
 * @param {number} maxTotal
 */
export async function collectIssueSourceNews(maxTotal = 30) {
  const feeds = [...RSS_FEEDS, COINDESK_FEED];
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  const deduplicated = deduplicateByTitle(all);

  const cutoffMs = Date.now() - 24 * 3_600_000;
  const recent = deduplicated.filter(it => {
    const t = new Date(it.pubDate).getTime();
    return !isNaN(t) && t >= cutoffMs;
  });

  recent.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  console.log(`[rss] 이슈 감지용: ${deduplicated.length}건 → 24시간 이내 ${recent.length}건`);
  return recent.slice(0, maxTotal);
}

function deduplicateByTitle(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = it.title.slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
