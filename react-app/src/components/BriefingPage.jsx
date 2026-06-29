import { useState, useEffect, useCallback } from 'react';
import Header from './Header';
import BottomNav from './BottomNav';

// ── 날짜 포맷 (RSS pubDate → "6/29 14:30") ───────────────────
function formatPubDate(pubDate) {
  if (!pubDate) return '';
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return '';
    const mo = d.getMonth() + 1;
    const dy = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${mo}/${dy} ${hh}:${mm}`;
  } catch { return ''; }
}

// ── 뉴스 아이템 (링크 있으면 클릭 가능) ──────────────────────
function NewsItem({ item }) {
  const hasLink = typeof item.link === 'string' && item.link.startsWith('http');
  const showSummary = item.summary && item.summary !== item.title && item.summary.length > 10;
  const date = formatPubDate(item.pubDate);

  const inner = (
    <div className="brf-news-item">
      <div className="brf-news-meta">
        <span className="brf-news-src">{item.source}</span>
        {date && <span className="brf-news-date">{date}</span>}
        {hasLink && <span className="brf-news-ext">↗</span>}
      </div>
      <p className="brf-news-title">{item.title}</p>
      {showSummary && <p className="brf-news-summary">{item.summary}</p>}
    </div>
  );

  if (hasLink) {
    return (
      <li>
        <a href={item.link} target="_blank" rel="noopener noreferrer" className="brf-news-link">
          {inner}
        </a>
      </li>
    );
  }
  return <li>{inner}</li>;
}

// ── 메인 페이지 ────────────────────────────────────────────────
export default function BriefingPage({ activePage, onPageChange }) {
  // ── RSS 뉴스 상태 ──────────────────────────
  const [newsPhase, setNewsPhase]       = useState('loading'); // loading | done | error
  const [newsItems, setNewsItems]       = useState([]);
  const [newsFetchedAt, setNewsFetchedAt] = useState(null);
  const [newsError, setNewsError]       = useState(null);

  // ── AI 브리핑 상태 ─────────────────────────
  const [aiPhase, setAiPhase]           = useState('idle'); // idle | loading | done | no-key | error
  const [aiBriefing, setAiBriefing]     = useState('');
  const [aiMeta, setAiMeta]             = useState(null);   // { generated_at, usage, cached }
  const [aiError, setAiError]           = useState(null);

  // ── 뉴스 로드 ─────────────────────────────
  const loadNews = useCallback(async () => {
    setNewsPhase('loading');
    setNewsError(null);
    try {
      const res = await fetch('/api/news');
      if (!res.ok) throw new Error(`서버 오류 (HTTP ${res.status})`);
      const data = await res.json();
      setNewsItems(data.items ?? []);
      setNewsFetchedAt(data.fetched_at ?? null);
      setNewsPhase('done');
    } catch (e) {
      setNewsError(e.message);
      setNewsPhase('error');
    }
  }, []);

  useEffect(() => { loadNews(); }, [loadNews]);

  // ── AI 브리핑 생성 (버튼 클릭 시에만) ────
  async function generateBriefing() {
    setAiPhase('loading');
    setAiError(null);
    setAiBriefing('');
    setAiMeta(null);
    try {
      const res = await fetch('/api/briefing');
      const data = await res.json();
      if (!res.ok) {
        const isNoKey = typeof data.error === 'string' && data.error.includes('ANTHROPIC_API_KEY');
        setAiError(data.error ?? `HTTP ${res.status}`);
        setAiPhase(isNoKey ? 'no-key' : 'error');
        return;
      }
      setAiBriefing(data.briefing ?? '');
      setAiMeta({
        generated_at: data.generated_at,
        cached:       data.cached,
        usage:        data.usage,
      });
      setAiPhase('done');
    } catch (e) {
      setAiError(e.message);
      setAiPhase('error');
    }
  }

  return (
    <>
      <Header />
      <div className="page active">
        <div className="briefing-scroll">

          {/* ── AI 브리핑 섹션 ─────────────────────── */}
          <section className="brf-section">
            <div className="brf-section-head">
              <span className="brf-section-title">
                <span className="brf-ai-star">✦</span>
                AI 시장 브리핑
              </span>
              <span className="brf-model-badge">claude haiku</span>
            </div>

            <div className="brf-ai-card">
              <AiBody
                phase={aiPhase}
                briefing={aiBriefing}
                meta={aiMeta}
                error={aiError}
              />
              <button
                className={`brf-gen-btn${aiPhase === 'loading' ? ' loading' : ''}`}
                onClick={generateBriefing}
                disabled={aiPhase === 'loading'}
              >
                {aiPhase === 'loading' ? '생성 중…' :
                 aiPhase === 'done'    ? '다시 생성' :
                 'AI 브리핑 생성'}
              </button>
            </div>
          </section>

          {/* ── RSS 뉴스 섹션 ──────────────────────── */}
          <section className="brf-section">
            <div className="brf-section-head">
              <span className="brf-section-title">최신 경제 뉴스</span>
              <button
                className="brf-reload-btn"
                onClick={loadNews}
                disabled={newsPhase === 'loading'}
                aria-label="뉴스 새로고침"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2.5"
                     strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10"/>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                </svg>
                새로고침
              </button>
            </div>

            <NewsBody
              phase={newsPhase}
              items={newsItems}
              fetchedAt={newsFetchedAt}
              error={newsError}
            />
          </section>

        </div>
      </div>
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </>
  );
}

// ── AI 섹션 본문 ────────────────────────────────────────────────
function AiBody({ phase, briefing, meta, error }) {
  if (phase === 'idle') {
    return (
      <p className="brf-ai-hint">
        버튼을 눌러 오늘의 시장 브리핑을 생성하세요.<br/>
        <span className="brf-ai-hint-sub">시장 지표 6종 + 경제 뉴스를 AI가 요약합니다.</span>
      </p>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="brf-ai-loading">
        <span className="brf-dot" />
        <span className="brf-dot" />
        <span className="brf-dot" />
        <span>AI가 시장을 분석 중입니다…</span>
      </div>
    );
  }

  if (phase === 'no-key') {
    return (
      <div className="brf-ai-nokey">
        <div className="brf-nokey-icon">🔑</div>
        <p className="brf-nokey-msg">API 키 설정 후 사용 가능합니다</p>
        <p className="brf-nokey-hint">
          Vercel Dashboard → Settings → Environment Variables에서<br/>
          <code>ANTHROPIC_API_KEY</code>를 추가하세요.
        </p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="brf-ai-error">
        <p className="brf-error-title">브리핑 생성 실패</p>
        <p className="brf-error-detail">{error}</p>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="brf-ai-result">
        <p className="brf-ai-text">{briefing}</p>
        {meta && (
          <div className="brf-ai-meta">
            <span>{meta.generated_at}</span>
            {meta.cached && <span className="brf-cached-chip">캐시</span>}
            {meta.usage?.input_tokens && (
              <span>입력 {meta.usage.input_tokens}tok · 출력 {meta.usage.output_tokens}tok</span>
            )}
          </div>
        )}
      </div>
    );
  }

  return null;
}

// ── 뉴스 섹션 본문 ─────────────────────────────────────────────
function NewsBody({ phase, items, fetchedAt, error }) {
  if (phase === 'loading') {
    return (
      <ul className="brf-news-list">
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="brf-news-skeleton" />
        ))}
      </ul>
    );
  }

  if (phase === 'error') {
    return (
      <div className="brf-news-state error">
        <p>뉴스를 불러올 수 없습니다</p>
        <small>{error}</small>
      </div>
    );
  }

  if (phase === 'done' && items.length === 0) {
    return <div className="brf-news-state"><p>수집된 뉴스가 없습니다</p></div>;
  }

  if (phase === 'done') {
    return (
      <>
        {fetchedAt && <p className="brf-fetched-at">수집: {fetchedAt}</p>}
        <ul className="brf-news-list">
          {items.map((item, i) => <NewsItem key={i} item={item} />)}
        </ul>
      </>
    );
  }

  return null;
}
