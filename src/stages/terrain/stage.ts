// The terrain stage (v2): water carves the site, land is divided into Voronoi cells, a rule
// table classifies them, same-kind neighbours merge into regions, and every vertex gets an
// elevation. Each region stores its own constrained triangulation (data.ground). Fine
// detail is cosmetic and lives in the renderer's shader.

import { childId } from '../../doc/tree.js';
import type { GroundSurface, MultiPolygon, Point2, RegionNode, Settings } from '../../doc/types.js';
import { difference, union } from '../../grammar/clipper.js';
import { area, containsPoint } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import type { Stage } from '../types.js';
import { buildCells, vkey } from './cells.js';
import { computeLevels, riverSurfaceAt } from './elevation.js';
import { constrainedSurface } from './ground.js';
import { classify, mergeRegions } from './rules.js';
import { layoutWater, riverProfile, type Shore } from './water.js';

const SEA_DEPTH = 15;
const RIVER_DEPTH = 3;
const r1 = (v: number) => Math.round(v * 10) / 10;

function distToLine(p: Point2, line: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(p[0] - (ax + dx * t), p[1] - (az + dz * t)));
  }
  return best;
}

/** Elevation range and area-weighted mean steepness (degrees) of a surface. */
function surfaceStats(g: GroundSurface) {
  let min = Infinity, max = -Infinity, wsum = 0, asum = 0;
  for (const p of g.points) { min = Math.min(min, p[2]); max = Math.max(max, p[2]); }
  for (const [i, j, k] of g.triangles) {
    const a = g.points[i], b = g.points[j], c = g.points[k];
    const ux = b[0] - a[0], uz = b[1] - a[1], uy = b[2] - a[2];
    const vx = c[0] - a[0], vz = c[1] - a[1], vy = c[2] - a[2];
    const nx = uz * vy - uy * vz, ny = ux * vz - uz * vx, nz = uy * vx - ux * vy; // (x, z, y) cross
    const plan = Math.abs(ny) / 2;
    const len = Math.hypot(nx, ny, nz);
    if (!plan || !len) continue;
    wsum += (Math.acos(Math.abs(ny) / len) * 180 / Math.PI) * plan;
    asum += plan;
  }
  return { minElevation: r1(min), maxElevation: r1(max), meanSteepness: r1(asum ? wsum / asum : 0) };
}

