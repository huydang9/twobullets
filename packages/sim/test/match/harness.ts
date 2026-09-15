import { BOT_PROFILES } from "@twobullets/shared/bots/profiles/profiles";
import type { BotBrainFactory, BotDifficulty, NavQuery } from "@twobullets/shared/bots/types";
import { createArmorPiece } from "@twobullets/shared/equipment/armor";
import { createInventory, type InventoryState } from "@twobullets/shared/equipment/inventory";
import { createStartingInventory } from "@twobullets/shared/equipment/presets";
import { createGroundLoot, generateLoot, type GroundLoot } from "@twobullets/shared/equipment/loot";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { createBrMatchConfig, type BrMatchConfigOptions } from "@twobullets/shared/match/rules";
import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import type { BrMatchConfig, MatchEvent, MatchExternalActor, TeamSpawnPlan } from "@twobullets/shared/match/types";
import type { HavokModule } from "../../src/index";
import { createMapSimWorld, type MapSimWorld } from "../../src/map/mapCollision";
import { MatchSim } from "../../src/match/MatchSim";
import { createMapV1Nav, loadMapV1 } from "./mapV1World";
import { StraightNav } from "./straightNav";

// Headless Map v1 match setup and runner shared by the match tests and tools/bench/bots/match.ts.

export interface HeadlessMatchOptions {
  readonly seed: number;
  readonly brains: BotBrainFactory;
  readonly timeScale?: number;
  readonly difficulty?: BotDifficulty;
  /** "armed": rifle, pistol, ammo, L1 armor, first aid (until bots loot); "empty": PUBG start; "starting": the offline client's kit. */
  readonly loadout?: "armed" | "empty" | "starting";
  /** "grid" (default): the real Map v1 NavQuery; "straight": terrain straight lines; or a query of your own. */
  readonly nav?: NavQuery | "grid" | "straight";
  readonly profile?: boolean;
  readonly config?: Partial<BrMatchConfigOptions>;
  /** Overrides the seeded POI spawn plan. */
  readonly spawns?: (world: MapSimWorld, config: BrMatchConfig) => TeamSpawnPlan[];
  /** Host-simulated actors (set `config.humanSlot`). */
  readonly external?: (world: MapSimWorld) => MatchExternalActor[];
}

export interface HeadlessMatch {
  readonly sim: MatchSim;
  readonly world: MapSimWorld;
  readonly ground: GroundLoot;
  readonly events: MatchEvent[];
  dispose(): void;
}

export function armedInventory(): InventoryState {
  return createInventory({
    weapons: [{ weaponId: "rifle", magazine: 30 }, null, { weaponId: "pistol", magazine: 12 }],
    helmet: createArmorPiece("helmet", 1),
    vest: createArmorPiece("vest", 1),
    backpack: 1,
    stacks: [
      { itemId: "ammo_556", quantity: 150 },
      { itemId: "ammo_9mm", quantity: 36 },
      { itemId: "first_aid", quantity: 2 },
    ],
  });
}

/** MatchSim `inventoryFor` option for a harness loadout. */
export function loadoutFor(loadout: HeadlessMatchOptions["loadout"]): { inventoryFor?: () => InventoryState } {
  if (loadout === "empty") return {};
  return { inventoryFor: loadout === "starting" ? () => createStartingInventory() : () => armedInventory() };
}

