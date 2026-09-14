/**
 * "Babylon" server match: NullEngine + Scene + HavokPlugin, exactly the client code path.
 *  - Level blocks go through `@twobullets/sim`'s `buildLevel` (Mesh + VertexData + PhysicsAggregate).
 *  - Players use the sim's `CharacterBody` (Babylon PhysicsCharacterController + step-up/ground-snap shape casts).
 *  - Hitboxes are ANIMATED trigger PhysicsBodies on TransformNodes with the TELEPORT prestep (like TargetDummy).
 *  - Bullets use the sim's `WorldRaycaster` (hitbox triggers included) through `stepProjectiles`.
 *  - The world is advanced with scene._advancePhysicsEngineStep (what scene.render() calls), or with a full
 *    scene.render() in "babylon-render" mode to price a naive NullEngine render loop.
 */
import type { MatchLike, PhaseName } from "./match.ts";
import { loadHavok, type HavokApi } from "./havok.ts";
import { BULLET_COLLIDE, HITBOX_SPECS, InputScript, LAYER, buildingBlocks, sameTownTarget, heightfieldBabylonOrder, hitboxPose, spawnPoint, terrainHeight, type ScenarioOptions } from "./scenario.ts";
import { createRng } from "./stats.ts";

const DT = 1 / 60;

/* eslint-disable @typescript-eslint/no-explicit-any */
export class BabylonMatch implements MatchLike {
  readonly mode: string;
  readonly phases: readonly PhaseName[];
  readonly setupMs: Record<string, number> = {};
  hk!: HavokApi;
  private readonly o: ScenarioOptions;
  private readonly render: boolean;
  private B: any;
  private S: any;
  private scene: any;
  private players: any[] = [];
  private projectiles: readonly any[] = [];
  private raycast!: (from: any, to: any) => any;
  private nextProjectileId = 1;
  private time = 0;
  private readonly pose = new Float64Array(7);
  private readonly rng: () => number;
  private readonly stats = { hitboxImpacts: 0, worldImpacts: 0, expired: 0, spawned: 0, belowTerrain: 0, groundedTicks: 0, playerTicks: 0, shots: 0 };
  private feet: any;
  private a3: any;
  private b3: any;

  constructor(o: ScenarioOptions, render: boolean) {
    this.o = o;
    this.render = render;
    this.mode = render ? "babylon-render" : "babylon";
    this.phases = render ? ["move", "weapons", "hitboxes", "render", "projectiles"] : ["move", "weapons", "hitboxes", "worldStep", "projectiles"];
    this.rng = createRng(o.seed ^ 0x5eed);
  }

  async setup(module?: WebAssembly.Module, sharedHavok?: HavokApi): Promise<void> {
    let t = performance.now();
    const lap = (name: string): void => {
      const now = performance.now();
      this.setupMs[name] = Math.round((now - t) * 100) / 100;
      t = now;
    };
    const hk = (this.hk = sharedHavok ?? (await loadHavok(module)));
    lap("havokInit");
    const B = (this.B = await import("@babylonjs/core"));
    lap("importBabylonCore");
    const S = (this.S = await import("../../../../packages/shared/src/index.ts"));
    // T3.1 moved CharacterBody, the raycaster and buildLevel into packages/sim (lib/resolve.ts maps the specifier).
    const Sim = await import("@twobullets/sim");
    lap("importSimCode");

    this.feet = new B.Vector3();
    this.a3 = new B.Vector3();
    this.b3 = new B.Vector3();
    const engine = new B.NullEngine();
    const scene = (this.scene = new B.Scene(engine));
    // A naive NullEngine render loop still needs an active camera.
    if (this.render) new B.FreeCamera("serverCamera", new B.Vector3(0, 50, 0), scene);
    // Fixed world step (the client uses delta time; a server steps exactly 1/60).
    scene.enablePhysics(new B.Vector3(0, -S.MOVEMENT.gravity, 0), new B.HavokPlugin(false, hk));
    lap("sceneAndPlugin");

    const o = this.o;
    const n = o.heightfieldSamples;
    const terrainShape = new B.PhysicsShapeHeightField(o.mapSize, o.mapSize, n, n, heightfieldBabylonOrder(o), scene);
    terrainShape.filterMembershipMask = LAYER.world;
    const terrainNode = new B.TransformNode("terrain", scene);
    const terrainBody = new B.PhysicsBody(terrainNode, B.PhysicsMotionType.STATIC, false, scene);
    terrainBody.shape = terrainShape;
    lap("terrain");

    const built = Sim.buildLevel(scene, { name: "bench", blocks: buildingBlocks(o), spawnPoints: [], targets: [], killY: -100 });
    for (const mesh of built.meshes) mesh.physicsBody.shape.filterMembershipMask = LAYER.world;
    lap("buildings");

    const colliderIds = new Map<unknown, string>();
    const hitboxShapes = HITBOX_SPECS.slice(0, o.hitboxesPerPlayer).map((spec) => {
      const [a, b, c] = spec.size;
      const shape =
        spec.kind === "sphere"
          ? new B.PhysicsShapeSphere(B.Vector3.Zero(), a, scene)
          : spec.kind === "box"
            ? new B.PhysicsShapeBox(B.Vector3.Zero(), B.Quaternion.Identity(), new B.Vector3(a * 2, b * 2, c * 2), scene)
            : new B.PhysicsShapeCapsule(new B.Vector3(0, -b, 0), new B.Vector3(0, b, 0), a, scene);
      shape.isTrigger = true;
      shape.filterMembershipMask = LAYER.hitbox;
      shape.filterCollideMask = LAYER.bulletQuery;
      return shape;
    });
    for (let i = 0; i < o.players; i++) {
      const spawn = spawnPoint(o, i);
      const body = new Sim.CharacterBody(scene, spawn);
      this.applyPlayerFilter(body);
      const hitboxes = hitboxShapes.map((shape, k) => {
        const node = new B.TransformNode(`hb_${i}_${k}`, scene);
        node.position.set(spawn.x, spawn.y + 1, spawn.z);
        node.rotationQuaternion = B.Quaternion.Identity();
        const hb = new B.PhysicsBody(node, B.PhysicsMotionType.ANIMATED, false, scene);
        hb.shape = shape;
        hb.disablePreStep = false;
        hb.disableSync = true;
        colliderIds.set(hb, `p${i}:${HITBOX_SPECS[k]!.name}`);
        return node;
      });
      this.players.push({ body, script: new InputScript(o.seed, i), move: S.createMoveState(), weapon: S.createWeaponState(S.DEFAULT_LOADOUT), yaw: 0, hitboxes, shape: null, input: null });
    }
    const raycaster = new Sim.WorldRaycaster(scene, {
      collideWith: BULLET_COLLIDE,
      shouldHitTriggers: true,
      colliderIdOf: (body) => (body ? (colliderIds.get(body) ?? null) : null),
    });
    (raycaster as any).query.membership = LAYER.bulletQuery;
    this.raycast = raycaster.cast;
    scene._advancePhysicsEngineStep(1000 / 60);
    lap("playersAndHitboxes");
  }

