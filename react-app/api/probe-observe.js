/**
 * api/probe-observe.js — [관측] 회차 스냅샷을 **서버 측에서** 적재하는 범용 프로브
 *
 * 목적: 밤 시간대 관측을 PC 가동 여부와 무관하게 만든다. 지금까지 밤 관측은 로컬 셸
 * 예약에 의존했고 PC가 꺼져 있으면 회차가 통째로 유실됐다(2026-08-03 밤 예약 3건 유실).
 *
 * ⚠️ probe-cnbc-format의 한계를 반복하지 않는다 — 그쪽은 `prev_close`를 담지 않아
 *    [c] 롤 시각 판정이 **원리상 불가능**했다(2026-08-03 확인). 이 프로브는 prev_close를
 *    항목마다 필수로 적재한다.
 *
 * GET /api/probe-observe            — Cron(Authorization: Bearer CRON_SECRET)
 * GET /api/probe-observe?key=…      — 수동 캡처(DEBUG_SIGNALS_KEY)
 * GET /api/probe-observe?key=…&view=1 — 쌓인 회차 조회(수집 유도 없음, Redis만 읽음)
 * 선택 파라미터: ?window=us-open (창 라벨 명시) / ?ids=nasdaq,vix (관측 대상 축소)
 * 기본 관측 대상은 **검사 2a 대상 전체**다(ASSET_META의 cross·semi에서 파생 — DEFAULT_IDS 주석).
 *
 * ── 판정 좌표는 반드시 원본이다 ──────────────────────────────────────
 * 서빙본의 `change`는 recalcChange 분기1이 h[-1]/h[-2]로 만든 값이라 **축퇴를 가린다.**
 *   실측 2026-08-03: nasdaq 서빙본 change=+251.67이었지만 원본 좌표에서는
 *   price == prev_close == 25,373.85 로 축퇴 상태였다.
 * 그래서 축퇴 판정은 originOf() 좌표에서만 하고(relative-guard.js:425), 사람이 되짚을 수
 * 있게 recalcFrom 원본과 degenEvidence(원본 두 값·h1 종가·양자·동치판정 2종)를 함께 적재한다.
 *
 * ── 판정 로직을 여기서 새로 쓰지 않는다 ──────────────────────────────
 * alignment·degenerate·축 상태는 전부 _lib/relative-guard.js의 **그 함수들**을 호출해 얻는다.
 * 프로브가 판정을 복제하면 서빙 경로의 판정과 조용히 갈라지고, 그러면 이 기록으로
 * 서빙 동작을 되짚을 수 없다. relative-guard는 순수 모듈이라(네트워크·Redis 없음)
 * import해도 관측 대상을 오염시키지 않는다.
 *
 * ── 격리(health.js 기록층·probe-store와 동일 원칙) ───────────────────
 *  · 이 핸들러는 실패해도 200을 돌려준다 — 크론의 성패는 "기록을 남겼는가"다.
 *  · saveProbe/readProbe는 절대 throw하지 않는다(probe-store.js:11).
 *  · 서빙 키(lastgood:* / market:home:v1 / market:detail:*)에 **쓰지 않는다.**
 *    이 파일은 _lib/last-good.js도 market-data.js도 import하지 않는다.
 *  ⚠️ 다만 아래 A-1 부작용은 명시해 둔다 — 수집 유도가 HTTP 자기호출이므로, 요청을 받은
 *    **서빙 함수가 평소대로** lastgood:*를 커밋하고 market:home:v1을 채운다. 프로브가
 *    서빙 키를 쓰는 것이 아니라 서빙 경로가 자기 일을 하는 것이고, 사용자 요청 1건과
 *    구별 불가능하다. 프로브 실패는 여전히 서빙으로 전파되지 않는다.
 *
 * ── 스케줄(2026-08-04 등록): KST = UTC+9 ─────────────────────────────
 *   22:20 KST = 13:20 UTC = 09:20 EDT — 정규장 개장 10분 전
 *   22:32 KST = 13:32 UTC = 09:32 EDT — 개장 2분 후
 *   22:45 KST = 13:45 UTC = 09:45 EDT — 개장 15분 후
 * 오늘은 US 개장 창 하나만 건다. 창 정의는 아래 WINDOWS 설정 객체에 있고, 창 안에서
 * 회차를 늘리는 것은 **vercel.json에 크론 한 줄 추가**로 끝난다(설정 변경 0줄).
 */

