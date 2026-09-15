import { KIT, PrefabBuilder, subtractRects, type Range } from "../kit";
import type { BuildingPrefab } from "../types";

/**
 * Saigon tube houses (nhà ống): narrow, deep row houses with party walls (no side windows), a shopfront ground floor
 * with a roll-up door opening, one straight stair per story stacked in a stair core along the west wall, a front and a
 * back room on every floor, front balconies upstairs, and a flat, terrace or steep gable roof.
 *
 * - Nav: at most 4 walkable levels per column (MAX_SPANS_PER_COLUMN). So only the 3-story house has a walkable roof, its
 *   stair head roof is steeper than the walkable slope, and the 4-story house has a gable instead of a roof deck.
 * - Loot: rooms sit on a raised 0.12 m tiled floor except round their doors and one kept loot spot, so a row of these
 *   houses holds about one loot spot per room (loot spots need bare floor) and doesn't flood a city map with loot.
 */
export interface TubeHouseSpec {
  readonly id: string;
  readonly name: string;
  /** Outer width (street frontage) and depth, m. */
  readonly width: number;
  readonly depth: number;
  readonly stories: 2 | 3 | 4;
  readonly roof: "parapet" | "terrace" | "gable";
}

const WALL = { exterior: "plaster", interior: "plasterInterior", frame: "darkSteel" } as const;
const SMALL_WINDOW = { width: 0.8, sill: 1.5, head: 2.2 } as const;
const H = KIT.storyHeight;
const CEILING = H - KIT.slabThickness;
/** Stair core: flight start and top (z); 10 rises of 0.3 m on 0.3 m runs. */
const STAIR_FRONT = 1.35;
const STAIR_BACK = -1.35;
/** Wall between the front and back rooms (z), leaving a landing behind the stairs. */
const PARTITION: Range = [-2.65, -2.5];
const RAISED = 0.12;
const BALCONY_DEPTH = 1.0;
/** Loot spot grid of `getPrefabLootSpots` (1.5 m spacing, 0.6 m inset). */
const SPOT_SPACING = 1.5;
const SPOT_INSET = 0.6;
/** Clear floor kept in front of both faces of a door (a standing capsule's depth plus the frame). */
const DOOR_APRON = 0.9;

type Rect = { readonly x: Range; readonly z: Range };

