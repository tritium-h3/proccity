import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { createCityDoc } from '../doc/create.js';
import { deleteCity, listCities, loadCity, renameCity, saveCity } from './db.js';

const city = (id: string, modifiedAt: string) => ({
  ...createCityDoc({ name: `City ${id}`, stages: [], seed: 1, now: '2026-11-20T00:00:00.000Z', id }),
  modifiedAt,
});

describe('city database', () => {
  it('lists newest first, loads, renames and deletes', async () => {
    await saveCity(city('a', '2026-11-20T01:00:00.000Z'));
    await saveCity(city('b', '2026-11-20T02:00:00.000Z'));
    expect((await listCities()).map(c => c.id)).toEqual(['b', 'a']);
    expect(await loadCity('a')).toEqual(city('a', '2026-11-20T01:00:00.000Z'));

    await renameCity('a', 'Renamed');
    expect((await loadCity('a'))?.name).toBe('Renamed');
    expect((await listCities()).find(c => c.id === 'a')?.name).toBe('Renamed');

    await deleteCity('a');
    expect(await loadCity('a')).toBeUndefined();
    expect((await listCities()).map(c => c.id)).toEqual(['b']);
  });
});