export async function createHeadlessMatch(havok: HavokModule, options: HeadlessMatchOptions): Promise<HeadlessMatch> {
  const map = await loadMapV1();
  const world = createMapSimWorld(havok, map);
  const config = createBrMatchConfig({ seed: options.seed, timeScale: options.timeScale ?? 1, difficulty: options.difficulty ?? "normal", ...options.config });
  const spawns = options.spawns?.(world, config) ?? planTeamSpawns(config.seed, config.teamCount, config.teamSize, MAP_V1.pois, MAP_V1.spawns, (x, z) => map.terrain.sampleHeight(x, z));
  const ground = createGroundLoot(generateLoot(config.seed, MAP_V1.pois, map.layout.buildings).items);
  const terrain = map.terrain;
  let nav: NavQuery;
  let isValidZoneCenter = (x: number, z: number) => terrain.isPlayable(x, z) && terrain.slopeTanAt(x, z) < 0.7;
  if (options.nav === undefined || options.nav === "grid") {
    const real = await createMapV1Nav();
    nav = real.nav;
    isValidZoneCenter = real.isValidZoneCenter;
  } else {
    nav = options.nav === "straight" ? new StraightNav(terrain) : options.nav;
  }
  const sim = new MatchSim({
    config,
    spawns,
    killY: MAP_V1.bounds.killY,
    profile: options.profile ?? false,
    ...loadoutFor(options.loadout),
    ports: {
      raycastWorld: world.raycastWorld,
      nav,
      groundLoot: ground,
      brainFactory: options.brains,
      profileFor: (difficulty) => BOT_PROFILES[difficulty],
      createBody: (feet) => world.createBody(feet),
      ...(options.external ? { external: options.external(world) } : {}),
      isValidZoneCenter,
    },
  });
  const events: MatchEvent[] = [];
  sim.onEvent((event) => events.push(event));
  return {
    sim,
    world,
    ground,
    events,
    dispose() {
      sim.dispose();
      world.dispose();
    },
  };
}

export interface StuckIncident {
  readonly slot: number;
  readonly startTick: number;
  readonly seconds: number;
  /** Where the bot was stuck. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MatchSummary {
  readonly ticks: number;
  readonly combatSeconds: number;
  readonly reason: string | null;
  readonly winnerTeam: number | null;
  readonly kills: number;
  readonly knocks: number;
  readonly revives: number;
  readonly zoneDeaths: number;
  readonly damageEvents: number;
  readonly shots: number;
  readonly placements: readonly (readonly [team: number, placement: number])[];
  readonly stuck: readonly StuckIncident[];
  readonly longestStuckSeconds: number;
  readonly nanPositions: number;
  readonly belowKillY: number;
  readonly tickMs: { readonly p50: number; readonly p99: number; readonly max: number; readonly mean: number };
  /** Brains plus nav.update per tick (MatchSim.stats.brainMs). */
  readonly brainMs: { readonly p50: number; readonly p99: number };
  /** Brains alone, and the time-sliced nav.update alone (bounded by its expansion budget). */
  readonly brainOnlyMs: { readonly p50: number; readonly p99: number };
  readonly navMs: { readonly p50: number; readonly p99: number };
  readonly wallMs: number;
}

const STUCK_WINDOW_TICKS = 600;
const STUCK_DISTANCE = 1.5;

/**
 * Runs until the match ends (or `maxTicks`) and collects the headless test metrics. A bot counts as stuck when it is
 * alive, pushing a move axis on most ticks of a 10 s window, not using an item, reviving or shooting, and moved less than 1.5 m;
 * consecutive windows merge into one incident.
 */