export function tubeHouse(spec: TubeHouseSpec): BuildingPrefab {
  const b = new PrefabBuilder(spec.id, spec.name);
  const hw = spec.width / 2;
  const hd = spec.depth / 2;
  const t = KIT.wallThickness;
  const ix: Range = [-hw + t, hw - t];
  const iz: Range = [-hd + t, hd - t];
  const core: Range = [ix[0], ix[0] + KIT.stairs.width];
  const coreWall: Range = [core[1], core[1] + 0.1];
  const top = spec.stories * H;
  const shopDoor = Math.min(3, spec.width - 1.4);
  const innerDoorAt = ix[1] - 0.8;
  const innerDoor: Range = [innerDoorAt - KIT.interiorDoor.width / 2, innerDoorAt + KIT.interiorDoor.width / 2];
  const partitionAprons: Rect[] = [
    { x: innerDoor, z: [PARTITION[1], PARTITION[1] + DOOR_APRON] },
    { x: innerDoor, z: [PARTITION[0] - DOOR_APRON, PARTITION[0]] },
  ];

  b.foundation([-hw, hw], [-hd, hd], "concrete");

  for (let story = 0; story < spec.stories; story++) {
    const y0 = story * H;
    const balconyDoor: Range = [hw - 1.1 - KIT.door.width / 2, hw - 1.1 + KIT.door.width / 2];
    const front =
      story === 0
        ? [{ kind: "door", at: 0, width: shopDoor, head: 2.6 } as const]
        : [
            { kind: "window", at: -hw + 1.05 } as const,
            { kind: "door", u: balconyDoor } as const,
          ];
    b.shell({ ...WALL, x: [-hw, hw], z: [-hd, hd], y: [y0, y0 + H], openings: { "+z": front, "-z": [{ kind: "window", at: 0.4, ...SMALL_WINDOW }] } });

    const flightAbove = story + 1 < spec.stories || spec.roof === "terrace";
    const isRoof = story + 1 === spec.stories;
    b.slab({
      x: ix,
      z: iz,
      y: [y0 + CEILING, y0 + H],
      holes: flightAbove ? [{ x: core, z: [STAIR_BACK, STAIR_FRONT] }] : [],
      top: isRoof && spec.roof === "parapet" ? "roofAsphalt" : "concrete",
      bottom: "plasterInterior",
      side: "plaster",
      role: isRoof ? "roof" : "floor",
    });
    if (flightAbove) {
      b.flight({ dir: "-z", start: STAIR_FRONT, across: core, fromY: y0, toY: y0 + H, solid: story === 0, material: "concrete", balustrade: story === 0 ? ["max"] : [] });
    }
    if (story > 0) {
      // A wall beside the stair hole; a railing across its front when no flight continues up.
      b.wall({ interior: "plasterInterior", axis: "z", along: [STAIR_BACK, STAIR_FRONT], across: coreWall, y: [y0, y0 + CEILING] });
      if (!flightAbove) b.railing([[core[0] + 0.035, STAIR_FRONT + 0.04], [core[1] - 0.035, STAIR_FRONT + 0.04]], y0, "darkSteel");
    }
    b.wall({ interior: "plasterInterior", frame: "woodTrim", axis: "x", along: ix, across: PARTITION, y: [y0, y0 + CEILING], openings: [{ kind: "door", u: innerDoor }] });

    const frontRoom: Rect = { x: [coreWall[1], ix[1]], z: [PARTITION[1], iz[1]] };
    const backRoom: Rect = { x: ix, z: [iz[0], PARTITION[0]] };
    const frontApron: Rect = story === 0 ? { x: [-shopDoor / 2, shopDoor / 2], z: [iz[1] - DOOR_APRON, iz[1]] } : { x: balconyDoor, z: [iz[1] - DOOR_APRON, iz[1]] };
    raisedFloor(b, y0, frontRoom, [frontApron, ...partitionAprons], [innerDoorAt, PARTITION[1]]);
    raisedFloor(b, y0, backRoom, partitionAprons, [innerDoorAt, PARTITION[0]]);
    if (story === 0) {
      // Shop shelving on the raised floor along the east wall, short of the doors.
      b.box([ix[1] - 0.55, ix[1]], [RAISED, 1.9], [PARTITION[1] + 1.7, iz[1] - DOOR_APRON - 0.1], "woodTrim", "prop");
    }
    b.room(story === 0 ? "shop" : `front${story}`, y0, frontRoom.x, frontRoom.z);
    b.room(story === 0 ? "kitchen" : `back${story}`, y0, backRoom.x, backRoom.z);

    if (story > 0) {
      b.slab({ x: [-hw, hw], z: [hd, hd + BALCONY_DEPTH], y: [y0 - KIT.slabThickness, y0], top: "concrete", bottom: "plaster", side: "plaster" });
      b.railing([[-hw + 0.035, hd + 0.035], [-hw + 0.035, hd + BALCONY_DEPTH - 0.035], [hw - 0.035, hd + BALCONY_DEPTH - 0.035], [hw - 0.035, hd + 0.035]], y0, "darkSteel");
      b.room(`balcony${story}`, y0, [-hw + 0.1, hw - 0.1], [hd + 0.05, hd + BALCONY_DEPTH - 0.1], false);
    }
  }

  // Roll-up shutter drum inside, over the shopfront.
  b.box([-shopDoor / 2 - 0.1, shopDoor / 2 + 0.1], [2.4, 2.72], [iz[1] - 0.4, iz[1] - 0.05], "darkSteel", "prop");

  if (spec.roof === "parapet") {
    parapet(b, hw, hd, top, 0.9, null);
  } else if (spec.roof === "terrace") {
    // Stair head (tum) over the core with a door onto the terrace, under a roof too steep to stand on.
    const tum: Rect = { x: [-hw, core[1] + t], z: [PARTITION[0] - 0.25, STAIR_FRONT + t] };
    const tumTop = top + 2.6;
    const tumDoor = -2.05;
    b.shell({ ...WALL, x: tum.x, z: tum.z, y: [top, tumTop], openings: { "+x": [{ kind: "door", at: tumDoor }] } });
    const ridge = (tum.x[0] + tum.x[1]) / 2;
    const rise = (ridge - tum.x[0]) * Math.tan((58 * Math.PI) / 180);
    const zr: Range = [tum.z[0] - 0.1, tum.z[1] + 0.1];
    b.wedge([tum.x[0], ridge], [tumTop, tumTop + rise], zr, "+x", "plaster", "roofMetal", "roof");
    b.wedge([ridge, tum.x[1]], [tumTop, tumTop + rise], zr, "-x", "plaster", "roofMetal", "roof");
    parapet(b, hw, hd, top, 1.1, tum);
    const terrace: Rect = { x: [tum.x[1] + 0.05, ix[1]], z: iz };
    const doorApron: Rect = { x: [tum.x[1], tum.x[1] + DOOR_APRON], z: [tumDoor - 0.6, tumDoor + 0.6] };
    raisedFloor(b, top, terrace, [doorApron], [tum.x[1], tumDoor]);
    b.room("terrace", top, terrace.x, terrace.z, false);
    b.room("stairHead", top, [tum.x[0] + t, tum.x[1] - t], [tum.z[0] + t, STAIR_BACK]);
  } else {
    const rise = hw * Math.tan((55 * Math.PI) / 180);
    const zr: Range = [-hd - 0.3, hd + 0.3];
    b.wedge([-hw, 0], [top, top + rise], zr, "+x", "plaster", "roofMetal", "roof");
    b.wedge([0, hw], [top, top + rise], zr, "-x", "plaster", "roofMetal", "roof");
  }

  return b.entrance(0, 0, hd + 0.75).build();
}

