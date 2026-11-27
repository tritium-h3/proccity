// Sub-districts: stage 4. Each developed superblock is cut into pieces of about Sub-district
// size, and each piece takes a density step within its district's type from the implied density
// field, or becomes Undeveloped. The blocks stage sizes its streets by the step.
// Design: docs/superpowers/specs/2026-11-27-subdistricts-design.md

import { childId, walk } from '../../doc/tree.js';
import type { MultiPolygon, Point2, RegionNode, Settings } from '../../doc/types.js';
import { area, bounds, containsPoint } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import { createRng } from '../../pipeline/seeds.js';
import type { Developed } from '../blocks/rules.js';
import { RoadIndex } from '../blocks/roads.js';
import { cutRegion } from '../districts/cut.js';
import { sharedLength, TOUCH } from '../districts/graph.js';
import type { DistrictType } from '../districts/rules.js';
import type { Stage } from '../types.js';
import { assignSteps, type SubInfo } from './assign.js';
import { densityField } from './field.js';
import { allowed, codeOf, labelOf, nominal } from './rules.js';

const SAMPLE = 20; // m between outline samples when looking for an arterial alongside
// How strongly a piece's difference from its district's mean field moves its step (measured: 1.5
// shows every level somewhere without emptying the middle ones).
const GAIN = 1.5;

function outlineSamples(fp: MultiPolygon): Point2[] {
  const out: Point2[] = [];
  for (const poly of fp) for (const ring of poly) ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / SAMPLE));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  });
  return out;
}

