import type { HitZone, Vec3Tuple } from "@twobullets/shared";

/**
 * Body plan for a chunky ~1.8 m humanoid (player-sized: MOVEMENT.standHeight), in meters relative to the feet,
 * facing +Z with +X to its right. Each part is one visual mesh and one hitbox, so later player hitboxes can reuse it.
 */

export type Tint = "team" | "dark" | "visor";

export interface Piece {
  readonly size: Vec3Tuple;
  /** Center. */
  readonly at: Vec3Tuple;
  readonly tint: Tint;
}

export type HitboxShape =
  | { readonly kind: "sphere"; readonly center: Vec3Tuple; readonly radius: number }
  | { readonly kind: "box"; readonly center: Vec3Tuple; readonly size: Vec3Tuple };

export interface PartSpec {
  readonly name: string;
  readonly zone: HitZone;
  readonly hitbox: HitboxShape;
  readonly pieces: readonly Piece[];
}

export const HUMANOID_HEIGHT = 1.8;

function arm(side: -1 | 1): PartSpec {
  const x = 0.37 * side;
  return {
    name: side < 0 ? "armL" : "armR",
    zone: "limb",
    hitbox: { kind: "box", center: [x, 1.16, 0], size: [0.2, 0.68, 0.26] },
    pieces: [
      { size: [0.22, 0.13, 0.26], at: [x + 0.01 * side, 1.44, 0], tint: "dark" }, // shoulder pad
      { size: [0.14, 0.44, 0.16], at: [x, 1.17, 0], tint: "team" },
      { size: [0.16, 0.13, 0.18], at: [x, 0.89, 0.01], tint: "dark" }, // glove
    ],
  };
}

function leg(side: -1 | 1): PartSpec {
  const x = 0.12 * side;
  return {
    name: side < 0 ? "legL" : "legR",
    zone: "limb",
    hitbox: { kind: "box", center: [x, 0.4, 0.02], size: [0.22, 0.8, 0.32] },
    pieces: [
      { size: [0.2, 0.15, 0.32], at: [x, 0.075, 0.04], tint: "dark" }, // boot
      { size: [0.18, 0.64, 0.22], at: [x, 0.47, 0], tint: "team" },
      { size: [0.2, 0.12, 0.06], at: [x, 0.46, 0.12], tint: "dark" }, // knee pad
    ],
  };
}

export const HUMANOID_PARTS: readonly PartSpec[] = [
  {
    name: "head",
    zone: "head",
    hitbox: { kind: "sphere", center: [0, 1.66, 0], radius: 0.18 },
    pieces: [
      { size: [0.3, 0.28, 0.3], at: [0, 1.66, 0], tint: "team" },
      { size: [0.26, 0.08, 0.04], at: [0, 1.68, 0.16], tint: "visor" },
      { size: [0.32, 0.05, 0.32], at: [0, 1.775, 0], tint: "dark" }, // helmet rim
    ],
  },
  {
    name: "torso",
    zone: "body",
    hitbox: { kind: "box", center: [0, 1.24, -0.02], size: [0.54, 0.54, 0.38] },
    pieces: [
      { size: [0.54, 0.5, 0.3], at: [0, 1.23, 0], tint: "team" },
      { size: [0.38, 0.24, 0.05], at: [0, 1.3, 0.17], tint: "dark" }, // chest plate
      { size: [0.34, 0.34, 0.1], at: [0, 1.25, -0.2], tint: "dark" }, // backpack
      { size: [0.14, 0.06, 0.14], at: [0, 1.51, 0], tint: "dark" }, // neck
    ],
  },
  {
    name: "pelvis",
    zone: "body",
    hitbox: { kind: "box", center: [0, 0.88, 0], size: [0.46, 0.2, 0.28] },
    pieces: [
      { size: [0.44, 0.2, 0.26], at: [0, 0.88, 0], tint: "dark" },
      { size: [0.1, 0.08, 0.03], at: [0, 0.94, 0.14], tint: "visor" }, // belt buckle
    ],
  },
  arm(-1),
  arm(1),
  leg(-1),
  leg(1),
];
