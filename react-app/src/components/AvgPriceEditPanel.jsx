import { useState } from 'react';
import { ITEM_CATEGORIES } from '../itemCategories';
import { getAvgPrice, saveAvgPrices, loadAvgPrices } from '../avgPriceStore';
import { loadEditToken, saveEditToken } from '../editTokenStore';

const UMI_ITEMS = ITEM_CATEGORIES.filter(c => c.categories.includes('umi'));

// 입력창 표시값 — KRW는 정수만(마침표 없음), 그 외(USD 등)는 그대로(소수 허용).
// MarketCard/Sparkline/Chart.jsx의 fmtAvgHint와 별개 규칙: 저건 "표시용 문자열"이고
// 이건 "입력창 시작값 문자열"이라 천단위 콤마 없이 순수 숫자만 넣는다(다시 파싱해야 하므로).
function draftValue(id) {
  const v = getAvgPrice(id);
  return v == null ? '' : String(v);
}

function buildDraftFromCache() {
  return Object.fromEntries(UMI_ITEMS.map(item => [item.id, draftValue(item.id)]));
}

// "평단 +16.7%" 배지와 동일한 통화 표시 관례 — MarketCard.jsx CURRENCY_PREFIX와 동일.
const CURRENCY_PREFIX = { usd: '$', krw: '₩' };

// 우미 투자 평단가 편집 패널 — MajorEditPanel.jsx와 같은 배경/패널 chrome 클래스를
// 재사용하고(major-edit-backdrop/panel/header/title/close/hint/done-btn/warn), 입력
// 행만 이 파일 전용 클래스(avgprice-edit-*)로 새로 그린다.
export default function AvgPriceEditPanel({ onClose }) {
  const [draft, setDraft]     = useState(buildDraftFromCache);
  const [saving, setSaving]   = useState(false);
  const [notice, setNotice]   = useState('');
  const [error, setError]     = useState('');

  function setField(id, raw) {
    setDraft(prev => ({ ...prev, [id]: raw }));
    setError('');
    setNotice('');
  }

  // 토큰이 없으면 프롬프트로 받는다(요구사항: 최초 저장 시/401 수신 시 프롬프트).
  // 입력을 취소하거나 빈 값을 넣으면 null을 반환해 저장을 계속 진행하지 않는다.
  function ensureToken() {
    const existing = loadEditToken();
    if (existing) return existing;
    const entered = window.prompt('평단가 저장에 사용할 토큰을 입력하세요');
    const trimmed = entered?.trim();
    if (!trimmed) return null;
    saveEditToken(trimmed);
    return trimmed;
  }

  function buildValueFromDraft() {
    const value = {};
    for (const item of UMI_ITEMS) {
      const raw = draft[item.id]?.trim();
      const num = raw ? Number(raw) : NaN;
      value[item.id] = Number.isFinite(num) && num > 0 ? num : null;
    }
    return value;
  }

  async function handleSave() {
    setError('');
    setNotice('');

    const hadTokenBefore = !!loadEditToken();
    const token = ensureToken();
    if (!token) {
      setError('토큰이 있어야 저장할 수 있습니다');
      return;
    }

    // 이 기기에서 방금 처음 토큰을 입력한 경우 — 아직 아무것도 안 채워진(또는
    // 이 기기 기준으로 오래된) 입력값으로 곧장 저장하면, 다른 기기에 이미 저장된
    // 실제 값을 빈 값으로 덮어써버릴 수 있다. 그래서 먼저 서버 값을 불러와 폼에
    // 반영하고, 사용자가 확인 후 다시 저장을 누르게 한다(자동 이어서 저장 안 함).
    if (!hadTokenBefore) {
      setSaving(true);
      await loadAvgPrices();
      setSaving(false);
      setDraft(buildDraftFromCache());
      setNotice('이 기기에 없던 토큰을 등록했습니다. 기존 저장값을 불러왔어요 — 확인 후 저장을 다시 눌러주세요.');
      return;
    }

    setSaving(true);
    try {
      await saveAvgPrices(buildValueFromDraft());
      onClose();
    } catch (e) {
      if (e.code === 'AUTH_ERROR') {
        saveEditToken(null); // 잘못된 토큰이었을 수 있음 — 지우고 다음 저장 시 다시 물어봄
        setError('토큰이 올바르지 않습니다. 저장을 다시 누르면 토큰을 다시 입력할 수 있어요.');
      } else {
        setError(e.message || '저장에 실패했습니다');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="major-edit-backdrop" onClick={onClose}>
      <div className="major-edit-panel" onClick={e => e.stopPropagation()}>
        <div className="major-edit-header">
          <span className="major-edit-title">우미 투자 평단가</span>
          <button className="major-edit-close" onClick={onClose} aria-label="닫기">×</button>
        </div>
        <p className="major-edit-hint">종목별 매수 평단가를 입력하세요 — 비워두면 표시하지 않습니다.</p>

        <div className="avgprice-edit-list">
          {UMI_ITEMS.map(item => (
            <div key={item.id} className="avgprice-edit-item">
              <span className="avgprice-edit-name">{item.name}</span>
              <div className="avgprice-edit-input-wrap">
                <span className="avgprice-edit-currency">{CURRENCY_PREFIX[item.currency] ?? ''}</span>
                <input
                  className="avgprice-edit-input"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step={item.currency === 'krw' ? '1' : '0.01'}
                  placeholder="미설정"
                  value={draft[item.id]}
                  onChange={e => setField(item.id, e.target.value)}
                />
              </div>
            </div>
          ))}
        </div>

        {notice && <p className="avgprice-edit-notice">{notice}</p>}
        {error && <p className="major-edit-warn">{error}</p>}

        <button className="major-edit-done-btn" onClick={handleSave} disabled={saving}>
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}
