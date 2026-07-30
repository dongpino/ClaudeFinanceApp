import { useState, useEffect, useCallback } from 'react';

/**
 * SettingsPanel — 설정(톱니) 화면. 현재는 "데이터 소스 상태"(관측성 2단계) 한 섹션만
 * 담지만, 다른 설정 기능이 추가돼도 각 섹션이 서로 격리되도록 섹션 단위로 구성한다.
 *
 * 데이터 소스 상태판:
 *  · /api/health(getHealthSnapshot, SOURCES 상수 기준)를 열 때 1회 조회 + 수동 새로고침.
 *    자동 폴링은 하지 않는다(유지보수용 화면).
 *  · 응답의 sources 배열을 그대로 렌더하므로(프론트에서 소스 목록을 하드코딩하지 않음)
 *    cnbc 같은 최근 편입분도, 수집기가 없는 calendar 유사 행(kind:'derived')도 자동으로
 *    목록에 나타난다. 유사 행은 note 필드로 수집 시각/성공률 대신 자체 요약을 낸다.
 *  · 로드 실패는 이 섹션 안에서만 표시(설정의 다른 기능과 격리).
 */

const HEALTH_TIMEOUT_MS = 8000;

// 폴백 전용 소스 — 주 소스가 정상이면 아예 호출되지 않아 'unknown'이 정상 상태다.
// stale/미수집으로 오해되지 않게 '대기(standby)' 회색으로 따로 표기한다.
//   · bybit = BTC/ETH 크립토 폴백  · yahoo = 코스피/코스닥 지수 폴백(Naver 장애 시)
//   · daum = 개별 KR 종목 폴백(Naver 장애 시)
const STANDBY_SOURCES = new Set(['bybit', 'yahoo', 'daum']);

// 온디맨드 소스(binance/twelvedata — 분석·상세 화면에서만 호출)는 나이 기반 판정이
// 성립하지 않아 별도 규칙으로 본다. 그 판정은 서버(_lib/health.js의 ON_DEMAND_SOURCES /
// judgeStatus)가 'idle'로 내려주므로 여기서 다시 계산하지 않는다 — 임계값이 두 곳에
// 흩어져 어긋나는 걸 막으려고 2026-07-28에 서버로 일원화했다.

// 소스 id → 사람이 읽는 라벨. 없는 id는 raw 그대로 노출(신규 편입분이 사라지지 않게).
const SOURCE_LABELS = {
  'naver':          '네이버 · 한국 종목',
  'naver-index':    '네이버 · 지수/환율',
  'yahoo':          'Yahoo · 지수 폴백',
  'daum':           'Daum · 한국종목 폴백',
  'finnhub':        'Finnhub · 미국 시세',
  'twelvedata':     'Twelve Data · 미국 일봉',
  'cnbc':           'CNBC · 미국 지수',
  'coingecko':      'CoinGecko · 크립토/도미넌스',
  'binance':        'Binance · BTC/ETH',
  'bybit':          'Bybit · BTC/ETH 폴백',
  'alternative-me': 'Alternative.me · 공포탐욕',
  'fred':           'FRED · 미국 매크로',
  'bok':            '한국은행 · 기준금리',
  'rss-yna':        '연합뉴스 RSS',
  'rss-asiae':      '아시아경제 RSS',
  'rss-edaily':     '이데일리 RSS',
  'rss-coindesk':   'CoinDesk RSS',
  // 수집기가 없는 유사 행(api/health.js buildCalendarSource) — 하드코딩 일정 소진 감시용
  'calendar':       '시장 캘린더 · 일정',
  // KASI 특일정보 자동대조 유사 행(api/_lib/holiday-audit.js) — 휴장일 표의 미래 구간 감시
  'kasi-audit':     'KASI · 휴장일 자동대조',
  // 검사 1(절대 타당성) 실행 계측 유사 행(api/health.js buildValueGuardSource)
  'value-guard':    '값 검사 · 절대 타당성',
  // 검사 2a(상대 타당성 — 가격 축) 유사 행(api/health.js buildRelativeGuardSource)
  // ⚠️ 2b(change 축)는 아직 미구현 — 이름에 2a를 박아 '상대 타당성 전부'로 읽히지 않게 한다.
  'relative-guard': '값 검사 · 상대 타당성(2a)',
};

const STATUS_META = {
  ok:      { label: '정상',      cls: 'ok' },
  stale:   { label: '지연',      cls: 'stale' },
  warn:    { label: '갱신 필요', cls: 'warn' },
  down:    { label: '장애',      cls: 'down' },
  standby: { label: '대기',      cls: 'standby' },
  unknown: { label: '미수집',    cls: 'unknown' },
};

// health 스냅샷의 원시 status를 화면 표기용 상태로 보정한다.
// 서버가 내리는 'idle'(온디맨드 미호출)과 폴백 전용 소스의 'unknown'은 둘 다 화면에선
// 같은 '대기' 배지로 묶는다 — 사유 구분은 standbyKind()가 문구로 한다.
function presentStatus(s) {
  if (STANDBY_SOURCES.has(s.source) && s.status === 'unknown') return 'standby';
  if (s.status === 'idle') return 'standby';
  return s.status;
}

// '대기'는 두 가지 사유로 뜬다 — 문구가 달라야 오해가 없다.
//   fallback: 폴백 전용 소스라 주 소스가 정상이면 아예 호출되지 않음(bybit/yahoo/daum)
//   idle    : 온디맨드 소스인데 최근 호출 자체가 없었음(binance/twelvedata)
function standbyKind(s) {
  return s.status === 'idle' ? 'idle' : 'fallback';
}

