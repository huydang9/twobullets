import type { Vec3Tuple } from "../../level/types";

// Prefab-local frame: meters, Y up, origin at the footprint center on the ground-floor finished floor level (y = 0).
// The "front" of a prefab (main entrance) faces local +Z. Foundations extend below y = 0 so small terrain slopes
// don't leave gaps.

export type Axis2 = "x" | "z";
export type HorizontalDir = "+x" | "-x" | "+z" | "-z";
export type FaceDir = HorizontalDir | "+y" | "-y";

/** Named material slots. The client maps each to a PBR look; several slots may share one look. */
export type BuildingMaterialId =
  | "plaster"
  | "plasterInterior"
  | "concrete"
  | "woodFloor"
  | "woodPlanks"
  | "woodTrim"
  | "corrugated"
  | "roofMetal"
  | "roofAsphalt"
  | "paintedSteel"
  | "darkSteel"
  | "containerRed"
  | "containerBlue";

/** What a part is, for tests, debugging and later gameplay (footstep surfaces, destructibility). */
export type PartRole = "foundation" | "wall" | "frame" | "floor" | "stairs" | "railing" | "roof" | "structure" | "prop";

interface PartBase {
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
  readonly role: PartRole;
  /** Material for every face not overridden in `faces`. */
  readonly material: BuildingMaterialId;
}

/** Axis-aligned box in prefab-local space. Every part is both a visual and an identical collision shape. */
export interface BoxPart extends PartBase {
  readonly kind: "box";
  readonly faces?: Partial<Readonly<Record<FaceDir, BuildingMaterialId>>>;
}

/**
 * Wedge filling its bounding box: the sloped face rises toward `rises`, from the bottom edge on the opposite side to
 * a vertical back face on the `rises` side. Convex, so physics uses a hull that matches the visual exactly.
 */
export interface WedgePart extends PartBase {
  readonly kind: "wedge";
  readonly rises: HorizontalDir;
  /** Material for the sloped face; `material` covers the bottom, back and triangular sides. */
  readonly slopeMaterial?: BuildingMaterialId;
}

export type BuildingPart = BoxPart | WedgePart;

/** Floor area a room occupies, for loot spawning and later AI/audio (indoor reverb). */
export interface BuildingRoom {
  readonly id: string;
  /** Finished floor height, prefab-local. */
  readonly floorY: number;
  readonly min: readonly [x: number, z: number];
  readonly max: readonly [x: number, z: number];
  /** Open-air areas (balconies, tower platforms, roofs) are false. */
  readonly indoor: boolean;
}

/** Clear passage through a wall (inside the frame), recorded by the kit for clearance tests and navigation. */
export interface BuildingOpening {
  readonly kind: "door" | "window" | "hole";
  /** Wall axis: the opening spans `u` along this axis and passes through along the other horizontal axis. */
  readonly axis: Axis2;
  /** Range along the wall axis. */
  readonly u: readonly [number, number];
  /** Clear vertical range. */
  readonly y: readonly [number, number];
  /** Wall face coordinates on the through axis, including frame protrusion. */
  readonly through: readonly [number, number];
}

/** One straight flight: tread tops in climbing order, starting one rise above `fromY` and ending one rise below `toY`. */
export interface BuildingStairFlight {
  readonly fromY: number;
  readonly toY: number;
  readonly treads: readonly { readonly min: Vec3Tuple; readonly max: Vec3Tuple }[];
}

export interface BuildingPrefab {
  readonly id: string;
  readonly name: string;
  readonly parts: readonly BuildingPart[];
  readonly rooms: readonly BuildingRoom[];
  readonly openings: readonly BuildingOpening[];
  readonly stairs: readonly BuildingStairFlight[];
  /** Intentionally low passages (under collapsed beams) that only a crouched player fits through. */
  readonly crouchPassages: readonly { readonly min: Vec3Tuple; readonly max: Vec3Tuple }[];
  /** Feet positions just outside each entrance (prefab-local), for spawn tests and navigation. */
  readonly entrances: readonly Vec3Tuple[];
  /** Local AABB of all parts. `footprint` is its XZ projection, which terrain should flatten. */
  readonly bounds: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
  /** Bridges stand on the road they carry: layout validation skips their road clearance. */
  readonly spansRoad?: boolean;
}

/** Where a prefab goes in the world. `yaw` turns local +Z toward world (sin yaw, 0, cos yaw), like LevelBlock.rotationY. */
export interface BuildingPlacement {
  /** World position of the prefab origin (ground-floor finished floor level at the footprint center). */
  readonly position: Vec3Tuple;
  readonly yaw: number;
}

/** Collision shape in prefab-local space: `center` and full `size`, axis-aligned. Wedges rise toward `rises`. */
export type BuildingCollisionShape =
  | { readonly kind: "box"; readonly center: Vec3Tuple; readonly size: Vec3Tuple }
  | { readonly kind: "wedge"; readonly center: Vec3Tuple; readonly size: Vec3Tuple; readonly rises: HorizontalDir };

export interface LootSpot {
  /** Floor-level position, prefab-local unless transformed. */
  readonly position: Vec3Tuple;
  readonly roomId: string;
}
