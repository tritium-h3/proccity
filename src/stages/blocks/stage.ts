// Blocks: stage 4. Each developed superblock is divided by collectors, then local roads, by
// recursive cuts running from road to road, into blocks; each block gets a zone.
// Design: docs/superpowers/specs/2026-11-25-blocks-design.md (zones: docs/notes/zoningBlocks.md)

import { childId, walk } from '../../doc/tree.js';
import type { MultiPolygon, Point2, RegionNode, Settings } from '../../doc/types.js';
import { difference, intersect, offsetPolyline, union } from '../../grammar/clipper.js';
import { area, bounds, containsPoint } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import type { DistrictType } from '../districts/rules.js';
import type { Stage } from '../types.js';
import { divideSuperblock, type BlockSettings, type DivideCtx, type Street } from './divide.js';
import { classifyBoundary, runsOf } from './edges.js';
import { makeField } from './field.js';
import { heightRaster } from './height.js';
import { extend } from './geometry.js';
import { RoadIndex } from './roads.js';
import { familyOf, smallestLot, type Developed } from './rules.js';

const PROBE = 2; // m beyond an outline edge, to see what's on the other side
const CRUMB = 100; // m²

export interface StreetData { id: string; points: Point2[]; category: 'C' | 'L'; width: number; culDeSac?: boolean }

