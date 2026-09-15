import { KIT, PrefabBuilder, subtractRects, type Range } from "../kit";
import type { Axis2, BuildingMaterialId } from "../types";

/**
 * Shared pieces of the Vietnamese city prefabs (`vnHouses.ts`, `vnCivic.ts`, `vnCommercial.ts`).
 *
 * - Loot follows the tube-house rule: rooms get a 0.12 m raised floor except round their doors, under props that stand
 *   on the slab, and round a few kept loot spots (loot spots need bare floor). A big hall holds 1–3 spots, not 40.
 * - Nav keeps at most 4 walkable levels per column (MAX_SPANS_PER_COLUMN), so tall buildings have enterable lower
 *   floors and a solid body above them, dressed with facade layers thinner than the nav support width (0.12 m).
 */

export type Rect = { readonly x: Range; readonly z: Range };
export type Point2 = readonly [x: number, z: number];

export const WALL = { exterior: "plaster", interior: "plasterInterior", frame: "darkSteel" } as const;
export const H = KIT.storyHeight;
export const CEILING = H - KIT.slabThickness;
export const T = KIT.wallThickness;
export const RAISED = 0.12;
/** Clear floor in front of both faces of a door (a standing capsule's depth plus the frame). */
export const DOOR_APRON = 0.9;
/** Facade layers stay under the nav grid's minimum support width, so they never add walkable levels. */
export const SKIN = 0.1;

const SPOT_SPACING = 1.5;
const SPOT_INSET = 0.6;

/** Loot spot centers along one room axis, as `getPrefabLootSpots` lays them out. */
export function spotAxis(lo: number, hi: number): number[] {
  const span = hi - lo - 2 * SPOT_INSET;
  if (span < 0) return [];
  const count = Math.floor(span / SPOT_SPACING) + 1;
  const start = lo + SPOT_INSET + (span - (count - 1) * SPOT_SPACING) / 2;
  return Array.from({ length: count }, (_, i) => start + i * SPOT_SPACING);
}

/** Floor kept clear on both sides (or one) of a door: `u` is the clear opening along `axis`, `across` the wall faces. */
export function doorAprons(axis: Axis2, u: Range, across: Range, sides: "both" | "min" | "max" = "both"): Rect[] {
  const f = KIT.frame.width + 0.01;
  const along: Range = [u[0] - f, u[1] + f];
  const out: Rect[] = [];
  const bands: Range[] = [];
  if (sides !== "max") bands.push([across[0] - DOOR_APRON, across[0]]);
  if (sides !== "min") bands.push([across[1], across[1] + DOOR_APRON]);
  for (const band of bands) out.push(axis === "x" ? { x: along, z: band } : { x: band, z: along });
  return out;
}

/**
 * Declares a room and tiles it with the raised floor, leaving bare floor under `holes` (door aprons, props standing on
 * the slab) and round the loot spot nearest each of `keeps`.
 */
export function lootRoom(b: PrefabBuilder, id: string, y0: number, room: Rect, holes: readonly Rect[], keeps: readonly Point2[], indoor = true, material: BuildingMaterialId = "concrete"): void {
  const spots: [number, number][] = [];
  for (const x of spotAxis(room.x[0], room.x[1])) for (const z of spotAxis(room.z[0], room.z[1])) spots.push([x, z]);
  const kept: [number, number][] = [];
  for (const [kx, kz] of keeps) {
    let best: [number, number] | null = null;
    let bestDistance = Infinity;
    for (const s of spots) {
      if (kept.includes(s)) continue;
      const d = (s[0] - kx) ** 2 + (s[1] - kz) ** 2;
      if (d < bestDistance) [best, bestDistance] = [s, d];
    }
    if (best) kept.push(best);
  }
  const rects = holes.map((h) => ({ u0: h.x[0], u1: h.x[1], v0: h.z[0], v1: h.z[1] }));
  // ±0.41 rather than a round 0.4 keeps tile edges off the nav grid's 0.25 m cell centers.
  for (const [x, z] of kept) rects.push({ u0: x - 0.41, u1: x + 0.41, v0: z - 0.41, v1: z + 0.41 });
  for (const r of subtractRects({ u0: room.x[0], u1: room.x[1], v0: room.z[0], v1: room.z[1] }, rects)) {
    if (r.u1 - r.u0 < 0.05 || r.v1 - r.v0 < 0.05) continue;
    b.box([r.u0, r.u1], [y0, y0 + RAISED], [r.v0, r.v1], material, "floor");
  }
  b.room(id, y0, room.x, room.z, indoor);
}

/** Parapet (or low wall) round a rectangle: ±z pieces span the full width, ±x pieces fit between. */
export function parapetRing(b: PrefabBuilder, x: Range, z: Range, y: number, height: number, thickness: number = T, material: BuildingMaterialId = "plaster"): void {
  const yr: Range = [y, y + height];
  b.box(x, yr, [z[1] - thickness, z[1]], material, "railing");
  b.box(x, yr, [z[0], z[0] + thickness], material, "railing");
  b.box([x[1] - thickness, x[1]], yr, [z[0] + thickness, z[1] - thickness], material, "railing");
  b.box([x[0], x[0] + thickness], yr, [z[0] + thickness, z[1] - thickness], material, "railing");
}

/**
 * A skin layer `SKIN` thick round a solid block's four sides (the block itself is inset by `SKIN`): alternating spandrel
 * and window bands per floor, for towers whose upper floors are a closed body.
 */
export function facadeBands(b: PrefabBuilder, x: Range, z: Range, y: Range, floor: number, windowFrom: number, wall: BuildingMaterialId, glass: BuildingMaterialId): void {
  const floors = Math.round((y[1] - y[0]) / floor);
  for (let k = 0; k < floors; k++) {
    const y0 = y[0] + k * floor;
    const y1 = k === floors - 1 ? y[1] : y0 + floor;
    const split = y0 + windowFrom;
    for (const [band, material] of [
      [[y0, split], wall],
      [[split, y1], glass],
    ] as const) {
      b.box(x, band, [z[1] - SKIN, z[1]], material, "wall");
      b.box(x, band, [z[0], z[0] + SKIN], material, "wall");
      b.box([x[1] - SKIN, x[1]], band, [z[0] + SKIN, z[1] - SKIN], material, "wall");
      b.box([x[0], x[0] + SKIN], band, [z[0] + SKIN, z[1] - SKIN], material, "wall");
    }
  }
}

/** Vertical fins on the outside of a facade skin (`x`, `z` are the skin's outer faces), each `SKIN` wide and deep. */
export function facadeFins(b: PrefabBuilder, x: Range, z: Range, y: Range, spacing: number, material: BuildingMaterialId): void {
  const along = (lo: number, hi: number): number[] => {
    const n = Math.max(1, Math.round((hi - lo) / spacing));
    return Array.from({ length: n - 1 }, (_, i) => lo + ((hi - lo) * (i + 1)) / n);
  };
  const h = SKIN / 2;
  for (const c of along(x[0], x[1])) {
    b.box([c - h, c + h], y, [z[1], z[1] + SKIN], material, "structure");
    b.box([c - h, c + h], y, [z[0] - SKIN, z[0]], material, "structure");
  }
  for (const c of along(z[0], z[1])) {
    b.box([x[1], x[1] + SKIN], y, [c - h, c + h], material, "structure");
    b.box([x[0] - SKIN, x[0]], y, [c - h, c + h], material, "structure");
  }
}