export const terrain: Stage = {
  id: 'terrain',
  title: 'Terrain',
  settings: [
    { key: 'relief', label: 'Relief', type: 'number', min: 20, max: 400, step: 10, default: 150, unit: 'm', help: 'Height range across the site' },
    { key: 'hilliness', label: 'Hilliness', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5, help: 'More hills, and bumpier ground' },
    { key: 'shore', label: 'Shore', type: 'choice', default: 'south', options: [
      { value: 'none', label: 'None' }, { value: 'north', label: 'North' }, { value: 'east', label: 'East' },
      { value: 'south', label: 'South' }, { value: 'west', label: 'West' }] },
    { key: 'river', label: 'River', type: 'boolean', default: true },
    { key: 'riverWidth', label: 'River width', type: 'number', min: 10, max: 120, step: 5, default: 40, unit: 'm' },
    { key: 'flatWidth', label: 'Flat width', type: 'number', min: 0, max: 5, step: 1, default: 2, help: 'How many cells deep the coastal and river flats run' },
    { key: 'ponds', label: 'Ponds', type: 'number', min: 0, max: 6, step: 1, default: 2 },
    { key: 'cellSize', label: 'Cell size', type: 'number', min: 60, max: 250, step: 10, default: 120, unit: 'm', help: 'How finely the land is divided' },
  ],
  overridable: {
    flat: [{ key: 'elevation', label: 'Elevation', type: 'number', min: 1, max: 400, step: 1, default: 3, unit: 'm' }],
  },

  run({ leaves, settings, rng, overridesForStage }) {
    const site = leaves.find(l => l.kind === 'site');
    if (!site) return { children: new Map() };
    const s = settings as Settings & { relief: number; hilliness: number; shore: Shore; river: boolean;
      riverWidth: number; flatWidth: number; ponds: number; cellSize: number };
    const footprint = site.geometry.footprint;
    const xs = footprint[0][0].map(p => p[0]);
    const size = Math.max(...xs) - Math.min(...xs);

    // 1. Water carves the site.
    const water = layoutWater({ size, rng, shore: s.shore, river: s.river, riverWidth: s.riverWidth });
    const course = water.river?.course ?? null;
    const profile = course ? riverProfile(course, s.relief, !!water.sea) : null;
    const land = difference(footprint, union(water.sea ?? [], water.river?.polygon ?? []));

    // 2–3. Cells, classification, regions.
    const cells = buildCells(land, footprint, water.sea, water.river?.polygon ?? null, s.cellSize, rng);
    const classified = classify(cells, { flatWidth: s.flatWidth, hilliness: s.hilliness, ponds: s.ponds }, rng);
    const groups = mergeRegions(cells, classified);

    // This stage's own overrides shape its output: flat elevation, matched by anchor.
    const overrides: { group: number; elevation: number }[] = [];
    for (const o of overridesForStage) {
      const e = o.settings.elevation;
      if (o.kind !== 'flat' || typeof e !== 'number') continue;
      const gi = groups.findIndex(g => g.kind === 'flat' && g.cells.some(ci => containsPoint([cells[ci].poly], o.anchor)));
      if (gi >= 0) overrides.push({ group: gi, elevation: Math.max(1, Math.round(e)) });
    }

    // 4. Elevations.
    const levels = computeLevels(cells, classified, groups, {
      relief: s.relief, hilliness: s.hilliness, flatWidth: s.flatWidth, course, profile,
      sea: water.sea, river: water.river?.polygon ?? null, overrides,
    }, rng);
    const vertexElevation = (p: Point2) => levels.vertex.get(vkey(p));

    // 5. Regions with their ground surfaces.
    const out: RegionNode[] = [];
    const node = (name: string, kind: string, fp: MultiPolygon, attrs: RegionNode['attrs'], data: NonNullable<RegionNode['data']>): RegionNode => ({
      id: childId(site.id, name), name, kind, stage: 'terrain', geometry: makeSlab(fp), attrs, children: [],
      data, dataStage: Object.fromEntries(Object.keys(data).map(k => [k, 'terrain'])),
    });

    if (water.sea && area(water.sea) > 0) {
      const coast = water.coastline!;
      const ground = constrainedSurface(water.sea, p => vertexElevation(p) ?? -SEA_DEPTH * Math.min(1, distToLine(p, coast) / (0.15 * size)), []);
      out.push(node('sea', 'sea', water.sea, { water: 'salt', flow: 'still', surface: 0 }, { ground }));
    }
    if (water.river && course && profile && area(water.river.polygon) > 0) {
      const surf = (p: Point2) => riverSurfaceAt(course, profile, p);
      const bed: [number, number, number][] = course.map((p, i) => [p[0], p[1], profile[i] - RIVER_DEPTH]);
      const ground = constrainedSurface(water.river.polygon, p => vertexElevation(p) ?? surf(p) + 0.5, bed);
      out.push(node('river', 'river', water.river.polygon,
        { water: 'fresh', flow: 'flowing', width: s.riverWidth, sourceSurface: profile[0], mouthSurface: profile[profile.length - 1] },
        { ground, course, profile }));
    }

    const counters = { flat: 0, slope: 0, hills: 0, pond: 0 };
    for (const g of groups) {
      const polys = g.cells.map(ci => cells[ci].poly);
      const fp = polys.length === 1 ? [polys[0]] : union(polys, []);
      const interior: [number, number, number][] = [];
      for (const ci of g.cells) {
        interior.push([cells[ci].seed[0], cells[ci].seed[1], levels.centre[ci]]);
        for (const ring of cells[ci].poly) for (const p of ring) interior.push([p[0], p[1], vertexElevation(p) ?? levels.centre[ci]]);
      }
      const fallback = (p: Point2) => {
        // A footprint vertex the union created (rare): nearest member corner's elevation.
        let best = levels.centre[g.cells[0]], bd = Infinity;
        for (const q of interior) { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d < bd) { bd = d; best = q[2]; } }
        return best;
      };
      const ground = constrainedSurface(fp, p => vertexElevation(p) ?? fallback(p), interior);
      const name = `${g.kind}:${counters[g.kind]++}`;
      if (g.kind === 'pond') {
        out.push(node(name, 'pond', fp, { water: 'fresh', flow: 'still', surface: r1(levels.pondSurface[g.cells[0]]!) }, { ground }));
      } else if (g.kind === 'flat') {
        const lv = g.cells.map(ci => levels.flatLevel[ci]!);
        out.push(node(name, 'flat', fp, {
          elevation: Math.round(lv.reduce((a, b) => a + b, 0) / lv.length),
          coastal: g.flatType === 'coastal', riverFlat: g.flatType === 'river',
        }, { ground }));
      } else {
        out.push(node(name, g.kind, fp, surfaceStats(ground), { ground }));
      }
    }

    return {
      children: new Map([[site.id, out]]),
      data: new Map([[site.id, { stats: { pondsPlaced: counters.pond, pondsRequested: s.ponds, cells: cells.length } }]]),
    };
  },
};
