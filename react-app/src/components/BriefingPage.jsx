import { useState, useEffect, useCallback, useRef } from 'react';
import { createChart, LineType } from 'lightweight-charts';
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

  // ── 매크로 카드 개별 해석(Haiku) 상태 ────────
  // /api/macro 데이터 fetch와 완전히 별개의 비동기 요청 — 페이지 렌더를 블로킹하지
  // 않는다. 실패/null이어도 카드·패널 자체는 정상 동작(해석 영역만 안 보임).
  const [macroInsightPhase, setMacroInsightPhase] = useState('loading'); // loading | done
  const [macroInsight,      setMacroInsight]      = useState(null);      // { fomc, cpi, unemployment } | null

  // ── 주요 이슈(돌발 이슈 감지) 상태 ───────────
  // 실패해도 조용히 섹션을 숨길 뿐 브리핑 본 기능에는 영향 없다.
  const [issuesPhase, setIssuesPhase] = useState('loading'); // loading | done | error
  const [issues,      setIssues]      = useState([]);

  // ── 지난 브리핑(히스토리) 상태 ──────────────
  const [historyPhase, setHistoryPhase]   = useState('loading'); // loading | done | error
  const [historyDates, setHistoryDates]   = useState([]);        // ["YYYY-MM-DD", ...] 최신순
  const [historyShowAll, setHistoryShowAll] = useState(false);   // false: 최근 7일만, true: 최대 30일
  const [selectedDate, setSelectedDate]   = useState(null);      // null이면 오늘 브리핑 표시 중
  const [historyDetail, setHistoryDetail] = useState(null);      // { date, morning, manual } — 선택한 날짜
  const [historyViewSlot, setHistoryViewSlot] = useState('manual'); // 'morning' | 'manual' — 현재 보고 있는 슬롯
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

  // ── 매크로 카드 개별 해석 로드 (탭 진입 시 1회, /api/macro와 별개 요청) ──
  // 실패/null이어도 카드 요약·펼침 자체는 정상 — 해석 영역만 렌더되지 않는다.
  useEffect(() => {
    fetch('/api/macro-insight')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        setMacroInsight(data && typeof data === 'object' ? data : null);
        setMacroInsightPhase('done');
      })
      .catch(() => {
        setMacroInsight(null);
        setMacroInsightPhase('done');
      });
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
  // 응답 shape: { date, morning, manual } — 기본 표시는 manual(수동 최신본), 없으면
  // morning(아침 보고). 둘 다 있으면 배지로 서로 전환 가능(toggleHistorySlot).
  async function selectHistoryDate(date) {
    setSelectedDate(date);
    setHistoryDetailPhase('loading');
    setHistoryDetailError(null);
    try {
      const res = await fetch(`/api/briefing-history?date=${encodeURIComponent(date)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setHistoryDetail(data);
      setHistoryViewSlot(data.manual ? 'manual' : 'morning');
      setHistoryDetailPhase('done');
    } catch (e) {
      setHistoryDetailError(e.message);
      setHistoryDetailPhase('error');
    }
  }

  function toggleHistorySlot() {
    setHistoryViewSlot(v => (v === 'morning' ? 'manual' : 'morning'));
  }

  function backToTodayBriefing() {
    setSelectedDate(null);
    setHistoryDetail(null);
    setHistoryViewSlot('manual');
    setHistoryDetailPhase('idle');
    setHistoryDetailError(null);
  }

  // 지난 브리핑 칩 줄 — 브리핑 카드 안(버튼 아래 또는 헤더-본문 사이)에 인라인으로
  // 삽입할 노드. 로딩 중(깜빡임 방지) 또는 목록이 비어있으면 렌더하지 않는다.
  const historyChipsNode = historyPhase === 'done' && historyDates.length > 0 ? (
    <HistoryChipRow
      dates={historyDates}
      selectedDate={selectedDate}
      showAll={historyShowAll}
      onToggleShowAll={() => setHistoryShowAll(v => !v)}
      onSelectDate={selectHistoryDate}
    />
  ) : null;

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
                <>
                  <HistoryDetailBody
                    phase={historyDetailPhase}
                    date={selectedDate}
                    data={historyDetail}
                    viewSlot={historyViewSlot}
                    onToggleSlot={toggleHistorySlot}
                    error={historyDetailError}
                    historyChips={historyChipsNode}
                  />
                  <button className="brf-gen-btn brf-gen-btn-secondary" onClick={backToTodayBriefing}>
                    오늘 브리핑으로 돌아가기
                  </button>
                </>
              ) : (
                <>
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
                     aiPhase === 'error'   ? '다시 시도' :
                     'AI 브리핑 생성'}
                  </button>
                  {historyChipsNode}
                </>
              )}
            </div>
          </section>

          {/* ── 매크로 현황 섹션 ───────────────────── */}
          <MacroSection
            phase={macroPhase}
            macro={macro}
            onPageChange={onPageChange}
            insightPhase={macroInsightPhase}
            insight={macroInsight}
          />

          {/* ── 주요 이슈 섹션 ─────────────────────── */}
          <IssueSection phase={issuesPhase} issues={issues} />

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

function EventBanner({ event }) {
  const weekday = koreanWeekday(event.date);
  const time = event.time ? ` ${event.time}` : '';
  return <div>⚡ 이번 주 {weekday}{time} {event.title}</div>;
}

// ── 매크로 카드 인라인 아코디언 상세(컨테이너 패턴) ──────────────────────────
// .brf-macro-cards(그리드)에서 카드마다 자기 order 바로 뒤(+1~4 사이 값)에
// 끼워 넣는 "카드별 슬롯" — 모바일(1열)에서는 그 카드 바로 아래, 데스크톱(3열,
// grid-auto-flow:dense)에서는 카드 줄 전체 폭 아래에 자동으로 놓인다(MacroSection
// 하단의 order 배치 주석 참고). indicator(kind)별 본문만 다르고 펼침/접힘 메커니즘
// (grid-template-rows 트랜지션, transitionend 감지, scrollIntoView)은 공용이다.
const FOMC_UPPER_COLOR = '#e8a640';
const FOMC_LOWER_COLOR = '#3d82ef';

function FomcChangesList({ changes }) {
  if (!changes || changes.length === 0) {
    return <p className="brf-macro-changes-empty">최근 변경 이력이 없습니다.</p>;
  }
  // API는 날짜 오름차순으로 준다 — 목록은 최신이 위로 오게 뒤집어 보여준다.
  return (
    <ul className="brf-macro-changes-list">
      {changes.slice().reverse().map((c, i) => (
        <li key={i} className="brf-macro-change-row">
          <span className="brf-macro-change-date">{formatMMDD(c.date)}</span>
          <span className={`brf-macro-change-dir brf-macro-change-${c.direction === '인상' ? 'up' : 'down'}`}>
            {c.direction}
          </span>
          <span className="brf-macro-change-bp">{c.delta_bp}bp</span>
        </li>
      ))}
    </ul>
  );
}

// 매크로 카드 개별 해석(Haiku, /api/macro-insight) 표시 — 세 Body 컴포넌트가 공용으로
// 쓴다. insightPhase==='loading'이면(아직 응답 전) 스켈레톤 한 줄만, 응답은 왔는데
// 이 지표 몫 텍스트가 없으면(전체 null 포함) 아무것도 렌더하지 않는다 — 에러 문구를
// 노출하지 않는다는 요구사항 그대로.
function MacroInsightNote({ insightPhase, insightText }) {
  if (insightPhase === 'loading') {
    return <div className="brf-macro-insight-skeleton" aria-hidden="true" />;
  }
  if (!insightText) return null;
  return <p className="brf-macro-insight">{insightText}</p>;
}

// FOMC 상세 본문 — 목표금리 상/하단 계단형 라인 차트(lightweight-charts, 첫 펼침 시
// lazy 마운트) + 최근 변경 이력(1단계 /api/macro-history의 changes). 카드 요약(macro)과
// 완전히 분리된 자체 fetch 상태를 가져 실패해도 카드 요약엔 영향 없다.
function FomcDetailBody({ expanded, transitionEnded, insightPhase, insightText }) {
  const [phase, setPhase] = useState('idle'); // idle | loading | done | error
  const [data, setData]   = useState(null);   // { series, changes } — /api/macro-history 응답
  const [error, setError] = useState(null);

  const fetchedRef = useRef(false); // 첫 펼침에만 fetch, 이후 재펼침은 재사용
  const chartElRef  = useRef(null); // 차트를 그릴 DOM 컨테이너
  const chartRef    = useRef(null); // 생성된 차트 인스턴스(한 번만 생성, 이후 재사용)
  const roRef       = useRef(null);

  // 첫 펼침 시 1회만 히스토리 로드.
  useEffect(() => {
    if (!expanded || fetchedRef.current) return;
    fetchedRef.current = true;
    setPhase('loading');
    fetch('/api/macro-history?indicator=fomc')
      .then(res => {
        if (!res.ok) return res.json().then(j => { throw new Error(j?.error ?? `HTTP ${res.status}`); });
        return res.json();
      })
      .then(json => { setData(json); setPhase('done'); })
      .catch(e => { setError(e.message); setPhase('error'); });
  }, [expanded]);

  // 차트 최초 마운트 — 데이터 준비 + 펼침 트랜지션 종료(부모 MacroDetailPanel이 넘겨줌)
  // + 아직 미생성, 셋 다 만족할 때만. 이후 재펼침은 chartRef.current 가드에 걸려
  // 재실행되지 않는다 — 이미 만든 차트를 그대로 재사용(요구사항4).
  useEffect(() => {
    if (chartRef.current || phase !== 'done' || !data || !transitionEnded) return;
    const el = chartElRef.current;
    if (!el || el.clientWidth === 0) return; // 방어적 가드 — 크기 0인 컨테이너엔 그리지 않는다

    const chart = createChart(el, {
      width:  el.clientWidth,
      height: el.clientHeight,
      layout: { background: { color: 'transparent' }, textColor: '#7a8ba8' },
      grid: { vertLines: { color: '#1a2540' }, horzLines: { color: '#1a2540' } },
      rightPriceScale: { borderColor: '#1a2540' },
      timeScale: { borderColor: '#1a2540' },
      handleScroll: { vertTouchDrag: false }, // Chart.jsx와 동일 — 세로 터치는 페이지 스크롤에 양보
      handleScale: { pinch: true },
    });
    chartRef.current = chart;

    const upper = data.series?.find(s => s.id === 'DFEDTARU');
    const lower = data.series?.find(s => s.id === 'DFEDTARL');
    const upperSeries = chart.addLineSeries({ color: FOMC_UPPER_COLOR, lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false });
    const lowerSeries = chart.addLineSeries({ color: FOMC_LOWER_COLOR, lineWidth: 2, lineType: LineType.WithSteps, priceLineVisible: false });
    upperSeries.setData((upper?.points ?? []).map(p => ({ time: p.date, value: p.value })));
    lowerSeries.setData((lower?.points ?? []).map(p => ({ time: p.date, value: p.value })));
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    roRef.current = ro;
  }, [phase, data, transitionEnded]);

  // 브리핑 탭 자체가 언마운트될 때만 정리 — 아코디언을 접을 때는 파괴하지 않는다.
  useEffect(() => {
    return () => {
      roRef.current?.disconnect();
      chartRef.current?.remove();
    };
  }, []);

  // 해석(insight)은 /api/macro-history(차트·변경이력)와 완전히 별개 fetch라, 저쪽이
  // loading/error여도 여기는 독립적으로 표시한다.
  if (phase === 'loading') {
    return (
      <>
        <div className="brf-ai-loading">
          <span className="brf-dot" /><span className="brf-dot" /><span className="brf-dot" />
          <span>히스토리를 불러오는 중…</span>
        </div>
        <MacroInsightNote insightPhase={insightPhase} insightText={insightText} />
      </>
    );
  }
  if (phase === 'error') {
    return (
      <>
        <div className="brf-ai-error">
          <p className="brf-error-title">히스토리를 불러오지 못했습니다</p>
          <p className="brf-error-detail">{error}</p>
        </div>
        <MacroInsightNote insightPhase={insightPhase} insightText={insightText} />
      </>
    );
  }
  if (phase === 'done' && data) {
    return (
      <>
        <div className="brf-macro-detail-chart" ref={chartElRef} />
        <div className="brf-macro-detail-legend">
          <span><i className="brf-macro-legend-dot" style={{ background: FOMC_UPPER_COLOR }} />상단</span>
          <span><i className="brf-macro-legend-dot" style={{ background: FOMC_LOWER_COLOR }} />하단</span>
        </div>
        <div className="brf-macro-changes-head">최근 변경 이력</div>
        <FomcChangesList changes={data.changes} />
        <MacroInsightNote insightPhase={insightPhase} insightText={insightText} />
      </>
    );
  }
  return null;
}

// CPI 상세 본문(1단계) — 카드 요약과 같은 데이터(트렌드 미니 차트)를 그대로 재사용해
// 우선 보여준다. 별도 fetch 없음 — 상세 그래프(FRED 히스토리)는 다음 단계에서 추가.
function CpiDetailBody({ cpi, cpiDir, cpiSparkHistory, insightPhase, insightText }) {
  if (!cpi) return null;
  return (
    <>
      <div className="brf-macro-detail-stat">
        <span className={`brf-macro-detail-value brf-macro-${cpiDir}`}>
          {cpi.yoy.toFixed(1)}%<span className="brf-macro-yoy-label">YoY</span>
        </span>
        <span className="brf-macro-detail-sub">
          전월비 {cpi.mom > 0 ? '+' : ''}{cpi.mom.toFixed(1)}% · {cpi.refMonth} 기준
        </span>
      </div>
      {cpiSparkHistory.length >= 2 && (
        <div className="brf-macro-detail-spark"><Sparkline history={cpiSparkHistory} dir={cpiDir} /></div>
      )}
      {cpi.next && (
        <div className="brf-macro-next">
          다음 발표: {formatMMDD(cpi.next.date)} {cpi.next.kstTime}
          <span className="brf-macro-dday">{formatDDay(cpi.next.dDay)}</span>
        </div>
      )}
      <p className="brf-macro-detail-note">상세 히스토리 그래프는 다음 단계에서 제공됩니다.</p>
      <MacroInsightNote insightPhase={insightPhase} insightText={insightText} />
    </>
  );
}

// 실업률 상세 본문(1단계) — 현재 수치 + 기준월만. 히스토리 차트는 다음 단계.
function UnemploymentDetailBody({ unemployment, insightPhase, insightText }) {
  if (!unemployment) return null;
  return (
    <>
      <div className="brf-macro-detail-stat">
        <span className="brf-macro-detail-value">{unemployment.rate.toFixed(1)}%</span>
        <span className="brf-macro-detail-sub">{unemployment.refMonth} 기준</span>
      </div>
      <p className="brf-macro-detail-note">히스토리 차트는 다음 단계에서 제공됩니다.</p>
      <MacroInsightNote insightPhase={insightPhase} insightText={insightText} />
    </>
  );
}

// 공용 아코디언 래퍼 — kind에 따라 본문만 바꿔 끼운다. 펼침/접힘 메커니즘(트랜지션
// 감지, 스크롤)은 여기 한 곳에만 있고 세 indicator가 그대로 공유한다.
function MacroDetailPanel({ kind, expanded, orderValue, insightPhase, insightText, ...bodyProps }) {
  const wrapRef = useRef(null); // grid-template-rows 트랜지션을 감지할 바깥 래퍼
  const [transitionEnded, setTransitionEnded] = useState(false);

  // 펼쳐질 때 뷰포트 밖이면 보이는 위치로 스크롤(요구사항5) — 접힐 때는 하지 않는다.
  useEffect(() => {
    if (expanded) wrapRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [expanded]);

  // grid-template-rows 트랜지션이 "끝난" 시점만 잡아낸다 — 접히면 다음 펼침을 위해
  // 리셋(false)한다. FomcDetailBody가 이 값을 받아 차트를 0-size 컨테이너에
  // 그리지 않도록 게이팅한다(카드마다 자체 인스턴스라 서로 간섭 없음).
  useEffect(() => {
    if (!expanded) { setTransitionEnded(false); return; }
    const el = wrapRef.current;
    if (!el) return;
    function onTransitionEnd(e) {
      if (e.target !== el || e.propertyName !== 'grid-template-rows') return;
      setTransitionEnded(true);
    }
    el.addEventListener('transitionend', onTransitionEnd);
    return () => el.removeEventListener('transitionend', onTransitionEnd);
  }, [expanded]);

  return (
    <div className={`brf-macro-detail${expanded ? ' expanded' : ''}`} style={{ order: orderValue }} ref={wrapRef}>
      <div className="brf-macro-detail-inner">
        <div className="brf-macro-detail-body">
          {kind === 'fomc' && (
            <FomcDetailBody
              expanded={expanded}
              transitionEnded={transitionEnded}
              insightPhase={insightPhase}
              insightText={insightText}
            />
          )}
          {kind === 'cpi' && <CpiDetailBody {...bodyProps} insightPhase={insightPhase} insightText={insightText} />}
          {kind === 'unemployment' && (
            <UnemploymentDetailBody {...bodyProps} insightPhase={insightPhase} insightText={insightText} />
          )}
        </div>
      </div>
    </div>
  );
}

function MacroSection({ phase, macro, onPageChange, insightPhase, insight }) {
  // expandedCard: 'fomc' | 'cpi' | 'unemployment' | null — 값 하나로 세 카드의
  // "동시 1개만 펼침"이 자동으로 보장된다.
  const [expandedCard, setExpandedCard] = useState(null);

  if (phase !== 'done' || !macro || (!macro.fomc?.rate && !macro.cpi)) return null;

  const { fomc, cpi, unemployment, upcoming } = macro;

  // 임박 배너 — "다가오는 이벤트"(FOMC/CPI/만기/MSCI/실적 통합) 중 D-3 이내인 것 전부 표시.
  // 이벤트 상세 목록 자체는 캘린더 탭으로 이사했으므로, 배너를 탭하면 그쪽으로 이동한다.
  const urgentEvents = (upcoming ?? []).filter(e => e.dDay <= 3);

  const cpiDir = cpi?.trend?.length >= 2
    ? (cpi.trend.at(-1).yoy >= cpi.trend[0].yoy ? 'up' : 'down')
    : 'flat';
  const cpiSparkHistory = cpi?.trend?.map(t => ({ close: t.yoy })) ?? [];

  function toggleCard(key) {
    setExpandedCard(prev => (prev === key ? null : key));
  }
  function handleCardKeyDown(e, key) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); // 스페이스의 기본 스크롤 동작 방지
      toggleCard(key);
    }
  }

  const fomcExpanded = expandedCard === 'fomc';
  const cpiExpanded = expandedCard === 'cpi';
  const unemploymentExpanded = expandedCard === 'unemployment';

  return (
    <section className="brf-section">
      <div className="brf-section-head">
        <span className="brf-section-title">매크로 현황</span>
      </div>

      {urgentEvents.length > 0 && (
        <div
          className="brf-macro-banner"
          role="button"
          tabIndex={0}
          onClick={() => onPageChange('calendar')}
        >
          {urgentEvents.map((e, i) => <EventBanner key={i} event={e} />)}
        </div>
      )}

      {/*
        카드/패널 순서는 DOM이 아니라 order로 정한다(+ .brf-macro-cards의
        grid-auto-flow:dense) — 모바일(1열)에서는 상세 패널이 그 카드 바로 다음
        order라 곧장 그 카드 아래에 놓이고(요구사항2), 데스크톱(3열)에서는 dense
        패킹이 order상 패널 "뒤"인 카드들을 패널이 만든 빈 칸(1열 그리드 폭 3칸 중
        나머지) 대신 먼저 온 줄로 당겨 채워서, 결국 카드 3장이 한 줄을 가득 채우고
        펼쳐진 패널만 그 다음 줄(전체 폭)에 놓인다. 카드는 10/20/30, 각 카드의 패널은
        바로 뒤 값(15/25/35)으로 끼워 넣는다.
      */}
      <div className="brf-macro-cards">
        {fomc?.rate && (
          <div
            className={`brf-macro-card brf-macro-card-expandable${fomcExpanded ? ' active' : ''}`}
            style={{ order: 10 }}
            role="button"
            tabIndex={0}
            aria-expanded={fomcExpanded}
            onClick={() => toggleCard('fomc')}
            onKeyDown={e => handleCardKeyDown(e, 'fomc')}
          >
            <div className="brf-macro-card-label-row">
              <span className="brf-macro-card-label">FOMC 기준금리</span>
              <span className="brf-macro-card-chevron" aria-hidden="true">{fomcExpanded ? '▴' : '▾'}</span>
            </div>
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
        {fomc?.rate && (
          <MacroDetailPanel
            kind="fomc"
            expanded={fomcExpanded}
            orderValue={15}
            insightPhase={insightPhase}
            insightText={insight?.fomc}
          />
        )}

        {cpi && (
          <div
            className={`brf-macro-card brf-macro-card-expandable${cpiExpanded ? ' active' : ''}`}
            style={{ order: 20 }}
            role="button"
            tabIndex={0}
            aria-expanded={cpiExpanded}
            onClick={() => toggleCard('cpi')}
            onKeyDown={e => handleCardKeyDown(e, 'cpi')}
          >
            <div className="brf-macro-card-label-row">
              <span className="brf-macro-card-label">CPI (소비자물가)</span>
              <span className="brf-macro-card-chevron" aria-hidden="true">{cpiExpanded ? '▴' : '▾'}</span>
            </div>
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
        {cpi && (
          <MacroDetailPanel
            kind="cpi"
            expanded={cpiExpanded}
            orderValue={25}
            cpi={cpi}
            cpiDir={cpiDir}
            cpiSparkHistory={cpiSparkHistory}
            insightPhase={insightPhase}
            insightText={insight?.cpi}
          />
        )}

        {unemployment && (
          <div
            className={`brf-macro-card brf-macro-card-expandable${unemploymentExpanded ? ' active' : ''}`}
            style={{ order: 30 }}
            role="button"
            tabIndex={0}
            aria-expanded={unemploymentExpanded}
            onClick={() => toggleCard('unemployment')}
            onKeyDown={e => handleCardKeyDown(e, 'unemployment')}
          >
            <div className="brf-macro-card-label-row">
              <span className="brf-macro-card-label">실업률</span>
              <span className="brf-macro-card-chevron" aria-hidden="true">{unemploymentExpanded ? '▴' : '▾'}</span>
            </div>
            <div className="brf-macro-card-main">{unemployment.rate.toFixed(1)}%</div>
            <div className="brf-macro-card-sub">{unemployment.refMonth} 기준</div>
          </div>
        )}
        {unemployment && (
          <MacroDetailPanel
            kind="unemployment"
            expanded={unemploymentExpanded}
            orderValue={35}
            unemployment={unemployment}
            insightPhase={insightPhase}
            insightText={insight?.unemployment}
          />
        )}
      </div>
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

// ── 지난 브리핑 칩 줄 ────────────────────────────────────────────
// 예전엔 "지난 브리핑" 제목을 단 독립 섹션이었으나, 이제 브리핑 카드(.brf-ai-card)
// 안으로 이동해 버튼 바로 아래(미생성 상태) 또는 헤더와 본문 사이(표시 상태)에
// 인라인으로 삽입된다 — 호출부(BriefingPage 본체/HistoryDetailBody)에서
// historyPhase==='done' && dates.length>0일 때만 렌더하도록 가드한다.
function HistoryChipRow({ dates, selectedDate, showAll, onToggleShowAll, onSelectDate }) {
  const visible = dates.slice(0, showAll ? 30 : 7);
  const hasMore = !showAll && dates.length > 7;

  return (
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
  );
}

// ── 지난 브리핑 상세(선택한 날짜) 본문 ─────────────────────────
// data는 api/briefing-history.js가 주는 { date, morning, manual } — 슬롯당 없으면 null.
// viewSlot('morning'|'manual')이 가리키는 쪽을 렌더링하고, 둘 다 있는 날짜에만 서로
// 전환하는 배지 버튼을 보여준다. generated_at("YYYY-MM-DD HH:MM KST")에서 시:분만 뽑아
// "아침 보고 08:30" / "수동 생성 14:20" 라벨을 만든다.
function slotTimeLabel(slot, entry) {
  const time = entry?.generated_at ? entry.generated_at.slice(11, 16) : '';
  return slot === 'morning' ? `아침 보고 ${time}` : `수동 생성 ${time}`;
}

// historyChips: 지난 브리핑 칩 줄(HistoryChipRow, 없으면 null) — 날짜/헤더가 있는
// 'done' 단계에서는 헤더 바로 아래·본문 위에, 로딩/에러 단계에서는 상단에 그대로
// 얹어서 날짜 탐색을 계속할 수 있게 한다.
function HistoryDetailBody({ phase, date, data, viewSlot, onToggleSlot, error, historyChips }) {
  if (phase === 'loading') {
    return (
      <>
        {historyChips}
        <div className="brf-ai-loading">
          <span className="brf-dot" />
          <span className="brf-dot" />
          <span className="brf-dot" />
          <span>{date} 브리핑을 불러오는 중…</span>
        </div>
      </>
    );
  }

  if (phase === 'error') {
    return (
      <>
        {historyChips}
        <div className="brf-ai-error">
          <p className="brf-error-title">{date} 브리핑을 불러올 수 없습니다</p>
          <p className="brf-error-detail">{error}</p>
        </div>
      </>
    );
  }

  if (phase === 'done' && data) {
    const hasBoth = Boolean(data.morning) && Boolean(data.manual);
    const current = data[viewSlot] ?? data.manual ?? data.morning;
    if (!current) return null;

    return (
      <div className="brf-ai-result">
        <div className="brf-history-label-row">
          <span className="brf-history-label">{date} 브리핑</span>
          <span className={`brf-slot-badge brf-slot-${viewSlot}`}>{slotTimeLabel(viewSlot, current)}</span>
        </div>
        {historyChips}
        <div className="brf-ai-text">{renderBriefingMarkdown(current.briefing)}</div>
        <div className="brf-ai-meta">
          <span>{current.generated_at}</span>
          {hasBoth && (
            <button className="brf-slot-toggle-btn" onClick={onToggleSlot}>
              {viewSlot === 'morning' ? '수동 생성 보기' : '아침 보고 보기'}
            </button>
          )}
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
