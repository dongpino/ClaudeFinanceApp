import { useState, useEffect, useCallback } from 'react';
import Header from './Header';
import BottomNav from './BottomNav';
import Sparkline from './Sparkline';
import { loadBriefing, saveBriefing, kstDateStr, kstHourBucket, generatedAtHourBucket } from '../briefingStore';

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

// meta.generated_at("YYYY-MM-DD HH:MM KST") → 오늘 생성분이면 "오늘 HH:MM 생성됨"으로 축약.
// meta.limited(일일 생성 상한 도달, 서버가 최신 캐시로 대체)면 별도 안내 문구를 보여준다.
function formatBriefingMetaLabel(meta) {
  const generatedAt = meta?.generated_at;
  if (!generatedAt) return '';
  if (meta.limited) {
    const hour = generatedAt.slice(11, 13);
    return `오늘 생성 한도 도달 · ${hour}시 브리핑 표시 중`;
  }
  const datePart = generatedAt.slice(0, 10);
  const timePart = generatedAt.slice(11, 16);
  return datePart === kstDateStr() ? `오늘 ${timePart} 생성됨` : generatedAt;
}

// ── AI 브리핑 마크다운 렌더링 ──────────────────────────────────
// 서버 프롬프트가 강제하는 고정 형식(## 소제목 / - 목록 / ⚠️ 로 시작하는 안내 문구)만
// 다루는 최소 파서 — 범용 마크다운 라이브러리 없이 우리 프롬프트 출력에 맞춰 직접 렌더링.
function renderInlineBold(str) {
  return str.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part
  );
}

function renderBriefingMarkdown(text) {
  if (!text) return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const blocks = [];
  let listBuf = [];

  const flushList = () => {
    if (listBuf.length) { blocks.push({ type: 'list', items: listBuf }); listBuf = []; }
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flushList();
      blocks.push({ type: 'heading', text: line.slice(3).trim() });
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      listBuf.push(line.slice(2).trim());
    } else if (line.startsWith('⚠️')) {
      flushList();
      blocks.push({ type: 'disclaimer', text: line.replace(/^⚠️\s*/, '') });
    } else if (line === '---') {
      flushList();
    } else {
      flushList();
      blocks.push({ type: 'p', text: line });
    }
  }
  flushList();

  return blocks.map((b, i) => {
    if (b.type === 'heading')    return <h3 key={i} className="brf-md-h">{renderInlineBold(b.text)}</h3>;
    if (b.type === 'list')       return <ul key={i} className="brf-md-list">{b.items.map((it, j) => <li key={j}>{renderInlineBold(it)}</li>)}</ul>;
    if (b.type === 'disclaimer') return <p key={i} className="brf-md-disclaimer">⚠️ {renderInlineBold(b.text)}</p>;
    return <p key={i} className="brf-md-p">{renderInlineBold(b.text)}</p>;
  });
}

// "YYYY-MM-DD" → 칩에 표시할 짧은 "M/D" 형식
function formatHistoryChipDate(dateStr) {
  const [, mo, dy] = dateStr.split('-');
  return `${Number(mo)}/${Number(dy)}`;
}

// ── 헤드라인 뉴스 레이아웃 ────────────────────────────────────
const SOURCE_PALETTE = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4'];

// ── 섹션 채움 임계값 (여기서 조절) ──────────────────────────
const FRESH_HOURS    = 24;  // 1차 신선도 기준: 이 시간 이내 기사 = "신선"
const SECTION_TARGET = 8;   // 섹션당 목표 기사 수 (top1 + side3 + card4)
const MIN_CARDS      = 2;   // 카드 그리드 최소 기사 수 (이 미만이면 그리드 숨김)

// ── 이미지 설정 상수 (여기서 조절) ──────────────────────────
const USE_CATEGORY_IMAGE_FOR_INDICES = true; // true: 지수/환율 기사에 카테고리 이미지 우선
const CATEGORY_RULES = [
  { id: 'index',  keywords: ['코스피','코스닥','나스닥','다우','S&P','환율','원/달러','USD/KRW'], color: '#0a1e38', symbol: '📈' },
  { id: 'crypto', keywords: ['비트코인','이더리움','가상화폐','가상자산','크립토'],                  color: '#180d00', symbol: '₿'  },
  { id: 'rate',   keywords: ['금리','연준','Fed','국채','채권','기준금리'],                         color: '#001a12', symbol: '🏦' },
];

function sourceAccent(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31 + name.charCodeAt(i)) >>> 0);
  return SOURCE_PALETTE[h % SOURCE_PALETTE.length];
}