import { saveProbe, readProbe, kstStamp, etStamp, isAuthorized } from './_lib/probe-store.js';
import { ASSET_META } from './_lib/asset-meta.js';
import { originOf, alignBySignal, checkCross, tradingDateOf } from './_lib/relative-guard.js';

const KEY = 'probe:observe';

/**
 * 기본 관측 대상 — **검사 2a 대상 전체를 ASSET_META에서 파생한다(2026-08-05).**
 *
 * 종전에는 6종 하드코딩이었다(nasdaq·dow·sp500·sox·vix·HYPR — 신설 당시 지시받은 범위).
 * 그 결과 검사 2a 대상 11종 중 **5종(dxy·us10y·419530·028300·080220)이 관측 밖**이었고,
 * 그 5종은 "검증 실패"가 아니라 **판정할 데이터가 없는** 상태로 남았다.
 *   실측 [저장소:9072dee8:probe:observe:2026-08-04 4회차] 계상 축 31개 중 진짜 검사 6개.
 *
 * ⚠️ **파생하는 이유**: 이 프로브의 관측 대상은 "검사 2a가 무엇을 검사하는가"와 정의상
 *    같은 집합이다. 그 집합을 정하는 것이 등급(ASSET_META.cross)이므로, 등급이 바뀌면
 *    프로브가 따라와야 둘이 갈라지지 않는다 — 하드코딩은 그 순간 조용히 어긋나고,
 *    어긋난 사실이 "그 종목은 관측된 적 없음"으로만 드러나 알아채기 어렵다.
 *    checkCross가 tauto·tautological·무등급을 최상단에서 조기반환하므로
 *    (relative-guard.js:565-569) cross·semi가 곧 "정렬 판정에 도달하는 항목"이다.
 * ⚠️ **market-data.js의 ITEM_ORDER를 import하지 않는다** — 파일 상단 격리 원칙대로 서빙
 *    모듈을 끌어오지 않는다. ASSET_META는 네트워크·Redis 없는 순수 상수 테이블이라
 *    import해도 관측 대상이 오염되지 않는다(relative-guard와 같은 근거).
 *    홈 응답에 없는 id가 섞이면 그 회차에 {absent:true}로 남을 뿐이고 그것도 기록이다.
 * ⚠️ 순서는 ASSET_META 정의 순서를 그대로 따른다 — 별도 정렬을 두면 그것대로 유지 대상이 된다.
 * ?ids=로 회차별 축소·확대는 종전대로 가능하다(capture()의 idsQ가 이 값을 덮는다).
 */
const CHECK_2A_GRADES = new Set(['cross', 'semi']);
export const DEFAULT_IDS = Object.entries(ASSET_META)
  .filter(([, m]) => CHECK_2A_GRADES.has(m?.cross))
  .map(([id]) => id);

const FETCH_TIMEOUT_MS = 25_000;   // MISS면 실제 수집이 돌아 수 초~십수 초 걸린다

/**
 * ── 창(window) 정의 — **폴백 전용 상수** ──────────────────────────────
 * 확립 규약: 응답(=신호)에서 파생 가능한 것을 코드 상수로 굳히지 않는다. 상수는 신호
 * 부재 시 폴백으로만 쓴다. 그래서 창은 "몇 시 몇 분 회차"의 목록이 아니라 **시각 범위**로
 * 둔다 — 목록으로 두면 크론을 한 줄 추가할 때마다 여기도 한 줄 고쳐야 한다.
 * 범위로 두면 같은 창 안의 회차 추가는 vercel.json 한 줄로 끝난다.
 */
