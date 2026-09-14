import { NO_ARMOR, type ArmorLoadout } from "@twobullets/shared/equipment/armor";
import { applyDamage, createVitals, stepRevive, type DamageContext, type DamageOutcome, type Vitals, type VitalsHit } from "@twobullets/shared/equipment/vitals";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import type { ExternalActorPose, MatchEvent, MatchExternalActor, MatchFxEvent, TeamSpawnPlan } from "@twobullets/shared/match/types";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HavokModule } from "../../src/index";
import { DEATH_PILE_ID_BASE } from "../../src/match/MatchSim";
import { loadHavok } from "../../src/node/loadHavok";
import { createHeadlessMatch, type HeadlessMatch } from "./harness";
import { brainsBySlot, idleScript, reviverScript, shooterScript } from "./testBrains";

// MatchSim pipeline on Map v1 with scripted brains: bullets through the rig, armor, knock → kill, team wipe credit,
// placements and win, friendly fire, revive, zone kills, death piles.

let havok: HavokModule;
let open: HeadlessMatch | null = null;

beforeAll(async () => {
  havok = await loadHavok();
}, 60_000);

afterAll(() => open?.dispose());

/** 2 teams × 2 on open ground near the first town spawn: team 0 at z, team 1 `range` m north. */
function duelSpawns(range: number): () => TeamSpawnPlan[] {
  const [x, z] = MAP_V1.spawns[0]!.position;
  return () => [
    { team: 0, poiId: "town", feet: [{ x, y: 0, z }, { x: x - 3, y: 0, z }], yaw: 0 },
    { team: 1, poiId: "town", feet: [{ x, y: 0, z: z + range }, { x: x + 25, y: 0, z: z + range }], yaw: Math.PI },
  ];
}

async function duel(brains: Parameters<typeof brainsBySlot>[0], range = 12): Promise<HeadlessMatch> {
  open?.dispose();
  const spawnPlan = duelSpawns(range);
  const match = await createHeadlessMatch(havok, {
    seed: 99,
    brains: brainsBySlot(brains),
    config: { teamCount: 2, teamSize: 2, timings: { countdownSeconds: 0.1 } },
    spawns: (world) => spawnPlan().map((p) => ({ ...p, feet: p.feet.map((f) => world.groundFeet(f.x, f.z)) })),
  });
  open = match;
  return match;
}

function runUntil(match: HeadlessMatch, done: (e: MatchEvent[]) => boolean, maxTicks: number): number {
  let n = 0;
  while (n < maxTicks && !done(match.events)) {
    match.sim.tick();
    n++;
  }
  return n;
}

