/**
 * "Direct" server match: Havok WASM driven through raw HP_* calls with no Babylon Scene/NullEngine and no
 * @babylonjs/core import at all. Player movement uses a minimal capsule collide-and-slide controller (shape casts,
 * step-up probe, ground snap) that feeds the shared `computeDesiredVelocity`, i.e. the "plan B" server controller.
 * Weapons and projectiles run the shared pure code unchanged.
 *
 * Query/transform arrays are allocated once and mutated per call; the embind layer still allocates on return
 * values (tuples, BigInt ids), which is inherent to @babylonjs/havok's JS API.
 */
import { MOVEMENT } from "../../../../packages/shared/src/constants.ts";
import { computeDesiredVelocity, createMoveState } from "../../../../packages/shared/src/movement/movement.ts";
import type { MoveInput, MoveState, Stance } from "../../../../packages/shared/src/movement/types.ts";
import { spawnProjectiles, stepProjectiles } from "../../../../packages/shared/src/weapons/ballistics.ts";
import type { Projectile, RayHit, RaycastFn, WeaponState } from "../../../../packages/shared/src/weapons/types.ts";
import { createWeaponState, stepWeapon } from "../../../../packages/shared/src/weapons/weaponStep.ts";
import { DEFAULT_LOADOUT } from "../../../../packages/shared/src/weapons/weapons.ts";
import { loadHavok, type HavokApi } from "./havok.ts";
import {
  BULLET_COLLIDE,
  HITBOX_SPECS,
  InputScript,
  LAYER,
  buildingBlocks,
  heightfieldBabylonOrder,
  hitboxPose,
  sameTownTarget,
  spawnPoint,
  terrainHeight,
  type ScenarioOptions,
} from "./scenario.ts";
import type { MatchLike, PhaseName } from "./match.ts";
import { createRng } from "./stats.ts";

const DT = 1 / 60;
/** Terrain/building shapes per Havok instance, for matches that share a map (shareStaticShapes). */
const STATIC_SHAPE_CACHE = new WeakMap<object, { terrain: unknown; buildings: unknown[] }>();
const KEEP = 0.05;
const SNAP = MOVEMENT.maxStepHeight;
const SUPPORT_PROBE = KEEP + 0.1;
const MAX_SLOPE_COS = Math.cos((MOVEMENT.maxSlopeDegrees * Math.PI) / 180);
const SLIDE_ITERATIONS = 4;

interface CastHit {
  fraction: number;
  nx: number;
  ny: number;
  nz: number;
  px: number;
  py: number;
  pz: number;
}

class DirectWorld {
  readonly castCollector: unknown;
  readonly rayCollector: unknown;
  private readonly castQuery: unknown[];
  private readonly castStart: number[] = [0, 0, 0];
  private readonly castEnd: number[] = [0, 0, 0];
  private readonly rayFrom: number[] = [0, 0, 0];
  private readonly rayTo: number[] = [0, 0, 0];
  private readonly rayFilter: number[] = [~0, ~0];
  private readonly rayQuery: unknown[];
  private readonly noBody: [bigint] = [BigInt(0)];
  readonly hit: CastHit = { fraction: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0 };

  readonly hk: HavokApi;
  readonly world: unknown;

  constructor(hk: HavokApi, world: unknown) {
    this.hk = hk;
    this.world = world;
    this.castCollector = hk.HP_QueryCollector_Create(1)[1];
    this.rayCollector = hk.HP_QueryCollector_Create(1)[1];
    this.castQuery = [null, [0, 0, 0, 1], this.castStart, this.castEnd, false, this.noBody];
    this.rayQuery = [this.rayFrom, this.rayTo, this.rayFilter, false, this.noBody];
  }

