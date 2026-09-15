import { applyDamage, armorLoadout, createInventory, createVitals, type ExternalActorPose, type MatchExternalActor, type Vitals } from "@twobullets/shared";
import { buildNavGrid, createNavQuery, isValidZoneCenter } from "@twobullets/shared/bots/nav/index";
import { createGroundLoot, generateLoot } from "@twobullets/shared/equipment/loot";
import { buildMapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { loadRealMap } from "@twobullets/shared/map/real/index";
import { decodeTerrainBake } from "@twobullets/shared/map/terrain/bake";
import { buildTerrain, Terrain } from "@twobullets/shared/map/terrain/terrain";
import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import { createMapSimWorld } from "@twobullets/sim/map/mapCollision";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createOfflineMatchConfig, createOfflineMatchSim } from "../../src/match/createOfflineMatchSim";
import { readOfflineMatchOptions } from "../../src/match/options";

// Practice with bots on a real-world map (`?bots=1&map=vn-camthanh`), headless: the same start path as the Map v1 test
// (offlineMatchStart.test.ts) on the generated map data and its terrain bake. TB_REAL_MAP=<id> picks another map,
// TB_MATCH_PROGRESS=<file> writes per-step breadcrumbs.

const MAP_ID = process.env.TB_REAL_MAP ?? "vn-camthanh";
const TICKS = Number(process.env.TB_REAL_MAP_TICKS ?? 900);
const PROGRESS = process.env.TB_MATCH_PROGRESS ?? "";
const progress = (line: string) => PROGRESS && appendFileSync(PROGRESS, `${line}\n`);
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "../../public/assets/map");

describe(`offline match start on a real map (${MAP_ID})`, () => {
  it("builds the nav grid, plans spawns, starts and runs without hanging", async () => {
    if (PROGRESS) writeFileSync(PROGRESS, "");
    const havok = await loadHavok();
    const module = await loadRealMap(MAP_ID);
    const map = module.map;
    const bake = join(ASSETS, `${MAP_ID}.terrain.bin`);
    let terrain: Terrain | null = null;
    if (existsSync(bake)) {
      const result = await decodeTerrainBake(new Uint8Array(readFileSync(bake)), map.terrain, map.flatten);
      if (result.ok) terrain = result.terrain;
    }
    terrain ??= buildTerrain(map.terrain, map.flatten);
    // The browser builds the world in a worker: the layout is structured-cloned and the terrain rebuilt from a snapshot.
    const layout = structuredClone(buildMapLayout(map, terrain));
    terrain = Terrain.fromSnapshot(map.terrain, structuredClone(terrain.snapshot()));
    progress("map loaded");
    const world = createMapSimWorld(havok, { terrain, layout });
    const t0 = performance.now();
    const grid = buildNavGrid({ map, terrain, layout });
    progress(`nav ${Math.round(performance.now() - t0)} ms`);
    const nav = createNavQuery(grid);
    const seeds = (process.env.TB_REAL_MAP_SEEDS ?? "42").split(",").map(Number);
    for (const matchSeed of seeds) {
      const options = readOfflineMatchOptions(`?bots=1&difficulty=normal&seed=${matchSeed}&map=${MAP_ID}${process.env.TB_REAL_MAP_QUERY ?? ""}`, true);
      const seed = options.seed!;
      const config = createOfflineMatchConfig({ seed, options, difficulty: options.difficulty, humanSlot: 0 });
      const spawns = planTeamSpawns(seed, config.teamCount, config.teamSize, map.pois, map.spawns, (x, z) => terrain.sampleHeight(x, z));
      progress(`spawns ${spawns.length}`);
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
      const loot = createGroundLoot(generateLoot(0x2b0b, map.pois, layout.buildings).items);
      progress(`loot ${loot.items.size}`);
      const sim = createOfflineMatchSim({
        seed,
        options,
        difficulty: options.difficulty,
        humanSlot: 0,
        spawns,
        killY: map.bounds.killY,
        raycastWorld: world.raycastWorld,
        nav,
        isValidZoneCenter: isValidZoneCenter(grid),
        groundLoot: loot,
        equipment: { smokes: [], throwables: [], spawnRelease: () => -1 },
        external: [human],
        createBody: (at) => world.createBody(at),
        profile: true,
      });
      progress("sim built");
      const physics = world.scene.getPhysicsEngine()!;
      const starts = sim.state.actors.map((a) => ({ x: a.feet.x, z: a.feet.z }));
      const slowest = { ms: 0, tick: -1 };
      for (let i = 0; i < TICKS; i++) {
        progress(`tick ${i} start`);
        physics._step(1 / 60);
        const start = performance.now();
        sim.tick();
        const ms = performance.now() - start;
        if (ms > slowest.ms) Object.assign(slowest, { ms, tick: i });
        progress(`tick ${i} ${ms.toFixed(2)} ms phase ${sim.state.phase}`);
      }
      const moved = sim.state.actors.filter((a, i) => a.kind === "bot" && Math.sqrt((a.feet.x - starts[i]!.x) ** 2 + (a.feet.z - starts[i]!.z) ** 2) > 3).length;
      progress(`[offline match ${MAP_ID}] ${TICKS} ticks, slowest ${slowest.ms.toFixed(1)} ms at ${slowest.tick}, phase ${sim.state.phase}, bots moved ${moved}, loot ${loot.items.size}`);
      expect(sim.state.phase).toBe("combat");
      expect(slowest.ms).toBeLessThan(250);
      expect(sim.state.actors.every((a) => Number.isFinite(a.feet.x) && Number.isFinite(a.feet.z))).toBe(true);

      sim.dispose();
    }
    world.dispose();
  }, 180_000);
});
