import { KIT, PrefabBuilder } from "../kit";
import type { BuildingPrefab } from "../types";

const WALL = { exterior: "plaster", interior: "plasterInterior", frame: "woodTrim" } as const;
const PARTITION = { interior: "plasterInterior", frame: "woodTrim" } as const;
const SMALL_WINDOW = { width: 0.8, sill: 1.4, head: 2.2 } as const;

/**
 * 9 × 7 m single-story house: living room with front and back doors, bedroom, bathroom, gable roof.
 * The ruined variant loses its roof and part of the ceiling, has broken walls, rubble, a climbable fallen slab and
 * a collapsed beam that must be crouched under.
 */
export function smallHouse(ruined: boolean): BuildingPrefab {
  const b = new PrefabBuilder(ruined ? "house_small_ruined" : "house_small", ruined ? "Ruined house" : "Small house");
  const H = KIT.storyHeight;
  const ceiling = H - KIT.slabThickness;

  b.foundation([-4.5, 4.5], [-3.5, 3.5], "woodFloor");
  b.foundation([-3, -1], [3.5, 4.5], "concrete"); // front stoop

  b.shell({
    ...WALL,
    x: [-4.5, 4.5],
    z: [-3.5, 3.5],
    y: [0, H],
    openings: {
      "+z": ruined
        ? [
            { kind: "door", at: -2 },
            { kind: "window", at: -3.5 },
            { kind: "window", at: -0.2 },
            // Blast hole with a stepped outline, open to the wall top.
            { kind: "hole", u: [1.7, 3.5], sill: 0.6, head: H },
            { kind: "hole", u: [2.1, 3.1], sill: 0.25, head: H },
          ]
        : [
            { kind: "door", at: -2 },
            { kind: "window", at: -3.5 },
            { kind: "window", at: -0.2 },
            { kind: "window", at: 2.6 },
          ],
      "-z": [
        { kind: "door", at: -3 },
        { kind: "window", at: -0.8 },
        { kind: "window", at: 2.6, ...SMALL_WINDOW },
      ],
      "+x": ruined
        ? [
            { kind: "window", at: 1.6 },
            { kind: "hole", u: [-3.3, 0.4], sill: 2.3, head: H },
            { kind: "hole", u: [-2.4, -0.6], sill: 1.5, head: H },
          ]
        : [
            { kind: "window", at: 1.6 },
            { kind: "window", at: -1.8, ...SMALL_WINDOW },
          ],
      "-x": [{ kind: "window", at: 0.5 }],
    },
  });

  b.wall({ ...PARTITION, axis: "z", along: [-3.3, 3.3], across: [0.8, 0.95], y: [0, ceiling], openings: [{ kind: "door", at: 1.8, width: KIT.interiorDoor.width }] });
  b.wall({ ...PARTITION, axis: "x", along: [0.95, 4.3], across: [-0.3, -0.15], y: [0, ceiling], openings: [{ kind: "door", at: 2.6, width: KIT.interiorDoor.width }] });

  const slab = { y: [ceiling, H], top: "concrete", bottom: "plasterInterior", side: "plaster" } as const;
  if (ruined) {
    b.slab({ ...slab, x: [-4.3, 0.8], z: [-3.3, 3.3], holes: [{ x: [-2.5, -0.8], z: [-1, 1.5] }] });
    // The fallen piece of ceiling, now a ramp up toward the hole.
    b.wedge([-2.4, -0.9], [0, 1.1], [-0.8, 1.2], "+z", "concrete", "concrete", "prop");
    // Rubble below the blast hole: two low steps.
    b.box([1.5, 2.7], [0, 0.25], [2.2, 3.3], "concrete", "prop");
    b.box([2.0, 2.7], [0.25, 0.45], [2.7, 3.3], "concrete", "prop");
    // Collapsed beam across the bedroom door, resting on rubble: 1.3 m clearance, crouch only.
    b.box([0, 0.77], [0, 1.3], [0.95, 1.15], "concrete", "prop");
    b.box([0, 0.77], [0, 1.3], [2.45, 2.65], "concrete", "prop");
    b.box([0, 0.77], [1.3, 1.5], [0.95, 2.65], "woodPlanks", "prop");
    b.crouchPassage([0, 0.77], [0, 1.3], [1.15, 2.45]);
  } else {
    b.slab({ ...slab, x: [-4.3, 4.3], z: [-3.3, 3.3] });
    b.gableRoof({ x: [-4.5, 4.5], z: [-3.5, 3.5], baseY: H, ridge: "x", pitchDeg: 28, eave: 0.4, gable: 0.25, roof: "roofMetal", body: "plaster", fascia: "woodTrim" });
  }

  return b
    .room("living", 0, [-4.3, 0.8], [-3.3, 3.3])
    .room("bedroom", 0, [0.95, 4.3], [-0.15, 3.3], !ruined)
    .room("bathroom", 0, [0.95, 4.3], [-3.3, -0.3], !ruined)
    .entrance(-2, 0, 4.2)
    .entrance(-3, 0, -4.2)
    .build();
}

/**
 * 10 × 8 m two-story house with a central stair hall, living room, kitchen, bathroom, two bedrooms, and a balcony over
 * the front porch.
 */
