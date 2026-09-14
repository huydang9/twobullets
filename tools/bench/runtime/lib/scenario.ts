/**
 * Engine-free description of the benchmark match, shared by every mode so they simulate the same world:
 * 1×1 km rolling heightfield, ~300 building boxes (+ a few ramps) clustered in towns, 10 players with scripted
 * random inputs, 20 bone hitboxes per player on a synthetic animation, and a steady population of projectiles.
 */
import type { LevelBlock, MoveInput, CombatInput, WeaponId } from "../../../../packages/shared/src/index.ts";
import { createRng } from "./stats.ts";

export interface ScenarioOptions {
  seed: number;
  players: number;
  hitboxesPerPlayer: number;
  projectiles: number;
  buildings: number;
  /** Heightfield samples per side (513 → ~1.95 m spacing over 1 km). */
  heightfieldSamples: number;
  mapSize: number;
  /** Seed for the building layout; matches on the same map share it (defaults to `seed`). */
  levelSeed?: number;
  /** Direct mode: reuse terrain/building Havok shapes across worlds in the same Havok instance. */
  shareStaticShapes?: boolean;
}

export const DEFAULT_SCENARIO: ScenarioOptions = {
  seed: 1234,
  players: 10,
  hitboxesPerPlayer: 20,
  projectiles: 50,
  buildings: 300,
  heightfieldSamples: 513,
  mapSize: 1000,
};

/** Collision filter bits (identical in every mode). World: default membership. */
export const LAYER = {
  world: 1 << 0,
  hitbox: 1 << 1,
  player: 1 << 3,
  bulletQuery: 1 << 4,
} as const;
/** Bullets see level geometry and hitboxes, not player capsules. */
export const BULLET_COLLIDE = LAYER.world | LAYER.hitbox;

export function terrainHeight(x: number, z: number): number {
  return (
    14 * Math.sin(x / 97) * Math.cos(z / 131) + 5 * Math.sin(x / 41 + 1.3) * Math.sin(z / 53 + 0.7) + 1.5 * Math.sin(x / 13) * Math.cos(z / 17)
  );
}

/**
 * Heights in Babylon's PhysicsShapeHeightField ordering. The plugin copies data[(n-1-a)*n + b] to Havok's
 * heights[b*n + a], and Havok's row index runs along world X and its column along world Z (verified by raycasts),
 * so data[(n-1-a)*n + b] is the sample at world (-size/2 + b*step, -size/2 + a*step), centered on the body.
 */
export function heightfieldBabylonOrder(o: ScenarioOptions): Float32Array {
  const n = o.heightfieldSamples;
  const step = o.mapSize / (n - 1);
  const data = new Float32Array(n * n);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      data[(n - 1 - a) * n + b] = terrainHeight(-o.mapSize / 2 + b * step, -o.mapSize / 2 + a * step);
    }
  }
  return data;
}

export const TOWNS: readonly (readonly [number, number])[] = [
  [0, 0],
  [260, 180],
  [-240, 220],
  [180, -260],
];
export const TOWN_RADIUS = 80;

/** Level blocks placed on the terrain, in the shared LevelBlock format so Babylon mode can use `buildLevel` directly. */
export function buildingBlocks(o: ScenarioOptions): LevelBlock[] {
  const rng = createRng(o.levelSeed ?? o.seed);
  const blocks: LevelBlock[] = [];
  const scattered = Math.floor(o.buildings * 0.2);
  for (let i = 0; i < o.buildings; i++) {
    let cx: number;
    let cz: number;
    if (i < o.buildings - scattered) {
      const [tx, tz] = TOWNS[i % TOWNS.length]!;
      const r = Math.sqrt(rng()) * TOWN_RADIUS;
      const a = rng() * Math.PI * 2;
      cx = tx + Math.cos(a) * r;
      cz = tz + Math.sin(a) * r;
    } else {
      cx = (rng() - 0.5) * (o.mapSize - 40);
      cz = (rng() - 0.5) * (o.mapSize - 40);
    }
    const ground = terrainHeight(cx, cz);
    const roll = rng();
    const rotationY = rng() * Math.PI;
    if (roll < 0.1) {
      // Ramp (convex hull in Babylon's buildLevel): 3 m rise over 6 m.
      blocks.push({ kind: "ramp", name: `ramp_${i}`, surface: "ramp", position: [cx, ground + 1.0, cz], size: [3, 3, 6], rotationY });
    } else if (roll < 0.3) {
      // Low crate/step: exercises the controller's step-up path.
      // Top 0.15–0.30 m above the terrain at its center (a 0.3 m skirt is buried so slopes don't leave gaps).
      const h = 0.15 + rng() * 0.15;
      blocks.push({ kind: "box", name: `step_${i}`, surface: "cover", position: [cx, ground + h - (h + 0.3) / 2, cz], size: [2 + rng() * 2, h + 0.3, 2 + rng() * 2], rotationY });
    } else if (roll < 0.45) {
      blocks.push({ kind: "box", name: `wall_${i}`, surface: "wall", position: [cx, ground + 1, cz], size: [0.4, 3, 6 + rng() * 10], rotationY });
    } else {
      const w = 6 + rng() * 10;
      const d = 6 + rng() * 10;
      const h = 3 + rng() * 7;
      blocks.push({ kind: "box", name: `house_${i}`, surface: "wall", position: [cx, ground + h / 2 - 1, cz], size: [w, h + 2, d], rotationY });
    }
  }
  return blocks;
}

