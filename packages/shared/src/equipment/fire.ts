import type { Vec3 } from "../movement/types";
import type { RaycastFn } from "../weapons/types";
import type { EntitySample } from "./explosion";
import { createRng, len2 } from "./math";

export const FIRE = {
  /** Ground grid spacing, m. */
  cellSize: 1,
  /** Burn time per cell from ignition, s (edges burn out a little sooner). */
  lifetime: 10,
  /** Seeded per-cell lifetime variation, ± s. */
  lifetimeJitter: 0.6,
  /** Spread budget in meters of flat ground; slopes spend it faster uphill and slower downhill. */
  spreadBudget: 3.2,
  /** Extra cost per meter climbed and discount per meter descended. */
  uphillCost: 2.5,
  downhillDiscount: 0.5,
  /** Ignition wave speed across the budget, m/s. */
  spreadSpeed: 4,
  /** Largest height change between neighbouring cells (ledges and curbs stop the fire), m. */
  maxStep: 0.5,
  /** Ground steeper than this doesn't burn (normal.y below cos 45°). */
  minNormalY: 0.707,
  maxCells: 40,
  /** Damage per tick to an entity standing in a burning cell; fire ignores armor. */
  damagePerTick: 5,
  /** Seconds between damage ticks (10 HP/s). */
  damageInterval: 0.5,
  /** Entity feet within this horizontal distance of a burning cell center, and this height band, take damage. m. */
  burnRadius: 0.8,
  burnHeight: 1.2,
  /** Molotov impacts on walls are pulled back along the normal before probing for ground, m. */
  wallOffset: 0.3,
  /** How far below the impact the ground probe reaches, m. */
  groundProbeDepth: 4,
} as const;

/** Floats per cell in FirePatch.cells: x, y, z (ground), igniteAt, dieAt (patch age, s). */
export const FIRE_CELL_STRIDE = 5;

export interface FirePatch {
  readonly id: number;
  readonly owner: number;
  readonly age: number;
  /** Number of damage ticks applied so far (ticks happen at age = (n + 1) × damageInterval). */
  readonly damageTicks: number;
  readonly cellCount: number;
  readonly cells: Float32Array;
  /** Latest dieAt of any cell. */
  readonly duration: number;
}

