import type { CityEditor } from './useCityEditor.js';
import styles from './editor.module.css';

export function Toasts({ editor }: { editor: CityEditor }) {
  const { toasts, actions } = editor;
  if (!toasts.length) return null;
  return (
    <div className={styles.toasts}>
      {toasts.map(t => (
        <div key={t.id} className={`${styles.toast} ${styles[t.kind]}`} role="status">
          <span className={styles.toastIcon}>{t.kind === 'info' ? 'ℹ' : '⚠'}</span>
          <span className={styles.toastText}>{t.message}</span>
          {t.undoable && (
            <button className={styles.small} onClick={() => { actions.undo(); actions.dismissToast(t.id); }}>Undo</button>
          )}
          <button className={styles.close} onClick={() => actions.dismissToast(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
