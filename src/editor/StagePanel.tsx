import { useState } from 'react';
import { STAGES } from '../stages/index.js';
import { DEFAULT_SITE_SIZE } from '../doc/create.js';
import type { CityEditor } from './useCityEditor.js';
import { SettingField } from './SettingField.js';
import styles from './editor.module.css';

export function StagePanel({ editor }: { editor: CityEditor }) {
  const { doc, currentStage, actions } = editor;
  const [seedText, setSeedText] = useState<string | null>(null);
  if (!doc) return <aside className={styles.left} />;

  const mark = (i: number) => (i <= doc.generatedThrough ? '✓' : '○');

  return (
    <aside className={styles.left}>
      <h2 className={styles.heading}>Stages</h2>

      <button className={`${styles.stage} ${currentStage === -1 ? styles.stageCurrent : ''}`} onClick={() => actions.selectStage(-1)}>
        <span className={styles.mark}>◆</span> Site
      </button>
      {currentStage === -1 && (
        <div className={styles.stageBody}>
          <SettingField
            field={{ key: 'size', label: 'Site size', type: 'number', min: 5000, max: 60000, step: 1000, default: DEFAULT_SITE_SIZE, unit: 'm' }}
            value={doc.site.size}
            onChange={(v, k) => actions.setSite({ size: v as number }, k)}
          />
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Seed</span>
            <input
              className={styles.seed} inputMode="numeric"
              value={seedText ?? String(doc.seed)}
              onChange={e => setSeedText(e.target.value)}
              onBlur={() => {
                const n = Number(seedText);
                if (seedText !== null && Number.isInteger(n) && n >= 0) actions.setSite({ seed: n >>> 0 });
                setSeedText(null);
              }}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </label>
        </div>
      )}

      {STAGES.map((stage, i) => {
        const generated = i <= doc.generatedThrough;
        const state = doc.stages.find(s => s.id === stage.id);
        return (
          <div key={stage.id}>
            <button
              className={`${styles.stage} ${currentStage === i ? styles.stageCurrent : ''}`}
              disabled={!generated}
              onClick={() => actions.selectStage(i)}
            >
              <span className={styles.mark}>{currentStage === i ? '●' : mark(i)}</span> {i + 1} {stage.title}
            </button>
            {currentStage === i && generated && (
              <div className={styles.stageBody}>
                {stage.settings.map(f => (
                  <SettingField key={f.key} field={f} value={state?.settings[f.key]}
                    onChange={(v, k) => actions.setStageSetting(i, f.key, v, k ? `${stage.id}.${k}` : undefined)} />
                ))}
                <div className={styles.row}>
                  <button className={styles.small} onClick={() => actions.reroll(i)}>Reroll</button>
                  {i < doc.generatedThrough && (
                    <button className={styles.small} onClick={() => actions.clearAfter(i)}>Clear after this</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {doc.generatedThrough < STAGES.length - 1 && (
        <button className={styles.primary} onClick={actions.nextStage}>
          Next ▸ {STAGES[doc.generatedThrough + 1].title}
        </button>
      )}
    </aside>
  );
}