export const blocks: Stage = {
  id: 'blocks',
  title: 'Blocks',
  settings: [
    { key: 'collectorWidth', label: 'Collector width', type: 'number', min: 12, max: 30, step: 1, default: 18, unit: 'm', help: 'Including verges' },
    { key: 'localWidth', label: 'Local road width', type: 'number', min: 8, max: 20, step: 1, default: 12, unit: 'm', help: 'Including verges' },
    { key: 'denseDepth', label: 'Dense block depth', type: 'number', min: 40, max: 200, step: 5, default: 70, unit: 'm', help: 'Town, urban and financial districts' },
    { key: 'denseLength', label: 'Dense block length', type: 'number', min: 50, max: 400, step: 10, default: 160, unit: 'm' },
    { key: 'sparseDepth', label: 'Sparse block depth', type: 'number', min: 60, max: 300, step: 5, default: 120, unit: 'm', help: 'Suburban and rural districts' },
    { key: 'sparseLength', label: 'Sparse block length', type: 'number', min: 80, max: 1000, step: 10, default: 400, unit: 'm' },
    { key: 'denseCollectors', label: 'Dense collector spacing', type: 'number', min: 200, max: 1000, step: 25, default: 400, unit: 'm' },
    { key: 'sparseCollectors', label: 'Sparse collector spacing', type: 'number', min: 300, max: 2000, step: 50, default: 700, unit: 'm' },
    { key: 'localGrade', label: 'Max grade', type: 'number', min: 4, max: 20, step: 1, default: 10, unit: '%', help: 'For collectors and local roads' },
    { key: 'culDeSacs', label: 'Cul-de-sacs', type: 'number', min: 0, max: 0.3, step: 0.01, default: 0.05, help: 'Share of Suburban pieces that may end in one when no road crosses them' },
  ],

  run({ tree, leaves, settings, rng, attr }) {
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
    const stats: Record<string, number> = { superblocks: 0, blocks: 0, collectors: 0, locals: 0, borderStreets: 0, roadless: 0, roadlessHa: 0 };
    const superblocks = leaves
      .filter(n => n.kind === 'superblock' && attr(n, 'type') !== 'undeveloped')
      .sort((a, b) => a.id.localeCompare(b.id));

    // 1. Shared border streets, for every superblock before any is divided: each side cuts half a
    //    collector along a border with another developed district, and together they make one
    //    street. Both sides find the same border line, so the street is recorded once.
    const dists: { id: string; developed: boolean; fp: MultiPolygon; b: ReturnType<typeof bounds> }[] = [];
    walk(tree, n => { if (n.kind === 'district') dists.push({ id: n.id, developed: n.attrs.type !== 'undeveloped', fp: n.geometry.footprint, b: bounds(n.geometry.footprint) }); });
    const districtAt = (p: Point2) => dists.find(d => p[0] >= d.b.minX && p[0] <= d.b.maxX && p[1] >= d.b.minZ && p[1] <= d.b.maxZ && containsPoint(d.fp, p));
    const half = s.collectorWidth / 2;
    const site = bounds(tree.geometry.footprint);
    const offSite = (p: Point2) => p[0] < site.minX || p[0] > site.maxX || p[1] < site.minZ || p[1] > site.maxZ;
    const water = tree.children.filter(n => ['sea', 'river', 'pond'].includes(n.kind)).map(n => n.geometry.footprint);
    const borders = new Map<string, { lines: Point2[][]; strips: MultiPolygon[]; pieces: MultiPolygon[]; open: RoadIndex }>();
    const seen = new Set<string>();
    const key = (line: Point2[]) => [line[0], line[line.length - 1]].map(p => `${Math.round(p[0])},${Math.round(p[1])}`).sort().join('|');
    for (const sb of superblocks) {
      const own = sb.id.slice(0, sb.id.lastIndexOf('/'));
      const runs = classifyBoundary(sb.geometry.footprint, (mid, out) => {
        if (roads.at(mid)) return 'A';
        const p: Point2 = [mid[0] + out[0] * PROBE, mid[1] + out[1] * PROBE];
        if (offSite(p) || water.some(w => containsPoint(w, p))) return 'open';
        const d = districtAt(p);
        if (!d) return 'none';
        if (!d.developed) return 'open';
        return d.id !== own ? 'border' : 'none';
      });
      // No arterial or border anywhere round it (a district the arterials never reached): any road
      // here would join nothing, so it stays one block.
      if (!runs.flat().some(r => r.kind === 'A' || r.kind === 'border')) { stats.roadless++; stats.roadlessHa += Math.round(area(sb.geometry.footprint) / 1e4); }
      const open = new RoadIndex();
      for (const line of runsOf(runs, 'open')) open.add({ points: line, category: 'L', half: 0 });
      const lines = runsOf(runs, 'border');
      const strips: MultiPolygon[] = [];
      for (const line of lines) {
        const strip = intersect(sb.geometry.footprint, offsetPolyline(extend(line, s.collectorWidth), half, 'butt'));
        strips.push(strip);
        if (area(strip) > 0) roads.add({ points: line, category: 'C', half });
      }
      const taken = union(strips.flat(), []);
      const rest = taken.length ? difference(sb.geometry.footprint, taken) : sb.geometry.footprint;
      // Crumbs where a strip's end meets an arterial at a slant join the strip, not a block.
      const pieces: MultiPolygon[] = [];
      for (const poly of rest) {
        if (area([poly]) < CRUMB && strips.length) strips[0] = union(strips[0], [poly]);
        else pieces.push([poly]);
      }
      borders.set(sb.id, { lines, strips, pieces, open });
    }

    // 2. Divide each superblock.
    for (const sb of superblocks) {
      const type = attr(sb, 'type') as Developed;
      const lot = smallestLot(type);
      const ctx: DivideCtx = {
        family: familyOf(type), s, minBlockArea: lot.area, minDepth: lot.depth, rng, roads,
        field: makeField(height, familyOf(type), s.localGrade / 100), height,
        openAt: p => !!borders.get(sb.id)!.open.at(p),
      };
      const border = borders.get(sb.id)!;
      const out = divideSuperblock(border.pieces, ctx);
      for (const [k, v] of Object.entries(out.stats)) stats[k] = (stats[k] ?? 0) + v;
      stats.superblocks++;
      // A superblock no cut fits is still a block (one child), so it gets a zone like any other.
      const kids: RegionNode[] = [];
      const node = (name: string, kind: string, footprint: MultiPolygon, attrs: Settings): RegionNode =>
        ({ id: childId(sb.id, name), name, kind, stage: 'blocks', geometry: makeSlab(footprint), attrs, children: [] });
      const count = { collector: 0, local: 0 };
      const addStreet = (st: Street, strip: MultiPolygon, record: boolean) => {
        const kind = st.category === 'C' ? 'collector' : 'local';
        const id = `st:${streets.length}`;
        if (record) streets.push({ id, ...st });
        kids.push(node(`${kind}:${count[kind]++}`, kind, strip, { road: id, width: st.width }));
      };
      border.lines.forEach((line, i) => {
        if (!border.strips[i]) return;
        const k = key(line), first = !seen.has(k);
        seen.add(k);
        if (first) { stats.borderStreets++; stats.collectors++; }
        addStreet({ points: line, category: 'C', width: s.collectorWidth }, border.strips[i], first);
      });
      out.streets.forEach((st, i) => {
        addStreet(st, out.strips[i], true);
        stats[st.category === 'C' ? 'collectors' : 'locals']++;
      });
      out.blocks.forEach((b, i) => kids.push(node(`block:${i}`, 'block', b, { district: type as DistrictType })));
      stats.blocks += out.blocks.length;
      children.set(sb.id, kids);
    }
    stats.ms = Math.round(performance.now() - t0);
    return { children, data: new Map([[tree.id, { streets, blockStats: stats }]]) };
  },
};
