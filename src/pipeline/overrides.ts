// Override resolution: after a stage runs, each of its overrides re-attaches to
// whichever created region of its kind covers its anchor point. If it can't
// land, it's dropped and reported (the editor shows a toast with Undo).

import type { Override, RegionNode, Settings } from '../doc/types.js';
import { containsPoint } from '../grammar/polygon.js';
import { isValidValue } from '../stages/settings.js';
import type { Stage } from '../stages/types.js';

export type DropReason = 'no-region' | 'invalid-setting' | 'superseded';
export interface DroppedOverride { override: Override; reason: DropReason; detail: string }
export interface Resolution { applied: Map<string, Settings>; kept: Override[]; dropped: DroppedOverride[] }

const pairs = (s: Settings) => Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(', ');

export function resolveOverrides(stage: Stage, created: RegionNode[], overrides: Override[]): Resolution {
  const kept: Override[] = [];
  const dropped: DroppedOverride[] = [];
  const mine = overrides.filter(o => o.stage === stage.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const landed = new Map<string, Override[]>(); // node id → overrides on it, oldest first

  for (const o of mine) {
    const under = created.filter(n => containsPoint(n.geometry.footprint, o.anchor));
    const candidates = under.filter(n => n.kind === o.kind).sort((a, b) => a.geometry.height.low - b.geometry.height.low);
    const node = candidates[0];
    if (!node) {
      dropped.push({ override: o, reason: 'no-region', detail: under[0]?.kind ?? '' });
      continue;
    }
    const schema = stage.overridable?.[node.kind] ?? [];
    const bad = Object.entries(o.settings).find(([k, v]) => {
      const field = schema.find(f => f.key === k);
      return !field || !isValidValue(field, v);
    });
    if (bad) {
      dropped.push({ override: o, reason: 'invalid-setting', detail: `${bad[0]}: ${bad[1]}` });
      continue;
    }
    landed.set(node.id, [...(landed.get(node.id) ?? []), o]);
  }

  const applied = new Map<string, Settings>();
  const survivors = new Set<Override>();
  for (const [nodeId, list] of landed) {
    // Newest first: an override loses if a newer one already claimed any of its keys.
    const claimed = new Set<string>();
    for (const o of [...list].reverse()) {
      const keys = Object.keys(o.settings);
      if (keys.some(k => claimed.has(k))) {
        dropped.push({ override: o, reason: 'superseded', detail: '' });
        continue;
      }
      keys.forEach(k => claimed.add(k));
      survivors.add(o);
    }
    const merged: Settings = {};
    for (const o of list) if (survivors.has(o)) Object.assign(merged, o.settings);
    applied.set(nodeId, merged);
  }

  for (const o of overrides) if (o.stage !== stage.id || survivors.has(o)) kept.push(o);
  return { applied, kept, dropped };
}

export function describeDrop(d: DroppedOverride): string {
  const k = d.override.kind;
  const s = pairs(d.override.settings);
  switch (d.reason) {
    case 'no-region':
      return d.detail
        ? `Dropped "${s}" on a ${k}: that spot is now a ${d.detail}.`
        : `Dropped "${s}" on a ${k}: there's no ${k} at that spot any more.`;
    case 'invalid-setting':
      return `Dropped "${s}" on a ${k}: that ${k} doesn't accept ${d.detail}.`;
    case 'superseded':
      return `Dropped "${s}" on a ${k}: a newer override on the same ${k} replaced it.`;
  }
}
