import { Fragment } from 'react';
import { ancestry } from '../doc/tree.js';
import { area } from '../grammar/polygon.js';
import { STAGES } from '../stages/index.js';
import { resolveAttr } from '../stages/settings.js';
import { overrideOn, type CityEditor } from './useCityEditor.js';
import { SettingField } from './SettingField.js';
import styles from './editor.module.css';

const fmtArea = (a: number) => `${Math.round(a).toLocaleString()} m²`;

export function Inspector({ editor }: { editor: CityEditor }) {
  const { doc, selectedId, actions } = editor;
  const path = doc && selectedId ? ancestry(doc.tree, selectedId) : [];
  const node = path.at(-1);

  if (!doc || !node) {
    return (
      <aside className={styles.right}>
        <h2 className={styles.heading}>Inspector</h2>
        <p className={styles.muted}>Click a region in the view to inspect it.</p>
      </aside>
    );
  }

  const schema = STAGES.find(s => s.id === node.stage)?.overridable?.[node.kind] ?? [];
  const inheritedKeys = [...new Set(path.flatMap(n => Object.keys(n.attrs)))];
  const { low, high } = node.geometry.height;

  return (
    <aside className={styles.right}>
      <h2 className={styles.heading}>Inspector</h2>
      <nav className={styles.crumbs}>
        {path.map((n, i) => (
          <span key={n.id}>
            {i > 0 && <span className={styles.crumbSep}>›</span>}
            <button className={n.id === node.id ? styles.crumbCurrent : styles.crumb} onClick={() => actions.selectNode(n.id)}>
              {n.name}
            </button>
          </span>
        ))}
      </nav>

      <dl className={styles.facts}>
        <dt>Kind</dt><dd>{node.kind}</dd>
        <dt>Area</dt><dd>{fmtArea(area(node.geometry.footprint))}</dd>
        <dt>Height</dt><dd>{low}–{high === null ? 'open' : `${high} m`}</dd>
        {inheritedKeys.map(k => (
          <Fragment key={k}><dt>{k}</dt><dd>{String(resolveAttr(path, k, {}))}</dd></Fragment>
        ))}
      </dl>

      {schema.length > 0 && (
        <>
          <h3 className={styles.subheading}>Local settings</h3>
          {schema.map(f => {
            const o = overrideOn(doc, node, f.key);
            return (
              <div key={f.key} className={styles.overrideRow}>
                <SettingField field={f} value={resolveAttr(path, f.key, {})} onChange={v => actions.setOverride(node.id, f.key, v)} />
                {o && (
                  <div className={styles.row}>
                    <span className={styles.badge}>override</span>
                    <button className={styles.small} onClick={() => actions.removeOverride(o.id)}>Remove</button>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </aside>
  );
}
