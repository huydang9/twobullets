import { NET_RESPAWN_SECONDS, NET_WEAPON_LOADOUT } from "@twobullets/contracts";
import { MAX_REWIND_TICKS, NETWORK_PROFILES, type NetworkProfile } from "@twobullets/netcode";
import { killCauseOfCode, LifeCode, ReliableEventType, TEAMMATE_REVIVE_MAX, type KillFeed, type ReliableEvent, type TeammateVitals } from "@twobullets/protocol";
import { quantizePitch, quantizeYaw } from "@twobullets/shared/aim";
import { MOVEMENT } from "@twobullets/shared/constants";
import { Btn } from "@twobullets/shared/input";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { WEAPONS } from "@twobullets/shared/weapons/weapons";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import type { HeadlessClient } from "../src/dev/HeadlessClient";
import type { ServerMatch } from "../src/match/ServerMatch";
import { createHarness, type Harness } from "./harness";

// Networked combat in-process (virtual clock, LinkConditioner): server projectiles with rewind, the damage pipeline,
// knock/revive/bleed-out/respawn, and event delivery. Players are placed on the arena's open south lane: the shooter at
// S looks at A past the east end of the south barrier; B is straight behind the barrier (x ∈ [−4, 4], z ∈ [−22.5, −21.5]).

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
});

const S: Vec3 = { x: 0, y: 0, z: -14 };
const A: Vec3 = { x: 7, y: 0, z: -26 };
const B: Vec3 = { x: 0, y: 0, z: -26 };
const CHEST = 1.15;

interface Logged {
  readonly events: ReliableEvent[];
  readonly feeds: KillFeed[];
}

function log(client: HeadlessClient): Logged {
  const l: Logged = { events: [], feeds: [] };
  client.onReliable = (e) => l.events.push({ ...e } as ReliableEvent);
  client.onKillFeed = (f) => l.feeds.push(f);
  return l;
}

function aimAt(match: ServerMatch, fromSlot: number, to: () => Vec3 | null, height: () => number): { yawQ: number; pitchQ: number } {
  const from = match.player(fromSlot)!.feet;
  const target = to();
  if (target === null) return { yawQ: 0, pitchQ: (1 << 17) - 1 };
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const dy = target.y + height() - (from.y + MOVEMENT.standEyeHeight);
  return { yawQ: quantizeYaw(Math.atan2(dx, dz)), pitchQ: quantizePitch(Math.atan2(-dy, Math.sqrt(dx * dx + dz * dz))) };
}

/** Stands still, facing nowhere in particular; optional interact. */
function idle(client: HeadlessClient, interact: () => boolean = () => false): void {
  client.script = (_tick, e) => {
    e.forward = 0;
    e.right = 0;
    e.buttons = interact() ? Btn.interact : 0;
    e.select = 0;
  };
}

interface Gun {
  readonly fireTicks: Set<number>;
  /** Fire every `every` ticks while this returns true (checked when the input is sampled). */
  auto: { every: number; while: () => boolean } | null;
  /** View offset override (1/8 tick) for scripted shots, or null for honest. */
  claim8: number | null;
}

/** Holds ADS at `target` and taps fire on scheduled ticks. */
function gunner(h: Harness, client: HeadlessClient, target: () => Vec3 | null, height: () => number = () => CHEST): Gun {
  const gun: Gun = { fireTicks: new Set(), auto: null, claim8: null };
  client.script = (tick, e) => {
    const aim = aimAt(h.match, client.playerSlot, target, height);
    e.forward = 0;
    e.right = 0;
    e.select = 0;
    e.yawQ = aim.yawQ;
    e.pitchQ = aim.pitchQ;
    e.buttons = Btn.aim;
    if (gun.fireTicks.has(tick) || (gun.auto !== null && tick % gun.auto.every === 0 && gun.auto.while())) {
      e.buttons |= Btn.fire;
      if (gun.claim8 !== null) e.viewOffset8 = gun.claim8;
    }
  };
  return gun;
}

