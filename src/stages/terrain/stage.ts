// The terrain stage: water and flats first (layout.ts), then a height map shaped around
// them, then the site divided into sea / river / pond / flat / slope / hills regions.
//
// Heights: pin the features (sea floor, river bed, pond beds, flats, inland edges), solve
// the smoothest surface through the pins, then add noise faded by distance from the
// features, so flats stay exact and the land eases into every feature.

import { childId } from '../../doc/tree.js';
import { makeHeightfield } from '../../doc/heightfield.js';
import type { MultiPolygon, Point2, Polygon, RegionNode, Settings } from '../../doc/types.js';
import { difference, intersect, offsetPolygons, union } from '../../grammar/clipper.js';
import { marchingSquares, simplify } from '../../grammar/contour.js';
import { area, bounds, containsPoint } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import type { Stage } from '../types.js';
import { distanceTo, fbm, gridFor, rasterize, solveHarmonic, steepness, type Grid } from './field.js';
import { layoutTerrain, type Shore } from './layout.js';

const SEA_DEPTH = 15;      // m below sea level at the site edge
const RIVER_DEPTH = 3;     // m from river surface to bed
const POND_DEPTH = 2;      // m from pond surface to bed
const FADE = 120;          // m over which noise fades in away from features
const MIN_LAND = 0.5;      // m: land never dips to/below sea level
const SPECK = 2000;        // m²: slope/hills pieces smaller than this merge into a neighbour
const BANK = 0.5;          // m: land beside a river or pond stays at least this far above its surface

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Bilinear lookup on a grid array. */
function at(g: Grid, a: Float32Array, p: Point2): number {
  const x = Math.min(Math.max((p[0] - g.origin[0]) / g.cell, 0), g.cols - 1);
  const z = Math.min(Math.max((p[1] - g.origin[1]) / g.cell, 0), g.rows - 1);
  const x0 = Math.min(Math.floor(x), g.cols - 2), z0 = Math.min(Math.floor(z), g.rows - 2);
  const tx = x - x0, tz = z - z0, k = z0 * g.cols + x0;
  return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - tz) + (a[k + g.cols] * (1 - tx) + a[k + g.cols + 1] * tx) * tz;
}

