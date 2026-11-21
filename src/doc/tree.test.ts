import { describe, it, expect } from 'vitest';
import type { RegionNode } from './types.js';
import { ancestry, attachChildren, findById, leaves, pruneStages } from './tree.js';

const node = (id: string, stage: string, children: RegionNode[] = []): RegionNode => ({
  id,
  name: id.split('/').pop()!,
  kind: id.split('/').pop()!.split(':')[0],
  stage,
  geometry: { type: 'slab', footprint: [], height: { ref: 'ground', low: 0, high: null } },
  attrs: {},
  children,
});

const fixture = () =>
  node('site', 'site', [
    node('site/a:0', 'a'),
    node('site/a:1', 'a', [node('site/a:1/b:0', 'b')]),
  ]);

describe('tree utilities', () => {
  it('lists leaves in depth-first order', () => {
    expect(leaves(fixture()).map(n => n.id)).toEqual(['site/a:0', 'site/a:1/b:0']);
  });

  it('returns the ancestry from root to node, or [] when missing', () => {
    expect(ancestry(fixture(), 'site/a:1/b:0').map(n => n.id)).toEqual(['site', 'site/a:1', 'site/a:1/b:0']);
    expect(ancestry(fixture(), 'site/nope')).toEqual([]);
  });

  it('finds nodes by id', () => {
    expect(findById(fixture(), 'site/a:1')?.kind).toBe('a');
    expect(findById(fixture(), 'site/zzz')).toBeUndefined();
  });

  it('prunes nodes of the given stages without mutating the input', () => {
    const root = fixture();
    const pruned = pruneStages(root, new Set(['b']));
    expect(findById(pruned, 'site/a:1/b:0')).toBeUndefined();
    expect(findById(root, 'site/a:1/b:0')).toBeDefined();
  });

  it('attaches children without mutating the input', () => {
    const root = fixture();
    const out = attachChildren(root, new Map([['site/a:0', [node('site/a:0/c:0', 'c')]]]));
    expect(findById(out, 'site/a:0/c:0')).toBeDefined();
    expect(findById(root, 'site/a:0/c:0')).toBeUndefined();
  });

  it('rejects an unknown parent', () => {
    expect(() => attachChildren(fixture(), new Map([['site/x', []]]))).toThrow(/unknown parent/);
  });
});