describe("MatchSim pipeline (Map v1, scripted brains)", () => {
  it("bullets knock through armor, the last standing dies, the downed teammate is wiped with knocker credit, team 0 wins", async () => {
    const match = await duel((slot) => (slot === 0 ? shooterScript(2) : idleScript));
    const fx: MatchFxEvent[] = [];
    match.sim.onFx((e) => fx.push(e));
    const { sim, events } = match;

    const heard: { kind: string; source: number; x: number; z: number }[] = [];
    let t1 = 0;
    while (t1 < 900 && !events.some((x) => x.type === "knock")) {
      sim.tick();
      t1++;
      // Brains read last tick's noises at the start of the next tick; sample them the same way.
      for (const n of sim.viewOf(2)!.noises) heard.push({ kind: n.kind, source: n.sourceSlot, x: n.position.x, z: n.position.z });
    }
    expect(t1).toBeLessThan(900);
    const damage = events.filter((e): e is Extract<MatchEvent, { type: "damage" }> => e.type === "damage");
    expect(damage.length).toBeGreaterThan(0);
    expect(damage.every((d) => d.attacker === 0 && d.victim === 2 && d.kind === "bullet" && d.weaponId === "rifle")).toBe(true);
    expect(damage.some((d) => d.armorAbsorbed > 0)).toBe(true);
    expect(events.find((e) => e.type === "knock")).toMatchObject({ attacker: 0, victim: 2, cause: "rifle" });
    expect(sim.state.actors[2]!.life).toBe("downed");
    expect(sim.state.teams[1]!.eliminated).toBe(false);
    expect(fx.some((e) => e.type === "shot" && e.slot === 0)).toBe(true);
    expect(fx.some((e) => e.type === "impact" && e.victim === 2)).toBe(true);
    // Noises for hearing: the shots, and impacts at the hit point carrying the shooter's slot.
    // `view.noises` holds every noise of the tick; perception applies radii.
    expect(heard.some((n) => n.kind === "shot" && n.source === 0 && Math.abs(n.x - sim.state.actors[0]!.feet.x) < 1e-6)).toBe(true);
    const impacts = heard.filter((n) => n.kind === "impact");
    expect(impacts.length).toBeGreaterThan(0);
    const victimFeet = sim.state.actors[2]!.feet;
    expect(impacts.every((n) => n.source === 0)).toBe(true);
    expect(impacts.some((n) => Math.hypot(n.x - victimFeet.x, n.z - victimFeet.z) < 1)).toBe(true);

    (sim.brainOf(0) as unknown as { target: number }).target = 3;
    // Team 1's second member stands 25 m to the side; bring it in front of the shooter.
    const [x, z] = MAP_V1.spawns[0]!.position;
    sim.placeActor(3, match.world.groundFeet(x + 4, z + 14));
    const t2 = runUntil(match, (e) => e.some((x) => x.type === "matchEnded"), 1500);
    expect(t2).toBeLessThan(1500);

    const kills = events.filter((e): e is Extract<MatchEvent, { type: "kill" }> => e.type === "kill");
    expect(kills.map((k) => [k.killer, k.victim, k.cause, k.knockedBy, k.teamKill])).toEqual([
      [0, 3, "rifle", -1, false],
      [0, 2, "teamWipe", 0, false],
    ]);
    expect(events.filter((e) => e.type === "knock")).toHaveLength(1);
    const tail = events.slice(-4).map((e) => e.type);
    expect(tail).toEqual(["teamEliminated", "win", "matchEnded", "phaseChanged"]);
    expect(sim.state).toMatchObject({ phase: "ended", winnerTeam: 0, endReason: "lastTeam", teamsInPlay: 1 });
    expect(sim.state.teams.map((t) => t.placement)).toEqual([1, 2]);
    expect(sim.state.actors[0]).toMatchObject({ kills: 2, knocks: 1 });
    expect(sim.state.actors[0]!.damageDealt).toBeGreaterThan(100);
    expect(sim.state.teams[0]!.kills).toBe(2);

    // Death pile: the whole inventory at the feet.
    const pile = [...match.ground.items.values()].filter((item) => item.pileId === DEATH_PILE_ID_BASE + 3);
    expect(pile.map((i) => i.itemId).sort()).toEqual(["ammo_556", "ammo_9mm", "backpack_1", "first_aid", "helmet_1", "vest_1", "weapon_pistol", "weapon_rifle"].sort());
    const feet = sim.state.actors[3]!.feet;
    for (const item of pile) expect(Math.hypot(item.position[0] - feet.x, item.position[2] - feet.z)).toBeLessThan(0.6);
    expect(sim.inventoryOf(3)!.weapons).toEqual([null, null, null]);

    // Ended: inputs frozen, the match stops after the linger.
    const firedBefore = sim.stats.shots;
    runUntil(match, () => sim.finished, 1000);
    expect(sim.finished).toBe(true);
    expect(sim.stats.shots).toBe(firedBefore);
  }, 60_000);

  it("friendly fire is on: a teammate's bullets damage and knock", async () => {
    const match = await duel((slot) => (slot === 0 ? shooterScript(1) : idleScript));
    const n = runUntil(match, (e) => e.some((x) => x.type === "knock"), 900);
    expect(n).toBeLessThan(900);
    expect(match.events.find((e) => e.type === "knock")).toMatchObject({ attacker: 0, victim: 1 });
    expect(match.sim.state.actors[0]!.knocks).toBe(0);
    expect(match.sim.state.actors[0]!.damageDealt).toBe(0);
  }, 60_000);

  it("a teammate holding interact revives a downed bot in 5 s with 10 HP; letting go cancels", async () => {
    const match = await duel((slot) => (slot === 0 ? shooterScript(2) : slot === 3 ? reviverScript(2) : idleScript));
    const { sim, events } = match;
    runUntil(match, (e) => e.some((x) => x.type === "knock"), 900);
    (sim.brainOf(0) as unknown as { target: number }).target = -1;
    const downed = sim.state.actors[2]!.feet;
    sim.placeActor(3, match.world.groundFeet(downed.x + 1, downed.z));
    const started = sim.state.tick;
    runUntil(match, (e) => e.some((x) => x.type === "revived"), 600);
    const revived = events.find((e) => e.type === "revived")!;
    expect(events.find((e) => e.type === "reviveStarted")).toMatchObject({ reviver: 3, target: 2 });
    expect(revived).toMatchObject({ reviver: 3, target: 2 });
    expect(revived.tick - started).toBeGreaterThanOrEqual(299);
    expect(revived.tick - started).toBeLessThanOrEqual(310);
    expect(sim.state.actors[2]).toMatchObject({ life: "alive", health: 10 });
  }, 60_000);

  it("idle bots all die to the zone; placements follow elimination order", async () => {
    open?.dispose();
    const match = await createHeadlessMatch(havok, { seed: 5, brains: idleScript, timeScale: 0.02, loadout: "empty", config: { timings: { countdownSeconds: 5, timeCapSeconds: 3000 } } });
    open = match;
    let ticks = 0;
    while (!match.sim.finished && ticks < 6000) {
      match.sim.tick();
      ticks++;
    }
    const { events, sim } = match;
    expect(sim.state.phase).toBe("ended");
    const kills = events.filter((e): e is Extract<MatchEvent, { type: "kill" }> => e.type === "kill");
    expect(kills.length).toBe(10 - sim.state.actorsInPlay);
    expect(sim.state.actorsInPlay).toBeLessThanOrEqual(2);
    expect(kills.every((k) => k.cause === "zone" || k.cause === "teamWipe")).toBe(true);
    // Each eliminated team loses at least its last standing member to the zone (downed mates go with the team wipe).
    expect(kills.filter((k) => k.cause === "zone").length).toBeGreaterThanOrEqual(sim.state.teams.filter((t) => t.eliminated).length);
    expect(sim.stats.shots).toBe(0);
    expect(events.filter((e) => e.type === "zoneAnnounced")).toHaveLength(7);
    const eliminated = events.filter((e): e is Extract<MatchEvent, { type: "teamEliminated" }> => e.type === "teamEliminated");
    for (let i = 1; i < eliminated.length; i++) {
      if (eliminated[i]!.tick > eliminated[i - 1]!.tick) expect(eliminated[i]!.placement).toBeLessThan(eliminated[i - 1]!.placement);
    }
    expect(["lastTeam", "allDead"]).toContain(sim.state.endReason);
  }, 60_000);
});

