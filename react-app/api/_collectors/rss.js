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
const MAX_ITEMS_PER_FEED = 8;   // 피드당 최대 8개 → 필터 전 최대 16개
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

function passesMarketFilter(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  return MARKET_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

// ── XML 파싱 유틸 ─────────────────────────────────────────────

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
    if (title.length > 3) {
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
 * @returns {Promise<Array<{title, summary, pubDate, link, source}>>}
 */
export async function collectRSSNews(maxTotal = 15) {
  const results = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  const deduplicated = deduplicateByTitle(all);

  // 방법 B: 키워드 필터 적용
  const filtered = deduplicated.filter(it => passesMarketFilter(it.title, it.summary));

  // 안전장치: 필터 후 기사가 너무 적으면 원본으로 보충
  let final;
  if (filtered.length >= MIN_AFTER_FILTER) {
    final = filtered;
    console.log(`[rss] 키워드 필터: ${deduplicated.length}건 → ${filtered.length}건 통과`);
  } else {
    // 필터 통과 기사 + 부족분만큼 원본에서 보충 (중복 제외)
    const filteredTitles = new Set(filtered.map(it => it.title.slice(0, 30)));
    const supplement = deduplicated
      .filter(it => !filteredTitles.has(it.title.slice(0, 30)))
      .slice(0, MIN_AFTER_FILTER - filtered.length);
    final = [...filtered, ...supplement];
    console.log(`[rss] 키워드 필터 fallback: ${filtered.length}건 → 보충 후 ${final.length}건`);
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
