import type { CityDoc } from '../doc/types.js';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Debounced saving with an observable state; failures surface as 'error' and never throw. */
export function createAutosaver(save: (doc: CityDoc) => Promise<void>, delayMs = 1000) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingDoc: CityDoc | null = null;
  const listeners = new Set<(s: SaveState) => void>();
  const emit = (s: SaveState) => listeners.forEach(fn => fn(s));

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const doc = pendingDoc;
    pendingDoc = null;
    if (!doc) return;
    emit('saving');
    try {
      await save(doc);
      emit('saved');
    } catch (err) {
      console.error('[proccity] save failed:', err);
      emit('error');
    }
  }

  return {
    schedule(doc: CityDoc): void {
      pendingDoc = doc;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, delayMs);
    },
    flush,
    subscribe(fn: (s: SaveState) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