export function spawnPoint(o: ScenarioOptions, index: number): { x: number; y: number; z: number } {
  const [tx, tz] = TOWNS[index % TOWNS.length]!;
  const a = (index * 2.39996) % (Math.PI * 2);
  const x = tx + Math.cos(a) * 25;
  const z = tz + Math.sin(a) * 25;
  return { x, y: terrainHeight(x, z) + 3, z };
}

/** A different player from the shooter's town (players are assigned to towns round-robin), so shots have line of sight more often. */
export function sameTownTarget(shooter: number, players: number, rng: () => number): number {
  const candidates: number[] = [];
  for (let i = shooter % TOWNS.length; i < players; i += TOWNS.length) if (i !== shooter) candidates.push(i);
  return candidates.length > 0 ? candidates[Math.floor(rng() * candidates.length)]! : Math.floor(rng() * players);
}

/** 20 hitboxes approximating the Mixamo bone roles used for hit detection (offsets from the feet, facing +Z). */
export interface HitboxSpec {
  readonly name: string;
  readonly kind: "sphere" | "box" | "capsule";
  readonly offset: readonly [number, number, number];
  /** Sphere/capsule radius or box half extents. */
  readonly size: readonly [number, number, number];
  /** Swing amplitude (m) and phase for the synthetic locomotion cycle. */
  readonly swing: number;
  readonly phase: number;
}

export const HITBOX_SPECS: readonly HitboxSpec[] = (() => {
  const specs: HitboxSpec[] = [
    { name: "head", kind: "sphere", offset: [0, 1.66, 0.02], size: [0.12, 0, 0], swing: 0.01, phase: 0 },
    { name: "neck", kind: "capsule", offset: [0, 1.52, 0], size: [0.06, 0.06, 0], swing: 0.01, phase: 0 },
    { name: "chest", kind: "box", offset: [0, 1.32, 0], size: [0.2, 0.14, 0.13], swing: 0.01, phase: 0 },
    { name: "spine", kind: "box", offset: [0, 1.12, 0], size: [0.17, 0.1, 0.11], swing: 0.01, phase: 0 },
    { name: "hips", kind: "box", offset: [0, 0.95, 0], size: [0.17, 0.1, 0.12], swing: 0.02, phase: 0 },
  ];
  for (const side of [-1, 1] as const) {
    const s = side < 0 ? "L" : "R";
    const p = side < 0 ? 0 : Math.PI;
    specs.push(
      { name: `shoulder${s}`, kind: "sphere", offset: [0.2 * side, 1.42, 0], size: [0.07, 0, 0], swing: 0.02, phase: p },
      { name: `upperArm${s}`, kind: "capsule", offset: [0.3 * side, 1.25, 0], size: [0.055, 0.12, 0], swing: 0.08, phase: p },
      { name: `forearm${s}`, kind: "capsule", offset: [0.34 * side, 1.02, 0.05], size: [0.045, 0.11, 0], swing: 0.12, phase: p },
      { name: `hand${s}`, kind: "sphere", offset: [0.35 * side, 0.85, 0.08], size: [0.05, 0, 0], swing: 0.15, phase: p },
      { name: `upLeg${s}`, kind: "capsule", offset: [0.1 * side, 0.72, 0], size: [0.08, 0.14, 0], swing: 0.1, phase: p + Math.PI },
      { name: `leg${s}`, kind: "capsule", offset: [0.1 * side, 0.32, 0], size: [0.06, 0.15, 0], swing: 0.18, phase: p + Math.PI },
    );
  }
  specs.push(
    { name: "footL", kind: "box", offset: [-0.1, 0.05, 0.06], size: [0.05, 0.04, 0.12], swing: 0.22, phase: Math.PI },
    { name: "footR", kind: "box", offset: [0.1, 0.05, 0.06], size: [0.05, 0.04, 0.12], swing: 0.22, phase: 0 },
    { name: "spine2", kind: "box", offset: [0, 1.22, 0], size: [0.18, 0.08, 0.12], swing: 0.01, phase: 0 },
  );
  return specs;
})();

