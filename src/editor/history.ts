// Undo/redo over the *editable* state. Trees aren't stored: undo restores the
// snapshot and the editor regenerates from the earliest stage that differs —
// per-stage seeds make that exact.

import type { CityDoc, Override, StageState } from '../doc/types.js';
import type { Stage } from '../stages/types.js';

export interface EditState {
  seed: number;
  site: { size: number };
  stages: StageState[];
  overrides: Override[];
  generatedThrough: number;
}

export function editStateOf(doc: CityDoc): EditState {
  const { seed, site, stages, overrides, generatedThrough } = doc;
  return structuredClone({ seed, site, stages, overrides, generatedThrough });
}

/** "Clear after this": later stages are no longer generated, and their overrides go with them
 *  (the owner: pins survive rerolling or changing a stage, not clearing what came after it).
 *  Overrides of stages the registry doesn't know are left alone. */
export function clearAfter(s: EditState, stageIndex: number, stages: Stage[]): EditState {
  const later = new Set(stages.slice(stageIndex + 1).map(st => st.id));
  return { ...s, generatedThrough: stageIndex, overrides: s.overrides.filter(o => !later.has(o.stage)) };
}

export class History {
  private past: EditState[] = [];
  private future: EditState[] = [];
  private now: EditState;
  private lastKey: string | undefined;

  constructor(initial: EditState) {
    this.now = structuredClone(initial);
  }

  get current(): EditState { return structuredClone(this.now); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  /** Number of undo steps available; identifies 'the edit just made' for toast Undo. */
  get depth(): number { return this.past.length; }

  /** Record `next`. A push with the same coalesceKey as the previous one replaces it. */
  push(next: EditState, coalesceKey?: string): void {
    if (!(coalesceKey !== undefined && coalesceKey === this.lastKey && this.past.length)) this.past.push(this.now);
    this.now = structuredClone(next);
    this.future = [];
    this.lastKey = coalesceKey;
  }

  undo(): EditState | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(this.now);
    this.now = prev;
    this.lastKey = undefined;
    return this.current;
  }

  redo(): EditState | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.now);
    this.now = next;
    this.lastKey = undefined;
    return this.current;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Stage index to regenerate from when moving a → b; null = nothing to do. */
export function regenerateFrom(a: EditState, b: EditState, stages: Stage[]): number | null {
  const candidates: number[] = [];
  if (a.seed !== b.seed || a.site.size !== b.site.size) candidates.push(0);
  stages.forEach((stage, i) => {
    const x = a.stages.find(s => s.id === stage.id);
    const y = b.stages.find(s => s.id === stage.id);
    if (!same(x, y)) candidates.push(i);
  });
  const byId = (os: Override[]) => new Map(os.map(o => [o.id, o]));
  const ao = byId(a.overrides), bo = byId(b.overrides);
  for (const id of new Set([...ao.keys(), ...bo.keys()])) {
    if (same(ao.get(id), bo.get(id))) continue;
    const stageId = (ao.get(id) ?? bo.get(id))!.stage;
    const i = stages.findIndex(s => s.id === stageId);
    if (i >= 0) candidates.push(i);
  }
  if (a.generatedThrough !== b.generatedThrough) candidates.push(Math.min(a.generatedThrough, b.generatedThrough) + 1);
  return candidates.length ? Math.min(...candidates) : null;
}

/** The stage to regenerate from, given a still-unapplied earlier request (`pending`).
 *  A superseded request never reached the tree, so its stages must be rebuilt too. */
export function combineFrom(pending: number | null, from: number | null): number | null {
  if (pending === null) return from;
  if (from === null) return pending;
  return Math.min(pending, from);
}