function relTime(iso) {
  if (!iso) return '기록 없음';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '방금';
  const min = Math.floor(ms / 60000);
  if (min < 1)  return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

export default function SettingsPanel({ onClose }) {
  const [sources, setSources]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [checkedAt, setCheckedAt] = useState(null);
  const [store, setStore]         = useState(null); // { storeFp, env } — 어느 KV/환경을 보고 있는지
  const [expanded, setExpanded]   = useState(false); // 유지보수용 — 기본 접힘

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    fetch('/api/health', { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        if (!Array.isArray(data.sources)) throw new Error('sources 배열 없음');
        setSources(data.sources);
        setCheckedAt(data.checkedAt ?? new Date().toISOString());
        setStore(data.storeFp ? { storeFp: data.storeFp, env: data.env ?? '?' } : null);
      })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message || '상태 조회 실패'); })
      .finally(() => { clearTimeout(tid); setLoading(false); });
    return () => { clearTimeout(tid); ctrl.abort(); };
  }, []);

  useEffect(() => load(), [load]); // 설정 열 때 1회(자동 폴링 없음)

  const hasDown = Array.isArray(sources) && sources.some(s => presentStatus(s) === 'down');

  return (
    <div className="major-edit-backdrop" onClick={onClose}>
      <div className="major-edit-panel" onClick={e => e.stopPropagation()}>
        <div className="major-edit-header">
          <span className="major-edit-title">설정</span>
          <button className="major-edit-close" onClick={onClose} aria-label="닫기">×</button>
        </div>

        <section className="settings-section">
          <button
            className="settings-section-head"
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
          >
            <span className="settings-section-title">
              데이터 소스 상태
              {hasDown && <span className="settings-down-badge" title="장애 소스 있음" />}
            </span>
            <span className={`settings-chevron ${expanded ? 'open' : ''}`} aria-hidden="true">⌄</span>
          </button>

          {expanded && (
            <div className="settings-section-body">
              <div className="settings-health-toolbar">
                <span className="settings-health-checked">
                  {checkedAt ? `${relTime(checkedAt)} 확인` : ''}
                  {/* 어느 KV를 보고 있는지 — 진단 스크립트 STORE_FP와 대조용.
                      env가 production이 아니면 배포본 신호가 아니라는 뜻이라 함께 표기. */}
                  {store && (
                    <span className="settings-store-fp" title={`KV 지문 ${store.storeFp} · 환경 ${store.env}`}>
                      {` · ${store.storeFp}`}{store.env !== 'production' && ` (${store.env})`}
                    </span>
                  )}
                </span>
                <button className="settings-refresh-btn" onClick={load} disabled={loading}>
                  {loading ? '조회 중…' : '새로고침'}
                </button>
              </div>

              {loading && !sources && <p className="settings-health-msg">불러오는 중…</p>}
              {error && (
                <p className="settings-health-error">상태를 불러오지 못했습니다 — {error}</p>
              )}
              {!error && sources && (
                <ul className="settings-health-list">
                  {sources.map(s => {
                    const st        = presentStatus(s);
                    const meta      = STATUS_META[st] ?? STATUS_META.unknown;
                    const isStandby = st === 'standby';
                    const sbKind    = isStandby ? standbyKind(s) : null;
                    const rate      = s.todayRate == null ? null : Math.round(s.todayRate * 100);
                    return (
                      <li key={s.source} className="settings-health-row">
                        <span className={`settings-dot ${meta.cls}`} aria-hidden="true" />
                        <span className="settings-src-name">{SOURCE_LABELS[s.source] ?? s.source}</span>
                        <span
                          className={`settings-src-status ${meta.cls}`}
                          title={
                            sbKind === 'fallback' ? '주 소스 정상 시 호출되지 않음'
                            : sbKind === 'idle' ? '해당 화면을 열 때만 호출되는 소스 — 최근 24시간 호출 없음'
                            : st === 'warn' ? '하드코딩 일정 소진 임박 — 배열 갱신 필요'
                            : (st === 'down' || st === 'stale') && s.lastError
                              // lastError는 성공해도 남으므로 '지금 유효한 오류'인지 밝혀야
                              // 옛 오류를 현재 장애로 오독하지 않는다(binance 위양성 교훈).
                              ? `마지막 오류: ${s.lastError}${s.lastErrorResolved ? ' (이후 성공 있음 — 해소됨)' : ''}`
                            : undefined
                          }
                        >
                          {meta.label}
                        </span>
                        {/* note가 있는 행(수집기 없는 유사 행)은 수집 시각/성공률 대신 자체 요약을 쓴다 */}
                        <span className="settings-src-meta" title={s.note || undefined}>
                          {/* idle 대기는 "언제가 마지막이었나"가 실제 정보라 시각을 그대로 보여준다 */}
                          {s.note ? s.note
                            : sbKind === 'fallback' ? '대기 중'
                            : sbKind === 'idle' ? `미호출 · ${relTime(s.lastSuccessAt)}`
                            : (
                            <>
                              {relTime(s.lastSuccessAt)}
                              {rate != null && <> · {rate}%</>}
                              {/* 배포본이 아닌 기록이면 표시 — production에선 나타나지 않는다 */}
                              {s.lastEnv && s.lastEnv !== 'production' && <> · {s.lastEnv}</>}
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