const WINDOWS = {
  'us-open': { label: '미 정규장 개장 전후', tz: 'America/New_York', from: 9 * 60, to: 10 * 60 + 30 },
};

// ── 유틸 ────────────────────────────────────────────────────────────
const num = v => (Number.isFinite(v) ? v : null);
const absDiff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) : null);

/** 'YYYY-MM-DDTHH:mm KST' — 해시 필드명(=회차 식별자). 문자열 정렬이 곧 시간순이다. */
function fieldOf(d = new Date()) { return kstStamp(d).replace(' ', 'T'); }

/** 그 순간의 tz 로컬 분(0~1439). */
function localMinutes(d, tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d);
  const g = t => Number(p.find(x => x.type === t)?.value ?? 0);
  return g('hour') * 60 + g('minute');
}

/** 그 순간이 어느 창에 드는가. 창마다 tz가 다를 수 있어 tz별 분을 지연 계산한다. 없으면 null. */
function windowAt(tzMinutesOf) {
  for (const [name, w] of Object.entries(WINDOWS)) {
    const m = tzMinutesOf(w.tz);
    if (m >= w.from && m <= w.to) return name;
  }
  return null;
}

/**
 * **창 식별 — 1순위는 크론 헤더, 부재 시 폴백한다.**
 *
 * [원문 https://vercel.com/docs/cron-jobs, last_updated 2026-06-16]
 *   "Each request also includes an `x-vercel-cron-schedule` header containing the cron
 *    expression that triggered the invocation … You can use this header to determine
 *    which schedule triggered your function when multiple cron jobs share the same path."
 *
 * ⚠️ **헤더가 안 오면 창 식별이 통째로 실패하는 구조를 피한다.** 헤더는 Vercel이 붙이는
 *    것이라 수동 호출·로컬 실행·플랫폼 변경 어느 쪽으로도 사라질 수 있다. 그래서 3단이다:
 *      ① cron-schedule 헤더의 **예정 시각**(hour/minute 필드)을 창 범위와 대조   → 'cron-schedule'
 *      ② ?window= 명시                                                        → 'query'
 *      ③ **실제 캡처 시각**을 같은 창 범위와 대조                                → 'capture-clock'
 *      ④ 어디에도 안 들면 null                                                 → 'unresolved'
 *    ①과 ③은 같은 WINDOWS 범위를 쓴다 — 판정 규칙이 하나라 둘이 갈라지지 않는다.
 *    ①이 ③보다 앞서는 이유: 크론이 지연 발화하면 실제 시각은 창 밖으로 나갈 수 있지만
 *    **예정 시각은 설계 의도 그대로**다. 지연은 at/kst 기록으로 따로 드러난다.
 * ⚠️ 헤더 원문(cronSchedule)은 창 판정 성공 여부와 무관하게 **항상 그대로 적재**한다.
 *    파생값이 틀렸을 때 되짚을 수 있는 근거는 원문뿐이다.
 */
export function resolveWindow(req, at) {
  const raw = req?.headers?.['x-vercel-cron-schedule'] ?? null;
  const tzMinutesAt = d => tz => localMinutes(d, tz);

  // ① 크론 예정 시각 — "m h * * *"의 앞 두 필드가 단일 숫자일 때만 쓴다(*, 목록, 스텝은 기권).
  if (typeof raw === 'string') {
    const [mm, hh] = raw.trim().split(/\s+/);
    if (/^\d{1,2}$/.test(mm ?? '') && /^\d{1,2}$/.test(hh ?? '')) {
      const scheduled = new Date(Date.UTC(
        at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), Number(hh), Number(mm), 0));
      const w = windowAt(tzMinutesAt(scheduled));
      if (w) return { window: w, windowBasis: 'cron-schedule', cronSchedule: raw };
    }
  }
  // ② 명시
  const q = req?.query?.window;
  if (typeof q === 'string' && q) {
    return { window: q, windowBasis: WINDOWS[q] ? 'query' : 'query-unknown', cronSchedule: raw };
  }
  // ③ 실제 캡처 시각
  const w = windowAt(tzMinutesAt(at));
  if (w) return { window: w, windowBasis: 'capture-clock', cronSchedule: raw };
  // ④
  return { window: null, windowBasis: 'unresolved', cronSchedule: raw };
}