  /** CharacterBody recreates its capsule on stance changes, so re-apply the player filter whenever the shape changes. */
  private applyPlayerFilter(body: any): void {
    const shape = body.controller.shape;
    shape.filterMembershipMask = LAYER.player;
    shape.filterCollideMask = LAYER.world | LAYER.player;
  }

  tick(out: Float64Array): void {
    const S = this.S;
    const scene = this.scene;
    const feet = this.feet;
    let t0 = performance.now();
    let t1: number;
    scene._frameId++;

    for (const p of this.players) {
      p.body.getFeetToRef(feet);
      p.input = p.script.next(feet.x, feet.z);
      p.move = p.body.step(p.move, p.input.move, DT);
      p.yaw = p.input.move.yaw;
      if (p.body.controller.shape !== p.shape) {
        this.applyPlayerFilter(p.body);
        p.shape = p.body.controller.shape;
      }
      this.stats.playerTicks++;
      if (p.move.grounded) this.stats.groundedTicks++;
    }
    t1 = performance.now();
    out[0] = t1 - t0;
    t0 = t1;

    for (const p of this.players) {
      p.body.getFeetToRef(feet);
      const result = S.stepWeapon(
        p.weapon,
        p.input.combat,
        {
          eye: { x: feet.x, y: feet.y + S.MOVEMENT.standEyeHeight, z: feet.z },
          yaw: p.input.move.yaw,
          pitch: p.input.move.pitch,
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

    this.time += DT;
    const pose = this.pose;
    for (const p of this.players) {
      p.body.getFeetToRef(feet);
      if (feet.y < terrainHeight(feet.x, feet.z) - 1.5) this.stats.belowTerrain++;
      for (let k = 0; k < p.hitboxes.length; k++) {
        hitboxPose(HITBOX_SPECS[k]!, feet.x, feet.y, feet.z, p.yaw, this.time, pose);
        const node = p.hitboxes[k];
        node.position.set(pose[0], pose[1], pose[2]);
        node.rotationQuaternion.set(pose[3], pose[4], pose[5], pose[6]);
      }
    }
    t1 = performance.now();
    out[2] = t1 - t0;
    t0 = t1;

    if (this.render) scene.render();
    else scene._advancePhysicsEngineStep(1000 / 60);
    t1 = performance.now();
    out[3] = t1 - t0;
    t0 = t1;

    this.projectiles = this.flyProjectiles();
    t1 = performance.now();
    out[4] = t1 - t0;
  }

  private flyProjectiles(): readonly any[] {
    const S = this.S;
    let list = this.projectiles as any[];
    if (list.length < this.o.projectiles) {
      list = list.slice();
      const rng = this.rng;
      const players = this.players;
      const a3 = this.a3;
      const b3 = this.b3;
      while (list.length < this.o.projectiles) {
        const shooterIndex = Math.floor(rng() * players.length);
        const shooter = players[shooterIndex];
        shooter.body.getFeetToRef(a3);
        let dx: number;
        let dy: number;
        let dz: number;
        if (rng() < 0.6) {
          players[sameTownTarget(shooterIndex, players.length, rng)].body.getFeetToRef(b3);
          dx = b3.x - a3.x + (rng() - 0.5) * 1.5;
          dy = b3.y + 1.2 - (a3.y + S.MOVEMENT.standEyeHeight) + (rng() - 0.5);
          dz = b3.z - a3.z + (rng() - 0.5) * 1.5;
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
        const eyeY = a3.y + S.MOVEMENT.standEyeHeight;
        const spawned = S.spawnProjectiles(
          { weaponId: "rifle", shotId: this.nextProjectileId, origin: { x: a3.x + dx * 0.6, y: eyeY + dy * 0.6, z: a3.z + dz * 0.6 }, directions: [{ x: dx, y: dy, z: dz }], recoilUp: 0, recoilRight: 0 },
          () => this.nextProjectileId++,
        );
        list.push(...spawned);
        this.stats.spawned++;
      }
    }
    const result = S.stepProjectiles(list, DT, this.raycast);
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
      meanHorizontalSpeed: Math.round((this.players.reduce((sum, p) => sum + Math.hypot(p.move.velocity.x, p.move.velocity.z), 0) / this.players.length) * 100) / 100,
    };
  }

  dispose(): void {
    this.scene?.getEngine().dispose();
  }
}
