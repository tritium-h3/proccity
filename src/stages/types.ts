// The stage contract. A stage divides the leaves it is given; it is pure
// (no DOM, no Three.js) so it can run in the generation worker. How a stage's
// regions look lives in src/scene/renderers/, keyed by stage id.

import type { Override, RegionData, RegionNode, SettingValue, Settings } from '../doc/types.js';

interface FieldBase { key: string; label: string; help?: string }

export type SettingField =
  | (FieldBase & { type: 'number'; min: number; max: number; step: number; default: number; unit?: string })
  | (FieldBase & { type: 'choice'; options: { value: string; label: string }[]; default: string })
  | (FieldBase & { type: 'boolean'; default: boolean });

export type SettingsSchema = SettingField[];

export interface StageInput {
  /** read-only: the tree as earlier stages left it */
  tree: RegionNode;
  /** nodes this stage may subdivide */
  leaves: RegionNode[];
  settings: Settings;
  /** seeded per stage */
  rng: () => number;
  /** resolveAttr bound to this tree and these settings */
  attr(node: RegionNode, key: string): SettingValue | undefined;
  /** this stage's overrides, before resolution: for stages whose overrides shape their own output */
  overridesForStage: Override[];
}

export interface StageOutput {
  /** parent id → new children (which may carry their own subtrees) */
  children: Map<string, RegionNode[]>;
  /** node id → bulky data to attach to an existing region (e.g. the site's height map) */
  data?: Map<string, RegionData>;
}

export interface Stage {
  /** stable; used in documents, seeds and node.stage */
  id: string;
  title: string;
  settings: SettingsSchema;
  /** node kind → local settings it accepts as overrides */
  overridable?: Record<string, SettingsSchema>;
  run(input: StageInput): StageOutput;
}
