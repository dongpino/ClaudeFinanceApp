/**
 * api/news.js — RSS 뉴스 전용 엔드포인트 (AI 호출 없음, 비용 0)
 *
 * GET /api/news
 *   → 한국 경제 뉴스 헤드라인 목록 반환
 *
 * 캐시: 인메모리 10분 + CDN 5분
 * 페이지 진입 시 자동 로드 가능 (무료 RSS, 비용 발생 없음)
 */

import { collectRSSNews } from './_collectors/rss.js';

const NEWS_CACHE_TTL_MS = 10 * 60 * 1000;  // 10분
let newsCache = null;  // { data: {...}, timestamp: number }

function fmtKST(date = new Date()) {
  const kst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
  const y  = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(kst.getUTCDate()).padStart(2, '0');
  const h  = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dy} ${h}:${mi} KST`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  if (newsCache && Date.now() - newsCache.timestamp < NEWS_CACHE_TTL_MS) {
    const ageMin = ((Date.now() - newsCache.timestamp) / 60_000).toFixed(1);
    console.log(`[news] Cache HIT (age=${ageMin}분)`);
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({ ...newsCache.data, cached: true });
  }

  console.log(`[news] Cache MISS — RSS 수집 시작 (${fmtKST()})`);
  const startMs = Date.now();

  const items = await collectRSSNews(15);
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[news] ${items.length}개 수집 완료 (${elapsed}s)`);

  const data = { items, fetched_at: fmtKST(), count: items.length, cached: false };
  newsCache = { data, timestamp: Date.now() };

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(data);
}
