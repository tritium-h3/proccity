// The city document: the unit of saving, undo and export. Plain JSON.
// Every region is a volume (a terrain-hugging slab); see the foundation design.

export type SettingValue = number | string | boolean;
export type Settings = Record<string, SettingValue>;

/** A ground point, [x, z], in metres. */
export type Point2 = [number, number];
export type Ring = Point2[];
/** [outer ring (CCW), ...holes (CW)] */
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

/** Metres above the ground beneath each point. `high: null` = open to the sky. */
export interface HeightRange { ref: 'ground'; low: number; high: number | null }

export interface Slab { type: 'slab'; footprint: MultiPolygon; height: HeightRange }

export type Geometry = Slab;

/** A height map: metres ABOVE SEA LEVEL on a regular grid (slab heights stay above-ground). */
export interface Heightfield {
  /** x, z of grid point (0, 0): the site's min corner */
  origin: Point2;
  /** metres between grid points */
  cell: number;
  cols: number;
  rows: number;
  /** base64 of a little-endian Float32Array, row-major (z, then x) */
  heights: string;
}

/** Bulky per-region data a stage may attach (to its own regions, or to existing ones). */
export interface RegionData {
  heightfield?: Heightfield;
  /** a centreline, e.g. a river's course from source to mouth */
  course?: Point2[];
  /** a value per course point, e.g. the river's surface elevation (m above sea level) */
  profile?: number[];
  /** numbers a stage reports about a region (e.g. the terrain's pondsPlaced) */
  stats?: Record<string, number>;
}

export interface RegionNode {
  /** path from the root, e.g. 'site/district:3/block:14' */
  id: string;
  /** last path segment, unique among siblings */
  name: string;
  kind: string;
  /** id of the stage that created this node ('site' for the root) */
  stage: string;
  geometry: Geometry;
  /** what this node *is*: values set on it, including applied overrides */
  attrs: Settings;
  children: RegionNode[];
  data?: RegionData;
  /** which stage wrote each data key, so pruning that stage removes it */
  dataStage?: Partial<Record<keyof RegionData, string>>;
}

export interface StageState { id: string; settings: Settings; seedOffset: number }

export interface Override {
  id: string;
  /** the stage whose output it targets */
  stage: string;
  kind: string;
  /** ground point where the user made it */
  anchor: Point2;
  settings: Settings;
  createdAt: string;
}

export interface CityDoc {
  format: 'proccity/1';
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  seed: number;
  site: { size: number };
  stages: StageState[];
  /** index of the last generated stage; -1 = none */
  generatedThrough: number;
  overrides: Override[];
  tree: RegionNode;
}

export const FORMAT = 'proccity/1';
export const SITE_ID = 'site';