function feetOf(match: ServerMatch, slot: number): Vec3 {
  const f = match.player(slot)!.feet;
  return { x: f.x, y: f.y, z: f.z };
}

const hitConfirms = (l: Logged) => l.events.filter((e) => e.type === ReliableEventType.HitConfirm);
const damageTaken = (l: Logged) => l.events.filter((e) => e.type === ReliableEventType.DamageTaken);
const kills = (l: Logged) => l.events.filter((e) => e.type === ReliableEventType.Kill);

async function duel(profile: NetworkProfile, onTickEnd?: { hook: ((tick: number, m: ServerMatch) => void) | null }) {
  const h = await createHarness(havok, { onTickEnd: (tick, m) => onTickEnd?.hook?.(tick, m) });
  const lossy = profile.name !== "lan";
  const opts = { profile, leadTicks: lossy ? 5 : 3, interpDelayMs: 25 };
  const shooter = h.connect({ ...opts, team: 1, seed: 11 });
  const target = h.connect({ ...opts, team: 2, seed: 12 });
  const bystander = h.connect({ ...opts, team: 3, seed: 13 });
  idle(target);
  idle(bystander);
  h.run(300);
  for (const c of [shooter, target, bystander]) expect(c.welcome).not.toBeNull();
  h.match.debugPlace(shooter.playerSlot, S);
  h.match.debugPlace(target.playerSlot, A);
  h.match.debugPlace(bystander.playerSlot, { x: -10, y: 0, z: -14 });
  return { h, shooter, target, bystander };
}