/** Host-side stand-in for the offline human: fixed pose, shared vitals, host-stepped revive. */
class FakeHuman implements MatchExternalActor {
  readonly slot = 0;
  vitals: Vitals = createVitals();
  armor: ArmorLoadout = NO_ARMOR;
  canBeKnocked = false;
  knockCalls: boolean[] = [];
  reviver: number | null = null;
  eliminated = false;
  feet: Vec3;
  constructor(feet: Vec3) {
    this.feet = feet;
  }
  readPose(out: ExternalActorPose): void {
    const stance = this.vitals.life === "downed" ? "prone" : "stand";
    out.feet = this.feet;
    out.eye = { x: this.feet.x, y: this.feet.y + (stance === "prone" ? 0.35 : 1.65), z: this.feet.z };
    out.velocity = { x: 0, y: 0, z: 0 };
    out.yaw = 0;
    out.pitch = 0;
    out.stance = stance;
    out.grounded = true;
    out.sprinting = false;
    out.adsBlend = 0;
    out.weaponId = "rifle";
  }
  applyDamage(hit: VitalsHit, ctx: DamageContext): DamageOutcome | null {
    if (this.vitals.life === "dead") return null;
    const outcome = applyDamage(this.vitals, this.armor, hit, ctx);
    this.vitals = outcome.vitals;
    this.armor = outcome.armor;
    return outcome;
  }
  setCanBeKnocked(value: boolean): void {
    this.canBeKnocked = value;
    this.knockCalls.push(value);
  }
  setReviver(slot: number | null): void {
    this.reviver = slot;
  }
  eliminate(): void {
    this.eliminated = true;
  }
  /** What EquipmentSystem.stepBeingRevived does each tick. */
  hostTick(): void {
    if (this.vitals.life !== "downed" || this.reviver === null) return;
    this.vitals = stepRevive(this.vitals, this.reviver, true, 1 / 60).target;
    if (this.vitals.life === "alive") this.reviver = null;
  }
}

