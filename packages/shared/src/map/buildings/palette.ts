import { hash2 } from "../terrain/noise";

/**
 * Facade colours for the city houses. A placement's exterior `plaster` slot takes one of these, picked by a hash of its
 * world XZ, so the client needs no extra map data and the converter can check that neighbours differ. "plaster" keeps
 * the prefab's default look.
 */
export const FACADE_COLORS = ["plaster", "yellow", "mint", "pink", "sky", "white"] as const;
export type FacadeColor = (typeof FACADE_COLORS)[number];

const PALETTED = new Set<string>([
  "tube_house_2",
  "tube_house_3",
  "tube_house_4",
  "tube_house_narrow",
  "tube_house_wide",
  "tube_house_planters",
  "tube_house_shed",
  "tube_house_mezzanine",
  "shophouse_french",
  "cafe_terrace",
  "villa",
  "boarding_house",
  "shop_kiosk",
]);

/** Facade colour of a placed prefab, or null when the prefab keeps fixed looks. Positions are hashed to 0.1 m. */
export function facadeColor(prefabId: string, x: number, z: number): FacadeColor | null {
  if (!PALETTED.has(prefabId)) return null;
  return FACADE_COLORS[(hash2(Math.round(x * 10), Math.round(z * 10), 0xfa5c) >>> 0) % FACADE_COLORS.length]!;
}