/** Index of the course vertex nearest each grid point in `mask` (−1 elsewhere). */
function nearestCourseIndex(g: Grid, mask: Uint8Array, course: Point2[]): Int32Array {
  const out = new Int32Array(mask.length).fill(-1);
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    const x = g.origin[0] + (k % g.cols) * g.cell, z = g.origin[1] + Math.floor(k / g.cols) * g.cell;
    let best = 0, bd = Infinity;
    for (let i = 0; i < course.length; i++) {
      const d = (course[i][0] - x) ** 2 + (course[i][1] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    out[k] = best;
  }
  return out;
}

/** Which site edges are "inland" (pinned high): not the shore, and not where a shoreless river exits. */
function inlandEdges(shore: Shore, mouth: Point2 | undefined, h: number): Set<string> {
  const edges = new Set(['north', 'east', 'south', 'west']);
  if (shore !== 'none') edges.delete(shore);
  else if (mouth) {
    const e = Math.abs(mouth[0]) > Math.abs(mouth[1]) ? (mouth[0] > 0 ? 'east' : 'west') : (mouth[1] > 0 ? 'south' : 'north');
    if (Math.max(Math.abs(mouth[0]), Math.abs(mouth[1])) > h - 1) edges.delete(e);
  }
  return edges;
}

function stats(g: Grid, h: Float32Array, steep: Float32Array, poly: MultiPolygon) {
  const m = rasterize(g, poly);
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  m.forEach((v, k) => { if (v) { min = Math.min(min, h[k]); max = Math.max(max, h[k]); sum += steep[k]; n++; } });
  if (!n) { // smaller than a grid cell: sample its first vertex
    const p = poly[0][0][0];
    const v = at(g, h, p);
    return { minElevation: round(v), maxElevation: round(v), meanSteepness: round(at(g, steep, p)) };
  }
  return { minElevation: round(min), maxElevation: round(max), meanSteepness: round(sum / n) };
}
const round = (v: number) => Math.round(v * 10) / 10;

export const terrain: Stage = {
  id: 'terrain',
  title: 'Terrain',
  settings: [
    { key: 'relief', label: 'Relief', type: 'number', min: 20, max: 400, step: 10, default: 150, unit: 'm', help: 'Height range across the site' },
    { key: 'ruggedness', label: 'Ruggedness', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5, help: 'How much the ground between features undulates' },
    { key: 'shore', label: 'Shore', type: 'choice', default: 'south', options: [
      { value: 'none', label: 'None' }, { value: 'north', label: 'North' }, { value: 'east', label: 'East' },
      { value: 'south', label: 'South' }, { value: 'west', label: 'West' }] },
    { key: 'coastWiggle', label: 'Coast wiggle', type: 'number', min: 0, max: 1, step: 0.05, default: 0.4 },
    { key: 'river', label: 'River', type: 'boolean', default: true },
    { key: 'riverWidth', label: 'River width', type: 'number', min: 10, max: 120, step: 5, default: 40, unit: 'm' },
    { key: 'meander', label: 'Meander', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5 },
    { key: 'ponds', label: 'Ponds', type: 'number', min: 0, max: 5, step: 1, default: 2 },
    { key: 'flats', label: 'Flats', type: 'number', min: 1, max: 4, step: 1, default: 2 },
    { key: 'flatSize', label: 'Flat size', type: 'number', min: 100, max: 600, step: 25, default: 300, unit: 'm' },
    { key: 'hillsThreshold', label: 'Hills threshold', type: 'number', min: 5, max: 35, step: 1, default: 15, unit: '°', help: 'Steepness at which slope becomes hills' },
  ],
  overridable: {
    flat: [{ key: 'elevation', label: 'Elevation', type: 'number', min: 1, max: 400, step: 1, default: 3, unit: 'm' }],
  },

  run({ leaves, settings, rng, overridesForStage }) {
    const children = new Map<string, RegionNode[]>();
    const data = new Map<string, NonNullable<RegionNode['data']>>();
    const site = leaves.find(l => l.kind === 'site');
    if (!site) return { children };
    const s = settings as Settings & { relief: number; ruggedness: number; shore: Shore; coastWiggle: number; river: boolean;
      riverWidth: number; meander: number; ponds: number; flats: number; flatSize: number; hillsThreshold: number };

    const b = bounds(site.geometry.footprint);
    const size = b.maxX - b.minX, half = size / 2;
    const layout = layoutTerrain({ size, rng, shore: s.shore, coastWiggle: s.coastWiggle, river: s.river, riverWidth: s.riverWidth,
      meander: s.meander, flats: s.flats, flatSize: s.flatSize, ponds: s.ponds });
    const g = gridFor(size);
    const N = g.cols * g.rows;

    // Flat elevations: the first just above the waterline, later ones stepping inland and up.
    // "Just above the waterline" only makes sense beside water; on a dry site every flat steps.
    const wet = !!(layout.sea || layout.river);
    const elevations = layout.flats.map((_, n) => {
      if (n === 0 && wet) return 3;
      const lo = wet ? 3 : 0.2 * s.relief;
      const t = wet ? n / Math.max(1, layout.flats.length - 1) : (n + 1) / layout.flats.length;
      // Whole metres: the elevation override is a step-1 slider, and an off-step value
      // snaps in the browser and comes back as a spurious edit.
      return Math.round((lo + (0.7 * s.relief - lo) * t) * (1 + (rng() - 0.5) * 0.2));
    });
    // This stage's own overrides shape its output: apply elevation overrides before pinning.
    for (const o of overridesForStage) {
      const e = o.settings.elevation;
      if (o.kind !== 'flat' || typeof e !== 'number') continue;
      const idx = layout.flats.findIndex(f => containsPoint(f, o.anchor));
      // Not clamped to relief: the ground must match the elevation the region reports.
      if (idx >= 0) elevations[idx] = Math.max(1, Math.round(e));
    }

    const seaM = layout.sea ? rasterize(g, layout.sea) : new Uint8Array(N);
    const riverM = layout.river ? rasterize(g, layout.river.polygon) : new Uint8Array(N);
    const pondMs = layout.ponds.map(p => rasterize(g, p));
    const flatMs = layout.flats.map(f => rasterize(g, f));

    // Sea floor: 0 at the coast falling to −SEA_DEPTH over 15 % of the site.
    const landM = new Uint8Array(N);
    for (let k = 0; k < N; k++) landM[k] = seaM[k] ? 0 : 1;
    const fromLand = distanceTo(g, landM);

    const edges = inlandEdges(s.shore, layout.river?.course.at(-1), half);
    // Inland edges rise to full relief only away from the sea: pinning them at full height
    // right beside the coast made a cliff where the shoreline meets a side edge.
    const fromSea = layout.sea ? distanceTo(g, seaM) : null;
    const edgeHeight = (k: number) => s.relief * (fromSea ? Math.max(0.1, smoothstep(0, 0.45 * size, fromSea[k])) : 1);
    // Edge points near a flat or pond stay free, so the ground eases from the feature up to the
    // edge; pinning them at full relief beside a low flat made a vertical wall.
    const nearFeatureM = new Uint8Array(N);
    for (const m of [...flatMs, ...pondMs]) m.forEach((v, k) => { if (v) nearFeatureM[k] = 1; });
    const fromFlatOrPond = distanceTo(g, nearFeatureM);
    const EDGE_CLEAR = 1.5 * FADE;
    const onEdge = (k: number) => {
      const i = k % g.cols, j = Math.floor(k / g.cols);
      if (fromFlatOrPond[k] < EDGE_CLEAR) return false;
      return (edges.has('west') && i === 0) || (edges.has('east') && i === g.cols - 1)
        || (edges.has('north') && j === 0) || (edges.has('south') && j === g.rows - 1);
    };

    const pinBase = () => {
      const pinned = new Uint8Array(N), values = new Float32Array(N);
      for (let k = 0; k < N; k++) {
        if (seaM[k]) { pinned[k] = 1; values[k] = -SEA_DEPTH * Math.min(1, fromLand[k] / (0.15 * size)); }
        else if (onEdge(k)) { pinned[k] = 1; values[k] = edgeHeight(k); }
      }
      flatMs.forEach((m, n) => m.forEach((v, k) => { if (v) { pinned[k] = 1; values[k] = elevations[n]; } }));
      return { pinned, values };
    };

    // Pass 1, without river and ponds, sets their source/surface levels from the land around them.
    const p1 = pinBase();
    const base1 = solveHarmonic(g, p1.pinned, p1.values);
    // River surface: never above the land it runs through. Walking downstream, it is the
    // lowest ground met so far (minus a margin), capped below any flat it passes, and 0 at
    // the coast. (A straight linear descent ignored the land and left rivers perched
    // tens of metres above the flats beside them.)
    let profile: number[] = [];
    if (layout.river) {
      const caps = layout.flats.map((f, n) => ({ zone: offsetPolygons(f, s.riverWidth / 2 + 24), cap: elevations[n] - 1 }));
      let running = Infinity;
      profile = layout.river.course.map(p => {
        let v = at(g, base1, p) - 1.5;
        for (const c of caps) if (containsPoint(c.zone, p)) v = Math.min(v, c.cap);
        running = Math.min(running, v);
        return round(Math.max(0, running));
      });
      if (layout.sea) profile[profile.length - 1] = 0;
    }
    const sourceSurface = profile[0] ?? 0;
    // Pond level: the lowest point of its rim, so it can't spill over the downhill side.
    const pondSurfaces = layout.ponds.map(p => {
      const rim = Math.min(...p[0][0].map(pt => at(g, base1, pt)));
      return round(Math.max(MIN_LAND + POND_DEPTH, rim - BANK));
    });

    // Pass 2, everything pinned.
    const { pinned, values } = pinBase();
    const riverIdx = layout.river ? nearestCourseIndex(g, riverM, layout.river.course) : new Int32Array(N).fill(-1);
    riverM.forEach((v, k) => { if (v && !seaM[k]) { pinned[k] = 1; values[k] = profile[riverIdx[k]] - RIVER_DEPTH; } });
    pondMs.forEach((m, n) => m.forEach((v, k) => { if (v) { pinned[k] = 1; values[k] = pondSurfaces[n] - POND_DEPTH; } }));
    const baseH = solveHarmonic(g, pinned, values);

    // Noise, faded in with distance from the features (not from inland edges).
    const feature = new Uint8Array(N);
    for (let k = 0; k < N; k++) feature[k] = seaM[k] || riverM[k] ? 1 : 0;
    for (const m of [...pondMs, ...flatMs]) m.forEach((v, k) => { if (v) feature[k] = 1; });
    const fromFeature = distanceTo(g, feature);
    const noise = fbm(g, rng, 600, 5);
    const amp = s.ruggedness * 0.25 * s.relief;
    const h = new Float32Array(N);
    const waterM = new Uint8Array(N);
    for (let k = 0; k < N; k++) waterM[k] = seaM[k] || riverM[k] ? 1 : 0;
    for (const m of pondMs) m.forEach((v, k) => { if (v) waterM[k] = 1; });
    for (let k = 0; k < N; k++) {
      h[k] = pinned[k] && !onEdge(k) ? baseH[k] : baseH[k] + noise[k] * amp * smoothstep(0, FADE, fromFeature[k]);
      if (!waterM[k] && h[k] < MIN_LAND) h[k] = MIN_LAND;
    }
    // Banks: land within two grid steps of a river or pond stays above its surface.
    const flatAny = new Uint8Array(N);
    for (const m of flatMs) m.forEach((v, k) => { if (v) flatAny[k] = 1; });
    const surf = new Float32Array(N).fill(NaN);
    riverM.forEach((v, k) => { if (v && !seaM[k]) surf[k] = profile[riverIdx[k]]; });
    pondMs.forEach((m, n) => m.forEach((v, k) => { if (v) surf[k] = pondSurfaces[n]; }));
    for (let k = 0; k < N; k++) {
      if (Number.isNaN(surf[k])) continue;
      const i = k % g.cols, j = Math.floor(k / g.cols);
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= g.cols || jj >= g.rows) continue;
        const kk = jj * g.cols + ii;
        if (waterM[kk] || flatAny[kk]) continue;
        if (h[kk] < surf[k] + BANK) h[kk] = surf[k] + BANK;
      }
    }

    // Division into regions.
    const site0 = site.geometry.footprint;
    const water = union(union(layout.sea ?? [], layout.river?.polygon ?? []), union(layout.ponds.flat(), []));
    const land = difference(site0, water);
    const rest = difference(land, union(layout.flats.flat(), []));

    const steep = steepness(g, h);
    const mask = new Float32Array(N);
    for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) {
      let sum = 0, n = 0; // 3×3 box blur of the steep/not-steep mask
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= g.cols || jj >= g.rows) continue;
        sum += steep[jj * g.cols + ii] > s.hillsThreshold ? 1 : 0; n++;
      }
      mask[j * g.cols + i] = sum / n;
    }
    const steepPolys: MultiPolygon = marchingSquares(mask, g.cols, g.rows, 0.5, g.origin, g.cell)
      .map(poly => poly.map(ring => simplify(ring, 2)));
    let hills = steepPolys.length ? intersect(rest, union(steepPolys, [])) : [];
    let slope = difference(rest, hills);
    // Specks: merge each piece under SPECK into the touching slope/hills piece it shares the
    // most boundary with (whole pieces move, so the partition holds). Pieces under 1 m² with
    // no neighbour are Clipper noise and are dropped; other isolated specks remain.
    // A merged region may hold several polygons: Clipper can leave a hair-width gap between
    // pieces that share an edge, so their union comes back as two polygons.
    type Piece = { kind: 'slope' | 'hills'; mp: MultiPolygon; a: number };
    let pieces: Piece[] = [
      ...slope.map((p: Polygon) => ({ kind: 'slope' as const, mp: [p], a: area([p]) })),
      ...hills.map((p: Polygon) => ({ kind: 'hills' as const, mp: [p], a: area([p]) })),
    ];
    for (let merged = true; merged;) {
      merged = false;
      for (const sp of [...pieces].sort((x, y) => x.a - y.a)) {
        if (sp.a >= SPECK) break;
        const grown = offsetPolygons(sp.mp, 0.5);
        let best: Piece | null = null, shared = 0.01;
        for (const o of pieces) {
          if (o === sp) continue;
          const sh = area(intersect(grown, o.mp));
          if (sh > shared) { shared = sh; best = o; }
        }
        if (best) {
          const u = union(best.mp, sp.mp);
          best.mp = u;
          best.a = area(u);
          pieces = pieces.filter(pc => pc !== sp);
          merged = true;
          break;
        }
        if (sp.a < 1) { pieces = pieces.filter(pc => pc !== sp); merged = true; break; }
      }
    }
    const slopeRegions = pieces.filter(pc => pc.kind === 'slope').map(pc => pc.mp);
    const hillsRegions = pieces.filter(pc => pc.kind === 'hills').map(pc => pc.mp);

    const out: RegionNode[] = [];
    const node = (name: string, kind: string, footprint: MultiPolygon, attrs: RegionNode['attrs'], extra?: RegionNode['data']): RegionNode => ({
      id: childId(site.id, name), name, kind, stage: 'terrain', geometry: makeSlab(footprint), attrs, children: [],
      ...(extra ? { data: extra, dataStage: Object.fromEntries(Object.keys(extra).map(key => [key, 'terrain'])) } : {}),
    });
    if (layout.sea && area(layout.sea) > 0) out.push(node('sea', 'sea', layout.sea, { water: 'salt', flow: 'still', surface: 0 }));
    if (layout.river && area(layout.river.polygon) > 0) {
      out.push(node('river', 'river', layout.river.polygon, { water: 'fresh', flow: 'flowing', width: s.riverWidth, sourceSurface, mouthSurface: profile[profile.length - 1] },
        { course: layout.river.course, profile }));
    }
    layout.ponds.forEach((p, n) => out.push(node(`pond:${n}`, 'pond', p, { water: 'fresh', flow: 'still', surface: pondSurfaces[n] })));
    layout.flats.forEach((f, n) => out.push(node(`flat:${n}`, 'flat', f, { elevation: elevations[n] })));
    slopeRegions.forEach((mp, n) => out.push(node(`slope:${n}`, 'slope', mp, stats(g, h, steep, mp))));
    hillsRegions.forEach((mp, n) => out.push(node(`hills:${n}`, 'hills', mp, stats(g, h, steep, mp))));

    children.set(site.id, out);
    data.set(site.id, {
      heightfield: makeHeightfield(g.origin, g.cell, g.cols, g.rows, h),
      stats: { pondsPlaced: layout.ponds.length, pondsRequested: s.ponds },
    });
    return { children, data };
  },
};
