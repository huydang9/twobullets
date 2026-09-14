import type { LevelBlock, LevelData, SpawnPoint, SurfaceKind, Vec3Tuple } from "./types";

// Layout conventions: +X = east, +Z = north, Y up, meters. Floor top is y = 0.
// The playable interior is x, z ∈ [-35, 35]; perimeter walls are 8 m tall.
// Height levels: ground 0 m, central platform 3 m, side catwalks 4.2 m.

type Dir = "+x" | "-x" | "+z" | "-z";

const DIR_VEC: Record<Dir, readonly [x: number, z: number]> = { "+x": [1, 0], "-x": [-1, 0], "+z": [0, 1], "-z": [0, -1] };
/** rotationY that turns a ramp's local +Z (uphill) toward the given direction. */
const YAW_OF: Record<Dir, number> = { "+z": 0, "+x": Math.PI / 2, "-z": Math.PI, "-x": -Math.PI / 2 };
const OPPOSITE: Record<Dir, Dir> = { "+x": "-x", "-x": "+x", "+z": "-z", "-z": "+z" };

const DEG = Math.PI / 180;

/** Axis-aligned box from min/max ranges per axis. */
function span(name: string, surface: SurfaceKind, x: readonly [number, number], y: readonly [number, number], z: readonly [number, number]): LevelBlock {
  return {
    kind: "box",
    name,
    surface,
    position: [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2],
    size: [x[1] - x[0], y[1] - y[0], z[1] - z[0]],
  };
}

/** Box resting on `baseY`, centered at (x, z). */
function crate(name: string, x: number, z: number, size: Vec3Tuple, opts: { baseY?: number; rotationY?: number; surface?: SurfaceKind } = {}): LevelBlock {
  const baseY = opts.baseY ?? 0;
  return {
    kind: "box",
    name,
    surface: opts.surface ?? "cover",
    position: [x, baseY + size[1] / 2, z],
    size,
    rotationY: opts.rotationY,
  };
}

interface EdgeAttachment {
  /** Center of the top edge where it meets the upper floor; y is the upper floor height. */
  readonly topEdge: Vec3Tuple;
  /** Direction pointing away from the upper floor, i.e. downhill. */
  readonly descend: Dir;
  readonly width: number;
  readonly baseY?: number;
}

/** Wedge ramp hanging off an edge, with the given slope angle. */
function ramp(name: string, opts: EdgeAttachment & { angleDeg: number; surface?: SurfaceKind }): LevelBlock {
  const [ex, topY, ez] = opts.topEdge;
  const baseY = opts.baseY ?? 0;
  const height = topY - baseY;
  const length = height / Math.tan(opts.angleDeg * DEG);
  const [dx, dz] = DIR_VEC[opts.descend];
  return {
    kind: "ramp",
    name,
    surface: opts.surface ?? "ramp",
    position: [ex + (dx * length) / 2, baseY + height / 2, ez + (dz * length) / 2],
    size: [opts.width, height, length],
    rotationY: YAW_OF[OPPOSITE[opts.descend]],
  };
}

/** Solid staircase hanging off an edge. The top step up onto the landing is one `rise` too. */
function stairs(name: string, opts: EdgeAttachment & { rise?: number; run?: number; surface?: SurfaceKind }): LevelBlock[] {
  const [ex, topY, ez] = opts.topEdge;
  const baseY = opts.baseY ?? 0;
  const rise = opts.rise ?? 0.3;
  const run = opts.run ?? 0.4;
  const [dx, dz] = DIR_VEC[opts.descend];
  const count = Math.ceil((topY - baseY) / rise - 1e-6) - 1;
  const steps: LevelBlock[] = [];
  for (let k = 0; k < count; k++) {
    const stepTop = topY - rise * (k + 1);
    const along = run * (k + 0.5);
    const alongX = dx !== 0;
    steps.push({
      kind: "box",
      name: `${name}_step${String(count - k).padStart(2, "0")}`,
      surface: opts.surface ?? "ramp",
      position: [ex + dx * along, (baseY + stepTop) / 2, ez + dz * along],
      size: alongX ? [run, stepTop - baseY, opts.width] : [opts.width, stepTop - baseY, run],
    });
  }
  return steps;
}