  shapeCast(shape: unknown, ignore: unknown, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): boolean {
    const q = this.castQuery;
    q[0] = shape;
    q[5] = ignore;
    this.castStart[0] = sx;
    this.castStart[1] = sy;
    this.castStart[2] = sz;
    this.castEnd[0] = ex;
    this.castEnd[1] = ey;
    this.castEnd[2] = ez;
    const hk = this.hk;
    hk.HP_World_ShapeCastWithCollector(this.world, this.castCollector, q);
    if (hk.HP_QueryCollector_GetNumHits(this.castCollector)[1] <= 0) return false;
    const [fraction, , hitShape] = hk.HP_QueryCollector_GetShapeCastResult(this.castCollector, 0)[1];
    const n = hitShape[4];
    const p = hitShape[3];
    const h = this.hit;
    h.fraction = fraction;
    h.nx = n[0];
    h.ny = n[1];
    h.nz = n[2];
    h.px = p[0];
    h.py = p[1];
    h.pz = p[2];
    return true;
  }

  /** Closest hit along a segment; writes fraction/point/normal to `hit` and returns the hit body id (or null). */
  raycast(membership: number, collide: number, hitTriggers: boolean, ignore: unknown, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): bigint | null {
    this.rayFrom[0] = fx;
    this.rayFrom[1] = fy;
    this.rayFrom[2] = fz;
    this.rayTo[0] = tx;
    this.rayTo[1] = ty;
    this.rayTo[2] = tz;
    this.rayFilter[0] = membership;
    this.rayFilter[1] = collide;
    this.rayQuery[3] = hitTriggers;
    this.rayQuery[4] = ignore;
    const hk = this.hk;
    hk.HP_World_CastRayWithCollector(this.world, this.rayCollector, this.rayQuery);
    if (hk.HP_QueryCollector_GetNumHits(this.rayCollector)[1] <= 0) return null;
    const [fraction, contact] = hk.HP_QueryCollector_GetCastRayResult(this.rayCollector, 0)[1];
    const h = this.hit;
    h.fraction = fraction;
    h.px = contact[3][0];
    h.py = contact[3][1];
    h.pz = contact[3][2];
    h.nx = contact[4][0];
    h.ny = contact[4][1];
    h.nz = contact[4][2];
    return contact[0][0] as bigint;
  }
}

/** Minimal server-side character controller: capsule sweeps only, no simplex solver or contact manifold. */
class CapsuleController {
  readonly body: unknown;
  private readonly standShape: unknown;
  private readonly crouchShape: unknown;
  private readonly headProbe: unknown;
  private readonly transform: [number[], number[]] = [[0, 0, 0], [0, 0, 0, 1]];
  /** Capsule center. */
  x: number;
  y: number;
  z: number;
  private stance: Stance = "stand";
  stepUps = 0;

  private readonly w: DirectWorld;

  constructor(w: DirectWorld, feet: { x: number; y: number; z: number }, shapes: { stand: unknown; crouch: unknown; head: unknown }) {
    this.w = w;
    const hk = w.hk;
    this.standShape = shapes.stand;
    this.crouchShape = shapes.crouch;
    this.headProbe = shapes.head;
    this.body = hk.HP_Body_Create()[1];
    hk.HP_Body_SetShape(this.body, this.standShape);
    hk.HP_Body_SetMotionType(this.body, hk.MotionType.KINEMATIC);
    this.x = feet.x;
    this.y = feet.y + KEEP + MOVEMENT.standHeight / 2;
    this.z = feet.z;
    this.syncBody();
    hk.HP_World_AddBody(w.world, this.body, false);
  }

  get feetY(): number {
    return this.y - this.halfHeight - KEEP;
  }

  private get halfHeight(): number {
    return (this.stance === "crouch" ? MOVEMENT.crouchHeight : MOVEMENT.standHeight) / 2;
  }

  private get shape(): unknown {
    return this.stance === "crouch" ? this.crouchShape : this.standShape;
  }

