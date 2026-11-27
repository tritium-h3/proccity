import { FORMAT, type CityDoc } from './types.js';
import { decodeHeights } from './heightfield.js';

export class CityDocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CityDocError';
  }
}

// Hand-written structural checks: enough to refuse files that aren't a
// proccity city of this format, with a message naming where it went wrong.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSetting = (v: unknown) => ['number', 'string', 'boolean'].includes(typeof v);

function fail(path: string, what: string): never {
  throw new CityDocError(`Not a valid city: ${path} ${what}`);
}

function checkSettings(v: unknown, path: string) {
  if (!isObj(v)) fail(path, 'should be an object');
  for (const [k, x] of Object.entries(v)) if (!isSetting(x)) fail(`${path}.${k}`, 'should be a number, string or boolean');
}

function checkPoint(v: unknown, path: string) {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(n => typeof n === 'number' && Number.isFinite(n))) fail(path, 'should be [x, z]');
}

function checkNode(v: unknown, path: string) {
  if (!isObj(v)) fail(path, 'should be an object');
  for (const k of ['id', 'name', 'kind', 'stage'] as const) if (typeof v[k] !== 'string') fail(`${path}.${k}`, 'should be a string');
  const g = v.geometry;
  if (!isObj(g) || g.type !== 'slab') fail(`${path}.geometry`, "should be a slab (type 'slab')");
  if (!Array.isArray(g.footprint)) fail(`${path}.geometry.footprint`, 'should be an array');
  g.footprint.forEach((poly: unknown, i: number) => {
    if (!Array.isArray(poly)) fail(`${path}.geometry.footprint[${i}]`, 'should be an array of rings');
    poly.forEach((ring: unknown, j: number) => {
      if (!Array.isArray(ring)) fail(`${path}.geometry.footprint[${i}][${j}]`, 'should be an array of points');
      ring.forEach((p: unknown, k: number) => checkPoint(p, `${path}.geometry.footprint[${i}][${j}][${k}]`));
    });
  });
  const h = g.height;
  if (!isObj(h) || h.ref !== 'ground' || typeof h.low !== 'number' || !(h.high === null || typeof h.high === 'number')) {
    fail(`${path}.geometry.height`, "should be { ref: 'ground', low: number, high: number | null }");
  }
  checkSettings(v.attrs, `${path}.attrs`);
  if (v.data !== undefined) {
    if (!isObj(v.data)) fail(`${path}.data`, 'should be an object');
    const hf = v.data.heightfield;
    if (hf !== undefined) {
      const at = `${path}.data.heightfield`;
      if (!isObj(hf) || typeof hf.cell !== 'number' || !Number.isInteger(hf.cols) || !Number.isInteger(hf.rows) || typeof hf.heights !== 'string') {
        fail(at, 'should be { origin, cell, cols, rows, heights }');
      }
      checkPoint(hf.origin, `${at}.origin`);
      let n = -1;
      try { n = decodeHeights(hf.heights).length; } catch { /* reported below */ }
      if (n !== (hf.cols as number) * (hf.rows as number)) fail(at, `heights should hold cols × rows = ${(hf.cols as number) * (hf.rows as number)} values`);
    }
    if (v.data.course !== undefined) {
      if (!Array.isArray(v.data.course)) fail(`${path}.data.course`, 'should be an array of points');
      v.data.course.forEach((p: unknown, i: number) => checkPoint(p, `${path}.data.course[${i}]`));
    }
    if (v.data.ground !== undefined) {
      const gr = v.data.ground, at = `${path}.data.ground`;
      if (!isObj(gr) || !Array.isArray(gr.points) || !Array.isArray(gr.triangles)) fail(at, 'should be { points, triangles }');
      const n = gr.points.length;
      gr.points.forEach((p: unknown, i: number) => {
        if (!Array.isArray(p) || p.length !== 3 || !p.every(x => typeof x === 'number' && Number.isFinite(x))) fail(`${at}.points[${i}]`, 'should be [x, z, elevation]');
      });
      gr.triangles.forEach((t: unknown, i: number) => {
        if (!Array.isArray(t) || t.length !== 3 || !t.every(x => Number.isInteger(x) && x >= 0 && x < n)) fail(`${at}.triangles[${i}]`, `should be three point indices below ${n}`);
      });
    }
    if (v.data.profile !== undefined) {
      if (!Array.isArray(v.data.profile) || !v.data.profile.every((x: unknown) => typeof x === 'number')) fail(`${path}.data.profile`, 'should be an array of numbers');
    }
    if (v.data.roads !== undefined) {
      const at = `${path}.data.roads`;
      if (!Array.isArray(v.data.roads)) fail(at, 'should be an array of roads');
      v.data.roads.forEach((r: unknown, i: number) => {
        if (!isObj(r) || typeof r.id !== 'string' || typeof r.exit !== 'boolean' || !Array.isArray(r.points)) fail(`${at}[${i}]`, 'should be { id, points, exit }');
        (r.points as unknown[]).forEach((p, j) => checkPoint(p, `${at}[${i}].points[${j}]`));
      });
    }
    if (v.data.streets !== undefined) {
      const at = `${path}.data.streets`;
      if (!Array.isArray(v.data.streets)) fail(at, 'should be an array of streets');
      v.data.streets.forEach((r: unknown, i: number) => {
        if (!isObj(r) || typeof r.id !== 'string' || (r.category !== 'C' && r.category !== 'L') || typeof r.width !== 'number' || !Array.isArray(r.points) || (r.route !== undefined && typeof r.route !== 'string')) fail(`${at}[${i}]`, 'should be { id, points, category, width, route? }');
        (r.points as unknown[]).forEach((p, j) => checkPoint(p, `${at}[${i}].points[${j}]`));
      });
    }
    if (v.data.blockStats !== undefined) {
      if (!isObj(v.data.blockStats) || !Object.values(v.data.blockStats).every(x => typeof x === 'number')) fail(`${path}.data.blockStats`, 'should map names to numbers');
    }
    if (v.data.lotStats !== undefined) {
      if (!isObj(v.data.lotStats) || !Object.values(v.data.lotStats).every(x => typeof x === 'number')) fail(`${path}.data.lotStats`, 'should map names to numbers');
    }
    if (v.data.subdistrictStats !== undefined) {
      if (!isObj(v.data.subdistrictStats) || !Object.values(v.data.subdistrictStats).every(x => typeof x === 'number')) fail(`${path}.data.subdistrictStats`, 'should map names to numbers');
    }
    if (v.data.stats !== undefined) {
      if (!isObj(v.data.stats) || !Object.values(v.data.stats).every(x => typeof x === 'number')) fail(`${path}.data.stats`, 'should map names to numbers');
    }
  }
  if (!Array.isArray(v.children)) fail(`${path}.children`, 'should be an array');
  v.children.forEach((c: unknown, i: number) => checkNode(c, `${path}.children[${i}]`));
}

