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

// ── 헤드라인 뉴스 레이아웃 ────────────────────────────────────
const SOURCE_PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];

function sourceAccent(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31 + name.charCodeAt(i)) >>> 0);
  return SOURCE_PALETTE[h % SOURCE_PALETTE.length];
}

function groupBySource(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.source)) map.set(item.source, []);
    map.get(item.source).push(item);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

function ArticleLink({ item, className, children }) {
  const hasLink = typeof item.link === 'string' && item.link.startsWith('http');
  if (hasLink) {
    return (
      <a href={item.link} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );
  }
  return <div className={className}>{children}</div>;
}

function SourceSection({ source, articles }) {
  const accent = sourceAccent(source);
  const top   = articles[0];
  const sides = articles.slice(1, 4);
  const cards = articles.slice(4);

  return (
    <div className="hn-section">
      <div className="hn-section-head" style={{ borderBottomColor: accent }}>
        <span className="hn-source-name" style={{ color: accent }}>{source}</span>
        <span className="hn-source-count">{articles.length}건</span>
      </div>

      <div className="hn-top-row">
        <ArticleLink item={top} className="hn-top">
          {top.image && (
            <div className="hn-img-wrap">
              <img className="hn-img" src={top.image} alt="" loading="lazy" />
            </div>
          )}
          <p className="hn-top-title">{top.title}</p>
          {top.pubDate && <span className="hn-meta-date">{formatPubDate(top.pubDate)}</span>}
        </ArticleLink>

        {sides.length > 0 && (
          <div className="hn-side-list">
            {sides.map((item, i) => (
              <ArticleLink key={i} item={item} className="hn-side-item">
                <p className="hn-side-title">{item.title}</p>
                {item.pubDate && <span className="hn-meta-date">{formatPubDate(item.pubDate)}</span>}
              </ArticleLink>
            ))}
          </div>
        )}
      </div>

      {cards.length > 0 && (
        <div className="hn-card-grid">
          {cards.map((item, i) => (
            <ArticleLink key={i} item={item} className="hn-card">
              {item.image && (
                <div className="hn-img-wrap">
                  <img className="hn-img" src={item.image} alt="" loading="lazy" />
                </div>
              )}
              <div className="hn-card-body">
                <p className="hn-card-title">{item.title}</p>
                {item.pubDate && <span className="hn-meta-date">{formatPubDate(item.pubDate)}</span>}
              </div>
            </ArticleLink>
          ))}
        </div>
      )}
    </div>
  );
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

            <HeadlineNewsBody
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

// ── 헤드라인 뉴스 섹션 본문 ────────────────────────────────────
function HeadlineNewsBody({ phase, items, fetchedAt, error }) {
  if (phase === 'loading') {
    return (
      <div className="hn-skeleton-wrap">
        {[0, 1].map(i => (
          <div key={i} className="hn-sk-section">
            <div className="hn-sk-head" style={{ animationDelay: `${i * 0.15}s` }} />
            <div className="hn-sk-top-row">
              <div className="hn-sk-top" style={{ animationDelay: `${i * 0.15 + 0.1}s` }} />
              <div className="hn-sk-side" style={{ animationDelay: `${i * 0.15 + 0.2}s` }} />
            </div>
          </div>
        ))}
      </div>
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
    const sections = groupBySource(items);
    return (
      <div className="hn-sections">
        {fetchedAt && <p className="brf-fetched-at">수집: {fetchedAt}</p>}
        {sections.map(([src, arts]) => (
          <SourceSection key={src} source={src} articles={arts} />
        ))}
      </div>
    );
  }

  return null;
}