export function twoStoryHouse(): BuildingPrefab {
  const b = new PrefabBuilder("house_two_story", "Two-story house");
  const H = KIT.storyHeight;
  const ceiling = H - KIT.slabThickness;

  b.foundation([-5, 5], [-4, 4], "woodFloor");
  b.foundation([-1.5, 1.5], [4, 5.5], "concrete"); // porch

  b.shell({
    ...WALL,
    x: [-5, 5],
    z: [-4, 4],
    y: [0, H],
    openings: {
      "+z": [
        { kind: "door", at: 0 },
        { kind: "window", at: -3.2 },
        { kind: "window", at: 3.2 },
      ],
      "-z": [
        { kind: "door", at: -0.6 },
        { kind: "window", at: -3.2 },
        { kind: "window", at: 3.2, ...SMALL_WINDOW },
      ],
      "+x": [
        { kind: "window", at: 1.5 },
        { kind: "window", at: -2.2, ...SMALL_WINDOW },
      ],
      "-x": [
        { kind: "window", at: 1.5 },
        { kind: "window", at: -1.5 },
      ],
    },
  });
  b.shell({
    ...WALL,
    x: [-5, 5],
    z: [-4, 4],
    y: [H, 2 * H],
    openings: {
      "+z": [
        { kind: "door", at: 0 },
        { kind: "window", at: -3.2 },
        { kind: "window", at: 3.2 },
      ],
      "-z": [
        { kind: "window", at: -3.2 },
        { kind: "window", at: -0.6 },
        { kind: "window", at: 3.2 },
      ],
      "+x": [
        { kind: "window", at: 1.5 },
        { kind: "window", at: -1.5 },
      ],
      "-x": [
        { kind: "window", at: 1.5 },
        { kind: "window", at: -1.5 },
      ],
    },
  });

  const interiorDoor = (at: number) => ({ kind: "door", at, width: KIT.interiorDoor.width }) as const;
  // Ground floor: hall between two partitions; the kitchen side is split off a bathroom.
  b.wall({ ...PARTITION, axis: "z", along: [-3.8, 3.8], across: [-1.6, -1.45], y: [0, ceiling], openings: [interiorDoor(2)] });
  b.wall({ ...PARTITION, axis: "z", along: [-3.8, 3.8], across: [1.45, 1.6], y: [0, ceiling], openings: [interiorDoor(2)] });
  b.wall({ ...PARTITION, axis: "x", along: [1.6, 4.8], across: [-0.8, -0.65], y: [0, ceiling], openings: [interiorDoor(3.2)] });
  // Upper floor: the same hall, bedroom doors next to the stair landing.
  b.wall({ ...PARTITION, axis: "z", along: [-3.8, 3.8], across: [-1.6, -1.45], y: [H, H + ceiling], openings: [interiorDoor(-2.4)] });
  b.wall({ ...PARTITION, axis: "z", along: [-3.8, 3.8], across: [1.45, 1.6], y: [H, H + ceiling], openings: [interiorDoor(-2.4)] });

  // Stairs along the east hall partition, climbing toward the back; the open side gets a stepped balustrade.
  const landing = b.flight({ dir: "-z", start: 1.2, across: [0.35, 1.45], fromY: 0, toY: H, solid: true, material: "concrete", balustrade: ["min"] });
  b.slab({ x: [-4.8, 4.8], z: [-3.8, 3.8], y: [ceiling, H], holes: [{ x: [0.35, 1.45], z: [landing, 1.2] }], top: "woodFloor", bottom: "plasterInterior", side: "plaster" });
  b.railing([[0.32, landing], [0.32, 1.23], [1.39, 1.23]], H, "woodTrim");

  b.slab({ x: [-4.8, 4.8], z: [-3.8, 3.8], y: [H + ceiling, 2 * H], top: "concrete", bottom: "plasterInterior", side: "plaster" });
  b.gableRoof({ x: [-5, 5], z: [-4, 4], baseY: 2 * H, ridge: "x", pitchDeg: 30, eave: 0.4, gable: 0.25, roof: "roofMetal", body: "plaster", fascia: "woodTrim" });

  // Balcony over the porch, on two posts.
  b.slab({ x: [-1.5, 1.5], z: [4, 5.5], y: [ceiling, H], top: "concrete", bottom: "plaster", side: "plaster" });
  b.box([-1.5, -1.35], [0, ceiling], [5.35, 5.5], "woodTrim", "structure");
  b.box([1.35, 1.5], [0, ceiling], [5.35, 5.5], "woodTrim", "structure");
  b.railing([[-1.47, 4.06], [-1.47, 5.47], [1.47, 5.47], [1.47, 4.06]], H, "woodTrim");

  return b
    .room("living", 0, [-4.8, -1.6], [-3.8, 3.8])
    .room("hall", 0, [-1.45, 1.45], [-3.8, 3.8])
    .room("kitchen", 0, [1.6, 4.8], [-0.65, 3.8])
    .room("bathroom", 0, [1.6, 4.8], [-3.8, -0.8])
    .room("bedroomWest", H, [-4.8, -1.6], [-3.8, 3.8])
    .room("landing", H, [-1.45, 0.29], [-3.8, 3.8])
    .room("bedroomEast", H, [1.6, 4.8], [-3.8, 3.8])
    .room("balcony", H, [-1.44, 1.44], [4.09, 5.44], false)
    .entrance(0, 0, 6.2)
    .entrance(-0.6, 0, -4.7)
    .build();
}