/** Support column from the ground up to `topY`. */
function pillar(name: string, x: number, z: number, topY: number): LevelBlock {
  return crate(name, x, z, [0.6, topY, 0.6], { surface: "accent" });
}

/** Spawn with feet at (x, y, z), facing the arena center. */
function spawn(x: number, z: number, y = 0): SpawnPoint {
  return { position: [x, y, z], yaw: Math.atan2(-x, -z) };
}

const WALL_HEIGHT = 8;
const PLATFORM_TOP = 3;
const CATWALK_TOP = 4.2; // 14 × 0.3 m steps
const CATWALK_UNDERSIDE = CATWALK_TOP - 0.5;

const FULL_COVER: Vec3Tuple = [2, 2, 2];
const CROUCH_COVER: Vec3Tuple = [1.5, 1, 1.5];

const shell: LevelBlock[] = [
  span("ground", "ground", [-36, 36], [-1, 0], [-36, 36]),
  span("wall_north", "wall", [-36, 36], [0, WALL_HEIGHT], [35, 36]),
  span("wall_south", "wall", [-36, 36], [0, WALL_HEIGHT], [-36, -35]),
  span("wall_east", "wall", [35, 36], [0, WALL_HEIGHT], [-35, 35]),
  span("wall_west", "wall", [-36, -35], [0, WALL_HEIGHT], [-35, 35]),
  span("wallCap_north", "accent", [-36.2, 36.2], [WALL_HEIGHT, WALL_HEIGHT + 0.3], [34.8, 36.2]),
  span("wallCap_south", "accent", [-36.2, 36.2], [WALL_HEIGHT, WALL_HEIGHT + 0.3], [-36.2, -34.8]),
  span("wallCap_east", "accent", [34.8, 36.2], [WALL_HEIGHT, WALL_HEIGHT + 0.3], [-34.8, 34.8]),
  span("wallCap_west", "accent", [-36.2, -34.8], [WALL_HEIGHT, WALL_HEIGHT + 0.3], [-34.8, 34.8]),
];

// 12 × 12 m block, top at 3 m, one access route per side.
const centralPlatform: LevelBlock[] = [
  span("platform_center", "platform", [-6, 6], [0, PLATFORM_TOP], [-6, 6]),
  // South: gentle 25° ramp, footprint x ∈ [-2, 2], z ∈ [-12.43, -6].
  ramp("platform_rampSouth25", { topEdge: [0, PLATFORM_TOP, -6], descend: "-z", width: 4, angleDeg: 25 }),
  // West: gentle 20° ramp, footprint x ∈ [-14.24, -6], z ∈ [-2, 2].
  ramp("platform_rampWest20", { topEdge: [-6, PLATFORM_TOP, 0], descend: "-x", width: 4, angleDeg: 20 }),
  // East: 60° ramp that must NOT be walkable, footprint x ∈ [6, 7.73], z ∈ [-3, 3].
  ramp("platform_rampEastSteep60", { topEdge: [6, PLATFORM_TOP, 0], descend: "+x", width: 6, angleDeg: 60 }),
  // North: 9 steps × 0.3 m rise, 0.4 m run, footprint x ∈ [-2, 2], z ∈ [6, 9.6].
  ...stairs("platform_stairsNorth", { topEdge: [0, PLATFORM_TOP, 6], descend: "+z", width: 4 }),
  crate("platform_coverNE", 2.5, 2.5, CROUCH_COVER, { baseY: PLATFORM_TOP }),
  crate("platform_coverSW", -2.5, -2.5, CROUCH_COVER, { baseY: PLATFORM_TOP }),
];

