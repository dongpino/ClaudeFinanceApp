/**
 * _collectors/rss.js — 한국 경제 뉴스 RSS 수집
 *
 * 외부 XML 파싱 라이브러리 없이 정규식으로 파싱.
 * 피드 1개라도 실패해도 나머지 결과 반환 (graceful).
 * collectRSSNews()가 빈 배열을 반환해도 briefing.js는 지표만으로 동작.
 */

const RSS_FEEDS = [
  { url: 'https://www.yna.co.kr/rss/economy.xml',  source: '연합뉴스 경제' },
  { url: 'https://www.hankyung.com/feed/economy',   source: '한국경제'      },
  { url: 'https://www.sedaily.com/rss/list?groupCode=GD',  source: '서울경제'   },
];

const FETCH_TIMEOUT_MS   = 6_000;
const MAX_ITEMS_PER_FEED = 6;   // 피드당 최대 6개 → 전체 최대 15~18개

// ── XML 파싱 유틸 ─────────────────────────────────────────────

function extractTag(block, tag) {
  // CDATA 먼저, 그 다음 일반 텍스트
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const normalRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const cdata = cdataRe.exec(block);
  if (cdata) return cdata[1].trim();
  const normal = normalRe.exec(block);
  return normal ? normal[1].trim() : '';
}

function cleanText(text) {
  return text
    .replace(/<[^>]+>/g, '')                                    // HTML 태그 제거
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);  // 설명이 너무 길면 잘라냄
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
    const link = extractTag(block, 'link') || extractTag(block, 'guid');
    if (title.length > 3) {          // 빈 제목 스킵
      items.push({ title, summary, pubDate, link, source });
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
 * @returns {Promise<Array<{title, summary, pubDate, source}>>}
 */
export async function collectRSSNews(maxTotal = 15) {
  const results = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }
  const unique = deduplicateByTitle(all);
  console.log(`[rss] 총 ${unique.length}개 뉴스 수집 (피드 ${RSS_FEEDS.length}개)`);
  return unique.slice(0, maxTotal);
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
