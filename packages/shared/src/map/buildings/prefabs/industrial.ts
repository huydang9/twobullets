import { KIT, PrefabBuilder } from "../kit";
import type { BuildingMaterialId, BuildingPrefab } from "../types";

const HIGH_WINDOW = { width: 2, sill: 4.8, head: 5.8 } as const;

/** 24 × 16 m corrugated warehouse: roller-door openings, clerestory windows, an office with a mezzanine deck, racks. */
export function warehouse(): BuildingPrefab {
  const b = new PrefabBuilder("warehouse", "Warehouse");
  const wallTop = 7;
  const deckY = 3.6;
  const deckBottom = deckY - KIT.slabThickness;
  const roller = { kind: "door", width: 4, head: 4.5 } as const;
  const high = (at: number) => ({ kind: "window", at, ...HIGH_WINDOW }) as const;

  b.foundation([-12, 12], [-8, 8], "concrete");
  b.shell({
    x: [-12, 12],
    z: [-8, 8],
    y: [0, wallTop],
    exterior: "corrugated",
    interior: "corrugated",
    frame: "paintedSteel",
    openings: {
      "+z": [{ ...roller, at: -6 }, { ...roller, at: 6 }, { kind: "door", at: 0 }, high(-9.5), high(-2.5), high(2.5), high(9.5)],
      "-z": [{ ...roller, at: 4 }, { kind: "door", at: -3 }, { kind: "window", at: -9 }, high(-9.5), high(-2), high(9.5)],
      "+x": [{ kind: "door", at: 0 }, high(-4.5), high(4.5)],
      "-x": [{ kind: "door", at: 3 }, { kind: "window", at: -5.2 }, high(4.5), high(-5.2)],
    },
  });

  // Office in the north-west corner; its ceiling is a steel mezzanine that extends over a corridor beside it.
  const office = { exterior: "plaster", interior: "plasterInterior", frame: "paintedSteel" } as const;
  b.wall({ ...office, axis: "x", along: [-11.8, -5.85], across: [-2.5, -2.35], y: [0, deckBottom], outside: "+z", openings: [{ kind: "door", at: -9.5 }, { kind: "window", at: -7.2 }] });
  b.wall({ ...office, axis: "z", along: [-7.8, -2.5], across: [-6, -5.85], y: [0, deckBottom], outside: "+x", openings: [{ kind: "window", at: -5.2 }] });
  b.slab({ x: [-11.8, -4.75], z: [-7.8, -2.35], y: [deckBottom, deckY], top: "paintedSteel", bottom: "plasterInterior", side: "paintedSteel" });
  for (const z of [-7.8, -2.55]) b.box([-4.95, -4.75], [0, deckBottom], [z, z + 0.2], "paintedSteel", "structure");
  const deckStart = -2.35 + 11 * KIT.stairs.run;
  b.flight({ dir: "-z", start: deckStart, across: [-5.85, -4.75], fromY: 0, toY: deckY, solid: true, material: "concrete", balustrade: ["max"] });
  b.railing([[-4.78, -7.77], [-4.78, -2.38]], deckY, "paintedSteel");
  b.railing([[-11.77, -2.38], [-5.88, -2.38]], deckY, "paintedSteel");

  // Pallet racks and a crate stack for cover.
  b.box([2, 10], [0, 2.4], [-1, 0.2], "paintedSteel", "prop");
  b.box([2, 10], [0, 2.4], [-5, -3.8], "paintedSteel", "prop");
  b.box([-2, -0.8], [0, 1.2], [2, 3.2], "woodPlanks", "prop");
  b.box([-0.8, 0.4], [0, 1.2], [2, 3.2], "woodPlanks", "prop");
  b.box([-2, -0.8], [1.2, 2.4], [2, 3.2], "woodPlanks", "prop");

  b.gableRoof({ x: [-12, 12], z: [-8, 8], baseY: wallTop, ridge: "x", pitchDeg: 12, eave: 0.5, gable: 0.3, roof: "corrugated", body: "corrugated", fascia: "paintedSteel" });

  return b
    .room("office", 0, [-11.8, -6], [-7.8, -2.5])
    .room("floorWest", 0, [-11.8, -5.85], [-2.35, 7.8])
    .room("floorEast", 0, [-4.75, 11.8], [-7.8, 7.8])
    .room("mezzanine", deckY, [-11.8, -4.81], [-7.8, -2.41])
    .entrance(-6, 0, 8.8)
    .entrance(0, 0, 8.8)
    .entrance(4, 0, -8.8)
    .entrance(12.8, 0, 0)
    .build();
}

