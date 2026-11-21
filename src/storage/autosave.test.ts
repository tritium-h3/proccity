import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCityDoc } from '../doc/create.js';
import type { CityDoc } from '../doc/types.js';
import { createAutosaver, type SaveState } from './autosave.js';

const doc = (name: string) => createCityDoc({ name, stages: [], seed: 1, now: 'now', id: 'x' });

describe('autosave', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces to one save of the latest document', async () => {
    const saved: CityDoc[] = [];
    const states: SaveState[] = [];
    const a = createAutosaver(async d => { saved.push(d); }, 1000);
    a.subscribe(s => states.push(s));
    a.schedule(doc('1'));
    a.schedule(doc('2'));
    a.schedule(doc('3'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved.map(d => d.name)).toEqual(['3']);
    expect(states).toEqual(['saving', 'saved']);
  });

  it('reports errors and recovers on the next successful save', async () => {
    let fail = true;
    const states: SaveState[] = [];
    const a = createAutosaver(async () => { if (fail) throw new Error('quota'); }, 1000);
    a.subscribe(s => states.push(s));
    a.schedule(doc('1'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.at(-1)).toBe('error');
    fail = false;
    a.schedule(doc('2'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states.at(-1)).toBe('saved');
  });

  it('flushes immediately', async () => {
    const saved: string[] = [];
    const a = createAutosaver(async d => { saved.push(d.name); }, 1000);
    a.schedule(doc('now'));
    await a.flush();
    expect(saved).toEqual(['now']);
  });
});

describe('autosave cancel (review: Important 6)', () => {
  it('drops a pending save so a deleted city is not written back', async () => {
    vi.useFakeTimers();
    const saved: string[] = [];
    const a = createAutosaver(async d => { saved.push(d.name); }, 1000);
    a.schedule(doc('doomed'));
    a.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(saved).toEqual([]);
    vi.useRealTimers();
  });
});