  private syncBody(): void {
    const t = this.transform[0];
    t[0] = this.x;
    t[1] = this.y;
    t[2] = this.z;
    this.w.hk.HP_Body_SetQTransform(this.body, this.transform);
  }

  step(state: MoveState, input: MoveInput, dt: number): MoveState {
    const w = this.w;
    const hit = w.hit;
    // Support query: sweep the capsule a little below its skin.
    let supported = false;
    let gnx = 0;
    let gny = 1;
    let gnz = 0;
    if (w.shapeCast(this.shape, this.body, this.x, this.y, this.z, this.x, this.y - SUPPORT_PROBE, this.z) && hit.ny >= MAX_SLOPE_COS) {
      supported = true;
      gnx = hit.nx;
      gny = hit.ny;
      gnz = hit.nz;
    }
    let canStand = true;
    if (state.stance === "crouch" && !input.crouch) {
      const bottom = this.y - this.halfHeight;
      const r = MOVEMENT.capsuleRadius;
      canStand = !w.shapeCast(this.headProbe, this.body, this.x, bottom + MOVEMENT.crouchHeight - r, this.z, this.x, bottom + MOVEMENT.standHeight - r + KEEP, this.z);
    }
    const next = computeDesiredVelocity(state, input, { supported, groundNormal: { x: gnx, y: gny, z: gnz }, canStand }, dt);
    if (next.stance !== this.stance) {
      const feet = this.y - this.halfHeight;
      this.stance = next.stance;
      this.y = feet + this.halfHeight;
      w.hk.HP_Body_SetShape(this.body, this.shape);
    }

    // Collide and slide.
    let vx = next.velocity.x;
    let vy = next.velocity.y;
    let vz = next.velocity.z;
    let dx = vx * dt;
    let dy = vy * dt;
    let dz = vz * dt;
    const startX = this.x;
    const startZ = this.z;
    for (let i = 0; i < SLIDE_ITERATIONS; i++) {
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-5) break;
      if (!w.shapeCast(this.shape, this.body, this.x, this.y, this.z, this.x + dx, this.y + dy, this.z + dz)) {
        this.x += dx;
        this.y += dy;
        this.z += dz;
        break;
      }
      const into = hit.nx * dx + hit.ny * dy + hit.nz * dz;
      if (hit.fraction <= 0 && into >= 0) {
        this.x += dx;
        this.y += dy;
        this.z += dz;
        break;
      }
      const travel = Math.max(0, hit.fraction * len - KEEP);
      const s = travel / len;
      this.x += dx * s;
      this.y += dy * s;
      this.z += dz * s;
      const rest = 1 - s;
      dx *= rest;
      dy *= rest;
      dz *= rest;
      const dn = hit.nx * dx + hit.ny * dy + hit.nz * dz;
      if (dn < 0) {
        dx -= hit.nx * dn;
        dy -= hit.ny * dn;
        dz -= hit.nz * dn;
      }
      const vn = hit.nx * vx + hit.ny * vy + hit.nz * vz;
      if (vn < 0) {
        vx -= hit.nx * vn;
        vy -= hit.ny * vn;
        vz -= hit.nz * vn;
      }
      if (hit.fraction <= 0) {
        // Penetration recovery: push out along the contact normal.
        this.x += hit.nx * KEEP;
        this.y += hit.ny * KEEP;
        this.z += hit.nz * KEEP;
      }
    }