/** 20 ft ISO container (6.06 × 2.44 × 2.59 m) with both doors swung back against its sides. */
export function openContainer(id: string, name: string, paint: BuildingMaterialId): BuildingPrefab {
  const b = new PrefabBuilder(id, name);
  const [hx, hz, top] = [1.22, 3.03, 2.59];
  const floor = 0.15;
  const roofBottom = 2.44;
  const skin = 0.05;
  const post = 0.15;

  b.box([-hx, hx], [0, floor], [-hz, hz], paint, "floor", { "+y": "woodFloor" });
  b.box([-hx, hx], [roofBottom, top], [-hz, hz], paint, "roof");
  b.box([-hx, -hx + skin], [floor, roofBottom], [-hz, hz - post], paint, "wall");
  b.box([hx - skin, hx], [floor, roofBottom], [-hz, hz - post], paint, "wall");
  b.box([-hx + skin, hx - skin], [floor, roofBottom], [-hz, -hz + skin], paint, "wall");
  b.box([-hx, -hx + post], [floor, roofBottom], [hz - post, hz], paint, "structure");
  b.box([hx - post, hx], [floor, roofBottom], [hz - post, hz], paint, "structure");
  b.box([-hx + post, hx - post], [roofBottom - 0.2, roofBottom], [hz - post, hz], paint, "structure");
  for (const side of [-1, 1]) {
    const x = side * (hx + 0.02);
    b.box([x - 0.02, x + 0.02], [0.1, roofBottom], [hz - hx, hz], paint, "prop");
  }
  return b.room("inside", floor, [-hx + skin, hx - skin], [-hz + skin, hz - post]).entrance(0, 0, hz + 0.8).build();
}

/** Closed 20 ft container: a solid block, the cheapest hard cover on the map. */
export function closedContainer(): BuildingPrefab {
  return new PrefabBuilder("container_closed", "Container (closed)").box([-1.22, 1.22], [0, 2.59], [-3.03, 3.03], "containerBlue", "structure").build();
}

/** 10 × 7 m radar control building: two rooms, exterior stairs to a parapet roof with the antenna mast. */
export function radarStation(): BuildingPrefab {
  const b = new PrefabBuilder("radar_station", "Radar station");
  const H = KIT.storyHeight;
  const ceiling = H - KIT.slabThickness;
  const parapetTop = H + 1;

  b.foundation([-5, 5], [-3.5, 3.5], "concrete");
  // Pad under the exterior stairs, running 0.6 m past the first tread as a bottom step: snapped floors sit 0.1 m above
  // the ground, so the 0.3 m first rise straight off the terrain would be a 0.4 m step.
  b.foundation([-6.1, -5], [-3.5, 0.9], "concrete");
  b.shell({
    x: [-5, 5],
    z: [-3.5, 3.5],
    y: [0, parapetTop],
    exterior: "plaster",
    interior: "plasterInterior",
    frame: "paintedSteel",
    openings: {
      "+z": [{ kind: "door", at: -2.5 }, { kind: "window", at: -4 }, { kind: "window", at: -0.3 }, { kind: "window", at: 3 }],
      "-z": [{ kind: "window", at: -2.5 }, { kind: "window", at: 3, width: 0.8, sill: 1.4, head: 2.2 }],
      "+x": [{ kind: "door", at: -1.5 }, { kind: "window", at: 1.5 }],
      // Gap in the parapet where the stairs arrive.
      "-x": [{ kind: "window", at: 2 }, { kind: "hole", u: [-3.3, -2.2], sill: H, head: parapetTop }],
    },
  });
  b.wall({ interior: "plasterInterior", frame: "paintedSteel", axis: "z", along: [-3.3, 3.3], across: [1, 1.15], y: [0, ceiling], openings: [{ kind: "door", at: 0, width: KIT.interiorDoor.width }] });
  b.slab({ x: [-4.8, 4.8], z: [-3.3, 3.3], y: [ceiling, H], top: "roofAsphalt", bottom: "plasterInterior", side: "plaster" });

  // Exterior stairs along the west wall, climbing south to a landing level with the roof.
  const landingZ = b.flight({ dir: "-z", start: -2.4 + 9 * KIT.stairs.run, across: [-6.1, -5], fromY: 0, toY: H, solid: true, material: "concrete", balustrade: ["min"] });
  const panel = KIT.balustrade.thickness;
  b.box([-6.1 + panel, -5], [0, H], [-3.5 + panel, landingZ], "concrete", "stairs");
  b.box([-6.1, -6.1 + panel], [0, H + KIT.balustrade.height], [-3.5, landingZ], "concrete", "railing");
  b.box([-6.1 + panel, -5], [0, H + KIT.balustrade.height], [-3.5, -3.5 + panel], "concrete", "railing");

  // Antenna on a pedestal and mast.
  b.box([1.8, 3], [H, H + 1.2], [-0.6, 0.6], "concrete", "structure");
  b.box([2.2, 2.6], [H + 1.2, H + 3.5], [-0.2, 0.2], "paintedSteel", "structure");
  b.box([0.4, 4.4], [H + 3.5, H + 5.1], [-0.12, 0.12], "paintedSteel", "structure");

  return b
    .room("control", 0, [-4.8, 1], [-3.3, 3.3])
    .room("equipment", 0, [1.15, 4.8], [-3.3, 3.3])
    .room("roof", H, [-4.8, 4.8], [-3.3, 3.3], false)
    .entrance(-2.5, 0, 4.2)
    .entrance(5.7, 0, -1.5)
    .entrance(-5.55, 0, 1.2)
    .build();
}
