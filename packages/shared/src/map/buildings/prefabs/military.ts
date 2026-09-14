import { KIT, PrefabBuilder, type Range } from "../kit";
import type { BuildingPrefab } from "../types";

const SMALL_WINDOW = { width: 0.8, sill: 1.5, head: 2.2 } as const;

/** 20 × 9 m flat-roofed barracks: dormitory with bunks, entrance hall, office, washroom. */
export function barracks(): BuildingPrefab {
  const b = new PrefabBuilder("barracks", "Barracks");
  const ceiling = KIT.storyHeight - KIT.slabThickness;
  const parapetTop = 3.6;
  const partition = { interior: "plasterInterior", frame: "paintedSteel" } as const;
  const door = (at: number) => ({ kind: "door", at, width: KIT.interiorDoor.width }) as const;

  b.foundation([-10, 10], [-4.5, 4.5], "concrete");
  b.shell({
    x: [-10, 10],
    z: [-4.5, 4.5],
    y: [0, parapetTop],
    exterior: "plaster",
    interior: "plasterInterior",
    frame: "paintedSteel",
    openings: {
      "+z": [
        { kind: "door", at: 0 },
        ...[-8.3, -5.9, -3.5, 4.5, 7.5].map((at) => ({ kind: "window", at }) as const),
      ],
      "-z": [
        { kind: "door", at: 0 },
        ...[-8.3, -5.9, -3.5].map((at) => ({ kind: "window", at }) as const),
        ...[4.5, 7.5].map((at) => ({ kind: "window", at, ...SMALL_WINDOW }) as const),
      ],
      "+x": [
        { kind: "door", at: 2.2 },
        { kind: "window", at: -2.2, ...SMALL_WINDOW },
      ],
      "-x": [-2.5, 0, 2.5].map((at) => ({ kind: "window", at }) as const),
    },
  });

  b.wall({ ...partition, axis: "z", along: [-4.3, 4.3], across: [-2.15, -2], y: [0, ceiling], openings: [door(-2.5)] });
  b.wall({ ...partition, axis: "z", along: [-4.3, 4.3], across: [2, 2.15], y: [0, ceiling], openings: [door(2.2), door(-2.2)] });
  b.wall({ ...partition, axis: "x", along: [2.15, 9.8], across: [-0.075, 0.075], y: [0, ceiling] });
  b.slab({ x: [-9.8, 9.8], z: [-4.3, 4.3], y: [ceiling, KIT.storyHeight], top: "roofAsphalt", bottom: "plasterInterior", side: "plaster" });
  b.slab({ x: [-1.5, 1.5], z: [4.5, 5.7], y: [2.6, 2.8], top: "roofAsphalt", bottom: "concrete", side: "concrete", role: "roof" }); // entrance canopy

  // Steel bunks between the windows.
  for (const x of [-7.55, -5.15]) {
    for (const z of [[2.2, 4.2], [-4.2, -2.2]] as const) b.box([x, x + 0.9], [0, 1.6], z, "paintedSteel", "prop");
  }

  return b
    .room("dormitory", 0, [-9.8, -2.15], [-4.3, 4.3])
    .room("hall", 0, [-2, 2], [-4.3, 4.3])
    .room("office", 0, [2.15, 9.8], [0.075, 4.3])
    .room("washroom", 0, [2.15, 9.8], [-4.3, -0.075])
    .entrance(0, 0, 6.3)
    .entrance(0, 0, -5.2)
    .entrance(10.7, 0, 2.2)
    .build();
}

/**
 * Concrete-core watchtower: a square spiral of steel block treads around the core (three flights with corner
 * landings, 0.3 m rises) up to a 9 m platform with a parapet and a roof.
 */
