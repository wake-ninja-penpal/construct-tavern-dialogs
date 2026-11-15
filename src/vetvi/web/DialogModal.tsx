'use client';

/**
 * Ветви — редактор диалога (dlgModal оригинала): дерево реплик с вложенными
 * ветками, говорящий из участников, «повтор», добавление ниже/веткой, удаление,
 * двойной клик — к реплике на холсте, порядок.
 */

import { useEffect, useRef } from 'react';

import type { VetviNode, VetviReply } from '@/vetvi/core/types';
import { findReplyParent } from '@/vetvi/core/dialog';
import type { VetviStore } from './store';

export function DialogModal({ store }: { store: VetviStore }) {
  const nodeId = store.dialogEdit;
  const node = nodeId ? store.nodeById(nodeId) : null;
  const editPreRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  void store.revision;

  useEffect(() => {
    if (store.dialogEdit) editPreRef.current = store.beginEdit();
    else editPreRef.current = null;
     
  }, [store.dialogEdit]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector('.flash');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  const n = node;
  const chars = store.doc.chars || [];
  const participants = n && n.dialog ? n.dialog.participants || [] : [];
  const partChars = participants.map((pid) => chars.find((c) => c.id === pid)).filter(Boolean) as typeof chars;
  const flash = store.flash;
  const close = () => {
    store.commitReplyEdit(editPreRef.current);
    store.closeDialogEditor();
  };

  if (!n || n.type !== 'dialog' || !n.dialog) {
    return null;
  }

  const renderReply = (r: VetviReply, depth: number): React.ReactNode => {
    const isFlash = !!(flash && flash.nodeId === n.id && flash.replyId === r.id);
    const parent = findReplyParent(n.dialog!.replies, r.id, null);
    return (
      <div key={r.id} className={'rn-dlg-reply' + (isFlash ? ' flash' : '')} style={{ marginLeft: depth * 23 }}>
        <div className="rn-dlg-toolbar">
          <span className="rn-dlg-depth">{depth > 0 ? '└' : '·'}</span>
          <select
            className="rn-dlg-speaker"
            value={r.speaker || ''}
            aria-label="Говорящий"
            onFocus={() => { editPreRef.current = editPreRef.current || store.beginEdit(); }}
            onChange={(e) => {
              const pre = editPreRef.current;
              store.updateReply(n.id, r.id, { speaker: e.target.value || null }, { history: false });
              if (pre) store.commitReplyEdit(pre);
              editPreRef.current = store.beginEdit();
            }}
          >
            <option value="">— не выбран —</option>
            {partChars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button
            type="button"
            className={'rn-dlg-loop' + ((r as unknown as { loop?: boolean }).loop ? ' on' : '')}
            title="Повтор: диалог зациклится на этой реплике"
            onClick={() => {
              const cur = (r as unknown as { loop?: boolean }).loop;
              store.updateReply(n.id, r.id, { loop: !cur } as Partial<VetviReply>, { label: 'Повтор реплики' });
            }}
          >↻</button>
          <div className="rn-dlg-btns">
            <button type="button" title="Реплика ниже" onClick={() => store.addReply(n.id, r.id, false)}>+ ниже</button>
            <button type="button" title="Ответ-ветка" onClick={() => store.addReply(n.id, r.id, true)}>+ ветка</button>
            <button type="button" title="Выше" onClick={() => store.moveReply(n.id, r.id, -1)}>↑</button>
            <button type="button" title="Ниже" onClick={() => store.moveReply(n.id, r.id, 1)}>↓</button>
            <button type="button" title="К реплике на холсте" onClick={() => { store.requestFlash(n.id, r.id); }}>⌖</button>
            <button type="button" className="danger" title="Удалить реплику" onClick={() => store.deleteReply(n.id, r.id)}>×</button>
          </div>
        </div>
        <textarea
          rows={2}
          className="rn-dlg-text"
          value={r.text}
          placeholder="Текст реплики…"
          aria-label={'Текст реплики ' + r.id}
          onFocus={() => { editPreRef.current = editPreRef.current || store.beginEdit(); }}
          onChange={(e) => store.updateReply(n.id, r.id, { text: e.target.value }, { history: false })}
          onBlur={() => {
            const pre = editPreRef.current;
            if (pre) { store.commitReplyEdit(pre); editPreRef.current = store.beginEdit(); }
          }}
        />
        {parent && depth === 0 && null}
        {(r.children || []).map((ch) => renderReply(ch, depth + 1))}
      </div>
    );
  };

  return (
    <div className="rn-modal show" onClick={(e) => { if (e.target === e.currentTarget) close(); }} role="dialog" aria-label="Редактор диалога">
      <div className="rn-modal-card rn-dlg-card">
        <div className="rn-modal-head">
          <span className="rn-modal-title">Реплики — {n.title || 'Диалог'}</span>
          <button type="button" className="rn-modal-close" title="Закрыть" onClick={close}>×</button>
        </div>
        <div className="rn-modal-body">
          <div className="rn-dlg-desc">
            <label className="rn-field slim">
              <span>Описание (интро диалога)</span>
              <textarea
                rows={2}
                value={n.dialog.description}
                onFocus={() => { editPreRef.current = editPreRef.current || store.beginEdit(); }}
                onChange={(e) => store.updateNode(n.id, { dialog: { ...n.dialog!, description: e.target.value } }, { history: false })}
                onBlur={() => {
                  const pre = editPreRef.current;
                  if (pre) { store.commitReplyEdit(pre); editPreRef.current = store.beginEdit(); }
                }}
                aria-label="Описание диалога"
              />
            </label>
            <div className="rn-dlg-tools">
              <span className="rn-insp-hint">Участников: {partChars.length} · реплик: {countAll(n.dialog.replies)}</span>
              <button type="button" className="rn-mini" onClick={() => store.addReply(n.id)}>+ Реплика</button>
            </div>
          </div>
          <div className="rn-dlg-list" ref={listRef}>
            {n.dialog.replies.map((r) => renderReply(r, 0))}
            {!n.dialog.replies.length && <div className="rn-insp-hint">Реплик пока нет — добавьте первую.</div>}
          </div>
        </div>
        <div className="rn-modal-foot">
          <button type="button" className="rn-btn primary" onClick={close}>Готово</button>
        </div>
      </div>
    </div>
  );
}

function countAll(arr: VetviReply[]): number {
  let c = 0;
  for (const r of arr) {
    c++;
    if (r.children) c += countAll(r.children);
  }
  return c;
}
