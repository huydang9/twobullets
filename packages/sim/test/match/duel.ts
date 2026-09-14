import { BOT_PROFILES } from "@twobullets/shared/bots/profiles/profiles";
import type { BotBrainFactory, BotDifficulty, NavQuery } from "@twobullets/shared/bots/types";
import { createVitals } from "@twobullets/shared/equipment/vitals";
import { DEFAULT_ZONE_SPEC } from "@twobullets/shared/match/zone";
import type { MatchEvent, MatchFxEvent } from "@twobullets/shared/match/types";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import type { HavokModule } from "../../src/index";
import type { MapSimWorld } from "../../src/map/mapCollision";
import { brainsBySlot, straferScript } from "./testBrains";
import { createHeadlessMatch } from "./harness";

// Duel harness (design.md §6 tuning targets, §12.2): one bot with a rifle against a strafing, unarmored target on open
// Map v1 ground at a fixed range. The target's vitals are restored after every hit so it never dies; time to kill is
// counted per 100 HP of damage dealt.

export interface DuelOptions {
  readonly brain: BotBrainFactory;
  readonly difficulty: BotDifficulty;
  readonly range: number;
  readonly seconds: number;
  readonly seed?: number;
  readonly nav?: NavQuery;
}

export interface DuelResult {
  readonly difficulty: BotDifficulty;
  readonly range: number;
  readonly shots: number;
  readonly hits: number;
  readonly hitRate: number;
  readonly headshots: number;
  /** Combat start → first shot, s (null when it never fired). */
  readonly firstShotSeconds: number | null;
  /** Seconds from the first shot of a "life" to 100 HP dealt, median. */
  readonly ttkMedianSeconds: number | null;
  readonly kills: number;
  /** Target's average horizontal speed, m/s. */
  readonly targetSpeed: number;
  readonly lane: { readonly x: number; readonly z: number; readonly yaw: number };
}

/** An open lane: shooter at a map spawn, target `range` m ahead, clear sight over ±6 m of strafing, gentle ground. */
export function findOpenLane(world: MapSimWorld, range: number): { ax: number; az: number; bx: number; bz: number; yaw: number } {
  const t = world.terrain;
  for (const spawn of MAP_V1.spawns) {
    const [ax, az] = spawn.position;
    for (let k = 0; k < 16; k++) {
      const yaw = spawn.yaw + (k * Math.PI) / 8;
      const bx = ax + Math.sin(yaw) * range;
      const bz = az + Math.cos(yaw) * range;
      if (!t.isPlayable(bx, bz) || Math.abs(t.sampleHeight(bx, bz) - t.sampleHeight(ax, az)) > 2.5) continue;
      const eye = { x: ax, y: t.sampleHeight(ax, az) + 1.65, z: az };
      let clear = true;
      for (const side of [-6, -3, 0, 3, 6]) {
        const px = bx + Math.cos(yaw) * side;
        const pz = bz - Math.sin(yaw) * side;
        if (t.slopeTanAt(px, pz) > 0.35 || world.raycastWorld(eye, { x: px, y: t.sampleHeight(px, pz) + 1.0, z: pz })) clear = false;
      }
      if (clear) return { ax, az, bx, bz, yaw };
    }
  }
  throw new Error(`no open ${range} m lane on Map v1`);
}

export async function runDuel(havok: HavokModule, options: DuelOptions): Promise<DuelResult> {
  let lane!: ReturnType<typeof findOpenLane>;
  const match = await createHeadlessMatch(havok, {
    seed: options.seed ?? 1,
    brains: brainsBySlot((slot) => (slot === 0 ? options.brain : straferScript())),
    difficulty: options.difficulty,
    ...(options.nav ? { nav: options.nav } : {}),
    config: {
      teamCount: 2,
      teamSize: 1,
      zone: { ...DEFAULT_ZONE_SPEC, firstAnnounceSeconds: 1e6 },
      timings: { countdownSeconds: 1, timeCapSeconds: 1e6 },
    },
    spawns: (world) => {
      lane = findOpenLane(world, options.range);
      return [
        { team: 0, poiId: "duel", feet: [world.groundFeet(lane.ax, lane.az)], yaw: lane.yaw },
        { team: 1, poiId: "duel", feet: [world.groundFeet(lane.bx, lane.bz)], yaw: lane.yaw + Math.PI },
      ];
    },
  });
  void BOT_PROFILES;
  const { sim } = match;
  const fx: MatchFxEvent[] = [];
  sim.onFx((e) => {
    if (e.type === "shot" && e.slot === 0) fx.push(e);
  });
  let hits = 0;
  let headshots = 0;
  let lifeDamage = 0;
  let lifeStart = -1;
  const ttk: number[] = [];
  const onDamage = (e: MatchEvent) => {
    if (e.type !== "damage" || e.victim !== 1 || e.attacker !== 0) return;
    hits++;
    if (e.zone === "head") headshots++;
    lifeDamage += e.amount;
    if (lifeDamage >= 100) {
      if (lifeStart >= 0) ttk.push((e.tick - lifeStart) / 60);
      lifeDamage = 0;
      lifeStart = -1;
    }
    sim.setBotVitals(1, createVitals());
  };
  sim.onEvent(onDamage);
  let travelled = 0;
  let last = { ...sim.state.actors[1]!.feet };
  const totalTicks = sim.schedule.combatStartTick + Math.round(options.seconds * 60);
  let shotsBefore = 0;
  for (let i = 0; i < totalTicks; i++) {
    sim.tick();
    if (fx.length > shotsBefore) {
      if (lifeStart < 0) lifeStart = sim.state.tick;
      shotsBefore = fx.length;
    }
    const f = sim.state.actors[1]!.feet;
    if (sim.state.phase === "combat") travelled += Math.sqrt((f.x - last.x) ** 2 + (f.z - last.z) ** 2);
    last = { x: f.x, y: f.y, z: f.z };
  }
  const first = fx[0];
  const sorted = [...ttk].sort((a, b) => a - b);
  const result: DuelResult = {
    difficulty: options.difficulty,
    range: options.range,
    shots: fx.length,
    hits,
    hitRate: fx.length > 0 ? hits / fx.length : 0,
    headshots,
    firstShotSeconds: first ? (first.tick - sim.state.combatStartTick) / 60 : null,
    ttkMedianSeconds: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : null,
    kills: ttk.length,
    targetSpeed: travelled / options.seconds,
    lane: { x: lane.ax, z: lane.az, yaw: lane.yaw },
  };
  match.dispose();
  return result;
}
