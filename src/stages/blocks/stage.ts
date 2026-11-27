// Blocks: stage 5. Each developed sub-district is divided by collectors, then local roads, by
// recursive cuts running from road to road, into blocks sized by its density step; each block
// gets a zone.
// Design: docs/superpowers/specs/2026-11-25-blocks-design.md (zones: docs/notes/zoningBlocks.md)

import { childId, walk } from '../../doc/tree.js';
import type { MultiPolygon, Point2, RegionNode, Settings } from '../../doc/types.js';
import { difference, intersect, offsetPolyline, union } from '../../grammar/clipper.js';
import { area, bounds, containsPoint } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import { TYPE_LABEL, type DistrictType } from '../districts/rules.js';
import { createRng } from '../../pipeline/seeds.js';
import type { Stage } from '../types.js';
import { divideSuperblock, HARD_GRADE, type BlockSettings, type DivideCtx, type Street } from './divide.js';
import { classifyBoundary, runsOf } from './edges.js';
import { makeField } from './field.js';
import { heightRaster } from './height.js';
import { extend, offsetPath } from './geometry.js';
import { lotFactor } from '../subdistricts/rules.js';
import { RoadIndex } from './roads.js';
import { DISTRICT_ZONES, FACES, familyOf, smallestLot, ZONES, type Category, type Developed, type Zone } from './rules.js';
import { facesOf, pickZone, zoneFits } from './zones.js';

const PROBE = 2; // m beyond an outline edge, to see what's on the other side
const CRUMB = 100; // m²

export interface StreetData { id: string; points: Point2[]; category: 'C' | 'L'; width: number }

