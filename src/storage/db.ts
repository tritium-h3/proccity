// Cities live in IndexedDB: `cities` holds whole documents, `index` holds the
// small { id, name, modifiedAt } rows the city list needs.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CityDoc } from '../doc/types.js';

export interface CityIndexEntry { id: string; name: string; modifiedAt: string }

interface ProccityDB extends DBSchema {
  cities: { key: string; value: CityDoc };
  index: { key: string; value: CityIndexEntry };
}

let dbPromise: Promise<IDBPDatabase<ProccityDB>> | null = null;
const db = () => (dbPromise ??= openDB<ProccityDB>('proccity', 1, {
  upgrade(d) {
    d.createObjectStore('cities', { keyPath: 'id' });
    d.createObjectStore('index', { keyPath: 'id' });
  },
}));

const entryOf = (doc: CityDoc): CityIndexEntry => ({ id: doc.id, name: doc.name, modifiedAt: doc.modifiedAt });

export async function listCities(): Promise<CityIndexEntry[]> {
  const all = await (await db()).getAll('index');
  return all.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function loadCity(id: string): Promise<CityDoc | undefined> {
  return (await db()).get('cities', id);
}

export async function saveCity(doc: CityDoc): Promise<void> {
  const tx = (await db()).transaction(['cities', 'index'], 'readwrite');
  await Promise.all([tx.objectStore('cities').put(doc), tx.objectStore('index').put(entryOf(doc)), tx.done]);
}

export async function deleteCity(id: string): Promise<void> {
  const tx = (await db()).transaction(['cities', 'index'], 'readwrite');
  await Promise.all([tx.objectStore('cities').delete(id), tx.objectStore('index').delete(id), tx.done]);
}

export async function renameCity(id: string, name: string): Promise<void> {
  const doc = await loadCity(id);
  if (doc) await saveCity({ ...doc, name });
}

const LAST_KEY = 'proccity:lastCity';
export function getLastCityId(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}
export function setLastCityId(id: string): void {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* storage unavailable: just don't remember */ }
}
