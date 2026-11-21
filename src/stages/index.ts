import { debugGrid } from './debug-grid/stage.js';
import { debugSplit } from './debug-split/stage.js';
import type { Stage } from './types.js';

/** Every stage, in pipeline order. Adding a stage: one module + one line here + a renderer. */
export const STAGES: Stage[] = [debugGrid, debugSplit];