export const blocks: Stage = {
  id: 'blocks',
  title: 'Blocks',
  settings: [
    { key: 'collectorWidth', label: 'Collector width', type: 'number', min: 12, max: 30, step: 1, default: 18, unit: 'm', help: 'Including verges' },
    { key: 'localWidth', label: 'Local road width', type: 'number', min: 8, max: 20, step: 1, default: 12, unit: 'm', help: 'Including verges' },
    { key: 'densestDepth', label: 'Densest block depth', type: 'number', min: 40, max: 200, step: 5, default: 70, unit: 'm', help: 'At density step 9; steps between are interpolated' },
    { key: 'densestLength', label: 'Densest block length', type: 'number', min: 50, max: 400, step: 10, default: 160, unit: 'm' },
    { key: 'densestCollectors', label: 'Densest collector spacing', type: 'number', min: 200, max: 1000, step: 25, default: 400, unit: 'm' },
    { key: 'sparsestDepth', label: 'Sparsest block depth', type: 'number', min: 60, max: 400, step: 5, default: 150, unit: 'm', help: 'At density step 1' },
    { key: 'sparsestLength', label: 'Sparsest block length', type: 'number', min: 80, max: 1500, step: 10, default: 500, unit: 'm' },
    { key: 'sparsestCollectors', label: 'Sparsest collector spacing', type: 'number', min: 300, max: 3000, step: 50, default: 900, unit: 'm' },
    { key: 'localGrade', label: 'Max grade', type: 'number', min: 4, max: 20, step: 1, default: 10, unit: '%', help: 'For collectors and local roads' },
  ],

  overridable: {
    block: [{ key: 'zone', label: 'Zone', type: 'choice', default: 'LR', options: ZONES.map(z => ({ value: z, label: z })) }],
  },

  // A pin holds only where the generator could have picked it: the district allows the zone and the
  // block borders a road its lots may face.
  validateOverride(node, key, value) {
    if (node.kind !== 'block' || key !== 'zone' || typeof value !== 'string') return null;
    const t = node.attrs.district as DistrictType, faces = String(node.attrs.faces ?? '').split(',').filter(Boolean) as Category[];
    if (t === 'undeveloped' || !DISTRICT_ZONES[t].includes(value as Zone)) return `${value} in a ${TYPE_LABEL[t]} district`;
    if (!zoneFits(t, faces, value as Zone)) return `${value} here (its lots face ${FACES[value as Zone].join(' or ')} roads; this block borders ${faces.join(', ') || 'none'})`;
    return null;
  },

  run({ tree, leaves, settings, rng, attr }) {
    // Zones draw from their own stream, one value per block in id order, so cuts never shift them.
    const zoneRng = createRng(Math.floor(rng() * 2 ** 32));
    const t0 = performance.now();
    const s = settings as Settings & BlockSettings;
    const children = new Map<string, RegionNode[]>();

    // Arterials, as the roads every first cut must end on.
    let arterialHalf = 12.5;
    walk(tree, n => { if (n.kind === 'arterial' && typeof n.attrs.width === 'number') arterialHalf = n.attrs.width / 2; });
    const site0 = bounds(tree.geometry.footprint);
    const height = heightRaster(tree, (site0.maxX - site0.minX) / 500);
    const roads = new RoadIndex();
    for (const r of tree.data?.roads ?? []) roads.add({ points: r.points, category: 'A', half: arterialHalf });

    const streets: StreetData[] = [];
    const stats: Record<string, number> = { subdistricts: 0, blocks: 0, collectors: 0, locals: 0, borderStreets: 0, edgeStreets: 0, withCollectors: 0, unzoned: 0, zoneRestricted: 0, roadless: 0, roadlessHa: 0 };
    const superblocks = leaves
      .filter(n => n.kind === 'subdistrict' && n.attrs.step !== '0')
      .sort((a, b) => a.id.localeCompare(b.id));

    // 1. Shared border streets, for every sub-district before any is divided: each side cuts half a
    //    collector along a border with another developed sub-district, and together they make one
    //    street. Both sides find the same border line, so the street is recorded once. Beside an
    //    Undeveloped sub-district a dense one takes a whole collector (`edge`): there's no block
    //    stage on the other side to take half.
    type Area = { id: string; developed: boolean; fp: MultiPolygon; b: ReturnType<typeof bounds> };
    const areaOf = (n: RegionNode, developed: boolean): Area => ({ id: n.id, developed, fp: n.geometry.footprint, b: bounds(n.geometry.footprint) });
    const dists: Area[] = [], subs: Area[] = [];
    walk(tree, n => {
      if (n.kind === 'district') dists.push(areaOf(n, n.attrs.type !== 'undeveloped'));
      if (n.kind === 'subdistrict') subs.push(areaOf(n, n.attrs.step !== '0'));
    });
    const find = (list: Area[], p: Point2) => list.find(d => p[0] >= d.b.minX && p[0] <= d.b.maxX && p[1] >= d.b.minZ && p[1] <= d.b.maxZ && containsPoint(d.fp, p));
    const half = s.collectorWidth / 2;
    const site = bounds(tree.geometry.footprint);
    const offSite = (p: Point2) => p[0] < site.minX || p[0] > site.maxX || p[1] < site.minZ || p[1] > site.maxZ;
    const water = tree.children.filter(n => ['sea', 'river', 'pond'].includes(n.kind)).map(n => n.geometry.footprint);
    const borders = new Map<string, { lines: Point2[][]; strips: MultiPolygon[]; edges: Point2[][]; edgeStrips: MultiPolygon[]; pieces: MultiPolygon[]; open: RoadIndex }>();
    const seen = new Set<string>();
    const streetIds = new Map<string, string>();
    const key = (line: Point2[]) => [line[0], line[line.length - 1]].map(p => `${Math.round(p[0])},${Math.round(p[1])}`).sort().join('|');
    for (const sb of superblocks) {
      const dense = familyOf(attr(sb, 'type') as Developed) === 'dense';
      const runs = classifyBoundary(sb.geometry.footprint, (mid, out) => {
        if (roads.at(mid)) return 'A';
        const p: Point2 = [mid[0] + out[0] * PROBE, mid[1] + out[1] * PROBE];
        if (offSite(p) || water.some(w => containsPoint(w, p))) return 'open';
        const sub = find(subs, p);
        if (sub) return sub.id === sb.id ? 'none' : sub.developed ? 'border' : dense ? 'edge' : 'open';
        const d = find(dists, p);
        return d && !d.developed ? 'open' : 'none';
      });
      // No arterial or border anywhere round it (a district the arterials never reached): any road
      // here would join nothing, so it stays one block.
      if (!runs.flat().some(r => r.kind === 'A' || r.kind === 'border' || r.kind === 'edge')) { stats.roadless++; stats.roadlessHa += Math.round(area(sb.geometry.footprint) / 1e4); }
      const open = new RoadIndex();
      for (const line of runsOf(runs, 'open')) open.add({ points: line, category: 'L', half: 0 });
      const lines = runsOf(runs, 'border');
      const strips: MultiPolygon[] = [];
      // Each strip takes only what earlier ones left: cut independently, strips overlapped where
      // they met at a corner (an edge collector beside a border one, most often).
      let claimed: MultiPolygon = [];
      const claim = (strip: MultiPolygon) => {
        const own = claimed.length && strip.length ? difference(strip, claimed) : strip;
        if (area(own) > 0) claimed = union([...claimed, ...own], []);
        return own;
      };
      for (const line of lines) {
        const strip = claim(intersect(sb.geometry.footprint, offsetPolyline(extend(line, s.collectorWidth), half, 'butt')));
        strips.push(strip);
        if (area(strip) > 0) roads.add({ points: line, category: 'C', half });
      }
      const edges: Point2[][] = [], edgeStrips: MultiPolygon[] = [];
      for (const line of runsOf(runs, 'edge')) {
        const strip = claim(intersect(sb.geometry.footprint, offsetPolyline(extend(line, s.collectorWidth), s.collectorWidth, 'butt')));
        if (area(strip) <= 0) continue;
        // Rings keep the interior on their left, so a positive offset moves the centreline inwards.
        const centre = offsetPath(line, half);
        edges.push(centre);
        edgeStrips.push(strip);
        roads.add({ points: centre, category: 'C', half });
      }
      const taken = union([...strips, ...edgeStrips].flat(), []);
      const rest = taken.length ? difference(sb.geometry.footprint, taken) : sb.geometry.footprint;
      // Crumbs where a strip's end meets an arterial at a slant join the strip, not a block.
      const pieces: MultiPolygon[] = [];
      for (const poly of rest) {
        if (area([poly]) < CRUMB && strips.length) strips[0] = union(strips[0], [poly]);
        else if (area([poly]) < CRUMB && edgeStrips.length) edgeStrips[0] = union(edgeStrips[0], [poly]);
        else pieces.push([poly]);
      }
      borders.set(sb.id, { lines, strips, edges, edgeStrips, pieces, open });
    }

    // 2. Divide each superblock.
    for (const sb of superblocks) {
      const type = attr(sb, 'type') as Developed;
      const step = Number(sb.attrs.step);
      // Interim: the smallest lot grows as the step falls (the lots stage will own lot size).
      const lot = smallestLot(type), f = lotFactor(step);
      const ctx: DivideCtx = {
        family: familyOf(type), step, s, minBlockArea: lot.area * f * f, minDepth: lot.depth * f, rng, roads,
        field: makeField(height, familyOf(type), s.localGrade / 100, (HARD_GRADE * s.localGrade) / 100), height,
        openAt: p => !!borders.get(sb.id)!.open.at(p),
      };
      const border = borders.get(sb.id)!;
      const out = divideSuperblock(border.pieces, ctx);
      for (const [k, v] of Object.entries(out.stats)) stats[k] = (stats[k] ?? 0) + v;
      stats.subdistricts++;
      // A superblock no cut fits is still a block (one child), so it gets a zone like any other.
      const kids: RegionNode[] = [];
      const node = (name: string, kind: string, footprint: MultiPolygon, attrs: Settings): RegionNode =>
        ({ id: childId(sb.id, name), name, kind, stage: 'blocks', geometry: makeSlab(footprint), attrs, children: [] });
      const count = { collector: 0, local: 0 };
      const addStreet = (st: Street, strip: MultiPolygon, record: boolean, extra: Settings = {}) => {
        const kind = st.category === 'C' ? 'collector' : 'local';
        // A shared border street keeps the id it was first recorded under.
        const id = record ? `st:${streets.length}` : streetIds.get(key(st.points)) ?? `st:${streets.length}`;
        if (record) { streets.push({ id, ...st }); streetIds.set(key(st.points), id); }
        kids.push(node(`${kind}:${count[kind]++}`, kind, strip, { road: id, width: st.width, district: type, ...extra }));
      };
      border.lines.forEach((line, i) => {
        // A strip earlier strips took all of (or that missed the footprint) makes no region.
        if (!border.strips[i] || area(border.strips[i]) <= 0) return;
        const k = key(line), first = !seen.has(k);
        seen.add(k);
        if (first) { stats.borderStreets++; stats.collectors++; }
        addStreet({ points: line, category: 'C', width: s.collectorWidth }, border.strips[i], first);
      });
      border.edges.forEach((line, i) => {
        stats.edgeStreets++; stats.collectors++;
        addStreet({ points: line, category: 'C', width: s.collectorWidth }, border.edgeStrips[i], true, { edge: true });
      });
      out.streets.forEach((st, i) => {
        addStreet(st, out.strips[i], true);
        stats[st.category === 'C' ? 'collectors' : 'locals']++;
      });
      if (out.streets.some(st => st.category === 'C')) stats.withCollectors++;
      out.blocks.forEach((b, i) => {
        const faces = facesOf(b, roads);
        const { zone, restricted } = pickZone(type, faces, zoneRng());
        const attrs: Settings = { district: type, faces: faces.join(',') };
        if (zone) { attrs.zone = zone; stats[`zone:${zone}`] = (stats[`zone:${zone}`] ?? 0) + 1; } else stats.unzoned++;
        if (restricted) stats.zoneRestricted++;
        kids.push(node(`block:${i}`, 'block', b, attrs));
      });
      stats.blocks += out.blocks.length;
      children.set(sb.id, kids);
    }
    stats.ms = Math.round(performance.now() - t0);
    return { children, data: new Map([[tree.id, { streets, blockStats: stats }]]) };
  },
};
