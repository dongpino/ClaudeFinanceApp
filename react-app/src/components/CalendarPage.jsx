import { useState, useEffect, useRef } from 'react';
import Header from './Header';
import BottomNav from './BottomNav';
import PhotoBackground from './PhotoBackground';

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

// 브리핑 탭의 "주요 이슈" 카테고리 아이콘과 별개(이벤트 카테고리 전용) —
// AnalysisChart.jsx의 MA20/60/100/200·RSI 색상을 그대로 재사용해 앱 전체 색상 언어와 일관되게.
const CATEGORY_ICON = { fomc: '🏦', cpi: '📊', expiry: '🎯', msci: '🌐', earnings: '📈' };
const CATEGORY_COLOR = { fomc: '#22d3ee', cpi: '#f97316', expiry: '#a855f7', msci: '#10b981', earnings: '#fbbf24' };

function todayKST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function formatDDay(n) {
  if (n < 0) return '진행중';
  if (n === 0) return 'D-DAY';
  return `D-${n}`;
}

function formatDetailDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const weekday = WEEKDAY_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}년 ${m}월 ${d}일 (${weekday})`;
}

// 'YYYY-MM-DD' 시작~종료(포함) 사이 모든 날짜 문자열 — FOMC처럼 여러 날 이어지는 이벤트를
// 그리드의 각 날짜 셀에 전부 표시하기 위함.
function datesInRange(startStr, endStr) {
  const dates = [];
  let cur = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 86_400_000);
  }
  return dates;
}

function EventDetailRow({ event }) {
  return (
    <div className="cal-detail-row">
      <span className="cal-detail-icon">{CATEGORY_ICON[event.category] ?? '🔔'}</span>
      <span className="cal-detail-title">{event.title}</span>
      <span className={`brf-event-region brf-event-${event.region}`}>{event.region}</span>
      {event.time && <span className="cal-detail-time">{event.time}</span>}
    </div>
  );
}

function UpcomingRow({ event }) {
  return (
    <div className="brf-event-row">
      <span className="brf-event-icon">{CATEGORY_ICON[event.category] ?? '🔔'}</span>
      <span className="brf-event-title">{event.title}</span>
      <span className={`brf-event-region brf-event-${event.region}`}>{event.region}</span>
      <span className="brf-macro-dday">{formatDDay(event.dDay)}</span>
    </div>
  );
}

export default function CalendarPage({ activePage, onPageChange }) {
  const todayStr = todayKST();
  const [todayY, todayM] = todayStr.split('-').map(Number);

  const [viewYear, setViewYear]   = useState(todayY);
  const [viewMonth, setViewMonth] = useState(todayM); // 1~12
  const [monthEvents, setMonthEvents] = useState([]);
  const [monthPhase, setMonthPhase]   = useState('loading');
  const [selectedDate, setSelectedDate] = useState(todayStr);

  const [upcoming, setUpcoming]           = useState([]);
  const [upcomingPhase, setUpcomingPhase] = useState('loading');

  const detailRef = useRef(null);
  const scrollRef = useRef(null); // .cal-scroll — PhotoBackground 패럴랙스가 구독하는 스크롤 컨테이너

  function selectDate(dateStr) {
    setSelectedDate(dateStr);
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  useEffect(() => {
    setMonthPhase('loading');
    fetch(`/api/calendar?year=${viewYear}&month=${viewMonth}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        setMonthEvents(Array.isArray(data.events) ? data.events : []);
        setMonthPhase('done');
      })
      .catch(() => setMonthPhase('error'));
  }, [viewYear, viewMonth]);

  // 다가오는 이벤트(30일) — 브리핑 탭에 있던 리스트를 이곳으로 이사, 월 이동과 무관하게 1회 로드
  useEffect(() => {
    fetch('/api/calendar?upcoming=30')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        setUpcoming(Array.isArray(data.events) ? data.events : []);
        setUpcomingPhase('done');
      })
      .catch(() => setUpcomingPhase('error'));
  }, []);

  function goPrevMonth() {
    if (viewMonth === 1) { setViewYear(y => y - 1); setViewMonth(12); }
    else setViewMonth(m => m - 1);
  }
  function goNextMonth() {
    if (viewMonth === 12) { setViewYear(y => y + 1); setViewMonth(1); }
    else setViewMonth(m => m + 1);
  }

  // 날짜별 이벤트 맵 — FOMC처럼 endDate가 있으면 그 구간 모든 날짜에 표시
  const eventsByDate = {};
  for (const e of monthEvents) {
    const dates = e.endDate ? datesInRange(e.date, e.endDate) : [e.date];
    for (const d of dates) (eventsByDate[d] ??= []).push(e);
  }

  const daysInMonth   = new Date(Date.UTC(viewYear, viewMonth, 0)).getUTCDate();
  const firstWeekday  = new Date(Date.UTC(viewYear, viewMonth - 1, 1)).getUTCDay();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const selectedEvents = eventsByDate[selectedDate] ?? [];
  const visibleUpcoming = upcoming.slice(0, 7);

  return (
    <>
      <PhotoBackground src="/bg/forest-calendar.webp" scrollContainerRef={scrollRef} />
      <Header />
      <div className="page active">
        <div className="cal-scroll" ref={scrollRef}>
          <div className="cal-scroll-inner">
            <div className="cal-fold">
              <div className="cal-header">
                <button type="button" className="cal-nav-btn" onClick={goPrevMonth} aria-label="이전 달">‹</button>
                <span className="cal-month-label">{viewYear}년 {viewMonth}월</span>
                <button type="button" className="cal-nav-btn" onClick={goNextMonth} aria-label="다음 달">›</button>
              </div>

              <div className="cal-weekday-row">
                {WEEKDAY_KO.map((w, i) => (
                  <span key={w} className={`cal-weekday${i === 0 ? ' sun' : ''}${i === 6 ? ' sat' : ''}`}>{w}</span>
                ))}
              </div>

              <div className="cal-grid">
                {cells.map((d, i) => {
                  if (d === null) return <div key={i} className="cal-cell empty" />;
                  const dateStr = `${viewYear}-${String(viewMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                  const dayEvents = eventsByDate[dateStr] ?? [];
                  const weekday = (firstWeekday + d - 1) % 7;
                  const isToday    = dateStr === todayStr;
                  const isSelected = dateStr === selectedDate;
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`cal-cell${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}${weekday === 0 ? ' sun' : ''}${weekday === 6 ? ' sat' : ''}`}
                      onClick={() => selectDate(dateStr)}
                    >
                      <span className="cal-cell-day">{d}</span>
                      {dayEvents.length > 0 && (
                        <>
                          {/* 데스크톱(>768px) — 라벨 칩. CSS 미디어쿼리로 모바일에선 숨김 */}
                          <span className="cal-cell-chips">
                            {dayEvents.slice(0, 2).map((e, j) => (
                              <span
                                key={j}
                                className={`cal-chip cal-chip-${e.category}`}
                                style={{ '--chip-color': CATEGORY_COLOR[e.category] ?? '#999' }}
                              >
                                {e.shortLabel || e.title.slice(0, 5)}
                              </span>
                            ))}
                            {dayEvents.length > 2 && <span className="cal-chip-more">+{dayEvents.length - 2}</span>}
                          </span>
                          {/* 모바일(≤768px) — 점. CSS 미디어쿼리로 데스크톱에선 숨김 */}
                          <span className="cal-cell-dots">
                            {dayEvents.slice(0, 3).map((e, j) => (
                              <span key={j} className="cal-dot" style={{ background: CATEGORY_COLOR[e.category] ?? '#999' }} />
                            ))}
                            {dayEvents.length > 3 && <span className="cal-dot-more">+{dayEvents.length - 3}</span>}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="cal-detail" ref={detailRef}>
              <div className="cal-detail-label">{formatDetailDate(selectedDate)}</div>
              {monthPhase === 'done' && selectedEvents.length === 0 && (
                <p className="cal-detail-empty">이 날은 예정된 이벤트가 없습니다.</p>
              )}
              {selectedEvents.map((e, i) => <EventDetailRow key={i} event={e} />)}
            </div>

            {upcomingPhase === 'done' && visibleUpcoming.length > 0 && (
              <div className="brf-event-list">
                <div className="brf-event-list-label">다가오는 이벤트 (30일 이내)</div>
                {visibleUpcoming.map((e, i) => <UpcomingRow key={i} event={e} />)}
              </div>
            )}
          </div>
        </div>
      </div>
      <BottomNav activePage={activePage} onPageChange={onPageChange} />
    </>
  );
}