export const subdistricts: Stage = {
  id: 'subdistricts',
  title: 'Sub-districts',
  settings: [
    { key: 'subdistrictSize', label: 'Sub-district size', type: 'number', min: 50, max: 600, step: 10, default: 150, unit: 'ha', help: 'Superblocks over 1.5× this are cut' },
    { key: 'variation', label: 'Variation', type: 'number', min: 0, max: 3, step: 0.1, default: 1, unit: 'steps', help: 'Noise on the density field' },
    { key: 'openLand', label: 'Open land', type: 'number', min: 0, max: 2, step: 0.1, default: 1, unit: '×', help: 'How often sub-districts are left Undeveloped' },
  ],

  overridable: {
    subdistrict: [{
      key: 'step', label: 'Density step', type: 'choice', default: '0',
      options: Array.from({ length: 10 }, (_, k) => ({ value: String(9 - k), label: 9 - k === 0 ? 'Undeveloped' : `Step ${9 - k}` })),
    }],
  },

  validateOverride(node, key, value) {
    if (node.kind !== 'subdistrict' || key !== 'step') return null;
    const t = node.attrs.district as Developed, step = Number(value);
    return allowed(t, step) ? null : `step ${step} in this district (${codeOf(t, step)} isn't a valid code)`;
  },

  run({ tree, leaves, settings, rng, attr, overridesForStage }) {
    const t0 = performance.now();
    const s = settings as Settings & { subdistrictSize: number; variation: number; openLand: number };
    const children = new Map<string, RegionNode[]>();
    const drawRng = createRng(Math.floor(rng() * 2 ** 32));
    const fieldSeed = Math.floor(rng() * 2 ** 31);

    // The field's blur follows the districts' size (the districts stage's setting isn't visible
    // here; their mean area gives the same scale).
    const dAreas: number[] = [];
    walk(tree, n => { if (n.kind === 'district') dAreas.push(area(n.geometry.footprint)); });
    if (!dAreas.length) return { children };
    const districtSize = dAreas.reduce((a, b) => a + b, 0) / dAreas.length / 1e4;
    const field = densityField(tree, { districtSize, variation: s.variation, seed: fieldSeed });

    let arterialHalf = 12.5;
    walk(tree, n => { if (n.kind === 'arterial' && typeof n.attrs.width === 'number') arterialHalf = n.attrs.width / 2; });
    const roads = new RoadIndex();
    for (const r of tree.data?.roads ?? []) roads.add({ points: r.points, category: 'A', half: arterialHalf });

    // 1. Cut.
    interface Piece { parent: RegionNode; id: string; name: string; fp: MultiPolygon; type: Developed; district: string }
    const pieces: Piece[] = [];
    const superblocks = leaves.filter(n => n.kind === 'superblock' && attr(n, 'type') !== 'undeveloped').sort((a, b) => a.id.localeCompare(b.id));
    for (const sb of superblocks) {
      const a = area(sb.geometry.footprint) / 1e4;
      const k = a > 1.5 * s.subdistrictSize ? Math.round(a / s.subdistrictSize) : 1;
      cutRegion(sb.geometry.footprint, k, rng).forEach((fp, i) => {
        const name = `sub:${i}`;
        pieces.push({ parent: sb, id: childId(sb.id, name), name, fp, type: attr(sb, 'type') as Developed, district: sb.id.slice(0, sb.id.lastIndexOf('/')) });
      });
    }

    // 2. Neighbours (a shared border of TOUCH m or more) and arterial contact.
    const box = pieces.map(p => bounds(p.fp));
    const neighbours: number[][] = pieces.map(() => []);
    for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
      const a = box[i], b = box[j];
      if (a.maxX + 2 < b.minX || b.maxX + 2 < a.minX || a.maxZ + 2 < b.minZ || b.maxZ + 2 < a.minZ) continue;
      if (sharedLength(pieces[i].fp, pieces[j].fp) >= TOUCH) { neighbours[i].push(j); neighbours[j].push(i); }
    }

    // 3. Pins (newest wins), then steps.
    const pins = new Map<number, number>();
    for (const o of [...overridesForStage].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (o.kind !== 'subdistrict' || o.settings.step === undefined) continue;
      const i = pieces.findIndex(p => containsPoint(p.fp, o.anchor));
      const step = Number(o.settings.step);
      if (i >= 0 && allowed(pieces[i].type, step)) pins.set(i, step);
    }
    // A step is the type's nominal density moved by how far this piece's field is from its
    // district's mean: the side towards a denser neighbour is denser, but no type is pulled off
    // its own range (the densest type's neighbours are always sparser, so the raw field never
    // reached F9).
    const raw = pieces.map(p => field.meanOver(p.fp));
    const byDistrict = new Map<string, { sum: number; area: number }>();
    pieces.forEach((p, i) => {
      const d = byDistrict.get(p.district) ?? { sum: 0, area: 0 }, a = area(p.fp);
      d.sum += raw[i] * a; d.area += a;
      byDistrict.set(p.district, d);
    });
    const infos: SubInfo[] = pieces.map((p, i) => ({
      type: p.type, district: p.district, field: raw[i],
      local: nominal(p.type) + GAIN * (raw[i] - byDistrict.get(p.district)!.sum / byDistrict.get(p.district)!.area),
      arterial: outlineSamples(p.fp).some(q => roads.at(q)), draw: drawRng(), pin: pins.get(i),
    }));
    const { steps, openRefused } = assignSteps(infos, neighbours, s.openLand);

    // 4. Nodes and stats.
    const stats: Record<string, number> = { subdistricts: pieces.length, undeveloped: 0, undevelopedHa: 0, openRefused };
    pieces.forEach((p, i) => {
      const step = steps[i], code = codeOf(p.type, step), ha = area(p.fp) / 1e4;
      if (step === 0) { stats.undeveloped++; stats.undevelopedHa += ha; }
      stats[`ha:${code}`] = Math.round((stats[`ha:${code}`] ?? 0) + ha);
      const node: RegionNode = {
        id: p.id, name: p.name, kind: 'subdistrict', stage: 'subdistricts', geometry: makeSlab(p.fp),
        attrs: { district: p.type as DistrictType, step: String(step), code, label: labelOf(p.type, step) }, children: [],
      };
      const kids = children.get(p.parent.id) ?? [];
      kids.push(node);
      children.set(p.parent.id, kids);
    });
    stats.undevelopedHa = Math.round(stats.undevelopedHa);
    stats.ms = Math.round(performance.now() - t0);
    return { children, data: new Map([[tree.id, { subdistrictStats: stats }]]) };
  },
};
