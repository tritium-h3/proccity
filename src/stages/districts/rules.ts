// What a district may be: its types, the neighbour table agreed with the owner, which terrain
// each type may sit on, and the share of land each type may take at a given Growth. Density
// must change gradually through the city, so the table only allows steps of a notch or two.

export const TYPES = ['undeveloped', 'rural', 'suburban', 'town-core', 'town-business', 'low-urban', 'urban', 'financial'] as const;
export type DistrictType = typeof TYPES[number];
export type TerrainKind = 'flat' | 'slope' | 'hills';

export const RANK = Object.fromEntries(TYPES.map((t, i) => [t, i])) as Record<DistrictType, number>;

export const TYPE_LABEL: Record<DistrictType, string> = {
  undeveloped: 'Undeveloped', rural: 'Rural', suburban: 'Suburban', 'town-core': 'Town core',
  'town-business': 'Town business', 'low-urban': 'Low urban', urban: 'Urban', financial: 'Financial',
};

// Symmetric; undeveloped borders anything (but see fill.ts: a narrow undeveloped patch
// doesn't hide a jump between the districts on either side).
const TABLE: Record<Exclude<DistrictType, 'undeveloped'>, DistrictType[]> = {
  rural: ['rural', 'suburban', 'town-core', 'town-business'],
  suburban: ['rural', 'suburban', 'town-core', 'town-business'],
  'town-core': ['rural', 'suburban', 'town-core', 'town-business', 'low-urban'],
  'town-business': ['rural', 'suburban', 'town-core', 'town-business', 'low-urban', 'urban'],
  'low-urban': ['town-core', 'town-business', 'low-urban', 'urban', 'financial'],
  urban: ['town-business', 'low-urban', 'urban', 'financial'],
  financial: ['low-urban', 'urban', 'financial'],
};

export function mayBorder(a: DistrictType, b: DistrictType): boolean {
  if (a === 'undeveloped' || b === 'undeveloped') return true;
  return TABLE[a].includes(b);
}

const ON_SLOPE = new Set<DistrictType>(['undeveloped', 'rural', 'suburban', 'town-core']);

export function allowedOn(t: DistrictType, terrain: TerrainKind): boolean {
  if (terrain === 'hills') return t === 'undeveloped';
  if (terrain === 'slope') return ON_SLOPE.has(t);
  return true;
}

/** Largest share of land area each type may take at growth g (0–1); Infinity = uncapped. */
export function budgets(g: number): Record<DistrictType, number> {
  return {
    undeveloped: Infinity, rural: Infinity, suburban: 0.35, 'town-core': 0.15,
    'town-business': 0.08 + 0.1 * g, 'low-urban': 0.2 * g, urban: 0.16 * g, financial: 0.06 * g,
  };
}

/** The main centre's type: one district can exceed the Financial cap at moderate growth, so
 *  it's set by growth directly (the centre is placed outside the budgets). */
export function mainCentreType(g: number): DistrictType {
  return g >= 0.3 ? 'financial' : g >= 0.2 ? 'urban' : g >= 0.1 ? 'low-urban' : 'town-core';
}
