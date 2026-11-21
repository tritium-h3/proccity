// The pipeline: prune everything from `fromStage` on, then run stages
// fromStage … generatedThrough in order, resolving each stage's overrides as
// it goes. Pure; runs in the worker. A generator so the worker can yield
// between stages and abandon superseded work.

import { createSite } from '../doc/create.js';
import { ancestry, attachChildren, findById, leaves, pruneStages, walk } from '../doc/tree.js';
import type { CityDoc, Override, RegionNode } from '../doc/types.js';
import { checkPartition } from '../grammar/partition.js';
import { defaultsFor, resolveAttr } from '../stages/settings.js';
import type { Stage } from '../stages/types.js';
import { resolveOverrides, type DroppedOverride } from './overrides.js';
import { createRng, stageSeed } from './seeds.js';

export interface GenerateRequest { doc: CityDoc; fromStage: number; stages: Stage[]; devChecks?: boolean }
export interface GenerateResult {
  tree: RegionNode; overrides: Override[]; dropped: DroppedOverride[]; partitionProblems: string[];
}

export function* generateIter(req: GenerateRequest): Generator<{ stageIndex: number }, GenerateResult> {
  const { doc, stages, devChecks = false } = req;
  const from = Math.max(req.fromStage, 0);
  let tree = req.fromStage <= 0
    ? createSite(doc.site.size)
    : pruneStages(doc.tree, new Set(stages.slice(from).map(s => s.id)));

  const stageIndex = new Map(stages.map((s, i) => [s.id, i]));
  // Overrides for stages we won't run stay as they are; processed stages replace theirs.
  let overrides = doc.overrides.filter(o => {
    const i = stageIndex.get(o.stage);
    return i === undefined || i < from || i > doc.generatedThrough;
  });
  const dropped: DroppedOverride[] = [];
  const partitionProblems: string[] = [];

  for (let i = from; i <= doc.generatedThrough && i < stages.length; i++) {
    yield { stageIndex: i };
    const stage = stages[i];
    const state = doc.stages.find(s => s.id === stage.id);
    const settings = { ...defaultsFor(stage.settings), ...state?.settings };
    const current = tree;
    const out = stage.run({
      tree: current,
      leaves: leaves(current),
      settings,
      rng: createRng(stageSeed(doc.seed, stage.id, state?.seedOffset ?? 0)),
      attr: (node, key) => resolveAttr(ancestry(current, node.id), key, settings),
    });
    tree = attachChildren(tree, out.children);

    const created: RegionNode[] = [];
    for (const parentId of out.children.keys()) {
      for (const child of findById(tree, parentId)!.children) walk(child, n => { if (n.stage === stage.id) created.push(n); });
    }
    const res = resolveOverrides(stage, created, doc.overrides);
    for (const [nodeId, settingsApplied] of res.applied) Object.assign(findById(tree, nodeId)!.attrs, settingsApplied);
    overrides = [...overrides, ...res.kept.filter(o => o.stage === stage.id)];
    dropped.push(...res.dropped);

    if (devChecks) {
      for (const [parentId, kids] of out.children) {
        const parent = findById(tree, parentId)!;
        const check = (p: RegionNode, ks: RegionNode[]) => {
          for (const problem of checkPartition(p.geometry, ks.map(k => k.geometry)).problems) partitionProblems.push(`${p.id}: ${problem}`);
          for (const k of ks) if (k.children.length) check(k, k.children);
        };
        check(parent, kids);
      }
    }
  }

  return { tree, overrides, dropped, partitionProblems };
}

export function generate(req: GenerateRequest): GenerateResult {
  const it = generateIter(req);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
  }
}
