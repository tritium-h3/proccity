// Usable space: the land a district keeps after the roads are cut out must not be slivers. A
// piece is a sliver if it's narrower than the usable width (it vanishes when shrunk by half of
// it) or tiny (under the usable width squared). "Under a quarter of its district" flagged
// usable corners a road clipped off. A road along a district's edge leaves no piece.

import type { MultiPolygon } from '../../doc/types.js';
import { difference, offsetPolygons } from '../../grammar/clipper.js';
import { area } from '../../grammar/polygon.js';

export function slivers(district: MultiPolygon, roads: MultiPolygon, usableWidth: number): MultiPolygon[] {
  return difference(district, roads)
    .map(poly => [poly])
    .filter(piece => area(piece) < usableWidth * usableWidth || area(offsetPolygons(piece, -usableWidth / 2)) === 0);
}