    let stepped = false;
    if (next.grounded) {
      stepped = this.tryStepUp(startX, startZ, next.velocity.x, next.velocity.z, dt);
      if (stepped) {
        vx = next.velocity.x;
        vy = 0;
        vz = next.velocity.z;
        this.stepUps++;
      } else if (w.shapeCast(this.shape, this.body, this.x, this.y, this.z, this.x, this.y - SNAP - KEEP, this.z)) {
        if (hit.fraction > 0 && hit.ny >= MAX_SLOPE_COS) {
          const drop = hit.fraction * (SNAP + KEEP) - KEEP;
          if (Math.abs(drop) > 1e-4) this.y -= drop;
        }
      }
    }
    this.syncBody();
    return { ...next, velocity: { x: vx, y: vy, z: vz } };
  }

  private tryStepUp(startX: number, startZ: number, vx: number, vz: number, dt: number): boolean {
    const w = this.w;
    const hit = w.hit;
    const wanted = Math.hypot(vx, vz) * dt;
    if (wanted < 1e-3) return false;
    const dirX = (vx * dt) / wanted;
    const dirZ = (vz * dt) / wanted;
    const achieved = (this.x - startX) * dirX + (this.z - startZ) * dirZ;
    if (achieved >= wanted * 0.9) return false;
    const feetY = this.feetY;
    const reach = MOVEMENT.capsuleRadius + 0.1;
    const px = this.x + dirX * reach;
    const pz = this.z + dirZ * reach;
    if (w.raycast(LAYER.player, LAYER.world, false, this.body, px, feetY + MOVEMENT.maxStepHeight + KEEP, pz, px, feetY + 0.02, pz) === null) return false;
    if (hit.ny < MAX_SLOPE_COS) return false;
    const rise = hit.py - feetY;
    if (rise < 0.02 || rise > MOVEMENT.maxStepHeight) return false;
    const liftedY = this.y + rise;
    if (w.shapeCast(this.shape, this.body, this.x, this.y, this.z, this.x, liftedY + KEEP, this.z)) return false;
    const remaining = wanted - Math.max(0, achieved);
    const len = remaining + KEEP;
    const free = w.shapeCast(this.shape, this.body, this.x, liftedY, this.z, this.x + dirX * len, liftedY, this.z + dirZ * len) ? hit.fraction * len - KEEP : remaining;
    if (free <= 0) return false;
    this.x += dirX * free;
    this.y = liftedY;
    this.z += dirZ * free;
    return true;
  }
}

interface PlayerSlot {
  controller: CapsuleController;
  script: InputScript;
  move: MoveState;
  weapon: WeaponState;
  yaw: number;
  hitboxBodies: unknown[];
}

export class DirectMatch implements MatchLike {
  readonly mode = "direct";
  readonly phases: readonly PhaseName[] = ["move", "weapons", "hitboxes", "worldStep", "projectiles"];
  readonly setupMs: Record<string, number> = {};
  hk!: HavokApi;
  private w!: DirectWorld;
  private players: PlayerSlot[] = [];
  private projectiles: readonly Projectile[] = [];
  private nextProjectileId = 1;
  private time = 0;
  private readonly pose = new Float64Array(7);
  private readonly hitboxTransform: [number[], number[]] = [[0, 0, 0], [0, 0, 0, 1]];
  private readonly hitboxOwner = new Map<bigint, string>();
  private readonly rng: () => number;
  private readonly stats = { hitboxImpacts: 0, worldImpacts: 0, expired: 0, spawned: 0, belowTerrain: 0, groundedTicks: 0, playerTicks: 0, shots: 0 };
  private raycast!: RaycastFn;

  private readonly o: ScenarioOptions;

  constructor(o: ScenarioOptions) {
    this.o = o;
    this.rng = createRng(o.seed ^ 0x5eed);
  }

