import { terrain } from './terrain/stage.js';
import type { Stage } from './types.js';

/** Every stage, in pipeline order. Adding a stage: one module + one line here + a renderer. */
export const STAGES: Stage[] = [terrain];
