import type { CityDoc, StageState } from '../doc/types.js';
import { defaultsFor } from '../stages/settings.js';
import type { Stage } from '../stages/types.js';

/** Align a document's stage states with the registry: registry stages in order (missing
 *  ones get defaults), unknown ones kept after them, generatedThrough clamped. Saved cities
 *  must survive stages being added, reordered or retired. */
export function normalizeStages(doc: CityDoc, stages: Stage[]): CityDoc {
  const byId = new Map(doc.stages.map(s => [s.id, s]));
  const known: StageState[] = stages.map(st => byId.get(st.id) ?? { id: st.id, settings: defaultsFor(st.settings), seedOffset: 0 });
  const unknown = doc.stages.filter(s => !stages.some(st => st.id === s.id));
  const generatedThrough = Math.max(-1, Math.min(Math.trunc(doc.generatedThrough), stages.length - 1));
  return { ...doc, stages: [...known, ...unknown], generatedThrough };
}