  /** `sharedHavok`: reuse one Havok WASM instance (one heap, many worlds) instead of instantiating one per match. */
  async setup(module?: WebAssembly.Module, sharedHavok?: HavokApi): Promise<void> {
    let t = performance.now();
    const lap = (name: string): void => {
      const now = performance.now();
      this.setupMs[name] = Math.round((now - t) * 100) / 100;
      t = now;
    };
    const hk = (this.hk = sharedHavok ?? (await loadHavok(module)));
    lap("havokInit");
    const world = hk.HP_World_Create()[1];
    hk.HP_World_SetGravity(world, [0, -MOVEMENT.gravity, 0]);
    hk.HP_World_SetIdealStepTime(world, DT);
    const w = (this.w = new DirectWorld(hk, world));

    // Static level: terrain heightfield + one shape per building block (like buildLevel). With shareStaticShapes,
    // shapes are created once per Havok instance and only bodies are created per world.
    const o = this.o;
    let statics = o.shareStaticShapes ? STATIC_SHAPE_CACHE.get(hk) : undefined;
    const blocks = buildingBlocks(o);
    if (!statics) {
      const n = o.heightfieldSamples;
      const bjs = heightfieldBabylonOrder(o);
      const ptr = hk._malloc(n * n * 4);
      const heights = new Float32Array(hk.HEAPU8.buffer, ptr, n * n);
      for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) heights[z * n + x] = bjs[(n - 1 - x) * n + z]!;
      const step = o.mapSize / (n - 1);
      const terrain = hk.HP_Shape_CreateHeightField(n, n, [step, 1, step], ptr)[1];
      hk._free(ptr);
      hk.HP_Shape_SetFilterInfo(terrain, [LAYER.world, ~0]);
      const buildings = blocks.map((block) => {
        const [sx, sy, sz] = block.size;
        let shape: unknown;
        if (block.kind === "box") {
          shape = hk.HP_Shape_CreateBox([0, 0, 0], [0, 0, 0, 1], [sx, sy, sz])[1];
        } else {
          const hx = sx / 2;
          const hy = sy / 2;
          const hz = sz / 2;
          const verts = [-hx, -hy, -hz, hx, -hy, -hz, -hx, hy, hz, hx, hy, hz, -hx, -hy, hz, hx, -hy, hz];
          const vptr = hk._malloc(verts.length * 4);
          new Float32Array(hk.HEAPU8.buffer, vptr, verts.length).set(verts);
          shape = hk.HP_Shape_CreateConvexHull(vptr, verts.length / 3)[1];
          hk._free(vptr);
        }
        hk.HP_Shape_SetFilterInfo(shape, [LAYER.world, ~0]);
        return shape;
      });
      statics = { terrain, buildings };
      if (o.shareStaticShapes) STATIC_SHAPE_CACHE.set(hk, statics);
    }
    this.addStatic(statics.terrain, [0, 0, 0], [0, 0, 0, 1]);
    lap("terrain");
    blocks.forEach((block, i) => {
      const half = (block.rotationY ?? 0) / 2;
      this.addStatic(statics.buildings[i], [...block.position], [0, Math.sin(half), 0, Math.cos(half)]);
    });
    lap("buildings");

    // Players: controller capsules plus shared hitbox shapes (one per bone role, reused by every player).
    const r = MOVEMENT.capsuleRadius;
    const capsule = (h: number): unknown => {
      const s = hk.HP_Shape_CreateCapsule([0, h / 2 - r, 0], [0, -h / 2 + r, 0], r)[1];
      hk.HP_Shape_SetFilterInfo(s, [LAYER.player, LAYER.world | LAYER.player]);
      return s;
    };
    const head = hk.HP_Shape_CreateSphere([0, 0, 0], r - KEEP)[1];
    hk.HP_Shape_SetFilterInfo(head, [LAYER.player, LAYER.world | LAYER.player]);
    const controllerShapes = { stand: capsule(MOVEMENT.standHeight), crouch: capsule(MOVEMENT.crouchHeight), head };
    const hitboxShapes = HITBOX_SPECS.slice(0, o.hitboxesPerPlayer).map((spec) => {
      const [a, b, c] = spec.size;
      const shape =
        spec.kind === "sphere"
          ? hk.HP_Shape_CreateSphere([0, 0, 0], a)[1]
          : spec.kind === "box"
            ? hk.HP_Shape_CreateBox([0, 0, 0], [0, 0, 0, 1], [a * 2, b * 2, c * 2])[1]
            : hk.HP_Shape_CreateCapsule([0, -b, 0], [0, b, 0], a)[1];
      hk.HP_Shape_SetFilterInfo(shape, [LAYER.hitbox, LAYER.bulletQuery]);
      hk.HP_Shape_SetTrigger(shape, true);
      return shape;
    });
    for (let i = 0; i < o.players; i++) {
      const feet = spawnPoint(o, i);
      const controller = new CapsuleController(w, feet, controllerShapes);
      const hitboxBodies = hitboxShapes.map((shape, k) => {
        const body = hk.HP_Body_Create()[1];
        hk.HP_Body_SetShape(body, shape);
        hk.HP_Body_SetMotionType(body, hk.MotionType.KINEMATIC);
        hk.HP_Body_SetQTransform(body, [[feet.x, feet.y + 1, feet.z], [0, 0, 0, 1]]);
        hk.HP_World_AddBody(world, body, false);
        this.hitboxOwner.set(body[0] as bigint, `p${i}:${HITBOX_SPECS[k]!.name}`);
        return body;
      });
      this.players.push({ controller, script: new InputScript(o.seed, i), move: createMoveState(), weapon: createWeaponState(DEFAULT_LOADOUT), yaw: 0, hitboxBodies });
    }
    hk.HP_World_Step(world, DT);
    lap("playersAndHitboxes");