/** Loot spot centers of a room, as `getPrefabLootSpots` lays them out. */
function spotAxis(lo: number, hi: number): number[] {
  const span = hi - lo - 2 * SPOT_INSET;
  if (span < 0) return [];
  const count = Math.floor(span / SPOT_SPACING) + 1;
  const start = lo + SPOT_INSET + (span - (count - 1) * SPOT_SPACING) / 2;
  return Array.from({ length: count }, (_, i) => start + i * SPOT_SPACING);
}

/**
 * Tiles a room with a 0.12 m raised floor (walkable, below the step height), leaving bare floor round its doors and
 * round the one loot spot nearest `keepNear`.
 */
function raisedFloor(b: PrefabBuilder, y0: number, room: Rect, aprons: readonly Rect[], keepNear: readonly [number, number]): void {
  let keep: [number, number] | null = null;
  let best = Infinity;
  for (const x of spotAxis(room.x[0], room.x[1])) {
    for (const z of spotAxis(room.z[0], room.z[1])) {
      const d = (x - keepNear[0]) ** 2 + (z - keepNear[1]) ** 2;
      if (d < best) [keep, best] = [[x, z], d];
    }
  }
  // Aprons widen past the door frames, which stand proud of the wall faces.
  const frame = KIT.frame.width + 0.01;
  const holes = aprons.map((a) => ({ u0: a.x[0] - frame, u1: a.x[1] + frame, v0: a.z[0], v1: a.z[1] }));
  if (keep) holes.push({ u0: keep[0] - 0.4, u1: keep[0] + 0.4, v0: keep[1] - 0.4, v1: keep[1] + 0.4 });
  for (const r of subtractRects({ u0: room.x[0], u1: room.x[1], v0: room.z[0], v1: room.z[1] }, holes)) {
    if (r.u1 - r.u0 < 0.05 || r.v1 - r.v0 < 0.05) continue;
    b.box([r.u0, r.u1], [y0, y0 + RAISED], [r.v0, r.v1], "concrete", "floor");
  }
}

/** Parapet walls round a flat roof, leaving out the stair head footprint. */
function parapet(b: PrefabBuilder, hw: number, hd: number, y: number, height: number, skip: Rect | null): void {
  const t = KIT.wallThickness;
  const yr: Range = [y, y + height];
  const piece = (x: Range, z: Range) => {
    if (x[1] - x[0] > 1e-6 && z[1] - z[0] > 1e-6) b.box(x, yr, z, "plaster", "railing");
  };
  piece([-hw, hw], [hd - t, hd]);
  piece([-hw, hw], [-hd, -hd + t]);
  piece([hw - t, hw], [-hd + t, hd - t]);
  if (skip) {
    piece([-hw, -hw + t], [-hd + t, skip.z[0]]);
    piece([-hw, -hw + t], [skip.z[1], hd - t]);
  } else {
    piece([-hw, -hw + t], [-hd + t, hd - t]);
  }
}

export const TUBE_HOUSES: readonly TubeHouseSpec[] = [
  { id: "tube_house_2", name: "Tube house (2 stories)", width: 4.2, depth: 12, stories: 2, roof: "parapet" },
  { id: "tube_house_3", name: "Tube house (3 stories, roof terrace)", width: 4.5, depth: 14, stories: 3, roof: "terrace" },
  { id: "tube_house_4", name: "Tube house (4 stories, gable roof)", width: 4.8, depth: 15, stories: 4, roof: "gable" },
];