export function runHeadlessMatch(match: HeadlessMatch, maxTicks: number): MatchSummary {
  const { sim, events } = match;
  const started = performance.now();
  const slots = sim.state.actors.filter(Boolean).map((a) => a.slot);
  const windowStart = new Map<number, { x: number; z: number; pushing: number; busy: boolean }>();
  const openIncident = new Map<number, { startTick: number; windows: number; x: number; y: number; z: number }>();
  const stuck: StuckIncident[] = [];
  const tickTimes: number[] = [];
  const brainTimes: number[] = [];
  const brainOnlyTimes: number[] = [];
  const navTimes: number[] = [];
  let nanPositions = 0;
  let belowKillY = 0;
  let ticks = 0;
  const closeIncident = (slot: number) => {
    const open = openIncident.get(slot);
    if (open) stuck.push({ slot, startTick: open.startTick, seconds: (open.windows * STUCK_WINDOW_TICKS) / 60, x: open.x, y: open.y, z: open.z });
    openIncident.delete(slot);
  };

  for (; ticks < maxTicks && !sim.finished; ticks++) {
    const t0 = performance.now();
    sim.tick();
    tickTimes.push(performance.now() - t0);
    brainTimes.push(sim.stats.brainMs);
    brainOnlyTimes.push(sim.stats.brainMs - sim.stats.navMs);
    navTimes.push(sim.stats.navMs);
    const tick = sim.state.tick;
    const combat = sim.state.phase === "combat";
    for (const slot of slots) {
      const a = sim.state.actors[slot]!;
      if (!Number.isFinite(a.feet.x) || !Number.isFinite(a.feet.y) || !Number.isFinite(a.feet.z)) nanPositions++;
      if (a.life !== "dead" && a.feet.y < MAP_V1.bounds.killY) belowKillY++;
      if (!combat || a.life !== "alive") {
        windowStart.delete(slot);
        closeIncident(slot);
        continue;
      }
      const input = sim.inputOf(slot);
      let w = windowStart.get(slot);
      if (!w) windowStart.set(slot, (w = { x: a.feet.x, z: a.feet.z, pushing: 0, busy: false }));
      if (input && (input.forward !== 0 || input.right !== 0)) w.pushing++;
      // Reviving (interact) or fighting (fire/aim) in place is not being stuck.
      if (a.usingItem || (input && (input.buttons & (64 | 8 | 16)) !== 0)) w.busy = true;
      if ((tick + slot) % STUCK_WINDOW_TICKS === 0) {
        const moved = Math.sqrt((a.feet.x - w.x) ** 2 + (a.feet.z - w.z) ** 2);
        if (!w.busy && w.pushing > STUCK_WINDOW_TICKS * 0.6 && moved < STUCK_DISTANCE) {
          const open = openIncident.get(slot);
          if (open) open.windows++;
          else openIncident.set(slot, { startTick: tick - STUCK_WINDOW_TICKS, windows: 1, x: a.feet.x, y: a.feet.y, z: a.feet.z });
        } else {
          closeIncident(slot);
        }
        windowStart.set(slot, { x: a.feet.x, z: a.feet.z, pushing: 0, busy: false });
      }
    }
  }
  for (const slot of slots) closeIncident(slot);

  const count = (type: MatchEvent["type"]) => events.filter((e) => e.type === type).length;
  const s = sim.state;
  const sorted = [...tickTimes].sort((a, b) => a - b);
  const sortedBrain = [...brainTimes].sort((a, b) => a - b);
  const sortedBrainOnly = brainOnlyTimes.sort((a, b) => a - b);
  const sortedNav = navTimes.sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] ?? 0;
  const endTick = events.find((e) => e.type === "matchEnded")?.tick ?? s.tick;
  return {
    ticks,
    combatSeconds: s.combatStartTick >= 0 ? (endTick - s.combatStartTick) / 60 : 0,
    reason: s.endReason,
    winnerTeam: s.winnerTeam,
    kills: count("kill"),
    knocks: count("knock"),
    revives: count("revived"),
    zoneDeaths: events.filter((e) => e.type === "kill" && e.cause === "zone").length,
    damageEvents: count("damage"),
    shots: sim.stats.shots,
    placements: s.teams.map((t) => [t.team, t.placement ?? 0] as const),
    stuck,
    longestStuckSeconds: stuck.reduce((m, i) => Math.max(m, i.seconds), 0),
    nanPositions,
    belowKillY,
    tickMs: { p50: pct(sorted, 0.5), p99: pct(sorted, 0.99), max: sorted.at(-1) ?? 0, mean: tickTimes.reduce((a, b) => a + b, 0) / Math.max(1, tickTimes.length) },
    brainMs: { p50: pct(sortedBrain, 0.5), p99: pct(sortedBrain, 0.99) },
    brainOnlyMs: { p50: pct(sortedBrainOnly, 0.5), p99: pct(sortedBrainOnly, 0.99) },
    navMs: { p50: pct(sortedNav, 0.5), p99: pct(sortedNav, 0.99) },
    wallMs: performance.now() - started,
  };
}
