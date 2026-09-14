import { applyDamage, armorLoadout, createInventory, createVitals, type ExternalActorPose, type MatchExternalActor, type Vitals } from "@twobullets/shared";
import { createGroundLoot, generateLoot } from "@twobullets/shared/equipment/loot";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import { createMapSimWorld } from "@twobullets/sim/map/mapCollision";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { appendFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMapV1Nav, loadMapV1 } from "../../../../packages/sim/test/match/mapV1World";
import { createOfflineMatchSim, OFFLINE_TEAM_SIZE } from "../../src/match/createOfflineMatchSim";
import { readOfflineMatchOptions } from "../../src/match/options";

// Headless `?bots=1&difficulty=normal&seed=42` start path: the same MatchSim OfflineMatch.start builds
// (createOfflineMatchSim: real brains, real Map v1 nav, 5×2 with a standing human stand-in on slot 0) plus client-like
// physics (trigger hitboxes following each bot, a world step per tick), run for 600 ticks. Set TB_MATCH_PROGRESS=<file>
// to get per-tick breadcrumbs when hunting a hang.

const PROGRESS = process.env.TB_MATCH_PROGRESS ?? "";
const progress = (line: string) => PROGRESS && appendFileSync(PROGRESS, `${line}\n`);

describe("offline match start (client path, headless)", () => {
  it("starts seed 42 and runs 600 ticks without hanging", async () => {
    if (PROGRESS) writeFileSync(PROGRESS, "");
    const havok = await loadHavok();
    const map = await loadMapV1();
    const world = createMapSimWorld(havok, map);
    const { nav, isValidZoneCenter } = await createMapV1Nav();
    progress("loaded");
    const options = readOfflineMatchOptions("?bots=1&difficulty=normal&seed=42", true);
    const seed = options.seed!;
    const spawns = planTeamSpawns(seed, options.teams, OFFLINE_TEAM_SIZE, MAP_V1.pois, MAP_V1.spawns, (x, z) => map.terrain.sampleHeight(x, z));
    const feet = spawns.find((plan) => plan.team === 0)!.feet[0]!;
    let vitals: Vitals = createVitals();
    const inventory = createInventory();
    const human: MatchExternalActor = {
      slot: 0,
      get vitals() {
        return vitals;
      },
      armor: armorLoadout(inventory),
      readPose(out: ExternalActorPose) {
        Object.assign(out.feet, feet);
        Object.assign(out.eye, { x: feet.x, y: feet.y + 1.62, z: feet.z });
        Object.assign(out.velocity, { x: 0, y: 0, z: 0 });
        out.yaw = 0;
        out.pitch = 0;
        out.stance = "stand";
        out.grounded = true;
        out.sprinting = false;
        out.adsBlend = 0;
        out.weaponId = null;
      },
      applyDamage(hit, ctx) {
        const outcome = applyDamage(vitals, armorLoadout(inventory), hit, ctx);
        vitals = outcome.vitals;
        return outcome;
      },
      setCanBeKnocked() {},
      setReviver() {},
      eliminate() {},
    };
    const loot = createGroundLoot(generateLoot(0x2b0b, MAP_V1.pois, map.layout.buildings).items);
    const sim = createOfflineMatchSim({
      seed,
      options,
      difficulty: options.difficulty,
      humanSlot: 0,
      spawns,
      killY: MAP_V1.bounds.killY,
      raycastWorld: world.raycastWorld,
      nav,
      isValidZoneCenter,
      groundLoot: loot,
      equipment: { smokes: [], throwables: [], spawnRelease: () => -1 },
      external: [human],
      createBody: (at) => world.createBody(at),
      profile: true,
    });
    progress("sim built");
    // Client-like physics: trigger hitboxes (ANIMATED, membership hitbox) following each bot, and world steps.
    const { PhysicsBody, PhysicsMotionType, PhysicsShapeCapsule, TransformNode, Vector3 } = await import("@babylonjs/core");
    const triggers = sim.state.actors.filter((a) => a.kind === "bot").map((a) => {
      const node = new TransformNode(`hb${a.slot}`, world.scene);
      const shape = new PhysicsShapeCapsule(new Vector3(0, -0.6, 0), new Vector3(0, 0.6, 0), 0.25, world.scene);
      shape.isTrigger = true;
      shape.filterMembershipMask = 1 << 1;
      const body = new PhysicsBody(node, PhysicsMotionType.ANIMATED, false, world.scene);
      body.shape = shape;
      body.disablePreStep = false;
      body.disableSync = true;
      return { node, actor: a };
    });
    const physics = world.scene.getPhysicsEngine()!;
    const slowest = { ms: 0, tick: -1 };
    for (let i = 0; i < 600; i++) {
      progress(`tick ${i} start`);
      for (const t of triggers) t.node.position.set(t.actor.feet.x, t.actor.feet.y + 0.9, t.actor.feet.z);
      physics._step(1 / 60);
      const t0 = performance.now();
      sim.tick();
      const ms = performance.now() - t0;
      if (ms > slowest.ms) Object.assign(slowest, { ms, tick: i });
      progress(`tick ${i} ${ms.toFixed(2)} ms phase ${sim.state.phase}`);
    }
    console.info(`[offline match start] 600 ticks, slowest ${slowest.ms.toFixed(1)} ms at ${slowest.tick}, phase ${sim.state.phase}`);
    expect(sim.state.tick).toBeGreaterThanOrEqual(599);
    expect(sim.state.phase).toBe("combat");
    expect(slowest.ms).toBeLessThan(250);
    expect(sim.state.actors.every((a) => Number.isFinite(a.feet.x) && Number.isFinite(a.feet.z))).toBe(true);
    sim.dispose();
    world.dispose();
  }, 120_000);
});