/**
 * ── 수집 1회차 유도 — HTTP 자기호출(A-1) ─────────────────────────────
 * 서빙 함수를 그대로 부른다. 관측 대상이 "서빙본과 원본 좌표의 괴리"이므로, 서빙 경로를
 * 통과한 **그 객체**를 봐야 한다(수집기를 직접 import하면 last-good 폴백·stale이 빠진
 * 다른 객체가 되고, 게다가 trackedFetch가 health 집계를 오염시킨다).
 *
 * ⚠️ **X-Cache: MISS는 보장되지 않는다 — 이건 측정 질문으로 남긴다.**
 *    유니크 쿼리는 CDN만 우회하고 L1(인메모리, 인스턴스별)·L2(Redis market:home:v1,
 *    TTL 300초)는 그대로 탄다(market-data.js:186-201). 크론 간격이 12~13분이라 L2는
 *    만료돼 있을 **가능성이 높지만**, 직전 5분 내 사용자 트래픽이 있었다면 HIT-REDIS가
 *    나온다. 그래서 X-Cache와 updated_at을 회차마다 적재해 표본에 라벨을 붙인다 —
 *    신선도를 못 믿는 게 아니라 **회차마다 알 수 있게** 만드는 쪽을 택했다.
 *    (실측 2026-08-04 10:27 KST 유니크 쿼리 1회 → X-Cache: MISS)
 *
 * 절대 throw하지 않는다. 실패도 그 회차의 데이터다.
 */
async function induceCollect(baseOverride) {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const attempts = [];
  const hosts = hostCandidates(baseOverride);
  if (hosts.length === 0) {
    attempts.push({ host: null, status: 0, error: 'no-base-url(VERCEL_PROJECT_PRODUCTION_URL·VERCEL_URL 부재)' });
    return { attempts, xCache: null, updatedAt: null, items: null };
  }
  for (const host of hosts) {
    const url = `https://${host}/api/market-data?probe=${nonce}`;
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const ms = Date.now() - t0;
      const xCache = res.headers.get('x-cache');
      if (!res.ok) { attempts.push({ host, status: res.status, ms, xCache }); continue; }
      const body = await res.json();
      attempts.push({ host, status: res.status, ms, xCache, ok: true });
      return { attempts, xCache, updatedAt: body?.updated_at ?? null, items: Array.isArray(body?.items) ? body.items : [] };
    } catch (e) {
      attempts.push({ host, status: 0, ms: Date.now() - t0, error: `${e.name}: ${e.message}` });
    }
  }
  return { attempts, xCache: null, updatedAt: null, items: null };
}

/**
 * 자기호출 대상 호스트 후보. 프로덕션 별칭을 먼저 쓰고 배포 호스트로 폴백한다.
 * ⚠️ ?base=는 vercel.app 호스트로 제한한다 — 인증 게이트 뒤라 신뢰 경로지만, 임의 호스트를
 *    서버가 대신 치게 만드는 범용 수단을 남기지 않는다.
 */
function hostCandidates(baseOverride) {
  const list = [
    typeof baseOverride === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(baseOverride) ? baseOverride : null,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
  ].filter(Boolean);
  return [...new Set(list)];
}