interface Cell {
  readonly i: number;
  readonly j: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly cost: number;
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * Spreads a fire patch from a molotov impact over the ground: a cheapest-first flood over a 1 m grid, where each step
 * probes the ground with a downward ray (must exist, be walkable and within maxStep of the previous cell) and checks
 * a knee-height ray between the two cells (walls, fences and closed doors stop it). Uphill steps cost more budget,
 * downhill less, so fire runs down slopes. Returns null when there is no ground under the impact (e.g. mid-air over a cliff).
 */
export function createFirePatch(id: number, owner: number, impact: Vec3, normal: Vec3, seed: number, raycast: RaycastFn): FirePatch | null {
  const F = FIRE;
  const start = { x: impact.x + normal.x * F.wallOffset, y: impact.y + Math.max(0, normal.y) * 0.1, z: impact.z + normal.z * F.wallOffset };
  const ground = raycast({ x: start.x, y: start.y + 0.5, z: start.z }, { x: start.x, y: start.y - F.groundProbeDepth, z: start.z });
  if (!ground || ground.normal.y < F.minNormalY) return null;

  const originX = ground.point.x;
  const originZ = ground.point.z;
  const cells: Cell[] = [{ i: 0, j: 0, x: originX, y: ground.point.y, z: originZ, cost: 0 }];
  const visited = new Set<string>(["0,0"]);
  const frontier: Cell[] = [cells[0]!];

  while (frontier.length > 0 && cells.length < F.maxCells) {
    frontier.sort((a, b) => a.cost - b.cost || a.i - b.i || a.j - b.j);
    const parent = frontier.shift()!;
    for (const [di, dj] of NEIGHBOURS) {
      const i = parent.i + di;
      const j = parent.j + dj;
      const key = `${i},${j}`;
      if (visited.has(key)) continue;
      const x = originX + i * F.cellSize;
      const z = originZ + j * F.cellSize;
      const step = F.cellSize * len2(di, dj);
      // Early out on budget before any raycast: even the best downhill step costs half its length.
      if (parent.cost + step * 0.5 > F.spreadBudget) continue;

      const probeTop = parent.y + F.maxStep + 0.25;
      const probe = raycast({ x, y: probeTop, z }, { x, y: parent.y - F.maxStep - 0.25, z });
      if (!probe || probe.normal.y < F.minNormalY) continue;
      const dy = probe.point.y - parent.y;
      if (Math.abs(dy) > F.maxStep) continue;
      const knee = 0.35;
      if (raycast({ x: parent.x, y: parent.y + knee, z: parent.z }, { x, y: probe.point.y + knee, z })) continue;

      const cost = parent.cost + Math.max(step * 0.5, step + F.uphillCost * Math.max(0, dy) - F.downhillDiscount * Math.max(0, -dy));
      if (cost > F.spreadBudget) continue;
      visited.add(key);
      const cell: Cell = { i, j, x, y: probe.point.y, z, cost };
      cells.push(cell);
      frontier.push(cell);
      if (cells.length >= F.maxCells) break;
    }
  }

  const random = createRng(seed);
  const data = new Float32Array(cells.length * FIRE_CELL_STRIDE);
  let duration = 0;
  cells.forEach((cell, k) => {
    const igniteAt = cell.cost / F.spreadSpeed;
    const edge = cell.cost / F.spreadBudget;
    const dieAt = igniteAt + F.lifetime - edge * 1.5 + (random() * 2 - 1) * F.lifetimeJitter;
    const o = k * FIRE_CELL_STRIDE;
    data[o] = cell.x;
    data[o + 1] = cell.y;
    data[o + 2] = cell.z;
    data[o + 3] = igniteAt;
    data[o + 4] = dieAt;
    duration = Math.max(duration, dieAt);
  });
  return { id, owner, age: 0, damageTicks: 0, cellCount: cells.length, cells: data, duration };
}

export interface FireStepResult {
  readonly patch: FirePatch;
  /** A damage tick happened this step: apply fireDamageTargets. */
  readonly damageTick: boolean;
}

export function stepFirePatch(patch: FirePatch, dt: number): FireStepResult {
  const age = patch.age + dt;
  // Integer tick count, so tick timing doesn't drift with float accumulation.
  const due = Math.floor(age / FIRE.damageInterval + 1e-6);
  const damageTick = due > patch.damageTicks;
  return { patch: { ...patch, age, damageTicks: due }, damageTick };
}

export function isFireExpired(patch: FirePatch): boolean {
  return patch.age >= patch.duration;
}

export function isCellBurning(patch: FirePatch, index: number): boolean {
  const o = index * FIRE_CELL_STRIDE;
  return patch.age >= patch.cells[o + 3]! && patch.age < patch.cells[o + 4]!;
}

export function burningCellCount(patch: FirePatch): number {
  let n = 0;
  for (let k = 0; k < patch.cellCount; k++) if (isCellBurning(patch, k)) n++;
  return n;
}

/** Entities standing in a burning cell of the patch (each at most once). */
export function fireDamageTargets(patch: FirePatch, entities: readonly EntitySample[]): number[] {
  const ids: number[] = [];
  const r2 = FIRE.burnRadius * FIRE.burnRadius;
  for (const entity of entities) {
    const { x, y, z } = entity.feet;
    for (let k = 0; k < patch.cellCount; k++) {
      if (!isCellBurning(patch, k)) continue;
      const o = k * FIRE_CELL_STRIDE;
      const dx = x - patch.cells[o]!;
      const dz = z - patch.cells[o + 2]!;
      const dy = y - patch.cells[o + 1]!;
      if (dx * dx + dz * dz <= r2 && dy > -0.3 && dy < FIRE.burnHeight) {
        ids.push(entity.id);
        break;
      }
    }
  }
  return ids;
}
