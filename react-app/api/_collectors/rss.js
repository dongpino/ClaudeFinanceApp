/**
 * _collectors/rss.js — 금융시장 뉴스 RSS 수집
 *
 * 방법 A: 증시·마켓 전용 피드로 교체
 *   - 연합뉴스 마켓+ (market.xml)  — 증시·특징주 위주, 시장 전용도 ~90%
 *   - 한국경제 금융 (feed/finance) — 실제 채널명 "증권", 목표가·실적 위주
 *
 * 방법 B: 키워드 필터
 *   - 제목+요약에 시장 키워드가 하나라도 포함된 기사만 통과
 *   - 안전장치: 필터 후 MIN_AFTER_FILTER건 미만이면 원본(필터 전) 기사를 보충
 *
 * graceful fallback: 한 피드 실패해도 나머지 결과 반환
 */

const RSS_FEEDS = [
  { url: 'https://www.yna.co.kr/rss/market.xml',   source: '연합뉴스 마켓' },  // 마켓+ 전용
  { url: 'https://www.hankyung.com/feed/finance',   source: '한국경제 금융' },  // 증권 섹션
];

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

async function fetchFeed({ url, source }) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MarketBriefBot/1.0)',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml   = await res.text();
    const items = parseRSSItems(xml, source);
    console.log(`[rss] ${source}: ${items.length}개 수집`);
    return items;
  } catch (e) {
    console.warn(`[rss] ${source} 실패 (${e.message}) — 스킵`);
    return [];
  } finally {
    clearTimeout(tid);
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

function deduplicateByTitle(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = it.title.slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