export function watchtower(): BuildingPrefab {
  const b = new PrefabBuilder("watchtower", "Watchtower");
  const core = 1.4;
  const outer = 2.5;
  const panel = KIT.balustrade.thickness;
  const inner = outer - panel;
  const flightHeight = 3;
  const platformY = 3 * flightHeight;
  const slabBottom = platformY - KIT.slabThickness;
  const parapetTop = platformY + 1.1;
  const roofBottom = parapetTop + 1.3;
  const steel = "paintedSteel";
  const run = KIT.stairs.run;

  b.foundation([-2.8, 2.8], [-2.8, 2.8], "concrete");
  b.box([-core, core], [0, slabBottom], [-core, core], "concrete", "structure");

  // Flight 1: south side, climbing east. Flight 2: east side, north. Flight 3: north side, west.
  const end1 = b.flight({ dir: "+x", start: -core, across: [-outer, -core], fromY: 0, toY: flightHeight, solid: false, material: steel, balustrade: ["min"] });
  const end2 = b.flight({ dir: "+z", start: -core, across: [core, outer], fromY: flightHeight, toY: 2 * flightHeight, solid: false, material: steel, balustrade: ["max"] });
  const end3 = b.flight({ dir: "-x", start: core, across: [core, outer], fromY: 2 * flightHeight, toY: platformY, solid: false, material: steel, balustrade: ["max"] });

  const landing = (x: Range, z: Range, top: number, panels: { x: Range; z: Range }[]) => {
    b.box(x, [top - run, top], z, steel, "stairs");
    for (const p of panels) b.box(p.x, [top - run, top + KIT.balustrade.height], p.z, steel, "railing");
  };
  landing([end1, inner], [-inner, -core], flightHeight, [
    { x: [end1, outer], z: [-outer, -inner] },
    { x: [inner, outer], z: [-inner, -core] },
  ]);
  landing([core, inner], [end2, inner], 2 * flightHeight, [
    { x: [inner, outer], z: [end2, inner] },
    { x: [core, outer], z: [inner, outer] },
  ]);

  // Platform: open above flight 3 so climbers keep their headroom; flight 3 ends on its north-west corner.
  b.slab({ x: [-outer, outer], z: [-outer, outer], y: [slabBottom, platformY], holes: [{ x: [end3, core], z: [core, outer] }], top: "concrete", bottom: steel, side: steel, role: "floor" });
  b.railing([[end3 + 0.03, core - 0.03], [core + 0.03, core - 0.03], [core + 0.03, outer - 0.13]], platformY, steel);

  const parapet = (x: Range, z: Range) => b.box(x, [platformY, parapetTop], z, "corrugated", "railing");
  parapet([-outer, outer], [-outer, -outer + 0.1]);
  parapet([-outer, -outer + 0.1], [-outer + 0.1, outer]);
  parapet([outer - 0.1, outer], [-outer + 0.1, outer]);
  parapet([-outer + 0.1, end3], [outer - 0.1, outer]);
  parapet([core, outer - 0.1], [outer - 0.1, outer]);
  for (const x of [-outer, outer - 0.1]) {
    for (const z of [-outer, outer - 0.1]) b.box([x, x + 0.1], [parapetTop, roofBottom], [z, z + 0.1], steel, "structure");
  }
  b.slab({ x: [-2.8, 2.8], z: [-2.8, 2.8], y: [roofBottom, roofBottom + KIT.slabThickness], top: "corrugated", bottom: steel, side: steel, role: "roof" });

  return b
    .room("platform", platformY, [-outer + 0.1, outer - 0.1], [-outer + 0.1, core - 0.06], false)
    .entrance(-3.2, 0, -2)
    .build();
}

/** 2.4 m checkpoint booth on a raised base, windows on three sides, with a boom barrier. */
export function guardBooth(): BuildingPrefab {
  const b = new PrefabBuilder("guard_booth", "Guard booth");
  const floor = 0.2;
  const top = 2.8;
  const wide = { width: 1.4, sill: 1.0, head: 2.2 } as const;

  b.foundation([-1.3, 1.3], [-1.3, 1.3], "concrete", "concrete", floor);
  b.shell({
    x: [-1.2, 1.2],
    z: [-1.2, 1.2],
    y: [floor, top],
    thickness: 0.15,
    exterior: "plaster",
    interior: "plasterInterior",
    frame: "paintedSteel",
    openings: {
      "+z": [{ kind: "door", at: 0, width: 1 }],
      "-z": [{ kind: "window", at: 0, ...wide }],
      "+x": [{ kind: "window", at: 0, ...wide }],
      "-x": [{ kind: "window", at: 0, ...wide }],
    },
  });
  b.slab({ x: [-1.6, 1.6], z: [-1.6, 1.6], y: [top, top + 0.2], top: "paintedSteel", bottom: "plasterInterior", side: "paintedSteel", role: "roof" });
  b.box([1.6, 1.9], [-0.5, 1.1], [-0.15, 0.15], "paintedSteel", "structure");
  b.box([1.9, 6.4], [0.95, 1.05], [-0.05, 0.05], "paintedSteel", "prop");

  return b.room("booth", floor, [-1.05, 1.05], [-1.05, 1.05]).entrance(0, 0, 1.9).build();
}
