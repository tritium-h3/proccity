// Lots: stage 6. Every zoned block is cut into lots sized by its zone and density step, with open
// ground in the middle of very deep blocks; each lot records what lies along each of its sides.
// Design: docs/superpowers/specs/2026-11-27-lots-design.md

import { childId, walk } from '../../doc/tree.js';
import type { MultiPolygon, Point2, RegionNode, Settings } from '../../doc/types.js';
import { area, bounds, containsPoint } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import { RoadIndex } from '../blocks/roads.js';
import { FACES, type Category, type Zone } from '../blocks/rules.js';
import type { Stage } from '../types.js';
import { cutBlock } from './cut.js';
import { edgesOf, frontOf } from './faces.js';
import { lotTarget } from './rules.js';

const ORDER: Category[] = ['A', 'C', 'L'];

export const lots: Stage = {
  id: 'lots',
  title: 'Lots',
  settings: [
    { key: 'lotSize', label: 'Lot size', type: 'number', min: 0.5, max: 2, step: 0.05, default: 1, unit: '×', help: 'Scales every zone’s target lot' },
  ],

  run({ tree, leaves, settings, attr }) {
    const t0 = performance.now();
    const scale = (settings as Settings & { lotSize: number }).lotSize;
    const children = new Map<string, RegionNode[]>();

    let arterialHalf = 12.5;
    walk(tree, n => { if (n.kind === 'arterial' && typeof n.attrs.width === 'number') arterialHalf = n.attrs.width / 2; });
    const roads = new RoadIndex();
    for (const r of tree.data?.roads ?? []) roads.add({ points: r.points, category: 'A', half: arterialHalf });
    for (const st of tree.data?.streets ?? []) roads.add({ points: st.points, category: st.category, half: st.width / 2 });

    const stats: Record<string, number> = { blocks: 0, lots: 0, openGround: 0, openHa: 0, refused: 0 };
    for (const block of leaves.filter(n => n.kind === 'block' && typeof n.attrs.zone === 'string').sort((a, b) => a.id.localeCompare(b.id))) {
      const zone = block.attrs.zone as Zone, step = Number(attr(block, 'step') ?? 9);
      const allowedCats = FACES[zone];
      const out = cutBlock(block.geometry.footprint, {
        target: lotTarget(zone, step, scale),
        allowed: p => { const r = roads.at(p); return !!r && allowedCats.includes(r.category); },
      });
      stats.blocks++;
      stats.refused += out.refused;

      // What's beyond a lot's side: another lot of this block, its open ground, or neither.
      const boxes = out.lots.map(l => ({ l, b: bounds(l) }));
      const inBlock = (p: Point2): 'lot' | 'open' | null => {
        if (out.open && containsPoint(out.open, p)) return 'open';
        return boxes.some(({ l, b }) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minZ && p[1] <= b.maxZ && containsPoint(l, p)) ? 'lot' : null;
      };
      const kids: RegionNode[] = [];
      const node = (name: string, kind: string, fp: MultiPolygon, attrs: Settings): RegionNode =>
        ({ id: childId(block.id, name), name, kind, stage: 'lots', geometry: makeSlab(fp), attrs, children: [] });
      out.lots.forEach((fp, i) => {
        const edges = edgesOf(fp, roads, inBlock);
        const front = frontOf(fp, roads, allowedCats);
        const attrs: Settings = { faces: ORDER.filter(c => edges.includes(c)).join(','), edges };
        if (front) attrs.front = front; else stats.unfronted = (stats.unfronted ?? 0) + 1;
        kids.push(node(`lot:${i}`, 'lot', fp, attrs));
      });
      if (out.open) {
        kids.push(node('open:0', 'open', out.open, {}));
        stats.openGround++;
        stats.openHa += area(out.open) / 1e4;
      }
      stats.lots += out.lots.length;
      stats[`lots:${zone}`] = (stats[`lots:${zone}`] ?? 0) + out.lots.length;
      children.set(block.id, kids);
    }
    stats.openHa = Math.round(stats.openHa);
    stats.ms = Math.round(performance.now() - t0);
    return { children, data: new Map([[tree.id, { lotStats: stats }]]) };
  },
};
