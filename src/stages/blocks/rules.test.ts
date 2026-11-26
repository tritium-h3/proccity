import { describe, expect, it } from 'vitest';
import { DISTRICT_ZONES, FACES, familyOf, USES, ZONES, zoneWeight } from './rules.js';

describe('block rules', () => {
  it('copies the notes: Financial is office towers with optional apartments', () => {
    expect(DISTRICT_ZONES.financial).toEqual(['UO', 'UCO', 'UCOR']);
  });

  it('never lets a purely residential zone face an arterial', () => {
    for (const z of ZONES) if (USES[z].length === 1 && USES[z][0] === 'R') expect(FACES[z], z).not.toContain('A');
  });

  it('weights zones by their uses', () => {
    expect(zoneWeight('suburban', 'LR')).toBeGreaterThan(zoneWeight('suburban', 'LC'));
    expect(zoneWeight('financial', 'UO')).toBeGreaterThan(zoneWeight('financial', 'UCOR'));
    expect(zoneWeight('financial', 'UCOR')).toBeGreaterThan(0);
    expect(zoneWeight('urban', 'MR')).toBe(zoneWeight('low-urban', 'MR'));
  });

  it('has two spacing families', () => {
    expect(familyOf('rural')).toBe('sparse');
    expect(familyOf('suburban')).toBe('sparse');
    expect(familyOf('urban')).toBe('dense');
    expect(familyOf('town-core')).toBe('dense');
  });
});