function detectCategory(title) {
  const t = title.toLowerCase();
  for (const cat of CATEGORY_RULES) {
    if (cat.keywords.some(kw => t.includes(kw.toLowerCase()))) return cat;
  }
  return null;
}

function ArticleImage({ item }) {
  const cat = detectCategory(item.title);
  const forceCategory = cat?.id === 'index' && USE_CATEGORY_IMAGE_FOR_INDICES;

  if (!forceCategory && item.image) {
    return (
      <div className="hn-img-wrap">
        <img className="hn-img" src={item.image} alt="" loading="lazy"
          onError={e => { e.currentTarget.parentElement.style.display = 'none'; }} />
      </div>
    );
  }
  if (forceCategory || (!item.image && cat)) {
    return (
      <div className="hn-img-wrap hn-img-placeholder" style={{ background: cat.color }}>
        <span className="hn-placeholder-symbol">{cat.symbol}</span>
      </div>
    );
  }
  return null;
}

function isRecent(pubDate) {
  if (!pubDate) return false;
  const d = new Date(pubDate);
  return !isNaN(d) && Date.now() - d.getTime() < FRESH_HOURS * 3_600_000;
}

// 2단계 채움: 1차(신선) → 2차(구기사 보충) → SECTION_TARGET까지
function buildSectionArticles(articles) {
  // articles는 이미 최신순 정렬됨 (groupBySource에서)
  const fresh = articles.filter(a => isRecent(a.pubDate));
  if (fresh.length >= SECTION_TARGET) return fresh.slice(0, SECTION_TARGET);

  // 2차: 신선 기사 부족분을 구기사로 보충 (링크·제목 기준 중복 제거)
  const seen = new Set(fresh.map(a => a.link || a.title));
  const supplement = articles
    .filter(a => !isRecent(a.pubDate) && !seen.has(a.link || a.title))
    .slice(0, SECTION_TARGET - fresh.length);

  return [...fresh, ...supplement];
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
  const accent  = sourceAccent(source);
  const filled  = buildSectionArticles(articles);  // 2단계 채움 적용
  const top     = filled[0];
  const sides   = filled.slice(1, 4);
  const cards   = filled.slice(4);

  return (
    <div className="hn-section">
      <div className="hn-section-head" style={{ borderBottomColor: accent }}>
        <span className="hn-source-name" style={{ color: accent }}>{source}</span>
        <span className="hn-source-count">{filled.length}건</span>
      </div>

      <div className="hn-top-row">
        <ArticleLink item={top} className="hn-top">
          <ArticleImage item={top} />
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

      {cards.length >= MIN_CARDS && (
        <div className="hn-card-grid">
          {cards.map((item, i) => (
            <ArticleLink key={i} item={item} className="hn-card">
              <ArticleImage item={item} />
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

  // ── 매크로 현황(FOMC 금리·CPI) 상태 ─────────
  // 실패해도 조용히 섹션을 숨길 뿐 브리핑 본 기능(AI 브리핑·뉴스)에는 영향 없다.
  const [macroPhase, setMacroPhase] = useState('loading'); // loading | done | error
  const [macro,      setMacro]      = useState(null);

  // ── 주요 이슈(돌발 이슈 감지) 상태 ───────────
  // 실패해도 조용히 섹션을 숨길 뿐 브리핑 본 기능에는 영향 없다.
  const [issuesPhase, setIssuesPhase] = useState('loading'); // loading | done | error
  const [issues,      setIssues]      = useState([]);

  // ── 지난 브리핑(히스토리) 상태 ──────────────
  const [historyPhase, setHistoryPhase]   = useState('loading'); // loading | done | error
  const [historyDates, setHistoryDates]   = useState([]);        // ["YYYY-MM-DD", ...] 최신순
  const [historyShowAll, setHistoryShowAll] = useState(false);   // false: 최근 7일만, true: 최대 30일
  const [selectedDate, setSelectedDate]   = useState(null);      // null이면 오늘 브리핑 표시 중
  const [historyDetail, setHistoryDetail] = useState(null);      // 선택한 날짜의 브리핑 데이터
  const [historyDetailPhase, setHistoryDetailPhase] = useState('idle'); // idle | loading | done | error
  const [historyDetailError, setHistoryDetailError] = useState(null);

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

  // ── 마운트 시 localStorage에 같은 시간대 캐시가 있으면 즉시 복원 ──
  // (API 호출 없이 바로 보여줘서 재방문 시 불필요한 재생성을 유도하지 않는다)
  // 유효기간은 서버 Redis 캐시 버킷(1시간)과 정렬 — 시간이 바뀌면 복원하지 않는다.
  useEffect(() => {
    const cached = loadBriefing();
    if (!cached) return;
    if (generatedAtHourBucket(cached.generated_at) !== kstHourBucket()) return;
    setAiBriefing(cached.briefing);
    setAiMeta(cached.meta ?? null);
    setAiPhase('done');
  }, []);

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
      const meta = {
        generated_at: data.generated_at,
        cached:       data.cached,
        limited:      data.limited ?? false,
        usage:        data.usage,
      };
      setAiBriefing(data.briefing ?? '');
      setAiMeta(meta);
      setAiPhase('done');
      saveBriefing({ briefing: data.briefing ?? '', generated_at: data.generated_at, meta });
    } catch (e) {
      setAiError(e.message);
      setAiPhase('error');
    }
  }

  // ── 매크로 현황 로드 (탭 진입 시 1회) ────────
  // 실패해도 오늘의 AI 브리핑·뉴스 기능과는 완전히 분리된 상태이므로 영향 없음.
  useEffect(() => {
    fetch('/api/macro')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        setMacro(data);
        setMacroPhase('done');
      })
      .catch(() => setMacroPhase('error'));
  }, []);

  // ── 주요 이슈 로드 (탭 진입 시 1회) ─────────
  // 실패해도 오늘의 AI 브리핑·뉴스·매크로 현황과는 완전히 분리된 상태이므로 영향 없음.
  useEffect(() => {
    fetch('/api/issues')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        setIssues(Array.isArray(data.issues) ? data.issues : []);
        setIssuesPhase('done');
      })
      .catch(() => setIssuesPhase('error'));
  }, []);

  // ── 지난 브리핑 목록 로드 (탭 진입 시 1회) ──
  // 실패해도 오늘의 AI 브리핑·뉴스 기능과는 완전히 분리된 상태이므로 영향 없음.
  useEffect(() => {
    fetch('/api/briefing-history?list=true')
      .then(res => res.json())
      .then(data => {
        setHistoryDates(Array.isArray(data.dates) ? data.dates : []);
        setHistoryPhase('done');
      })
      .catch(() => setHistoryPhase('error'));
  }, []);

  // ── 지난 브리핑 날짜 선택 ────────────────────
  async function selectHistoryDate(date) {
    setSelectedDate(date);
    setHistoryDetailPhase('loading');
    setHistoryDetailError(null);
    try {
      const res = await fetch(`/api/briefing-history?date=${encodeURIComponent(date)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setHistoryDetail(data);
      setHistoryDetailPhase('done');
    } catch (e) {
      setHistoryDetailError(e.message);
      setHistoryDetailPhase('error');
    }
  }

  function backToTodayBriefing() {
    setSelectedDate(null);
    setHistoryDetail(null);
    setHistoryDetailPhase('idle');
    setHistoryDetailError(null);
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
              {selectedDate ? (
                <HistoryDetailBody
                  phase={historyDetailPhase}
                  date={selectedDate}
                  briefing={historyDetail}
                  error={historyDetailError}
                />
              ) : (
                <AiBody
                  phase={aiPhase}
                  briefing={aiBriefing}
                  meta={aiMeta}
                  error={aiError}
                />
              )}

              {selectedDate ? (
                <button className="brf-gen-btn brf-gen-btn-secondary" onClick={backToTodayBriefing}>
                  오늘 브리핑으로 돌아가기
                </button>
              ) : (
                <button
                  className={`brf-gen-btn${aiPhase === 'loading' ? ' loading' : ''}`}
                  onClick={generateBriefing}
                  disabled={aiPhase === 'loading'}
                >
                  {aiPhase === 'loading' ? '생성 중…' :
                   aiPhase === 'done'    ? '다시 생성' :
                   aiPhase === 'error'   ? '다시 시도' :
                   'AI 브리핑 생성'}
                </button>
              )}
            </div>
          </section>

          {/* ── 매크로 현황 섹션 ───────────────────── */}
          <MacroSection phase={macroPhase} macro={macro} />

          {/* ── 주요 이슈 섹션 ─────────────────────── */}
          <IssueSection phase={issuesPhase} issues={issues} />

          {/* ── 지난 브리핑 섹션 ───────────────────── */}
          <HistorySection
            phase={historyPhase}
            dates={historyDates}
            selectedDate={selectedDate}
            showAll={historyShowAll}
            onToggleShowAll={() => setHistoryShowAll(v => !v)}
            onSelectDate={selectHistoryDate}
          />

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
        <div className="brf-ai-text">{renderBriefingMarkdown(briefing)}</div>
        {meta && (
          <div className="brf-ai-meta">
            <span>{formatBriefingMetaLabel(meta)}</span>
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

// ── 매크로 현황 섹션 ────────────────────────────────────────────
// FRED 조회 실패 시(또는 로딩 중) 섹션 자체를 조용히 숨긴다 — AI 브리핑·뉴스와
// 완전히 분리된 상태라 이 섹션 실패가 브리핑 본 기능에 영향을 주지 않는다.
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

function koreanWeekday(dateStr) {
  return WEEKDAY_KO[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

function formatMMDD(dateStr) {
  const [, mo, dy] = dateStr.split('-');
  return `${Number(mo)}/${Number(dy)}`;
}

function formatDDay(n) {
  if (n < 0) return '진행중';
  if (n === 0) return 'D-DAY';
  return `D-${n}`;
}

// 카테고리별 아이콘 — "다가오는 이벤트" 리스트에서 라벨을 대신하는 짧은 시각 표식
const CATEGORY_ICON = { fomc: '🏦', cpi: '📊', expiry: '🎯', msci: '🌐', earnings: '📈' };

function EventBanner({ event }) {
  const weekday = koreanWeekday(event.date);
  const time = event.time ? ` ${event.time}` : '';
  return <div>⚡ 이번 주 {weekday}{time} {event.title}</div>;
}

function EventRow({ event }) {
  return (
    <div className="brf-event-row">
      <span className="brf-event-icon">{CATEGORY_ICON[event.category] ?? '🔔'}</span>
      <span className="brf-event-title">{event.title}</span>
      <span className={`brf-event-region brf-event-${event.region}`}>{event.region}</span>
      <span className="brf-macro-dday">{formatDDay(event.dDay)}</span>
    </div>
  );
}

function MacroSection({ phase, macro }) {
  if (phase !== 'done' || !macro || (!macro.fomc?.rate && !macro.cpi)) return null;

  const { fomc, cpi, unemployment, upcoming } = macro;

  // 임박 배너 — "다가오는 이벤트"(FOMC/CPI/만기/MSCI/실적 통합) 중 D-3 이내인 것 전부 표시
  const urgentEvents = (upcoming ?? []).filter(e => e.dDay <= 3);
  const visibleUpcoming = (upcoming ?? []).slice(0, 7);

  const cpiDir = cpi?.trend?.length >= 2
    ? (cpi.trend.at(-1).yoy >= cpi.trend[0].yoy ? 'up' : 'down')
    : 'flat';
  const cpiSparkHistory = cpi?.trend?.map(t => ({ close: t.yoy })) ?? [];

  return (
    <section className="brf-section">
      <div className="brf-section-head">
        <span className="brf-section-title">매크로 현황</span>
      </div>

      {urgentEvents.length > 0 && (
        <div className="brf-macro-banner">
          {urgentEvents.map((e, i) => <EventBanner key={i} event={e} />)}
        </div>
      )}

      <div className="brf-macro-cards">
        {fomc?.rate && (
          <div className="brf-macro-card">
            <div className="brf-macro-card-label">FOMC 기준금리</div>
            <div className="brf-macro-card-main">
              {fomc.rate.lower.toFixed(2)}–{fomc.rate.upper.toFixed(2)}%
            </div>
            <div className="brf-macro-card-sub">목표범위 · {fomc.rate.asOf} 기준</div>
            {fomc.next && (
              <div className="brf-macro-next">
                다음 회의: {formatMMDD(fomc.next.start)}–{formatMMDD(fomc.next.end)}
                <span className="brf-macro-dday">{formatDDay(fomc.next.dDay)}</span>
              </div>
            )}
          </div>
        )}

        {cpi && (
          <div className="brf-macro-card">
            <div className="brf-macro-card-label">CPI (소비자물가)</div>
            <div className={`brf-macro-card-main brf-macro-${cpiDir}`}>
              {cpi.yoy.toFixed(1)}%<span className="brf-macro-yoy-label">YoY</span>
            </div>
            <div className="brf-macro-card-sub">
              전월비 {cpi.mom > 0 ? '+' : ''}{cpi.mom.toFixed(1)}% · {cpi.refMonth} 기준
            </div>
            {cpiSparkHistory.length >= 2 && (
              <div className="brf-macro-spark"><Sparkline history={cpiSparkHistory} dir={cpiDir} /></div>
            )}
            {cpi.next && (
              <div className="brf-macro-next">
                다음 발표: {formatMMDD(cpi.next.date)} {cpi.next.kstTime}
                <span className="brf-macro-dday">{formatDDay(cpi.next.dDay)}</span>
              </div>
            )}
          </div>
        )}

        {unemployment && (
          <div className="brf-macro-card">
            <div className="brf-macro-card-label">실업률</div>
            <div className="brf-macro-card-main">{unemployment.rate.toFixed(1)}%</div>
            <div className="brf-macro-card-sub">{unemployment.refMonth} 기준</div>
          </div>
        )}
      </div>

      {visibleUpcoming.length > 0 && (
        <div className="brf-event-list">
          <div className="brf-event-list-label">다가오는 이벤트 (30일 이내)</div>
          {visibleUpcoming.map((e, i) => <EventRow key={i} event={e} />)}
        </div>
      )}
    </section>
  );
}

// ── 주요 이슈 섹션(돌발 이슈 감지) ──────────────────────────────
// 로딩 중이거나 실패하면 조용히 숨긴다 — RSS/Haiku 분류 실패가 브리핑 본 기능에
// 영향을 주지 않도록 완전히 분리된 상태다. 이슈가 0건인 날은 정상(평온한 날)이므로
// 섹션 자체를 숨기지 않고 "특이 이슈 없음" 한 줄로 시스템이 정상 동작 중임을 알린다.
const ISSUE_CATEGORY_ICON = {
  regulation: '⚖️', exchange: '🏦', listing: '🆕',
  earnings: '📈', macro_shock: '💥', other_major: '🔔',
};

function IssueSection({ phase, issues }) {
  if (phase !== 'done') return null;

  return (
    <section className="brf-section">
      <div className="brf-section-head">
        <span className="brf-section-title">주요 이슈</span>
      </div>
      {issues.length === 0 ? (
        <p className="brf-issue-empty">오늘은 특이 이슈가 감지되지 않았습니다.</p>
      ) : (
        <div className="brf-issue-list">
          {issues.map((it, i) => (
            <div key={i} className={`brf-issue-row${it.importance === 3 ? ' brf-issue-major' : ''}`}>
              <span className="brf-issue-icon">{ISSUE_CATEGORY_ICON[it.category] ?? '🔔'}</span>
              <span className="brf-issue-title">{it.title_ko}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 지난 브리핑 섹션 ────────────────────────────────────────────
// 목록 로딩 중이거나(깜빡임 방지 위해 조용히 비표시) 실패/빈 목록이면 섹션 자체를 숨긴다 —
// 요구사항 4번대로 오늘의 AI 브리핑·뉴스 기능에는 전혀 영향을 주지 않는다.
function HistorySection({ phase, dates, selectedDate, showAll, onToggleShowAll, onSelectDate }) {
  if (phase !== 'done' || dates.length === 0) return null;

  const visible  = dates.slice(0, showAll ? 30 : 7);
  const hasMore  = !showAll && dates.length > 7;

  return (
    <section className="brf-section">
      <div className="brf-section-head">
        <span className="brf-section-title">지난 브리핑</span>
      </div>
      <div className="brf-history-scroll">
        {visible.map(date => (
          <button
            key={date}
            className={`brf-history-chip${selectedDate === date ? ' active' : ''}`}
            onClick={() => onSelectDate(date)}
          >
            {formatHistoryChipDate(date)}
          </button>
        ))}
        {hasMore && (
          <button className="brf-history-chip brf-history-more" onClick={onToggleShowAll}>
            더보기
          </button>
        )}
      </div>
    </section>
  );
}

// ── 지난 브리핑 상세(선택한 날짜) 본문 ─────────────────────────
function HistoryDetailBody({ phase, date, briefing, error }) {
  if (phase === 'loading') {
    return (
      <div className="brf-ai-loading">
        <span className="brf-dot" />
        <span className="brf-dot" />
        <span className="brf-dot" />
        <span>{date} 브리핑을 불러오는 중…</span>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="brf-ai-error">
        <p className="brf-error-title">{date} 브리핑을 불러올 수 없습니다</p>
        <p className="brf-error-detail">{error}</p>
      </div>
    );
  }

  if (phase === 'done' && briefing) {
    return (
      <div className="brf-ai-result">
        <div className="brf-history-label">{date} 브리핑</div>
        <div className="brf-ai-text">{renderBriefingMarkdown(briefing.briefing)}</div>
        <div className="brf-ai-meta">
          <span>{briefing.generated_at}</span>
        </div>
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