/**
 * 항목 1건의 형상 스냅샷. **판정은 relative-guard가 하고 여기선 담기만 한다.**
 *
 * degenEvidence의 동치판정 2종은 alignBySignal(relative-guard.js:511)이 쓰는 것과 같은
 * 규칙(반틱 이내)을 **원자료로 재현**한 것이다. 판정 자체는 위 sig가 낸 값을 쓰고, 여기엔
 * 사람이 손으로 되짚을 수 있는 숫자를 남긴다.
 *   항등식: degenerate === (prevCloseVsH1.eq && priceVsH1.eq)
 *   — 이게 깨져 있으면 relative-guard의 판정과 이 기록이 갈라진 것이니 그 회차를 의심할 것.
 */
export function snapshotItem(item, now) {
  const meta = ASSET_META[item.id] ?? {};
  const quantum = meta.quantum ?? 0.01;
  const hist = Array.isArray(item.history) ? item.history : [];
  const h1 = hist.at(-1) ?? null;
  const h2 = hist.at(-2) ?? null;

  const origin = originOf(item);
  const sig = alignBySignal(origin, h1, quantum);
  const td = tradingDateOf(item.id, item.as_of ?? now, { extendedHours: item.quoteWindow === 'extended' });
  const c = checkCross(item, now);

  const eqTol = quantum * 0.5;
  const eq = v => Number.isFinite(v) && Number.isFinite(h1?.close) && Math.abs(v - h1.close) < eqTol;

  // 판정 축 + 관측 전용 축을 한 배열로. observeOnly로 구분되고 blocked에는 무관하다.
  const axes = [...(c.axes ?? []), ...(c.observations ?? [])].map(a => ({
    checkKind: a.checkKind ?? null,
    state: a.state ?? 'observed',
    reason: a.reason ?? null,
    // fired — 그 축이 실제로 값을 만들어 냈는가(스킵과 구분). 축 유무만으로는 알 수 없다.
    fired: a.state === 'checked' || (a.state === undefined && Number.isFinite(a.observed)),
    ok: typeof a.ok === 'boolean' ? a.ok : null,
    observed: num(a.observed), expected: num(a.expected),
    residual: num(a.residual), tolerance: num(a.tolerance),
    ticks: Number.isFinite(a.ticks) ? a.ticks : null, via: a.via ?? null,
    quanta: Number.isFinite(a.quanta) ? a.quanta : null,
    observeOnly: Boolean(a.observeOnly),
  }));

  return {
    id: item.id,
    price: num(item.price),
    // ⚠️ 필수 — probe-cnbc-format이 이걸 빠뜨려 롤 시각 브래킷이 불가능했던 전례가 있다.
    prev_close: num(item.prev_close),
    change: num(item.change),
    change_pct: num(item.change_pct),
    h1: h1 ? { date: h1.date ?? null, close: num(h1.close) } : null,
    h2: h2 ? { date: h2.date ?? null, close: num(h2.close) } : null,
    alignment: c.alignment ?? null,
    alignBasis: c.alignBasis ?? null,
    degenerate: Boolean(sig.degenerate),
    // basis — tradingDateOf가 "왜 그 거래일인가"를 어휘로 돌려준다(asof-date/intraday/
    // after-close/pre-open/pre-open+exthrs/non-trading-day/continuous-*/utc-date).
    basis: td.basis ?? null,
    priceDate: td.date ?? null,
    historyDate: h1?.date ?? null,
    signalAlignment: sig.alignment, signalBasis: sig.basis,
    clockAlignment: c.clockAlignment ?? null,
    circularAsOf: c.circularAsOf ?? null,
    cross: {
      state: c.state ?? null, reason: c.reason ?? null,
      grade: c.grade ?? meta.cross ?? null,
      gap: Number.isFinite(c.gap) ? c.gap : null,
      staleFinding: Boolean(c.staleFinding),
    },
    axes,
    // 재계산 원본 — 걸리지 않았으면 null이 정상이다(|change| > 0.01 구간).
    // null과 "구버전이라 도장이 없다"는 다르다 — 후자는 provenance='legacy'로 드러난다.
    recalcFrom: item.change_recalced ?? null,
    degenEvidence: {
      originPrice: num(origin.price),
      originPrevClose: num(origin.prevClose),
      h1Close: num(h1?.close),
      quantum, eqTol,
      prevCloseVsH1: { diff: absDiff(origin.prevClose, h1?.close), eq: eq(origin.prevClose) },
      priceVsH1: { diff: absDiff(origin.price, h1?.close), eq: eq(origin.price) },
      provenance: origin.provenance, recalced: origin.recalced,
    },
    historySource: item.historySource ?? null,
    source: item.source ?? null,
    as_of: item.as_of ?? null,
    quoteWindow: item.quoteWindow ?? null,
    stale: Boolean(item.stale),
    prov: item.prov ?? null,
  };
}

