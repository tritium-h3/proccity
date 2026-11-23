// Main-thread side of the generation worker. Only the latest request's result
// is ever delivered; anything older resolves as 'superseded'.

import type { CityDoc } from '../doc/types.js';
import type { GenerateResult } from './generate.js';
import { createLatestGate } from './gate.js';
import type { WorkerReply, WorkerRequest } from './protocol.js';

export type GenerateOutcome =
  | { status: 'done'; result: GenerateResult }
  | { status: 'superseded' }
  | { status: 'error'; message: string };

export interface GeneratorClient {
  run(doc: CityDoc, fromStage: number, onProgress?: (stageIndex: number) => void): Promise<GenerateOutcome>;
  dispose(): void;
}

export function createGeneratorClient(): GeneratorClient {
  const gate = createLatestGate();
  const pending = new Map<number, { resolve: (o: GenerateOutcome) => void; onProgress?: (i: number) => void }>();

  const settle = (ticket: number, outcome: GenerateOutcome) => {
    pending.get(ticket)?.resolve(outcome);
    pending.delete(ticket);
  };

  // A worker only checks for newer requests between stages, so a stale run inside one long
  // stage (arterials on a big site can take tens of seconds) kept running and queued every
  // later request behind it. A run still in flight is now killed and the worker replaced.
  let worker: Worker;
  const start = () => {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = onMessage;
    worker.onerror = onError;
  };
  const onMessage = (e: MessageEvent<WorkerReply>) => {
    const msg = e.data;
    if (!gate.isLatest(msg.ticket)) return settle(msg.ticket, { status: 'superseded' });
    switch (msg.type) {
      case 'progress': pending.get(msg.ticket)?.onProgress?.(msg.stageIndex); break;
      case 'done': settle(msg.ticket, { status: 'done', result: msg.result }); break;
      case 'error': settle(msg.ticket, { status: 'error', message: msg.message }); break;
      case 'abandoned': settle(msg.ticket, { status: 'superseded' }); break;
    }
  };
  const onError = (e: ErrorEvent) => {
    for (const ticket of pending.keys()) settle(ticket, { status: 'error', message: e.message || 'generation worker crashed' });
  };
  start();

  return {
    run(doc, fromStage, onProgress) {
      const ticket = gate.next();
      if (pending.size) { worker.terminate(); start(); }
      for (const older of [...pending.keys()]) settle(older, { status: 'superseded' });
      return new Promise(resolve => {
        pending.set(ticket, { resolve, onProgress });
        worker.postMessage({ type: 'generate', ticket, doc, fromStage } satisfies WorkerRequest);
      });
    },
    dispose() {
      for (const ticket of [...pending.keys()]) settle(ticket, { status: 'superseded' });
      worker.terminate();
    },
  };
}
