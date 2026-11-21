// Download / open a city as a JSON file: the most direct "reproducible" save,
// and the path to a Blender export later.

import type { CityDoc } from '../doc/types.js';
import { CityDocError, parseCityDoc } from '../doc/validate.js';

export function cityToJson(doc: CityDoc): string {
  return JSON.stringify(doc, null, 2);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'city';

export function downloadCity(doc: CityDoc): void {
  const url = URL.createObjectURL(new Blob([cityToJson(doc)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug(doc.name)}.proccity.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Parse and validate; the import becomes a new city. Throws CityDocError. */
export function importCity(text: string, newId: string, now: string): CityDoc {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CityDocError("Not a valid city: the file isn't JSON");
  }
  return { ...parseCityDoc(json), id: newId, modifiedAt: now };
}

/** Import then save; nothing is written unless the file validates. */
export async function importCityAndSave(
  text: string,
  deps: { save: (doc: CityDoc) => Promise<void>; newId: string; now: string },
): Promise<CityDoc> {
  const doc = importCity(text, deps.newId, deps.now);
  await deps.save(doc);
  return doc;
}

export function readFileText(file: File): Promise<string> {
  return file.text();
}
