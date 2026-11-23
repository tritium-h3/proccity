// Districts: stage 2. Each terrain land region is cut into one or more districts (hills stay
// whole; water gets none). Each district gets a type through an anchored, budgeted fill that
// keeps density changing gradually (fill.ts). The type limits which zones its blocks may take
// later; building height is set per block, so districts carry no height cap.
// Design: docs/superpowers/specs/2026-11-23-districts-design.md

import { childId } from '../../doc/tree.js';
import type { MultiPolygon, RegionNode, Settings } from '../../doc/types.js';
import { intersect, offsetPolygons, union } from '../../grammar/clipper.js';
import { area, bounds, centroid, containsPoint } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import { createRng } from '../../pipeline/seeds.js';
import type { Stage } from '../types.js';
import { cutRegion } from './cut.js';
import { assignStable } from './fill.js';
import { buildGraph, isWide, type DistrictInfo } from './graph.js';
import { allowedOn, TYPE_LABEL, TYPES, type DistrictType, type TerrainKind } from './rules.js';

const LAND = new Set<string>(['flat', 'slope', 'hills']);
const WATER = new Set<string>(['sea', 'river', 'pond']);
// Distances in units of a district's width (sqrt of its area, 283 m at the old 8 ha default).
const NEAR = 300 / 283; // flat land and water counted around a candidate main centre
const EDGE = 200 / 283; // too close to the site edge for a main centre

export const districts: Stage = {
  id: 'districts',
  title: 'Districts',
  settings: [
    { key: 'districtSize', label: 'District size', type: 'number', min: 450, max: 6750, step: 150, default: 1800, unit: 'ha', help: 'Regions bigger than about 1.5 × this are cut into several districts' },
    { key: 'settlements', label: 'Settlements', type: 'number', min: 1, max: 8, step: 1, default: 4, help: 'Centres, including the main one' },
    { key: 'growth', label: 'Growth', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5, help: 'From villages to a city' },
  ],
  overridable: {
    district: [{ key: 'type', label: 'Type', type: 'choice', default: 'rural', options: TYPES.map(t => ({ value: t, label: TYPE_LABEL[t] })) }],
  },

  validateOverride(node, key, value) {
    if (node.kind !== 'district' || key !== 'type' || typeof value !== 'string') return null;
    const t = value as DistrictType;
    return allowedOn(t, node.attrs.terrain as TerrainKind) ? null : `${TYPE_LABEL[t]} needs flat land`;
  },

  run({ tree, leaves, settings, rng, overridesForStage }) {
    const s = settings as Settings & { districtSize: number; settlements: number; growth: number };
    const children = new Map<string, RegionNode[]>();
    const land = leaves.filter(n => n.stage === 'terrain' && LAND.has(n.kind));
    const width = Math.sqrt(s.districtSize * 1e4), near = NEAR * width, edgeMargin = EDGE * width;
    if (!land.length) return { children };

    // 1. Cut regions into districts.
    const parts: { parent: RegionNode; footprint: MultiPolygon; terrain: TerrainKind }[] = [];
    for (const r of land) {
      const k = r.kind === 'hills' ? 1 : Math.max(1, Math.round(area(r.geometry.footprint) / (s.districtSize * 1e4)));
      for (const footprint of cutRegion(r.geometry.footprint, k, rng)) parts.push({ parent: r, footprint, terrain: r.kind as TerrainKind });
    }
    const infos: DistrictInfo[] = parts.map(p => ({ footprint: p.footprint, terrain: p.terrain, area: area(p.footprint), centroid: centroid(p.footprint) }));

    // 2. The graph. Water can be crossed where the banks come within 1.5 river widths.
    const river = tree.children.find(n => n.kind === 'river');
    const graph = buildGraph(infos, 1.5 * Number(river?.attrs.width ?? 40));

    // 3. How good a main-centre site each district is: flat land around it, water nearby,
    //    not at the site edge.
    const water = tree.children.filter(n => WATER.has(n.kind)).flatMap(n => n.geometry.footprint);
    const nearWater = water.length ? offsetPolygons(water, near) : [];
    const sb = bounds(tree.geometry.footprint);
    const siteScore = infos.map((d, i) => {
      let flat = 0;
      infos.forEach(o => { if (o.terrain === 'flat' && Math.hypot(o.centroid[0] - d.centroid[0], o.centroid[1] - d.centroid[1]) <= near) flat += o.area; });
      const [x, z] = d.centroid;
      const edge = Math.min(x - sb.minX, sb.maxX - x, z - sb.minZ, sb.maxZ - z);
      // Flat land in old-scale hectares (8 per district), so the water and edge terms keep their weight.
      return (flat / (s.districtSize * 1e4)) * 8 + (nearWater.length && area(intersect(nearWater, infos[i].footprint)) > 0 ? 40 : 0) - (edge < edgeMargin ? 30 : 0);
    });

    // 4. The user's type overrides pin districts before the fill.
    const pins = new Map<number, DistrictType>();
    for (const o of [...overridesForStage].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const t = o.settings.type;
      if (o.kind !== 'district' || typeof t !== 'string' || !(TYPES as readonly string[]).includes(t)) continue;
      const i = infos.findIndex(d => containsPoint(d.footprint, o.anchor));
      if (i >= 0) pins.set(i, t as DistrictType);
    }

    const wideMemo = new Map<string, boolean>();
    const isWidePatch = (ids: number[]) => {
      const key = ids.join(',');
      let w = wideMemo.get(key);
      if (w === undefined) {
        w = ids.some(i => infos[i].terrain === 'hills') || isWide(union(ids.flatMap(i => infos[i].footprint), []));
        wideMemo.set(key, w);
      }
      return w;
    };

    // One seed for the fill, replayed for each refill, so a pin that obeys the rules changes
    // only its own district (assignStable).
    const fillSeed = Math.floor(rng() * 2 ** 32);
    const fill = assignStable({
      graph, terrain: infos.map(d => d.terrain), area: infos.map(d => d.area), siteScore,
      growth: s.growth, settlements: s.settlements, pins, isWidePatch, unit: width / 283,
    }, () => createRng(fillSeed));

    const counters = new Map<string, number>();
    parts.forEach((p, i) => {
      const n = counters.get(p.parent.id) ?? 0;
      counters.set(p.parent.id, n + 1);
      const name = `district:${n}`;
      const attrs: RegionNode['attrs'] = { type: fill.types[i], terrain: p.terrain };
      if (fill.anchor[i]) attrs.anchor = fill.anchor[i]!;
      const node: RegionNode = { id: childId(p.parent.id, name), name, kind: 'district', stage: 'districts', geometry: makeSlab(p.footprint), attrs, children: [] };
      children.set(p.parent.id, [...(children.get(p.parent.id) ?? []), node]);
    });

    return {
      children,
      data: new Map([[tree.id, { stats: {
        districts: parts.length, repairs: fill.repairs, overflows: fill.overflows,
        centres: fill.anchor.filter(a => a === 'main' || a === 'minor').length,
      } }]]),
    };
  },
};
