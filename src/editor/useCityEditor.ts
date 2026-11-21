// All editor state and actions. Every edit goes: next EditState → history →
// regenerate from the earliest stage that changed (in the worker) → doc →
// autosave. Loading a saved city shows its stored tree and never regenerates.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createCityDoc } from '../doc/create.js';
import { findById, walk } from '../doc/tree.js';
import type { CityDoc, Override, Point2, RegionNode, SettingValue } from '../doc/types.js';
import { CityDocError } from '../doc/validate.js';
import { bounds, containsPoint } from '../grammar/polygon.js';
import { createGeneratorClient, type GeneratorClient } from '../pipeline/client.js';
import { describeDrop } from '../pipeline/overrides.js';
import { STAGES } from '../stages/index.js';
import { defaultsFor } from '../stages/settings.js';
import { createAutosaver, type SaveState } from '../storage/autosave.js';
import * as db from '../storage/db.js';
import { downloadCity, importCityAndSave, readFileText } from '../storage/file.js';
import { combineFrom, editStateOf, History, regenerateFrom, type EditState } from './history.js';
import { isTextEntry } from './keys.js';
import { normalizeStages } from './normalize.js';

export interface Toast {
  id: string; kind: 'warning' | 'error' | 'info'; message: string; undoable: boolean;
  /** history depth right after the edit that caused it; Undo only applies while it's still the latest */
  undoDepth?: number;
}
export interface PickHit { nodeId: string; point: Point2 }

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const randomSeed = () => Math.floor(Math.random() * 2 ** 32);

function newDoc(): CityDoc {
  return {
    ...createCityDoc({
      name: 'Untitled city', seed: randomSeed(), now: now(), id: uuid(),
      stages: STAGES.map(s => ({ id: s.id, defaults: defaultsFor(s.settings) })),
    }),
    generatedThrough: 0,
  };
}

/** The override (if any) on this node for this key: same stage and kind, anchor inside it. */
export function overrideOn(doc: CityDoc, node: RegionNode, key: string): Override | undefined {
  return doc.overrides.find(o =>
    o.stage === node.stage && o.kind === node.kind && key in o.settings && containsPoint(node.geometry.footprint, o.anchor));
}

