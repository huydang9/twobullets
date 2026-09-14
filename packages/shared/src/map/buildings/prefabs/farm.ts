import { KIT, PrefabBuilder } from "../kit";
import type { BuildingPrefab } from "../types";

/** 12 × 18 m plank barn: open floor with livestock stalls, big doors at both gable ends, a hay loft over the back third. */
export function barn(): BuildingPrefab {
  const b = new PrefabBuilder("barn", "Barn");
  const wallTop = 5;
  const loftY = KIT.storyHeight;
  const loftEdge = -3;

  b.foundation([-6, 6], [-9, 9], "concrete");
  b.shell({
    x: [-6, 6],
    z: [-9, 9],
    y: [0, wallTop],
    exterior: "woodPlanks",
    interior: "woodPlanks",
    frame: "woodTrim",
    openings: {
      "+z": [{ kind: "door", at: 0, width: 4, head: 4 }],
      "-z": [
        { kind: "door", at: 0, width: 2.4, head: 2.5 },
        { kind: "window", at: 0, width: 1.6, sill: 3.3, head: 4.6 }, // hay door into the loft
      ],
      "+x": [
        { kind: "window", at: 6 },
        { kind: "window", at: 2 },
        { kind: "window", at: -6, width: 1, sill: 3.8, head: 4.6 },
      ],
      "-x": [
        { kind: "door", at: 4 },
        { kind: "window", at: 0 },
        { kind: "window", at: -6 },
        { kind: "window", at: -6, width: 1, sill: 3.8, head: 4.6 },
      ],
    },
  });

  // Loft on posts, reached by stairs along the east wall that arrive at its open edge.
  b.slab({ x: [-5.8, 5.8], z: [-8.8, loftEdge], y: [loftY - KIT.slabThickness, loftY], top: "woodFloor", bottom: "woodPlanks", side: "woodPlanks" });
  for (const x of [-3, 0.5]) b.box([x - 0.1, x + 0.1], [0, loftY - KIT.slabThickness], [loftEdge - 0.2, loftEdge], "woodTrim", "structure");
  const start = loftEdge + 9 * KIT.stairs.run;
  b.flight({ dir: "-z", start, across: [4.7, 5.8], fromY: 0, toY: loftY, solid: true, material: "woodPlanks", balustrade: ["min"] });
  b.railing([[-5.77, loftEdge - 0.03], [4.67, loftEdge - 0.03]], loftY, "woodTrim");

  // Stall partitions along the west wall: waist-high cover.
  for (const z of [2.9, 5.6]) b.box([-5.8, -3.3], [0, 1.3], [z, z + 0.1], "woodPlanks", "prop");
  b.box([-1.2, 0], [0, 1.2], [-6.5, -5.3], "woodPlanks", "prop");
  b.box([-1.2, 0], [1.2, 2.4], [-6.5, -5.3], "woodPlanks", "prop");

  b.gableRoof({ x: [-6, 6], z: [-9, 9], baseY: wallTop, ridge: "z", pitchDeg: 35, eave: 0.4, gable: 0.3, roof: "corrugated", body: "woodPlanks", fascia: "woodTrim" });

  return b
    .room("floor", 0, [-5.8, 5.8], [-2.8, 8.8])
    .room("underLoft", 0, [-5.8, 5.8], [-8.8, -3.2])
    .room("loft", loftY, [-5.8, 5.8], [-8.8, loftEdge - 0.06])
    .entrance(0, 0, 9.8)
    .entrance(0, 0, -9.8)
    .entrance(-6.8, 0, 4)
    .build();
}