export function parseCityDoc(json: unknown): CityDoc {
  if (!isObj(json)) fail('document', 'should be an object');
  if (json.format !== FORMAT) fail('format', `should be '${FORMAT}' (got ${JSON.stringify(json.format)})`);
  for (const k of ['id', 'name', 'createdAt', 'modifiedAt'] as const) if (typeof json[k] !== 'string') fail(k, 'should be a string');
  if (typeof json.seed !== 'number') fail('seed', 'should be a number');
  if (!isObj(json.site) || typeof json.site.size !== 'number') fail('site.size', 'should be a number');
  if (typeof json.generatedThrough !== 'number') fail('generatedThrough', 'should be a number');
  if (!Array.isArray(json.stages)) fail('stages', 'should be an array');
  json.stages.forEach((s: unknown, i: number) => {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.seedOffset !== 'number') fail(`stages[${i}]`, 'should have id and seedOffset');
    checkSettings(s.settings, `stages[${i}].settings`);
  });
  if (!Array.isArray(json.overrides)) fail('overrides', 'should be an array');
  json.overrides.forEach((o: unknown, i: number) => {
    if (!isObj(o)) fail(`overrides[${i}]`, 'should be an object');
    for (const k of ['id', 'stage', 'kind', 'createdAt'] as const) if (typeof o[k] !== 'string') fail(`overrides[${i}].${k}`, 'should be a string');
    checkPoint(o.anchor, `overrides[${i}].anchor`);
    checkSettings(o.settings, `overrides[${i}].settings`);
  });
  if (json.tree === undefined) fail('tree', 'is missing');
  checkNode(json.tree, 'tree');
  return json as unknown as CityDoc;
}
