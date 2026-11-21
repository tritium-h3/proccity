import { useRef } from 'react';
import type { SettingValue } from '../doc/types.js';
import type { SettingField as Field } from '../stages/types.js';
import styles from './editor.module.css';

interface Props {
  field: Field;
  value: SettingValue | undefined;
  /** coalesceKey groups one drag of a slider into one undo step */
  onChange(value: SettingValue, coalesceKey?: string): void;
}

export function SettingField({ field, value, onChange }: Props) {
  // A fresh token per interaction: each drag is one undo step, but two drags are two.
  const session = useRef(0);
  const begin = () => { session.current += 1; };
  const key = () => `${field.key}#${session.current}`;

  switch (field.type) {
    case 'number': {
      const v = typeof value === 'number' ? value : field.default;
      return (
        <label className={styles.field} title={field.help}>
          <span className={styles.fieldLabel}>{field.label}</span>
          <input
            type="range" min={field.min} max={field.max} step={field.step} value={v}
            onPointerDown={begin} onKeyDown={begin}
            onChange={e => onChange(Number(e.target.value), key())}
          />
          <span className={styles.fieldValue}>{v}{field.unit ? ` ${field.unit}` : ''}</span>
        </label>
      );
    }
    case 'choice':
      return (
        <label className={styles.field} title={field.help}>
          <span className={styles.fieldLabel}>{field.label}</span>
          <select value={String(value ?? field.default)} onChange={e => onChange(e.target.value)}>
            {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      );
    case 'boolean':
      return (
        <label className={styles.field} title={field.help}>
          <span className={styles.fieldLabel}>{field.label}</span>
          <input type="checkbox" checked={Boolean(value ?? field.default)} onChange={e => onChange(e.target.checked)} />
        </label>
      );
  }
}