/** 회차 1건 캡처. 절대 throw하지 않고 결과 객체로 회수한다(에러도 그 회차의 데이터). */
async function capture(req) {
  const at = new Date();
  // ⚠️ KST와 ET를 둘 다 남긴다 — 크론은 UTC 고정이라 KST는 늘 같지만 ET는 서머타임으로
  //    한 시간 움직인다. 꼬리표(EDT/EST)가 없으면 "이 표본이 개장 전인가 후인가"를
  //    나중에 되짚을 수 없다(probe-store.js:67 와 같은 근거). 해석은 사람이 한다.
  const base = {
    at: at.toISOString(), kst: kstStamp(at), et: etStamp(at),
    ...resolveWindow(req, at),
  };
  try {
    const idsQ = typeof req?.query?.ids === 'string' ? req.query.ids.split(',').map(s => s.trim()).filter(Boolean) : null;
    const ids = idsQ?.length ? idsQ : DEFAULT_IDS;

    const collected = await induceCollect(req?.query?.base);
    if (!collected.items) {
      return { ...base, ok: false, ids, collect: { attempts: collected.attempts, xCache: null, updatedAt: null }, items: [] };
    }
    const byId = {};
    for (const it of collected.items) if (it?.id) byId[it.id] = it;

    const items = ids.map(id => {
      const it = byId[id];
      if (!it) return { id, absent: true };
      try {
        return snapshotItem(it, at);
      } catch (e) {
        // 한 종목의 판정 실패가 나머지 5종을 날리지 않는다.
        return { id, error: `${e.name}: ${e.message}` };
      }
    });

    return {
      ...base, ok: true, ids,
      collect: {
        attempts: collected.attempts,
        // 신선도 라벨 — MISS면 이 회차가 실제 수집을 유도한 것이고, HIT/HIT-REDIS면
        // updated_at이 가리키는 과거 수집본을 본 것이다. 둘을 섞어 읽으면 안 된다.
        xCache: collected.xCache, updatedAt: collected.updatedAt,
      },
      items,
    };
  } catch (e) {
    return { ...base, ok: false, error: `${e.name}: ${e.message}`, items: [] };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!isAuthorized(req)) return res.status(403).json({ error: '접근 권한 없음' });

  res.setHeader('Cache-Control', 'no-store');

  if (req.query?.view === '1') {
    const rows = await readProbe(KEY);
    return res.status(200).json({ key: KEY, count: rows.length, rows });
  }

  const field  = fieldOf();
  const result = await capture(req);
  const saved  = await saveProbe(KEY, field, result);
  console.log(`[probe-observe] ${field} window=${result.window ?? '-'}(${result.windowBasis})`
    + ` xCache=${result.collect?.xCache ?? '-'} saved=${saved} `
    + (result.items ?? []).map(i => `${i.id}=${i.absent ? 'ABSENT' : `${i.alignment}${i.degenerate ? '/degen' : ''}`}`).join(' '));

  // 소스·수집 실패에도 200 — 크론의 성패는 "기록을 남겼는가"다(실패 사실도 회차에 저장됨).
  return res.status(200).json({ key: KEY, field, saved, result });
}
