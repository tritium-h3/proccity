import { arterials } from './arterials/stage.js';
import { blocks } from './blocks/stage.js';
import { districts } from './districts/stage.js';
import { subdistricts } from './subdistricts/stage.js';
import { terrain } from './terrain/stage.js';
import type { Stage } from './types.js';

/** Every stage, in pipeline order. Adding a stage: one module + one line here + a renderer. */
export const STAGES: Stage[] = [terrain, districts, arterials, subdistricts, blocks];
