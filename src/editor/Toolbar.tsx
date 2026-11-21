import { useRef, useState } from 'react';
import { STAGES } from '../stages/index.js';
import type { CityEditor } from './useCityEditor.js';
import styles from './editor.module.css';

const SAVE_LABEL = { idle: '', saving: 'saving…', saved: 'saved ✓', error: 'not saved — storage unavailable' } as const;

export function Toolbar({ editor, backend }: { editor: CityEditor; backend: string | null }) {
  const { doc, cities, saveState, generating, canUndo, canRedo, actions } = editor;
  const [menuOpen, setMenuOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <header className={styles.toolbar}>
      <span className={styles.brand}>proccity</span>

      <div className={styles.menuWrap}>
        <button className={styles.cityButton} onClick={() => setMenuOpen(o => !o)}>▾ {doc?.name ?? '…'}</button>
        {menuOpen && (
          <div className={styles.menu} onMouseLeave={() => setMenuOpen(false)}>
            {cities.map(c => (
              <button key={c.id} className={c.id === doc?.id ? styles.menuCurrent : styles.menuItem}
                onClick={() => { setMenuOpen(false); void actions.openCity(c.id); }}>
                {c.name}
              </button>
            ))}
            <hr className={styles.menuRule} />
            <button className={styles.menuItem} onClick={() => { setMenuOpen(false); void actions.newCity(); }}>New city</button>
            <button className={styles.menuItem} onClick={() => {
              setMenuOpen(false);
              const name = prompt('Rename city', doc?.name);
              if (name) actions.renameCity(name);
            }}>Rename…</button>
            {doc && (
              <button className={styles.menuDanger} onClick={() => {
                setMenuOpen(false);
                if (confirm(`Delete "${doc.name}"? This can't be undone.`)) void actions.deleteCity(doc.id);
              }}>Delete…</button>
            )}
          </div>
        )}
      </div>

      <button className={styles.icon} disabled={!canUndo} onClick={actions.undo} title="Undo (Ctrl+Z)">↶</button>
      <button className={styles.icon} disabled={!canRedo} onClick={actions.redo} title="Redo (Shift+Ctrl+Z)">↷</button>

      <span className={styles.status}>
        {generating ? `Generating: ${STAGES[generating.stageIndex]?.title ?? ''}…` : SAVE_LABEL[saveState]}
      </span>

      <span className={styles.spacer} />
      {backend && <span className={styles.backend}>{backend}</span>}
      <button className={styles.small} onClick={actions.download} disabled={!doc}>Download</button>
      <button className={styles.small} onClick={() => fileRef.current?.click()}>Open</button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden
        onChange={e => { const f = e.target.files?.[0]; if (f) void actions.importFile(f); e.target.value = ''; }} />
    </header>
  );
}
