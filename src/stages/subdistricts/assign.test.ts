import { describe, expect, it } from 'vitest';
import { assignSteps, type SubInfo } from './assign.js';

const sub = (o: Partial<SubInfo>): SubInfo => ({ type: 'rural', district: 'd', field: 1, arterial: true, draw: 0.99, ...o, local: o.local ?? o.field ?? 1 });

describe('step assignment', () => {
  it('takes the field’s step within the type, or the pin', () => {
    const r = assignSteps([sub({ type: 'urban', field: 9 }), sub({ type: 'urban', field: 6.2 }), sub({ type: 'urban', field: 9, pin: 6 })], [[1], [0, 2], [1]], 1);
    expect(r.steps).toEqual([8, 6, 6]);
  });
  it('picks no open land when Open land is 0', () => {
    const r = assignSteps([sub({ draw: 0 }), sub({ draw: 0 })], [[1], [0]], 0);
    expect(r.steps).toEqual([1, 1]);
  });
  it('keeps the last developed sub-district of a district', () => {
    const r = assignSteps([sub({ draw: 0 }), sub({ draw: 0 }), sub({ draw: 0 })], [[1], [0, 2], [1]], 1);
    expect(r.steps).toEqual([0, 0, 1]);
    expect(r.openRefused).toBe(1);
  });
  it('refuses an open pick that would cut a developed one off from the arterials', () => {
    // A (arterial) – B – C: B open would leave C with no way out.
    const subs = [sub({ draw: 0.99 }), sub({ arterial: false, draw: 0 }), sub({ arterial: false, draw: 0.99 })];
    const r = assignSteps(subs, [[1], [0, 2], [1]], 1);
    expect(r.steps).toEqual([1, 1, 1]);
    expect(r.openRefused).toBe(1);
  });
  it('honours a pin to Undeveloped even when it cuts a neighbour off', () => {
    const subs = [sub({}), sub({ arterial: false, pin: 0 }), sub({ arterial: false })];
    expect(assignSteps(subs, [[1], [0, 2], [1]], 1).steps).toEqual([1, 0, 1]);
  });
  it('never leaves Financial open unpinned', () => {
    const r = assignSteps([sub({ type: 'financial', field: 0, draw: 0 }), sub({ type: 'financial', field: 0, draw: 0 })], [[1], [0]], 2);
    expect(r.steps).toEqual([8, 8]);
  });
  it('opens more where the field is low', () => {
    const subs = [sub({ type: 'suburban', field: 2, draw: 0.2 }), sub({ type: 'suburban', field: 8, draw: 0.2 }), sub({ type: 'suburban', field: 3 })];
    expect(assignSteps(subs, [[1, 2], [0, 2], [0, 1]], 1).steps).toEqual([0, 4, 3]);
  });
});