describe("networked combat", () => {
  it('scripted duel on "typical": rewound hit on a stationary target, events to the right clients, no hit on a target that moved behind the barrier beyond the rewind, and a backtracked claim gains nothing', async () => {
    const hooks: { hook: ((tick: number, m: ServerMatch) => void) | null } = { hook: null };
    const { h, shooter, target, bystander } = await duel(NETWORK_PROFILES.typical, hooks);
    const shooterLog = log(shooter);
    const targetLog = log(target);
    const bystanderLog = log(bystander);
    const tSlot = target.playerSlot;
    const sSlot = shooter.playerSlot;
    let aimPoint: Vec3 = A;
    const gun = gunner(h, shooter, () => aimPoint);
    h.run(2000);

    // 1. Stationary target at A.
    const view = h.match.player(sSlot)!.viewDelay;
    const expected = view.expectedTicks;
    expect(view.rttMs).toBeGreaterThan(45);
    expect(view.rttMs).toBeLessThan(95);
    const p = h.match.nextTick + 40;
    gun.fireTicks.add(p);
    h.run(1200);
    expect(hitConfirms(shooterLog)).toHaveLength(1);
    const confirm = hitConfirms(shooterLog)[0]!;
    expect(confirm).toMatchObject({ victim: tSlot, pellets: 1, killed: false, downed: false });
    const health = h.match.player(tSlot)!.vitals.health;
    expect(health).toBeLessThan(100);
    expect(confirm.damageQ).toBe(Math.round((100 - health) * 10));
    expect(damageTaken(targetLog)).toHaveLength(1);
    expect(damageTaken(targetLog)[0]).toMatchObject({ attacker: sSlot, amountQ: confirm.damageQ });
    expect(hitConfirms(targetLog)).toHaveLength(0);
    expect(bystanderLog.events).toHaveLength(0);
    // Tier U: tracers for everyone but the shooter, bystander blood for everyone but the victim.
    expect(shooter.shotsSeen).toBe(0);
    expect(target.shotsSeen).toBe(1);
    expect(bystander.shotsSeen).toBe(1);
    expect(bystander.hitsSeen).toBe(1);
    expect(target.hitsSeen).toBe(0);
    expect(shooter.hitsSeen).toBe(1);
    // The honest client's D agreed with the server's expectation.
    expect(view.stats.clamps).toBe(0);
    expect(Math.abs(shooter.viewOffsets[0]! / 8 - expected)).toBeLessThan(2);

    // 2. The target teleports behind the barrier at tick t1; the shooter fires at A one tick later (it still saw A).
    const t1 = h.match.nextTick + 40;
    hooks.hook = (tick, m) => {
      if (tick === t1 - 1) m.debugPlace(tSlot, B);
    };
    gun.fireTicks.add(t1 + 1);
    // ... and again long after the move: beyond any rewind, A is empty.
    gun.fireTicks.add(t1 + MAX_REWIND_TICKS + 8);
    h.run(1500);
    hooks.hook = null;
    expect(feetOf(h.match, tSlot).x).toBeCloseTo(0, 1);
    expect(hitConfirms(shooterLog)).toHaveLength(2);
    expect(view.stats.shots).toBe(3);

    // 3. Backtrack: back to A, then behind the barrier again; the shooter claims MAX_REWIND at t2 + ceil(D + 2) + 1. A
    // true D of 12 would still see A (D ≤ 8), but the claim is clamped to expected + 2 and misses.
    h.match.debugPlace(tSlot, A);
    h.run(300);
    const d = view.expectedTicks;
    expect(d).toBeLessThanOrEqual(8);
    const t2 = h.match.nextTick + 40;
    hooks.hook = (tick, m) => {
      if (tick === t2 - 1) m.debugPlace(tSlot, B);
    };
    gun.claim8 = MAX_REWIND_TICKS * 8;
    gun.fireTicks.add(t2 + Math.ceil(d + 2) + 1);
    const clampsBefore = view.stats.clamps;
    h.run(1500);
    expect(view.stats.clamps).toBe(clampsBefore + 1);
    expect(h.match.combat!.stats.viewDelayClamps).toBeGreaterThanOrEqual(1);
    expect(hitConfirms(shooterLog)).toHaveLength(2);

    // 4. Aiming at the target behind the barrier: the barrier stops the bullet.
    gun.claim8 = null;
    aimPoint = B;
    gun.fireTicks.add(h.match.nextTick + 40);
    h.run(1200);
    expect(hitConfirms(shooterLog)).toHaveLength(2);
    expect(h.match.combat!.projectiles.stats.worldHits).toBeGreaterThanOrEqual(1);
    for (const c of [shooter, target, bystander]) expect(c.disconnect).toBeNull();
    await h.dispose();
  }, 120_000);

  it("friendly fire: a teammate's bullets knock and then kill, flagged as friendly fire", async () => {
    const h = await createHarness(havok);
    const a = h.connect({ team: 0, seed: 21, interpDelayMs: 25 });
    const b = h.connect({ team: 0, seed: 22, interpDelayMs: 25 });
    idle(b);
    h.run(300);
    const logA = log(a);
    const logB = log(b);
    h.match.debugPlace(a.playerSlot, S);
    h.match.debugPlace(b.playerSlot, A);
    const victim = h.match.player(b.playerSlot)!;
    const gun = gunner(
      h,
      a,
      () => feetOf(h.match, b.playerSlot),
      () => (victim.life === "downed" ? 0.25 : CHEST),
    );
    gun.auto = { every: 12, while: () => victim.life !== "dead" };
    h.run(12_000);
    expect(victim.life === "dead" || victim.deathTick >= 0 || h.match.combat!.stats.respawns > 0).toBe(true);
    const k = kills(logA);
    expect(k.length).toBeGreaterThanOrEqual(2);
    expect(k[0]).toMatchObject({ killer: a.playerSlot, victim: b.playerSlot, knock: true, friendlyFire: true, cause: 2 });
    expect(k[1]).toMatchObject({ killer: a.playerSlot, victim: b.playerSlot, knock: false, friendlyFire: true });
    expect(killCauseOfCode(k[1]!.type === ReliableEventType.Kill ? k[1]!.cause : 0)).toBe("rifle");
    expect(logB.feeds[1]).toMatchObject({ friendlyFire: true, knock: false, knockedBy: a.playerSlot });
    expect(h.match.combat!.stats.friendlyFireHits).toBeGreaterThan(5);
    expect(damageTaken(logB).length).toBeGreaterThan(5);
    await h.dispose();
  }, 60_000);

  async function knockSetup() {
    const h = await createHarness(havok);
    const a = h.connect({ team: 0, seed: 31, interpDelayMs: 25 });
    const mate = h.connect({ team: 0, seed: 32, interpDelayMs: 25 });
    const enemy = h.connect({ team: 1, seed: 33, interpDelayMs: 25 });
    idle(a);
    h.run(300);
    const logs = [log(a), log(mate), log(enemy)] as const;
    h.match.debugPlace(a.playerSlot, A);
    h.match.debugPlace(mate.playerSlot, { x: 8.2, y: 0, z: -26.5 });
    h.match.debugPlace(enemy.playerSlot, S);
    const victim = h.match.player(a.playerSlot)!;
    const gun = gunner(h, enemy, () => feetOf(h.match, a.playerSlot));
    gun.auto = { every: 12, while: () => victim.life === "alive" };
    return { h, a, mate, enemy, logs, victim, gun };
  }

  it("knock → teammate holds interact for 5 s → alive with revive health", async () => {
    const { h, a, mate, enemy, logs, victim, gun } = await knockSetup();
    let reviving = false;
    idle(mate, () => reviving);
    let maxReviveTicks = 0;
    a.onSnapshot = (snap) => {
      if (snap.vitals && snap.vitals.life === LifeCode.downed) maxReviveTicks = Math.max(maxReviveTicks, snap.vitals.reviveTicks);
    };
    for (let i = 0; i < 100 && victim.life === "alive"; i++) h.run(100);
    expect(victim.life).toBe("downed");
    const knock = kills(logs[1]);
    expect(knock).toHaveLength(1);
    expect(knock[0]).toMatchObject({ killer: enemy.playerSlot, victim: a.playerSlot, knock: true, friendlyFire: false });
    for (const l of logs) expect(l.feeds.map((f) => f.knock)).toEqual([true]);
    const downedHealth = victim.vitals.downedHealth;

    gun.auto = null;
    reviving = true;
    h.run(2500);
    expect(victim.life).toBe("downed");
    // Bleed-out paused while the revive runs.
    expect(victim.vitals.downedHealth).toBeGreaterThan(downedHealth - 1);
    h.run(2400);
    expect(victim.life).toBe("downed");
    h.run(400);
    expect(victim.life).toBe("alive");
    expect(victim.vitals.health).toBe(10);
    expect(h.match.combat!.stats.revives).toBe(1);
    expect(maxReviveTicks).toBeGreaterThan(200);
    await h.dispose();
  }, 60_000);

  it("teammate vitals: damage, knock and revive reach the teammate's snapshots (reviver sees its progress); enemies never get the group", async () => {
    const h = await createHarness(havok);
    const a = h.connect({ team: 0, seed: 41, interpDelayMs: 25 });
    const mate = h.connect({ team: 0, seed: 42, interpDelayMs: 25 });
    const enemy = h.connect({ team: 1, seed: 43, interpDelayMs: 25 });
    const enemyMate = h.connect({ team: 1, seed: 44, interpDelayMs: 25 });
    let reviving = false;
    idle(a);
    idle(mate, () => reviving);
    idle(enemyMate);
    h.run(300);
    const clients = [a, mate, enemy, enemyMate] as const;
    // Newest group per client, every slot any group listed, and how many snapshots carried one.
    const newest = clients.map(() => ({ tick: -1, list: [] as TeammateVitals[] }));
    const listed = clients.map(() => new Set<number>());
    const carried = clients.map(() => ({ snapshots: 0, groups: 0 }));
    let maxReviveQ = 0;
    clients.forEach((c, i) => {
      c.onSnapshot = (snap) => {
        carried[i]!.snapshots++;
        const list = snap.teammates ?? [];
        if (list.length === 0) return;
        carried[i]!.groups++;
        for (const m of list) listed[i]!.add(m.slot);
        if (snap.header.serverTick > newest[i]!.tick) newest[i] = { tick: snap.header.serverTick, list: list.map((m) => ({ ...m })) };
        const mine = list.find((m) => m.slot === a.playerSlot && m.reviverIsMe);
        if (i === 1 && mine) maxReviveQ = Math.max(maxReviveQ, mine.reviveQ);
      };
    });
    const entry = (i: number, slot: number) => newest[i]!.list.find((m) => m.slot === slot) ?? null;

    // Quiet: unchanged vitals ride only the keyframes.
    for (const c of carried) c.snapshots = c.groups = 0;
    h.run(3000);
    for (const c of carried) {
      expect(c.snapshots).toBeGreaterThan(150);
      expect(c.groups / c.snapshots).toBeLessThan(0.05);
    }
    expect(entry(1, a.playerSlot)).toMatchObject({ life: LifeCode.alive, health: 100 });

    h.match.debugPlace(a.playerSlot, A);
    h.match.debugPlace(mate.playerSlot, { x: 8.2, y: 0, z: -26.5 });
    h.match.debugPlace(enemy.playerSlot, S);
    h.match.debugPlace(enemyMate.playerSlot, { x: -10, y: 0, z: -14 });
    const victim = h.match.player(a.playerSlot)!;
    const gun = gunner(h, enemy, () => feetOf(h.match, a.playerSlot));
    gun.auto = { every: 12, while: () => victim.vitals.health >= 100 };
    for (let i = 0; i < 100 && victim.vitals.health >= 100; i++) h.run(100);
    gun.auto = null;
    h.run(500);
    expect(victim.life).toBe("alive");
    expect(victim.vitals.health).toBeLessThan(100);
    expect(entry(1, a.playerSlot)).toMatchObject({ life: LifeCode.alive, health: Math.ceil(victim.vitals.health) });
    expect(entry(0, mate.playerSlot)).toMatchObject({ life: LifeCode.alive, health: 100 });

    gun.auto = { every: 12, while: () => victim.life === "alive" };
    for (let i = 0; i < 100 && victim.life === "alive"; i++) h.run(100);
    gun.auto = null;
    expect(victim.life).toBe("downed");
    h.run(300);
    const knocked = entry(1, a.playerSlot)!;
    expect(knocked).toMatchObject({ life: LifeCode.downed, health: 0, reviverIsMe: false, reviveQ: 0 });
    expect(Math.abs(knocked.downedHealth - victim.vitals.downedHealth)).toBeLessThanOrEqual(2);

    reviving = true;
    h.run(2500);
    expect(victim.life).toBe("downed");
    const midway = entry(1, a.playerSlot)!;
    expect(midway.reviverIsMe).toBe(true);
    expect(Math.abs(midway.reviveQ - (victim.vitals.reviveProgress / 5) * TEAMMATE_REVIVE_MAX)).toBeLessThanOrEqual(4);
    h.run(3000);
    expect(victim.life).toBe("alive");
    expect(maxReviveQ).toBeGreaterThan(55);
    h.run(200);
    expect(entry(1, a.playerSlot)).toMatchObject({ life: LifeCode.alive, health: 10 });

    // Never an enemy's vitals: each client's groups list only its own teammate.
    expect([...listed[0]!]).toEqual([mate.playerSlot]);
    expect([...listed[1]!]).toEqual([a.playerSlot]);
    expect([...listed[2]!]).toEqual([enemyMate.playerSlot]);
    expect([...listed[3]!]).toEqual([enemy.playerSlot]);
    await h.dispose();
  }, 60_000);

  it("knock → bleed-out → dead (credited to the knocker) → respawn with a fresh loadout", async () => {
    const { h, a, mate, enemy, logs, victim, gun } = await knockSetup();
    idle(mate);
    for (let i = 0; i < 100 && victim.life === "alive"; i++) h.run(100);
    expect(victim.life).toBe("downed");
    gun.auto = null;
    const ammoBefore = h.match.player(enemy.playerSlot)!.state.weapon.slots[0]!.magazine;
    expect(ammoBefore).toBeLessThan(WEAPONS.rifle.magazineSize);

    let deadSeen = false;
    a.onSnapshot = (snap) => {
      if (snap.vitals?.life === LifeCode.dead) deadSeen = true;
    };
    for (let i = 0; i < 70 && victim.life === "downed"; i++) h.run(1000);
    expect(victim.life).toBe("dead");
    const k = kills(logs[2]);
    expect(k.map((e) => e.type === ReliableEventType.Kill && [e.knock, killCauseOfCode(e.cause), e.killer])).toEqual([
      [true, "rifle", enemy.playerSlot],
      [false, "bleedOut", enemy.playerSlot],
    ]);
    expect(logs[0].feeds[1]).toMatchObject({ knockedBy: enemy.playerSlot, knock: false });
    const deathTick = victim.deathTick;
    h.run(500);
    expect(deadSeen).toBe(true);
    expect(victim.life).toBe("dead");
    // The dead don't move or shoot.
    const frozen = feetOf(h.match, a.playerSlot);
    h.run(NET_RESPAWN_SECONDS * 1000 - 800);
    expect(feetOf(h.match, a.playerSlot)).toEqual(frozen);
    h.run(600);
    expect(victim.life).toBe("alive");
    expect(victim.vitals.health).toBe(100);
    expect(h.match.nextTick - deathTick).toBeGreaterThanOrEqual(NET_RESPAWN_SECONDS * 60);
    const spawn = victim.spawn.feet;
    const f = feetOf(h.match, a.playerSlot);
    expect(Math.abs(f.x - spawn.x) + Math.abs(f.z - spawn.z)).toBeLessThan(0.5);
    expect(victim.state.weapon.slots.map((s) => s?.id ?? null)).toEqual([...NET_WEAPON_LOADOUT]);
    expect(victim.state.weapon.slots[0]!.magazine).toBe(WEAPONS.rifle.magazineSize);
    await h.dispose();
  }, 90_000);

  it('reliable events and the kill feed arrive exactly once on "typical" through kills and respawns', async () => {
    const { h, shooter, target, bystander } = await duel(NETWORK_PROFILES.typical);
    const logs = [log(shooter), log(target), log(bystander)];
    const victim = h.match.player(target.playerSlot)!;
    const gun = gunner(h, shooter, () => (victim.life === "dead" ? null : feetOf(h.match, target.playerSlot)));
    gun.auto = { every: 9, while: () => victim.life !== "dead" };
    // Respawned targets are brought back to A.
    let placedAfterRespawn = 0;
    for (let s = 0; s < 20; s++) {
      h.run(1000);
      if (victim.life === "alive" && Math.abs(victim.feet.x - A.x) > 0.5) {
        h.match.debugPlace(target.playerSlot, A);
        placedAfterRespawn++;
      }
    }
    gun.auto = null;
    h.run(3000);
    const stats = h.match.combat!.stats;
    expect(stats.kills).toBeGreaterThanOrEqual(2);
    expect(placedAfterRespawn).toBeGreaterThanOrEqual(1);
    for (const [i, c] of [shooter, target, bystander].entries()) {
      const server = h.match.player(c.playerSlot)!.net;
      expect(server.events.pending, `client ${i} unacked`).toBe(0);
      expect(c.reliableDelivered, `client ${i} delivered`).toBe(server.events.stats.pushed);
      expect(c.events.stats.dropped).toBe(0);
      // Knocks can't happen for a solo team: every Kill is a kill.
      expect(kills(logs[i]!)).toHaveLength(stats.kills);
      expect(logs[i]!.feeds).toHaveLength(stats.kills);
      const seqs = logs[i]!.events.map((e) => e.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
    }
    expect(hitConfirms(logs[0]!).length).toBe(damageTaken(logs[1]!).length);
    // Honest view offsets on "typical" stay inside the ±2 tick window.
    const view = h.match.player(shooter.playerSlot)!.viewDelay.stats;
    console.log(`[combat] typical: ${view.shots} shots, ${view.clamps} D clamps, ${stats.kills} kills, reliable pushed ${h.match.player(shooter.playerSlot)!.net.events.stats.pushed}`);
    expect(view.clamps / view.shots).toBeLessThan(0.05);
    expect(shooter.disconnect).toBeNull();
    await h.dispose();
  }, 120_000);
});
