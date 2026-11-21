import { describe, it, expect } from 'vitest';
import type { RegionNode } from '../doc/types.js';
import { defaultsFor, isValidValue, resolveAttr } from './settings.js';
import type { SettingField, SettingsSchema } from './types.js';

const num: SettingField = { key: 'n', label: 'N', type: 'number', min: 0, max: 10, step: 1, default: 3 };
const choice: SettingField = { key: 'c', label: 'C', type: 'choice', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' };
const bool: SettingField = { key: 'b', label: 'B', type: 'boolean', default: true };
const schema: SettingsSchema = [num, choice, bool];

const n = (attrs: RegionNode['attrs']): RegionNode => ({
  id: 'x', name: 'x', kind: 'x', stage: 's', attrs, children: [],
  geometry: { type: 'slab', footprint: [], height: { ref: 'ground', low: 0, high: null } },
});

describe('settings', () => {
  it('collects defaults', () => {
    expect(defaultsFor(schema)).toEqual({ n: 3, c: 'a', b: true });
  });

  it('validates values against their field', () => {
    expect(isValidValue(num, 5)).toBe(true);
    expect(isValidValue(num, 11)).toBe(false);
    expect(isValidValue(num, '5')).toBe(false);
    expect(isValidValue(choice, 'b')).toBe(true);
    expect(isValidValue(choice, 'z')).toBe(false);
    expect(isValidValue(bool, false)).toBe(true);
    expect(isValidValue(bool, 1)).toBe(false);
  });

  it('resolves attributes: own > parent > grandparent > stage setting', () => {
    const chain = [n({ k: 'grand', g: 1 }), n({ k: 'parent' }), n({ k: 'own' })];
    expect(resolveAttr(chain, 'k', { k: 'stage' })).toBe('own');
    expect(resolveAttr(chain.slice(0, 2), 'k', { k: 'stage' })).toBe('parent');
    expect(resolveAttr(chain, 'g', {})).toBe(1);
    expect(resolveAttr(chain, 's', { s: 'stage' })).toBe('stage');
    expect(resolveAttr(chain, 'missing', {})).toBeUndefined();
  });
});
