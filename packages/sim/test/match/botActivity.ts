import type { HeadlessMatch } from "./harness";

// Instrumentation for the "bots stand still" investigation: per-bot goal/sub-state histograms, distance walked and
// shots, sampled from the live brains while a headless match runs.

export interface BotActivity {
  readonly ticks: number;
  readonly combatTicks: number;
  /** Metres walked per bot (ground track), summed over the match. */
  readonly distance: Float64Array;
  /** Fraction of alive-combat samples per goal, summed over all bots. */
  readonly goals: Map<string, number>;
  readonly subStates: Map<string, number>;
  /** Samples where the bot pressed a move axis. */
  readonly pushing: number;
  readonly samples: number;
  readonly shots: number;
  readonly damageEvents: number;
  readonly kills: number;
  readonly knocks: number;
  readonly zoneKills: number;
  /** Bots holding a gun, sampled every second: fraction of alive-combat samples. */
  readonly armedFraction: number;
  /** Samples where perception had a visible hostile. */
  readonly targetFraction: number;
  /** Bots that walked less than 20 m over the whole run. */
  readonly frozen: number;
  readonly medianDistance: number;
  /** The same numbers over the first `EARLY_SECONDS` of combat, when the zone still contains the whole map. */
  readonly early: {
    readonly medianDistance: number;
    readonly frozen: number;
    readonly pushing: number;
    readonly samples: number;
    readonly shots: number;
    readonly goals: Map<string, number>;
    readonly subStates: Map<string, number>;
  };
}

/** The window the owner watches: the first minutes, before the zone pushes anyone. */
export const EARLY_SECONDS = 180;

const SAMPLE_TICKS = 15;

export function runWithActivity(match: HeadlessMatch, maxTicks: number): BotActivity {
  const { sim, events } = match;
  const slots = sim.state.actors.filter(Boolean).map((a) => a.slot);
  const distance = new Float64Array(slots.length ? Math.max(...slots) + 1 : 0);
  const lastX = new Float64Array(distance.length);
  const lastZ = new Float64Array(distance.length);
  for (const slot of slots) {
    const a = sim.state.actors[slot]!;
    lastX[slot] = a.feet.x;
    lastZ[slot] = a.feet.z;
  }
  const goals = new Map<string, number>();
  const subStates = new Map<string, number>();
  let pushing = 0;
  let armedSamples = 0;
  let targetSamples = 0;
  let samples = 0;
  let combatTicks = 0;
  let ticks = 0;
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const earlyGoals = new Map<string, number>();
  const earlySubStates = new Map<string, number>();
  const earlyDistance = new Float64Array(distance.length);
  let earlyPushing = 0;
  let earlySamples = 0;
  let earlyShots = 0;
  let earlyDone = false;

  for (; ticks < maxTicks && !sim.finished; ticks++) {
    sim.tick();
    const combat = sim.state.phase === "combat";
    if (combat) combatTicks++;
    const early = combat && combatTicks <= EARLY_SECONDS * 60;
    if (!early && !earlyDone && combatTicks > 0) {
      earlyDone = true;
      earlyShots = sim.stats.shots;
      for (const slot of slots) earlyDistance[slot] = distance[slot]!;
    }
    for (const slot of slots) {
      const a = sim.state.actors[slot]!;
      if (a.life !== "dead") {
        const dx = a.feet.x - lastX[slot]!;
        const dz = a.feet.z - lastZ[slot]!;
        distance[slot]! += Math.sqrt(dx * dx + dz * dz);
      }
      lastX[slot] = a.feet.x;
      lastZ[slot] = a.feet.z;
      if (!combat || a.life !== "alive" || sim.state.tick % SAMPLE_TICKS !== 0) continue;
      const debug = sim.brainOf(slot)?.debug();
      if (!debug) continue;
      samples++;
      if (sim.inventoryOf(slot)?.weapons.some(Boolean)) armedSamples++;
      const brain = sim.brainOf(slot)!;
      if (brain.perception.actors.some((t) => t.hostile && t.visible)) targetSamples++;
      bump(goals, debug.goal);
      bump(subStates, `${debug.goal}:${debug.subState}`);
      const input = sim.inputOf(slot);
      const moving = input !== null && (input.forward !== 0 || input.right !== 0);
      if (moving) pushing++;
      if (early) {
        earlySamples++;
        bump(earlyGoals, debug.goal);
        bump(earlySubStates, `${debug.goal}:${debug.subState}`);
        if (moving) earlyPushing++;
      }
    }
  }
  if (!earlyDone) {
    earlyShots = sim.stats.shots;
    for (const slot of slots) earlyDistance[slot] = distance[slot]!;
  }

  const walked = slots.map((s) => distance[s]!).sort((a, b) => a - b);
  const earlyWalked = slots.map((s) => earlyDistance[s]!).sort((a, b) => a - b);
  return {
    ticks,
    combatTicks,
    distance,
    goals,
    subStates,
    pushing,
    samples,
    shots: sim.stats.shots,
    damageEvents: events.filter((e) => e.type === "damage").length,
    kills: events.filter((e) => e.type === "kill").length,
    knocks: events.filter((e) => e.type === "knock").length,
    zoneKills: events.filter((e) => e.type === "kill" && e.cause === "zone").length,
    armedFraction: armedSamples / Math.max(1, samples),
    targetFraction: targetSamples / Math.max(1, samples),
    frozen: walked.filter((d) => d < 20).length,
    medianDistance: walked[Math.floor(walked.length / 2)] ?? 0,
    early: {
      medianDistance: earlyWalked[Math.floor(earlyWalked.length / 2)] ?? 0,
      frozen: earlyWalked.filter((d) => d < 20).length,
      pushing: earlyPushing,
      samples: earlySamples,
      shots: earlyShots,
      goals: earlyGoals,
      subStates: earlySubStates,
    },
  };
}

function top(m: Map<string, number>, total: number, n: number): string {
  return [...m.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${((v / Math.max(1, total)) * 100).toFixed(0)}%`)
    .join(", ");
}

export function formatActivity(label: string, a: BotActivity): string {
  const e = a.early;
  return (
    `[${label}] ${a.ticks} ticks (${(a.combatTicks / 60).toFixed(0)} s combat): median walk ${a.medianDistance.toFixed(0)} m, ` +
    `frozen bots (<20 m) ${a.frozen}, pushing ${((a.pushing / Math.max(1, a.samples)) * 100).toFixed(0)}% of samples, ` +
    `${a.shots} shots, ${a.damageEvents} damage, ${a.knocks} knocks, ${a.kills} kills (${a.zoneKills} zone), armed ${(a.armedFraction * 100).toFixed(0)}%, seeing an enemy ${(a.targetFraction * 100).toFixed(0)}%\n` +
    `        goals: ${top(a.goals, a.samples, 8)}\n` +
    `        states: ${top(a.subStates, a.samples, 8)}\n` +
    `        first ${EARLY_SECONDS} s: median walk ${e.medianDistance.toFixed(0)} m, frozen ${e.frozen}, ` +
    `pushing ${((e.pushing / Math.max(1, e.samples)) * 100).toFixed(0)}%, ${e.shots} shots\n` +
    `        first ${EARLY_SECONDS} s goals: ${top(e.goals, e.samples, 8)}\n` +
    `        first ${EARLY_SECONDS} s states: ${top(e.subStates, e.samples, 8)}`
  );
}
