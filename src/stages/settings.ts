import type { RegionNode, SettingValue, Settings } from '../doc/types.js';
import type { SettingField, SettingsSchema } from './types.js';

export function defaultsFor(schema: SettingsSchema): Settings {
  return Object.fromEntries(schema.map(f => [f.key, f.default]));
}

export function isValidValue(field: SettingField, v: SettingValue): boolean {
  switch (field.type) {
    case 'number': return typeof v === 'number' && Number.isFinite(v) && v >= field.min && v <= field.max;
    case 'choice': return typeof v === 'string' && field.options.some(o => o.value === v);
    case 'boolean': return typeof v === 'boolean';
  }
}

/** Strongest first: the node's own attrs, then nearest ancestor's, then the stage setting. */
export function resolveAttr(ancestry: RegionNode[], key: string, stageSettings: Settings): SettingValue | undefined {
  for (let i = ancestry.length - 1; i >= 0; i--) {
    if (key in ancestry[i].attrs) return ancestry[i].attrs[key];
  }
  return stageSettings[key];
}
