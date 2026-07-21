/**
 * scripts/test-rss-fetch.js — rss.js fetchFeed의 재시도/챌린지 감지 동작 검증(네트워크 목킹).
 *
 * global.fetch를 갈아끼워 403→200 재시도, 200-HTML(챌린지) 실패 처리, 정상 XML 수집을
 * collectIssueSourceNews(키워드 필터 없음) 경유로 확인한다. health 기록(recordFailure)은
 * Redis 미설정 시 no-op이라 여기선 "아이템이 들어오나/빠지나"의 사용자 체감 결과로 검증한다.
 * 실행: node scripts/test-rss-fetch.js
 */
import { collectIssueSourceNews } from '../api/_collectors/rss.js';

const originalFetch = global.fetch;
const nowUTC = new Date().toUTCString();

function xmlFeed(titles) {
  const items = titles.map(t =>
    `<item><title>${t}</title><link>http://x/${encodeURIComponent(t)}</link><pubDate>${nowUTC}</pubDate></item>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function makeRes({ status = 200, contentType = 'application/xml', body = '', retryAfter = null }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(k) {
        const key = String(k).toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'retry-after')  return retryAfter;
        return null;
      },
    },
    text: async () => body,
  };
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ FAIL:', msg); } }

const has = (items, title) => items.some(it => it.title === title);

async function run() {
  // ── 1. 403 → 1회 재시도 → 200 XML: 한경 아이템이 결국 들어온다 ──
  {
    const attempts = { hankyung: 0 };
    global.fetch = async (url) => {
      if (url.includes('yna.co.kr'))   return makeRes({ body: xmlFeed(['연합-정상기사']) });
      if (url.includes('coindesk'))    return makeRes({ body: xmlFeed(['coindesk-news']) });
      if (url.includes('hankyung')) {
        attempts.hankyung++;
        if (attempts.hankyung === 1) return makeRes({ status: 403, contentType: 'text/html', body: 'blocked', retryAfter: '0' });
        return makeRes({ body: xmlFeed(['한경-재시도성공']) });
      }
      return makeRes({ status: 404, body: '' });
    };
    const items = await collectIssueSourceNews(30);
    assert(attempts.hankyung === 2, '1: 한경 재시도 발생(2회 호출)');
    assert(has(items, '한경-재시도성공'), '1: 재시도 성공분이 결과에 포함');
    assert(has(items, '연합-정상기사'), '1: 정상 피드는 그대로');
  }

  // ── 2. 200-HTML(Cloudflare 챌린지): 한경 탈락, 나머지는 유지 ──
  {
    global.fetch = async (url) => {
      if (url.includes('yna.co.kr'))   return makeRes({ body: xmlFeed(['연합-살아있음']) });
      if (url.includes('coindesk'))    return makeRes({ body: xmlFeed(['coindesk-ok']) });
      if (url.includes('hankyung'))    return makeRes({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!DOCTYPE html><html>Just a moment…</html>' });
      return makeRes({ status: 404, body: '' });
    };
    const items = await collectIssueSourceNews(30);
    assert(!items.some(it => it.source === '한국경제 금융'), '2: 챌린지 HTML은 실패 처리 → 한경 0건');
    assert(has(items, '연합-살아있음'), '2: 다른 피드는 graceful 유지');
  }

  // ── 3. 정상 XML: 전 피드 수집 ──
  {
    global.fetch = async (url) => {
      if (url.includes('yna.co.kr'))   return makeRes({ body: xmlFeed(['연합-A']) });
      if (url.includes('hankyung'))    return makeRes({ contentType: 'text/xml;charset=UTF-8', body: xmlFeed(['한경-A']) });
      if (url.includes('coindesk'))    return makeRes({ body: xmlFeed(['coindesk-A']) });
      return makeRes({ status: 404, body: '' });
    };
    const items = await collectIssueSourceNews(30);
    assert(has(items, '한경-A') && has(items, '연합-A') && has(items, 'coindesk-A'), '3: 정상 시 전 피드 수집');
  }

  console.log(`\n[test-rss-fetch] ${pass} passed, ${fail} failed`);
  global.fetch = originalFetch;
  if (fail) process.exit(1);
}

run().catch(e => { console.error('테스트 실행 오류:', e); global.fetch = originalFetch; process.exit(1); });
