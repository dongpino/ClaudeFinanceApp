import { useState } from 'react';
import { ITEM_CATEGORIES } from '../itemCategories';
import { MAX_MAJOR } from '../homeMajorStore';

// "주요" 탭 편집 패널 — 전체 종목 체크리스트로 최대 MAX_MAJOR개까지 선택.
// 완료 버튼/닫기(×)/배경 클릭 중 무엇으로 나가든 그 시점의 선택을 그대로 저장한다
// (별도의 "취소" 경로는 두지 않음 — 체크 상태 자체가 편집 중인 값).
export default function MajorEditPanel({ selectedIds, onSave }) {
  const [draft, setDraft]     = useState(selectedIds);
  const [warning, setWarning] = useState('');

  function toggle(id) {
    setDraft(prev => {
      const checked = prev.includes(id);
      if (checked) {
        if (prev.length <= 1) {
          setWarning('최소 1개는 선택되어야 합니다');
          return prev;
        }
        setWarning('');
        return prev.filter(x => x !== id);
      }
      if (prev.length >= MAX_MAJOR) {
        setWarning(`최대 ${MAX_MAJOR}개까지 선택 가능합니다`);
        return prev;
      }
      setWarning('');
      return [...prev, id];
    });
  }

  function finish() {
    onSave(draft);
  }

  return (
    <div className="major-edit-backdrop" onClick={finish}>
      <div className="major-edit-panel" onClick={e => e.stopPropagation()}>
        <div className="major-edit-header">
          <span className="major-edit-title">주요 종목 편집</span>
          <button className="major-edit-close" onClick={finish} aria-label="닫기">×</button>
        </div>
        <p className="major-edit-hint">최대 {MAX_MAJOR}개까지 선택할 수 있습니다 ({draft.length}/{MAX_MAJOR})</p>

        <div className="major-edit-list">
          {ITEM_CATEGORIES.map(item => {
            const checked = draft.includes(item.id);
            return (
              <div
                key={item.id}
                className={`major-edit-item${checked ? ' checked' : ''}`}
                onClick={() => toggle(item.id)}
                role="checkbox"
                aria-checked={checked}
              >
                <span className="major-edit-checkbox">{checked && '✓'}</span>
                <span className="major-edit-name">{item.name}</span>
                <span className="major-edit-cat">{item.categories.join(' · ')}</span>
              </div>
            );
          })}
        </div>

        <p className="major-edit-warn">{warning}</p>

        <button className="major-edit-done-btn" onClick={finish}>완료</button>
      </div>
    </div>
  );
}
