import type { RegionNode } from './types.js';

export function childId(parentId: string, name: string): string {
  return `${parentId}/${name}`;
}

export function walk(root: RegionNode, fn: (n: RegionNode) => void): void {
  fn(root);
  for (const c of root.children) walk(c, fn);
}

export function findById(root: RegionNode, id: string): RegionNode | undefined {
  return ancestry(root, id).at(-1);
}

/** Nodes from the root down to `id`, inclusive; [] when not found. */
export function ancestry(root: RegionNode, id: string): RegionNode[] {
  if (root.id === id) return [root];
  if (!id.startsWith(`${root.id}/`)) return [];
  for (const c of root.children) {
    const path = ancestry(c, id);
    if (path.length) return [root, ...path];
  }
  return [];
}

export function leaves(root: RegionNode): RegionNode[] {
  const out: RegionNode[] = [];
  walk(root, n => { if (n.children.length === 0) out.push(n); });
  return out;
}

/** Deep copy with every node created by one of `stageIds` removed. */
export function pruneStages(root: RegionNode, stageIds: Set<string>): RegionNode {
  return {
    ...structuredClone({ ...root, children: [] }),
    children: root.children.filter(c => !stageIds.has(c.stage)).map(c => pruneStages(c, stageIds)),
  };
}

/** Deep copy with `children` appended under their parents (keyed by parent id). */
export function attachChildren(root: RegionNode, children: Map<string, RegionNode[]>): RegionNode {
  const copy = structuredClone(root);
  for (const [parentId, kids] of children) {
    const parent = findById(copy, parentId);
    if (!parent) throw new Error(`unknown parent ${parentId}`);
    parent.children.push(...structuredClone(kids));
  }
  return copy;
}
