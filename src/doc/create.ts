import { FORMAT, SITE_ID, type CityDoc, type RegionNode, type Settings } from './types.js';

export const DEFAULT_SITE_SIZE = 2000;

/** The root region: a square open slab centred on the origin. */
export function createSite(size: number): RegionNode {
  const h = size / 2;
  return {
    id: SITE_ID,
    name: SITE_ID,
    kind: 'site',
    stage: 'site',
    geometry: {
      type: 'slab',
      footprint: [[[[-h, -h], [h, -h], [h, h], [-h, h]]]],
      height: { ref: 'ground', low: 0, high: null },
    },
    attrs: {},
    children: [],
  };
}

export function createCityDoc(opts: {
  name: string;
  stages: { id: string; defaults: Settings }[];
  seed: number;
  now: string;
  id: string;
}): CityDoc {
  return {
    format: FORMAT,
    id: opts.id,
    name: opts.name,
    createdAt: opts.now,
    modifiedAt: opts.now,
    seed: opts.seed,
    site: { size: DEFAULT_SITE_SIZE },
    stages: opts.stages.map(s => ({ id: s.id, settings: { ...s.defaults }, seedOffset: 0 })),
    generatedThrough: -1,
    overrides: [],
    tree: createSite(DEFAULT_SITE_SIZE),
  };
}
