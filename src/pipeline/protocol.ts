import type { CityDoc } from '../doc/types.js';
import type { GenerateResult } from './generate.js';

export type WorkerRequest = { type: 'generate'; ticket: number; doc: CityDoc; fromStage: number };

export type WorkerReply =
  | { type: 'progress'; ticket: number; stageIndex: number }
  | { type: 'done'; ticket: number; result: GenerateResult }
  | { type: 'error'; ticket: number; message: string }
  | { type: 'abandoned'; ticket: number };