/**
 * World-space pose of hitbox `spec` for a player at `feet` facing `yaw` at time `t`: a gait swing along the facing
 * axis plus a small bob, and a yaw + pitch-swing quaternion. Writes into out[0..6] = x, y, z, qx, qy, qz, qw.
 */
export function hitboxPose(spec: HitboxSpec, feetX: number, feetY: number, feetZ: number, yaw: number, t: number, out: Float64Array, o = 0): void {
  const swing = Math.sin(t * 9 + spec.phase) * spec.swing;
  const lx = spec.offset[0];
  const ly = spec.offset[1] + Math.abs(swing) * 0.2;
  const lz = spec.offset[2] + swing;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  out[o] = feetX + lx * c + lz * s;
  out[o + 1] = feetY + ly;
  out[o + 2] = feetZ - lx * s + lz * c;
  // q = yaw(Y) * pitch(X) swing
  const hy = yaw / 2;
  const hp = swing * 1.5;
  const sy = Math.sin(hy);
  const cy = Math.cos(hy);
  const sp = Math.sin(hp);
  const cp = Math.cos(hp);
  out[o + 3] = cy * sp;
  out[o + 4] = sy * cp;
  out[o + 5] = -sy * sp;
  out[o + 6] = cy * cp;
}

/** Scripted random input: holds a movement intent for 0.5–2 s, jumps and crouches occasionally, and heads home when far from its town. */
export class InputScript {
  private readonly rng: () => number;
  private hold = 0;
  private forward = 0;
  private right = 0;
  private sprint = false;
  private crouch = false;
  private yaw: number;
  private yawRate = 0;
  private fire = false;
  private aim = false;
  private readonly home: readonly [number, number];

  constructor(seed: number, index: number) {
    this.rng = createRng(seed * 31 + index * 7919);
    this.yaw = this.rng() * Math.PI * 2;
    this.home = TOWNS[index % TOWNS.length]!;
  }

  next(x: number, z: number): { move: MoveInput; combat: CombatInput; weapon: WeaponId } {
    const rng = this.rng;
    if (this.hold-- <= 0) {
      this.hold = 30 + Math.floor(rng() * 90);
      this.forward = [1, 1, 1, 0, -1][Math.floor(rng() * 5)]!;
      this.right = [-1, 0, 0, 1][Math.floor(rng() * 4)]!;
      this.sprint = rng() < 0.5;
      this.crouch = rng() < 0.1;
      this.yawRate = (rng() - 0.5) * 0.06;
      this.fire = rng() < 0.3;
      this.aim = rng() < 0.3;
    }
    const dx = this.home[0] - x;
    const dz = this.home[1] - z;
    if (dx * dx + dz * dz > (TOWN_RADIUS + 20) ** 2) {
      this.yaw = Math.atan2(dx, dz);
      this.forward = 1;
    } else {
      this.yaw += this.yawRate;
    }
    return {
      move: {
        forward: this.forward,
        right: this.right,
        jump: rng() < 0.004,
        sprint: this.sprint,
        crouch: this.crouch,
        speedScale: this.aim ? 0.6 : 1,
        yaw: this.yaw,
        pitch: (rng() - 0.5) * 0.1,
      },
      combat: { fire: this.fire, aim: this.aim, reload: rng() < 0.002, selectIndex: rng() < 0.002 ? Math.floor(rng() * 4) : null },
      weapon: "rifle",
    };
  }
}
