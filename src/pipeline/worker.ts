// Generation worker. Runs the pipeline off the main thread, yielding between
// stages so a newer request can arrive; once one has, the older run is abandoned.

import { STAGES } from '../stages/index.js';
import { generateIter } from './generate.js';
import type { WorkerReply, WorkerRequest } from './protocol.js';

const post = (msg: WorkerReply) => (self as unknown as { postMessage(m: WorkerReply): void }).postMessage(msg);
let newest = 0;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { ticket, doc, fromStage } = e.data;
  newest = Math.max(newest, ticket);
  try {
    const it = generateIter({ doc, fromStage, stages: STAGES, devChecks: import.meta.env.DEV });
    for (;;) {
      await new Promise(r => setTimeout(r, 0)); // let newer messages in
      if (ticket !== newest) return post({ type: 'abandoned', ticket });
      const step = it.next();
      if (step.done) return post({ type: 'done', ticket, result: step.value });
      post({ type: 'progress', ticket, stageIndex: step.value.stageIndex });
    }
  } catch (err) {
    post({ type: 'error', ticket, message: err instanceof Error ? err.message : String(err) });
  }
};