// West catwalk: x ∈ [-35, -31], z ∈ [-20, 20], top 4.2 m. Ramp at the north end, stairs at the south end.
const westCatwalk: LevelBlock[] = [
  span("catwalkWest", "platform", [-35, -31], [CATWALK_UNDERSIDE, CATWALK_TOP], [-20, 20]),
  ...[-19, -6.5, 6.5, 19].map((z, i) => pillar(`catwalkWest_pillar${i}`, -31.7, z, CATWALK_UNDERSIDE)),
  // 30° ramp, footprint z ∈ [20, 27.27].
  ramp("catwalkWest_rampNorth30", { topEdge: [-33, CATWALK_TOP, 20], descend: "+z", width: 4, angleDeg: 30 }),
  // 13 steps, footprint z ∈ [-25.2, -20].
  ...stairs("catwalkWest_stairsSouth", { topEdge: [-33, CATWALK_TOP, -20], descend: "-z", width: 4 }),
  crate("catwalkWest_cover", -33, 8, CROUCH_COVER, { baseY: CATWALK_TOP }),
];

// East catwalk: x ∈ [31, 35], top 4.2 m, split by a 3 m jump gap at z ∈ [-1.5, 1.5].
// Rotationally symmetric to the west side: stairs at the north end, ramp at the south end.
const eastCatwalk: LevelBlock[] = [
  span("catwalkEast_south", "platform", [31, 35], [CATWALK_UNDERSIDE, CATWALK_TOP], [-20, -1.5]),
  span("catwalkEast_north", "platform", [31, 35], [CATWALK_UNDERSIDE, CATWALK_TOP], [1.5, 20]),
  ...[-19, -10.5, -2.2, 2.2, 10.5, 19].map((z, i) => pillar(`catwalkEast_pillar${i}`, 31.7, z, CATWALK_UNDERSIDE)),
  // 13 steps, footprint z ∈ [20, 25.2].
  ...stairs("catwalkEast_stairsNorth", { topEdge: [33, CATWALK_TOP, 20], descend: "+z", width: 4 }),
  // 30° ramp, footprint z ∈ [-27.27, -20].
  ramp("catwalkEast_rampSouth30", { topEdge: [33, CATWALK_TOP, -20], descend: "-z", width: 4, angleDeg: 30 }),
  crate("catwalkEast_cover", 33, -8, CROUCH_COVER, { baseY: CATWALK_TOP }),
];

const groundCover: LevelBlock[] = [
  // Crate stacks near the platform corners: 1 m step-up next to a 2 m crate.
  crate("cover_crateNE", 9, 9, FULL_COVER),
  crate("cover_crateNE_step", 10.75, 9.25, CROUCH_COVER),
  crate("cover_crateSW", -9, -9, FULL_COVER),
  crate("cover_crateSW_step", -10.75, -9.25, CROUCH_COVER),
  // Mid-lane crates.
  crate("cover_crateMidNE", 20, 12, FULL_COVER),
  crate("cover_crateMidSW", -20, -12, FULL_COVER),
  crate("cover_crouchMidSE", 16, -14, CROUCH_COVER, { rotationY: 0.4 }),
  crate("cover_crouchMidNW", -16, 14, CROUCH_COVER, { rotationY: -0.4 }),
  crate("cover_lowWallEast", 18, 0, [1, 1, 4]),
  crate("cover_lowWallWest", -19, 0, [1, 1, 4]),
  crate("cover_lowWallSE", 12, -20, [4, 1, 1]),
  crate("cover_lowWallNW", -12, 20, [4, 1, 1]),
  // Outer stacks under the catwalks' approach.
  crate("cover_stackEast", 25, -10, FULL_COVER),
  crate("cover_stackEast_step", 25, -8.25, CROUCH_COVER),
  crate("cover_stackWest", -25, 10, FULL_COVER),
  crate("cover_stackWest_step", -25, 8.25, CROUCH_COVER),
  // Tall barriers shielding the north/south spawns.
  crate("cover_barrierNorth", 0, 22, [8, 3, 1]),
  crate("cover_barrierSouth", 0, -22, [8, 3, 1]),
];

export const ARENA_LEVEL: LevelData = {
  name: "Blockout Arena",
  killY: -20,
  spawnPoints: [
    spawn(-24, -28),
    spawn(24, 28),
    spawn(24, -28),
    spawn(-24, 28),
    spawn(0, -29),
    spawn(0, 29),
    spawn(-25, 0),
    spawn(25, 0),
  ],
  blocks: [...shell, ...centralPlatform, ...westCatwalk, ...eastCatwalk, ...groundCover],
};