    const noBody: [bigint] = [BigInt(0)];
    this.raycast = (from, to): RayHit | null => {
      const bodyId = w.raycast(LAYER.bulletQuery, BULLET_COLLIDE, true, noBody, from.x, from.y, from.z, to.x, to.y, to.z);
      if (bodyId === null) return null;
      const h = w.hit;
      return {
        point: { x: h.px, y: h.py, z: h.pz },
        normal: { x: h.nx, y: h.ny, z: h.nz },
        fraction: h.fraction,
        colliderId: this.hitboxOwner.get(bodyId) ?? null,
      };
    };
  }

  private addStatic(shape: unknown, position: number[], rotation: number[]): void {
    const hk = this.hk;
    const body = hk.HP_Body_Create()[1];
    hk.HP_Body_SetShape(body, shape);
    hk.HP_Body_SetMotionType(body, hk.MotionType.STATIC);
    hk.HP_Body_SetQTransform(body, [position, rotation]);
    hk.HP_World_AddBody(this.w.world, body, false);
  }

  tick(out: Float64Array): void {
    const hk = this.hk;
    let t0 = performance.now();
    let t1: number;
    const players = this.players;

    // 1. Inputs + movement.
    for (const p of players) {
      const c = p.controller;
      const input = p.script.next(c.x, c.z);
      (p as { lastInput?: unknown }).lastInput = input;
      p.move = c.step(p.move, input.move, DT);
      p.yaw = input.move.yaw;
      this.stats.playerTicks++;
      if (p.move.grounded) this.stats.groundedTicks++;
      if (c.feetY < terrainHeight(c.x, c.z) - 1.5) this.stats.belowTerrain++;
    }
    t1 = performance.now();
    out[0] = t1 - t0;
    t0 = t1;

    // 2. Weapons (shared pure code). Shots are counted; the projectile population is controlled separately below.
    for (const p of players) {
      const input = (p as unknown as { lastInput: ReturnType<InputScript["next"]> }).lastInput;
      const c = p.controller;
      const result = stepWeapon(
        p.weapon,
        input.combat,
        {
          eye: { x: c.x, y: c.feetY + MOVEMENT.standEyeHeight, z: c.z },
          yaw: input.move.yaw,
          pitch: input.move.pitch,
          horizontalSpeed: Math.hypot(p.move.velocity.x, p.move.velocity.z),
          grounded: p.move.grounded,
          sprinting: p.move.sprinting,
        },
        DT,
      );
      p.weapon = result.state;
      this.stats.shots += result.shots.length;
    }
    t1 = performance.now();
    out[1] = t1 - t0;
    t0 = t1;

    // 3. Hitbox poses → kinematic bodies (teleport).
    this.time += DT;
    const pose = this.pose;
    const tr = this.hitboxTransform;
    for (const p of players) {
      const c = p.controller;
      const feetY = c.feetY;
      for (let k = 0; k < p.hitboxBodies.length; k++) {
        hitboxPose(HITBOX_SPECS[k]!, c.x, feetY, c.z, p.yaw, this.time, pose);
        tr[0][0] = pose[0]!;
        tr[0][1] = pose[1]!;
        tr[0][2] = pose[2]!;
        tr[1][0] = pose[3]!;
        tr[1][1] = pose[4]!;
        tr[1][2] = pose[5]!;
        tr[1][3] = pose[6]!;
        hk.HP_Body_SetQTransform(p.hitboxBodies[k], tr);
      }
    }
    t1 = performance.now();
    out[2] = t1 - t0;
    t0 = t1;

    // 4. World step (refreshes the broadphase for moved bodies).
    hk.HP_World_Step(this.w.world, DT);
    t1 = performance.now();
    out[3] = t1 - t0;
    t0 = t1;

    // 5. Projectiles: top up the population, then fly them with segment raycasts.
    this.projectiles = this.flyProjectiles();
    t1 = performance.now();
    out[4] = t1 - t0;
  }

  private flyProjectiles(): readonly Projectile[] {
    let list = this.projectiles as Projectile[];
    if (list.length < this.o.projectiles) {
      list = list.slice();
      const rng = this.rng;
      const players = this.players;
      while (list.length < this.o.projectiles) {
        const shooterIndex = Math.floor(rng() * players.length);
        const c = players[shooterIndex]!.controller;
        let dx: number;
        let dy: number;
        let dz: number;
        if (rng() < 0.6) {
          const target = players[sameTownTarget(shooterIndex, players.length, rng)]!.controller;
          dx = target.x - c.x + (rng() - 0.5) * 1.5;
          dy = target.feetY + 1.2 - (c.feetY + MOVEMENT.standEyeHeight) + (rng() - 0.5);
          dz = target.z - c.z + (rng() - 0.5) * 1.5;
        } else {
          const a = rng() * Math.PI * 2;
          dx = Math.sin(a);
          dy = (rng() - 0.5) * 0.04;
          dz = Math.cos(a);
        }
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len;
        dy /= len;
        dz /= len;
        const eyeY = c.feetY + MOVEMENT.standEyeHeight;
        const spawned = spawnProjectiles(
          { weaponId: "rifle", shotId: this.nextProjectileId, origin: { x: c.x + dx * 0.6, y: eyeY + dy * 0.6, z: c.z + dz * 0.6 }, directions: [{ x: dx, y: dy, z: dz }], recoilUp: 0, recoilRight: 0 },
          () => this.nextProjectileId++,
        );
        list.push(...spawned);
        this.stats.spawned++;
      }
    }
    const result = stepProjectiles(list, DT, this.raycast);
    for (const impact of result.impacts) {
      if (impact.hit.colliderId !== null) this.stats.hitboxImpacts++;
      else this.stats.worldImpacts++;
    }
    this.stats.expired += result.expired.length;
    return result.alive;
  }

  sanity(): Record<string, number> {
    const s = this.stats;
    return {
      ...s,
      groundedRatio: Math.round((s.groundedTicks / Math.max(1, s.playerTicks)) * 1000) / 1000,
      stepUps: this.players.reduce((sum, p) => sum + p.controller.stepUps, 0),
      meanHorizontalSpeed: Math.round((this.players.reduce((sum, p) => sum + Math.hypot(p.move.velocity.x, p.move.velocity.z), 0) / this.players.length) * 100) / 100,
    };
  }

  dispose(): void {
    // Havok instance memory is released with the isolate/thread; nothing to do for a benchmark.
  }
}
