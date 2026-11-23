import { describe, it, expect } from 'vitest';
import { allowedOn, budgets, mainCentreType, mayBorder, RANK, TYPES } from './rules.js';

describe('district rules', () => {
  it('has a symmetric neighbour table', () => {
    for (const a of TYPES) for (const b of TYPES) expect(mayBorder(a, b), `${a}/${b}`).toBe(mayBorder(b, a));
  });

  it('matches the agreed table', () => {
    expect(mayBorder('rural', 'financial')).toBe(false);
    expect(mayBorder('suburban', 'low-urban')).toBe(false);
    expect(mayBorder('town-core', 'low-urban')).toBe(true);
    expect(mayBorder('rural', 'town-business')).toBe(true);
    expect(mayBorder('rural', 'low-urban')).toBe(false);
    expect(mayBorder('undeveloped', 'financial')).toBe(true);
    expect(mayBorder('town-core', 'urban')).toBe(false);
  });

  it('ranks types from undeveloped to financial', () => {
    expect(TYPES.map(t => RANK[t])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps dense types off slopes and everything off hills', () => {
    expect(allowedOn('town-business', 'slope')).toBe(false);
    expect(allowedOn('town-core', 'slope')).toBe(true);
    expect(allowedOn('rural', 'hills')).toBe(false);
    expect(allowedOn('undeveloped', 'hills')).toBe(true);
    expect(allowedOn('financial', 'flat')).toBe(true);
  });

  it('scales budgets with growth', () => {
    expect(budgets(0).financial).toBe(0);
    expect(budgets(1).urban).toBeCloseTo(0.16);
    expect(budgets(0.5).rural).toBe(Infinity);
    expect(budgets(0.5)['town-business']).toBeCloseTo(0.13);
  });

  it('picks the main centre type from growth', () => {
    expect(mainCentreType(0.5)).toBe('financial');
    expect(mainCentreType(0.3)).toBe('financial');
    expect(mainCentreType(0.25)).toBe('urban');
    expect(mainCentreType(0.15)).toBe('low-urban');
    expect(mainCentreType(0.05)).toBe('town-core');
  });
});
