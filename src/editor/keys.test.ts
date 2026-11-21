import { describe, it, expect } from 'vitest';
import { isTextEntry } from './keys.js';

const el = (tagName: string, type?: string, isContentEditable = false) => ({ tagName, type, isContentEditable });

describe('isTextEntry (review: Important 4)', () => {
  it('lets undo through on sliders, checkboxes and selects', () => {
    expect(isTextEntry(el('INPUT', 'range'))).toBe(false);
    expect(isTextEntry(el('INPUT', 'checkbox'))).toBe(false);
    expect(isTextEntry(el('SELECT'))).toBe(false);
    expect(isTextEntry(el('BUTTON'))).toBe(false);
  });
  it('blocks it in text fields', () => {
    expect(isTextEntry(el('INPUT', 'text'))).toBe(true);
    expect(isTextEntry(el('INPUT', 'number'))).toBe(true);
    expect(isTextEntry(el('INPUT', ''))).toBe(true);
    expect(isTextEntry(el('TEXTAREA'))).toBe(true);
    expect(isTextEntry(el('DIV', undefined, true))).toBe(true);
  });
});