/** A point guaranteed (best effort) to lie in the node: its bounds centre, else its first vertex. */
function pointIn(node: RegionNode): Point2 {
  const b = bounds(node.geometry.footprint);
  const c: Point2 = [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
  return containsPoint(node.geometry.footprint, c) ? c : node.geometry.footprint[0][0][0];
}

export function useCityEditor() {
  const [doc, setDocState] = useState<CityDoc | null>(null);
  const [cities, setCities] = useState<db.CityIndexEntry[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [generating, setGenerating] = useState<{ stageIndex: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [currentStage, setCurrentStage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false, depth: 0 });

  const docRef = useRef<CityDoc | null>(null);
  const historyRef = useRef<History | null>(null);
  const clientRef = useRef<GeneratorClient | null>(null);
  const lastPickRef = useRef<Point2 | null>(null);
  const selectedRef = useRef<string | null>(null);
  /** Earliest stage a superseded or failed request was meant to rebuild but never applied. */
  const pendingFromRef = useRef<number | null>(null);
  /** Bumped whenever a city is opened (or deleted); results from an older session are discarded. */
  const sessionRef = useRef(0);
  const inflightRef = useRef<Promise<unknown> | null>(null);
  const autosaver = useMemo(() => createAutosaver(db.saveCity), []);

  const select = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedId(id);
  }, []);

  const syncHistory = useCallback(() => {
    const h = historyRef.current;
    setUndoState({ canUndo: h?.canUndo ?? false, canRedo: h?.canRedo ?? false, depth: h?.depth ?? 0 });
  }, []);

  const setDoc = useCallback((d: CityDoc | null) => {
    docRef.current = d;
    setDocState(d);
  }, []);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = uuid();
    setToasts(ts => [...ts, { ...t, id }]);
    if (t.kind === 'info') setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), 4000);
  }, []);

  const refreshCities = useCallback(() => {
    db.listCities().then(setCities, () => setCities([]));
  }, []);

  useEffect(() => {
    const client = createGeneratorClient();
    clientRef.current = client;
    const unsub = autosaver.subscribe(s => {
      setSaveState(s);
      if (s === 'saved') refreshCities();
    });
    // Don't lose a debounced save when the tab is hidden or closed.
    const flushNow = () => { void autosaver.flush(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushNow(); };
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsub();
      window.removeEventListener('pagehide', flushNow);
      document.removeEventListener('visibilitychange', onVisibility);
      client.dispose();
      flushNow();
    };
  }, [autosaver, refreshCities]);

  /** Apply an edit state to the current doc and regenerate what changed. */
  const commit = useCallback(async (prev: EditState, next: EditState) => {
    const base = docRef.current;
    if (!base) return;
    const session = sessionRef.current;
    const updated: CityDoc = { ...base, ...structuredClone(next), modifiedAt: now() };
    // The tree only reflects applied results: if an earlier request was superseded (or
    // failed), its stages were never rebuilt, so regenerate from the earliest of them.
    const from = combineFrom(pendingFromRef.current, regenerateFrom(prev, next, STAGES));
    if (from === null) {
      setDoc(updated);
      autosaver.schedule(updated);
      return;
    }
    pendingFromRef.current = from;
    setDoc(updated);
    const run = clientRef.current!.run(updated, from, stageIndex => setGenerating({ stageIndex }));
    inflightRef.current = run;
    const outcome = await run;
    if (outcome.status === 'superseded') return;
    if (session !== sessionRef.current) return; // a different city (or a fresh load) is open now
    setGenerating(null);
    if (outcome.status === 'error') {
      // pendingFrom stays set, so the next edit rebuilds the stages this one failed to.
      toast({ kind: 'error', message: `Generation failed: ${outcome.message}`, undoable: false });
      return;
    }
    pendingFromRef.current = null;
    const { result } = outcome;
    const latest = docRef.current;
    if (!latest) return;
    const done: CityDoc = { ...latest, tree: result.tree, overrides: result.overrides };
    // Ids are positional, so after a regenerate the old id may name a different region.
    // Re-find the selection the way overrides re-attach: same stage and kind, under the picked point.
    const sel = selectedRef.current && findById(latest.tree, selectedRef.current);
    const at = lastPickRef.current;
    if (sel) {
      let found: RegionNode | null = null;
      if (at) walk(done.tree, n => {
        if (n.stage === sel.stage && n.kind === sel.kind && containsPoint(n.geometry.footprint, at) &&
          (!found || n.geometry.height.low < found.geometry.height.low)) found = n;
      });
      select((found as RegionNode | null)?.id ?? null);
    }
    setDoc(done);
    autosaver.schedule(done);
    if (result.partitionProblems.length && import.meta.env.DEV) {
      console.warn('[proccity] partition problems:', result.partitionProblems);
    }
    if (result.dropped.length) {
      toast({ kind: 'warning', message: result.dropped.map(describeDrop).join('\n'), undoable: true, undoDepth: historyRef.current?.depth });
    }
  }, [autosaver, select, setDoc, toast]);

  const edit = useCallback((change: (s: EditState) => void, coalesceKey?: string) => {
    const d = docRef.current;
    const h = historyRef.current;
    if (!d || !h) return;
    const prev = editStateOf(d);
    const next = editStateOf(d);
    change(next);
    h.push(next, coalesceKey);
    syncHistory();
    void commit(prev, next);
  }, [commit, syncHistory]);

  const openDoc = useCallback((loaded: CityDoc, regenerate: boolean) => {
    // Saved cities must survive stages being added, reordered or retired.
    const d = normalizeStages(loaded, STAGES);
    sessionRef.current += 1;
    pendingFromRef.current = null;
    setGenerating(null);
    setToasts(ts => ts.filter(t => !t.undoable)); // their Undo belongs to the previous city
    historyRef.current = new History(editStateOf(d));
    syncHistory();
    select(null);
    lastPickRef.current = null;
    setCurrentStage(Math.max(d.generatedThrough, 0));
    db.setLastCityId(d.id);
    if (regenerate) {
      // Show the bare site immediately, then generate through generatedThrough.
      setDoc(d);
      const empty: EditState = { ...editStateOf(d), generatedThrough: -1 };
      void commit(empty, editStateOf(d));
    } else {
      setDoc(d);
    }
  }, [commit, select, setDoc, syncHistory]);

  // Start-up: last city, else newest, else a new one. Stored trees are shown as-is.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let list: db.CityIndexEntry[] = [];
      try { list = await db.listCities(); } catch { setSaveState('error'); }
      if (cancelled) return;
      setCities(list);
      const id = db.getLastCityId() ?? list[0]?.id;
      let d: CityDoc | undefined;
      try { if (id) d = await db.loadCity(id); } catch { d = undefined; }
      if (cancelled) return;
      if (d) openDoc(d, false);
      else {
        const fresh = newDoc();
        openDoc(fresh, true);
      }
    })();
    return () => { cancelled = true; };
  }, [openDoc]);

  /** Let an in-flight generation land and its save go out before leaving this city. */
  const settle = useCallback(async () => {
    await inflightRef.current?.catch(() => undefined);
    await autosaver.flush();
  }, [autosaver]);

  const actions = useMemo(() => ({
    async newCity() {
      await settle();
      openDoc(newDoc(), true);
    },
    async openCity(id: string) {
      if (id === docRef.current?.id) return;
      await settle();
      const d = await db.loadCity(id).catch(() => undefined);
      if (d) openDoc(d, false);
      else toast({ kind: 'error', message: 'Could not open that city.', undoable: false });
    },
    renameCity(name: string) {
      const d = docRef.current;
      if (!d || !name.trim()) return;
      const renamed = { ...d, name: name.trim(), modifiedAt: now() };
      setDoc(renamed);
      autosaver.schedule(renamed);
    },
    async deleteCity(id: string) {
      if (id === docRef.current?.id) {
        // A pending autosave or in-flight result would write the city straight back.
        sessionRef.current += 1;
        autosaver.cancel();
      }
      try {
        await db.deleteCity(id);
      } catch {
        toast({ kind: 'error', message: 'Could not delete that city.', undoable: false });
        return;
      }
      const list = await db.listCities().catch(() => []);
      setCities(list);
      if (id === docRef.current?.id) {
        const next = list[0] && await db.loadCity(list[0].id).catch(() => undefined);
        if (next) openDoc(next, false); else openDoc(newDoc(), true);
      }
    },
    async importFile(file: File) {
      try {
        await settle();
        const text = await readFileText(file);
        const d = await importCityAndSave(text, { save: db.saveCity, newId: uuid(), now: now() });
        refreshCities();
        openDoc(d, false);
        toast({ kind: 'info', message: `Opened "${d.name}" from file.`, undoable: false });
      } catch (err) {
        const message = err instanceof CityDocError ? err.message : `Could not open that file: ${err instanceof Error ? err.message : err}`;
        toast({ kind: 'error', message, undoable: false });
      }
    },
    download() {
      if (docRef.current) downloadCity(docRef.current);
    },
    setSite(patch: Partial<{ size: number; seed: number }>, coalesceKey?: string) {
      edit(s => {
        if (patch.size !== undefined) s.site.size = patch.size;
        if (patch.seed !== undefined) s.seed = patch.seed;
      }, coalesceKey);
    },
    setStageSetting(stageIndex: number, key: string, value: SettingValue, coalesceKey?: string) {
      const id = STAGES[stageIndex].id;
      edit(s => { s.stages.find(st => st.id === id)!.settings[key] = value; }, coalesceKey);
    },
    reroll(stageIndex: number) {
      const id = STAGES[stageIndex].id;
      edit(s => { s.stages.find(st => st.id === id)!.seedOffset += 1; });
    },
    nextStage() {
      const d = docRef.current;
      if (!d || d.generatedThrough >= STAGES.length - 1) return;
      const target = d.generatedThrough + 1;
      setCurrentStage(target);
      select(null);
      edit(s => { s.generatedThrough = target; });
    },
    clearAfter(stageIndex: number) {
      setCurrentStage(c => Math.min(c, stageIndex));
      select(null);
      edit(s => { s.generatedThrough = stageIndex; });
    },
    selectStage(i: number) {
      setCurrentStage(i);
      select(null);
    },
    pick(hit: PickHit | null) {
      select(hit?.nodeId ?? null);
      lastPickRef.current = hit?.point ?? null;
    },
    selectNode(id: string) {
      select(id);
      const node = docRef.current && findById(docRef.current.tree, id);
      lastPickRef.current = node ? pointIn(node) : null;
    },
    setOverride(nodeId: string, key: string, value: SettingValue) {
      const d = docRef.current;
      const node = d && findById(d.tree, nodeId);
      if (!d || !node) return;
      const existing = overrideOn(d, node, key);
      const anchor = lastPickRef.current && containsPoint(node.geometry.footprint, lastPickRef.current) ? lastPickRef.current : pointIn(node);
      edit(s => {
        if (existing) {
          const o = s.overrides.find(x => x.id === existing.id)!;
          o.settings = { ...o.settings, [key]: value };
        } else {
          s.overrides.push({ id: uuid(), stage: node.stage, kind: node.kind, anchor, settings: { [key]: value }, createdAt: now() });
        }
      });
    },
    removeOverride(overrideId: string) {
      edit(s => { s.overrides = s.overrides.filter(o => o.id !== overrideId); });
    },
    undo() {
      const d = docRef.current;
      const s = historyRef.current?.undo();
      syncHistory();
      if (d && s) {
        setCurrentStage(c => Math.min(c, Math.max(s.generatedThrough, 0)));
        void commit(editStateOf(d), s);
      }
    },
    redo() {
      const d = docRef.current;
      const s = historyRef.current?.redo();
      syncHistory();
      if (d && s) void commit(editStateOf(d), s);
    },
    dismissToast(id: string) {
      setToasts(ts => ts.filter(t => t.id !== id));
    },
  }), [autosaver, commit, edit, openDoc, refreshCities, select, setDoc, settle, syncHistory, toast]);

  // Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z — not while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      if (isTextEntry(e.target as HTMLInputElement | null)) return;
      e.preventDefault();
      if (e.shiftKey) actions.redo(); else actions.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions]);

  return {
    doc, cities, saveState, generating, toasts, currentStage, selectedId,
    canUndo: undoState.canUndo,
    canRedo: undoState.canRedo,
    historyDepth: undoState.depth,
    actions,
  };
}

export type CityEditor = ReturnType<typeof useCityEditor>;
