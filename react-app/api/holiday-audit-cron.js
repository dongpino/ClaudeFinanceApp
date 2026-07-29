/**
 * api/holiday-audit-cron.js — 휴장일 표 ↔ KASI 자동 대조 (Vercel Cron, 일 1회)
 *
 * vercel.json crons "20 21 * * *"(UTC) = **06:20 KST 매일**.
 * KASI는 연 1회 갱신이라 일 1회면 차고 넘치지만, 매일 도는 편이 낫다 —
 * 제도 변경은 예고 없이 반영되고, 크론이 멈춘 것과 "변화가 없는 것"을 구분하려면
 * 최신 대조 시각이 계속 갱신돼야 하기 때문이다(상태판이 그 시각을 읽는다).
 *
 * 하는 일: 우리 표가 덮는 연도(현재 2026·2027)를 연 단위로 각 1콜씩 받아
 *   ① 3갈래 판정(누락 / KRX 고유 / 오탑재)  ② 소진 3축  을 계산해 Redis에 적재.
 *   판정 로직은 _lib/holiday-audit.js에 있고 여기서는 조립만 한다(회귀가 네트워크
 *   없이 로직만 검증할 수 있게 분리).
 *
 * ── 절대 원칙(health 기록층과 동일) ──────────────────────────────────
 * KASI 실패가 데이터 파이프라인에 전파되면 안 된다:
 *  · 수집기를 import하지 않고, trackedFetch도 쓰지 않는다(health 통계 오염 방지).
 *  · 모든 실패를 결과 객체로 회수해 **그대로 기록**한다 — 크론의 성패는 "기록을
 *    남겼는가"이지 "KASI가 응답했는가"가 아니다. 그래서 소스 실패에도 200을 준다.
 *  · Redis 미설정이면 조용히 no-op(적재만 안 됨).
 *
 * GET /api/holiday-audit-cron           — Cron(Authorization: Bearer CRON_SECRET)
 * GET /api/holiday-audit-cron?key=…     — 수동 실행(DEBUG_SIGNALS_KEY)
 * GET /api/holiday-audit-cron?key=…&view=1 — 마지막 결과만 조회(외부 호출 없음)
 */

import { fetchKasiYear } from './_collectors/kasi-holidays.js';
import {
  normalizeKasiItems, compareHolidays, auditCoverage,
  saveAudit, readAudit, auditYears,
} from './_lib/holiday-audit.js';
import { isAuthorized } from './_lib/probe-store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!isAuthorized(req)) return res.status(403).json({ error: '접근 권한 없음' });
  res.setHeader('Cache-Control', 'no-store');

  if (req.query?.view === '1') {
    return res.status(200).json({ audit: await readAudit() });
  }

  const checkedAt = new Date().toISOString();
  // 대조 연도는 **표에 있는 연도 중 당해연도 이상**만(auditYears). 표 전체를 돌면 해가
  // 바뀐 뒤 지난 연도만 훑으면서 계속 "이상 없음"이 뜬다 — 과거 구간은 거래일 스냅샷이
  // 이미 담당하므로 재대조할 이유도 없다.
  const years = auditYears();
  const fetched = [];
  for (const y of years) fetched.push(await fetchKasiYear(y));  // 순차 — 30tps 제한 여유

  // 요청할 연도가 없다 = 표가 낡았다. 호출이 0건이라 아래 "전 연도 실패" 분기(0===0)에
  // 걸리면 원인이 "KASI 장애"로 잘못 기록되므로 여기서 먼저 끊고 coverage 경고로 낸다.
  if (years.length === 0) {
    const coverage = auditCoverage([]);
    const payload = { checkedAt, ok: true, source: 'KASI SpcdeInfoService/getRestDeInfo',
      calls: [], partialFailure: null, result: null, coverage };
    const saved = await saveAudit(payload);
    console.warn(`[holiday-audit] 대조 구간 없음 — ${coverage.warnings.join(' / ')}`);
    return res.status(200).json({ saved, ...payload });
  }

  const failures = fetched.filter(f => !f.ok);
  // 전 연도 실패면 대조 자체가 성립하지 않는다. "일치 0건"으로 기록하면 401이 정상처럼
  // 보이므로(키 만료의 조용한 실패 경로) ok:false로 못박아 상태판이 빨강이 되게 한다.
  if (failures.length === years.length) {
    const payload = { checkedAt, ok: false, error: failures.map(f => `${f.year}: ${f.error}`).join(' / ') };
    const saved = await saveAudit(payload);
    console.error(`[holiday-audit] 전 연도 실패 — ${payload.error}`);
    return res.status(200).json({ saved, ...payload });
  }

  const okYears = fetched.filter(f => f.ok && f.totalCount > 0).map(f => f.year);
  const items = fetched.filter(f => f.ok).flatMap(f => normalizeKasiItems(f.body));
  const result = compareHolidays(items, okYears);
  const coverage = auditCoverage(okYears);

  const payload = {
    checkedAt, ok: true,
    source: 'KASI SpcdeInfoService/getRestDeInfo',
    calls: fetched.map(f => ({ year: f.year, ok: f.ok, status: f.status, count: f.totalCount ?? 0, error: f.error ?? null })),
    partialFailure: failures.length > 0 ? failures.map(f => `${f.year}: ${f.error}`) : null,
    result, coverage,
  };
  const saved = await saveAudit(payload);
  console.log(`[holiday-audit] ${checkedAt} 누락 ${result.missing.length} / 오탑재 ${result.extra.length}`
    + ` / KRX고유 ${result.krxOnly.length} / 일치 ${result.matched} / 경고 ${coverage.warnings.length} / saved=${saved}`);

  return res.status(200).json({ saved, ...payload });
}
