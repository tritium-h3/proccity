import { describe, it, expect, vi } from 'vitest';
import { createCityDoc } from '../doc/create.js';
import { CityDocError } from '../doc/validate.js';
import { cityToJson, importCity, importCityAndSave } from './file.js';

const doc = createCityDoc({ name: 'My City', stages: [], seed: 1, now: '2026-11-20T00:00:00.000Z', id: 'orig' });

describe('JSON files', () => {
  it('imports an exported city under a new id', () => {
    const out = importCity(cityToJson(doc), 'new', '2026-11-21T00:00:00.000Z');
    expect(out).toEqual({ ...doc, id: 'new', modifiedAt: '2026-11-21T00:00:00.000Z' });
  });

  it('refuses broken and foreign files without saving anything', async () => {
    const save = vi.fn(async () => {});
    await expect(importCityAndSave('{not json', { save, newId: 'n', now: 't' })).rejects.toThrow(CityDocError);
    const old = JSON.stringify({ ...doc, format: 'proccity/0' });
    await expect(importCityAndSave(old, { save, newId: 'n', now: 't' })).rejects.toThrow(CityDocError);
    expect(save).not.toHaveBeenCalled();
  });

  it('saves a valid import', async () => {
    const save = vi.fn(async () => {});
    const out = await importCityAndSave(cityToJson(doc), { save, newId: 'n', now: 't' });
    expect(save).toHaveBeenCalledWith(out);
  });
});