describe("MatchSim with an external (human) actor", () => {
  it("bot bullets reach the human through its host, the human's damage credits kills, a bot revives the human", async () => {
    open?.dispose();
    const [x, z] = MAP_V1.spawns[0]!.position;
    let human!: FakeHuman;
    const match = await createHeadlessMatch(havok, {
      seed: 11,
      brains: brainsBySlot((slot) => (slot === 2 ? shooterScript(0) : slot === 1 ? reviverScript(0) : idleScript)),
      config: { teamCount: 2, teamSize: 2, humanSlot: 0, timings: { countdownSeconds: 0.1 } },
      spawns: (world) => [
        { team: 0, poiId: "town", feet: [world.groundFeet(x, z), world.groundFeet(x - 20, z)], yaw: 0 },
        { team: 1, poiId: "town", feet: [world.groundFeet(x, z + 12), world.groundFeet(x + 20, z + 12)], yaw: Math.PI },
      ],
      external: (world) => [(human = new FakeHuman(world.groundFeet(x, z)))],
    });
    open = match;
    const { sim, events } = match;
    expect(sim.spawnOf(0)!.feet.x).toBeCloseTo(x, 6);

    let n = 0;
    while (n++ < 900 && human.vitals.life === "alive") {
      human.hostTick();
      sim.tick();
    }
    expect(human.knockCalls[0]).toBe(true);
    expect(human.vitals.life).toBe("downed");
    expect(events.find((e) => e.type === "knock")).toMatchObject({ attacker: 2, victim: 0, cause: "rifle" });
    expect(events.filter((e) => e.type === "knock")).toHaveLength(1);
    expect(sim.state.actors[0]!.life).toBe("downed");

    // The human's shots on bot 2 (CombatSystem → BotDamageable → damageActor): knock, then finish.
    (sim.brainOf(2) as unknown as { target: number }).target = -1;
    const shot = { attacker: 0, victim: 2, kind: "bullet", zone: "head", weaponId: "sniper", position: { x, y: 1.6, z: z + 12 }, direction: { x: 0, y: 0, z: 1 } } as const;
    expect(sim.damageActor({ ...shot, amount: 150 })).toMatchObject({ knocked: true, killed: false });
    const finish = sim.damageActor({ ...shot, amount: 150 });
    expect(finish).toMatchObject({ killed: true });
    expect(events.find((e) => e.type === "kill")).toMatchObject({ killer: 0, victim: 2, cause: "sniper", headshot: true, knockedBy: 0 });
    expect(sim.state.actors[0]!.kills).toBe(1);
    expect(sim.damageActor({ ...shot, amount: 10 })).toBeNull();

    // Bot teammate walks in (placed) and holds interact: the host runs the revive.
    sim.placeActor(1, match.world.groundFeet(x + 1, z));
    n = 0;
    while (n++ < 600 && human.vitals.life !== "alive") {
      human.hostTick();
      sim.tick();
    }
    expect(human.vitals.life).toBe("alive");
    sim.tick();
    expect(events.find((e) => e.type === "reviveStarted")).toMatchObject({ reviver: 1, target: 0 });
    expect(events.find((e) => e.type === "revived")).toMatchObject({ reviver: 1, target: 0 });
    expect(sim.state.actors[0]).toMatchObject({ life: "alive", health: 10 });
    expect(human.eliminated).toBe(false);

    // Kill the human outright: eliminate() is called.
    sim.killActor(0);
    expect(human.eliminated).toBe(true);
    expect(sim.state.actors[0]!.life).toBe("dead");
  }, 60_000);
});
