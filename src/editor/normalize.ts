import { pruneStages } from '../doc/tree.js';
import type { CityDoc, StageState } from '../doc/types.js';
import { defaultsFor } from '../stages/settings.js';
import type { Stage } from '../stages/types.js';

/** Align a document's stage states with the registry: registry stages in order (missing
 *  ones get defaults), unknown ones kept after them, generatedThrough clamped. Saved cities
 *  must survive stages being added, reordered or retired. A stage inserted inside a city's
 *  generated range (sub-districts, between arterials and blocks) steps the city back to just
 *  before it and drops the later stages' regions: they were built without it (blocks divided
 *  superblocks then), and the next-stage button rebuilds them. */
export function normalizeStages(doc: CityDoc, stages: Stage[]): CityDoc {
  const byId = new Map(doc.stages.map(s => [s.id, s]));
  const known: StageState[] = stages.map(st => byId.get(st.id) ?? { id: st.id, settings: defaultsFor(st.settings), seedOffset: 0 });
  const unknown = doc.stages.filter(s => !stages.some(st => st.id === s.id));
  let generatedThrough = Math.max(-1, Math.min(Math.trunc(doc.generatedThrough), stages.length - 1));
  let tree = doc.tree;
  // generatedThrough is an index into the saved stage list: map it to the registry by id.
  const lastId = doc.stages[Math.trunc(doc.generatedThrough)]?.id;
  const last = stages.findIndex(st => st.id === lastId);
  if (last >= 0) {
    const missing = stages.findIndex((st, i) => i <= last && !byId.has(st.id));
    generatedThrough = missing >= 0 ? missing - 1 : last;
    if (missing >= 0) tree = pruneStages(tree, new Set(stages.slice(missing).map(st => st.id)));
  }
  return { ...doc, tree, stages: [...known, ...unknown], generatedThrough };
}
