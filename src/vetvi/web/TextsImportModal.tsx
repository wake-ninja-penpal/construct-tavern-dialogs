'use client';

/**
 * Ветви — импорт текстов из JSON (openTextsImport 10473–10487 +
 * textsImpStep2 10498–10528 оригинала). Два шага в одном окне:
 *
 * Шаг 1: textarea (v3 placeholder) + «Выбрать файл…» (#txtFileInput) +
 * «Проверить» — ошибка парсинга возвращает в шаг 1 с сохранённым текстом.
 *
 * Шаг 2 (сверка): сводка формата/файла/счётчиков (.tx-imp-sum), список
 * совпавших ✎ и новых ＋ нод (.tx-imp-row, первые 24 + «и ещё N…») и
 * флажки: обновить совпавших (txChkUpd), создать новых (txChkNew),
 * обновить реплики/варианты (txChkMed), синхронизировать связи (txChkLnk).
 */

import { useEffect, useRef, useState } from 'react';

import type { VetviStore } from './store';
import { ModalShell } from './Modals';

export function TextsImportModal({ store }: { store: VetviStore }) {
  const step2 = store.textsImp;
  const [ta, setTa] = useState(store.textsKeep || '');
  const fileRef = useRef<HTMLInputElement | null>(null);

  /* шаг 1 → шаг 2 переключается store.textsImp; флажки локальные */
  const [upd, setUpd] = useState(true);
  const [cre, setCre] = useState(true);
  const [med, setMed] = useState(true);
  const [lnk, setLnk] = useState(true);

  const close = () => {
    store.textsKeep = null;
    store.textsImp = null;
    store.textsImpFname = null;
    store.closeModal();
  };

  useEffect(() => {
    if (step2) {
      const have: Record<string, boolean> = {};
      store.doc.nodes.forEach((n) => { have[n.id] = true; });
      let matched = 0, fresh = 0;
      step2.nodes.forEach((en) => { if (have[en.id]) matched++; else fresh++; });
      setUpd(matched > 0);
      setCre(fresh > 0);
    }
  }, [step2, store]);

  if (!step2) {
    return (
      <ModalShell
        title="Импорт текстов из JSON"
        onClose={close}
        foot={
          <>
            <button type="button" className="btn primary" onClick={() => store.textsImportCheck(ta)}>Проверить</button>
            <button type="button" className="btn" onClick={close}>Отмена</button>
          </>
        }
      >
        <p style={{ margin: '2px 0 9px', fontSize: '12.5px', color: 'var(--tx2)' }}>
          Вставьте JSON с текстами нод: массив <b style={{ color: 'var(--acc2)' }}>texts</b> — пары{' '}
          <b style={{ color: 'var(--acc2)' }}>{'{id, text}'}</b> (каждая строка встаёт по своему id, порядок не важен) —
          и служебный блок <b style={{ color: 'var(--acc2)' }}>service</b>. Ноды сопоставляются по <b>id</b>:
          совпавшие — обновятся, отсутствующие — можно создать.
        </p>
        <textarea
          id="txImpTa"
          className="tx-imp-ta"
          spellCheck={false}
          placeholder={'{ "texts": [ { "id": "…", "text": "…" } ], "service": { "format": "vetvi-texts-v3", "nodes": [ … ], "links": [ … ] } }'}
          value={ta}
          onChange={(e) => setTa(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn" id="txImpFile" onClick={() => { fileRef.current?.click(); }}>Выбрать файл…</button>
          <span style={{ fontSize: 11, color: 'var(--tx3)' }}>
            файл — из меню «Сохранить» → «Тексты (JSON)» или «Тексты выделенных нод (JSON)»: ноды из него вернутся в проект
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.txt,application/json,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files && e.target.files[0];
              if (!f) return;
              const rd = new FileReader();
              rd.onload = () => {
                const txt = String(rd.result || '');
                store.textsImportCheck(txt, f.name);
                e.target.value = '';
              };
              rd.readAsText(f);
            }}
          />
        </div>
      </ModalShell>
    );
  }

  /* ── шаг 2: сверка (textsImpStep2 оригинала) ── */
  const have: Record<string, boolean> = {};
  store.doc.nodes.forEach((n) => { have[n.id] = true; });
  const matched = step2.nodes.filter((en) => have[en.id]);
  const fresh = step2.nodes.filter((en) => !have[en.id]);
  const hasRep = step2.nodes.some((en) => !!en.replies);
  const hasOut = step2.nodes.some((en) => !!en.outcomes);
  const fname = store.textsImpFname;

  const rows: React.ReactNode[] = [];
  matched.slice(0, 24).forEach((en, i) => {
    rows.push(
      <div className="tx-imp-row up" key={'m' + i}>
        <span className="mk">✎</span>
        <span className="tt">{en.title || '(без названия)'}</span>
        <span className="sub">{en.id}</span>
      </div>,
    );
  });
  fresh.slice(0, 24).forEach((en, i) => {
    rows.push(
      <div className="tx-imp-row new" key={'f' + i}>
        <span className="mk">＋</span>
        <span className="tt">{en.title || '(без названия)'}</span>
        <span className="sub">{en.id}</span>
      </div>,
    );
  });
  if (step2.nodes.length - Math.min(24, matched.length) - Math.min(24, fresh.length) > 0) {
    rows.push(
      <div className="tx-imp-row" key="more">
        <span className="sub">и ещё {step2.nodes.length - Math.min(24, matched.length) - Math.min(24, fresh.length)}…</span>
      </div>,
    );
  }

  return (
    <ModalShell
      title="Импорт текстов — проверка"
      onClose={close}
      foot={
        <>
          <button type="button" className="btn primary" onClick={() => store.textsImportApply({ upd, cre, med, lnk })}>
            Импортировать
          </button>
          <button type="button" className="btn" onClick={close}>Отмена</button>
        </>
      }
    >
      <div className="tx-imp-sum">
        {step2.fmt ? <b>{step2.fmt}</b> : null}
        {step2.fmt ? ' · ' : ''}
        {step2.srcName ? '«' + step2.srcName + '» · ' : ''}
        {fname ? fname + ' · ' : ''}
        в файле: текстов — <b>{typeof step2.tx === 'number' ? step2.tx : '—'}</b>, нод — <b>{step2.nodes.length}</b>, связей — <b>{step2.links.length}</b>
        {step2.skip ? ', без id пропущено — ' + step2.skip : ''}
        <br />
        в проекте совпадают по id: <b>{matched.length}</b>, новых: <b>{fresh.length}</b>
      </div>
      <div className="tx-imp-list">{rows}</div>
      <div className="tx-imp-chk">
        <label>
          <input type="checkbox" checked={upd} disabled={matched.length === 0} onChange={(e) => setUpd(e.target.checked)} />
          <span>
            Обновить тексты и заголовки совпавших нод
            <span className="hint">совпадений по id: {matched.length}</span>
          </span>
        </label>
        <label>
          <input type="checkbox" checked={cre} disabled={fresh.length === 0} onChange={(e) => setCre(e.target.checked)} />
          <span>
            Создать ноды, которых нет в проекте
            <span className="hint">новых: {fresh.length} — разместятся сеткой на свободном месте</span>
          </span>
        </label>
        {(hasRep || hasOut) && (
          <label>
            <input type="checkbox" checked={med} onChange={(e) => setMed(e.target.checked)} />
            <span>
              Обновить реплики диалогов{hasOut ? ' и подписи вариантов развилок' : ''}
              <span className="hint">реплики заменяются списком из файла целиком</span>
            </span>
          </label>
        )}
        <label>
          <input type="checkbox" checked={lnk} onChange={(e) => setLnk(e.target.checked)} />
          <span>
            Синхронизировать связи
            <span className="hint">подписи существующих связей обновятся, недостающие — добавятся</span>
          </span>
        </label>
      </div>
    </ModalShell>
  );
}
