import { ReliableEventSender } from "@twobullets/netcode/reliableEvents";
import {
  createEntityState,
  createOwnerBlock,
  killFeedOf,
  writeDamageTaken,
  writeHitConfirm,
  writeKill,
  writePlayerHitEvent,
  writeRemoteEntity,
  writeShotEvent,
} from "@twobullets/netcode/replication";
import { ManualClock } from "@twobullets/netcode/testing/clock";
import { createMemorySessionPair } from "@twobullets/netcode/testing/memorySession";
import { createBitWriter } from "@twobullets/protocol/bits";
import { hitZoneMaskBit, LifeCode } from "@twobullets/protocol/codes";
import { encodeKillFeed, encodeResyncResponse, encodeWelcome, ResyncScope } from "@twobullets/protocol/messages/control";
import { createPlayerHitEvent, createReliableEventStore, createShotEvent } from "@twobullets/protocol/messages/events";
import { MsgId } from "@twobullets/protocol/messages/ids";
import { createOwnerVitalsBlock, encodeSnapshot, type Snapshot } from "@twobullets/protocol/messages/snapshot";
import { quantizeHealth } from "@twobullets/protocol/quantize";
import { dequantizePitch, dequantizeYaw, quantizePitch, quantizeYaw } from "@twobullets/shared/aim";
import { Btn } from "@twobullets/shared/input";
import type { MatchEvent } from "@twobullets/shared/match/types";
import { createMoveState } from "@twobullets/shared/movement/movement";
import type { FiredShot, HitZone } from "@twobullets/shared/weapons/types";
import { WEAPONS } from "@twobullets/shared/weapons/weapons";
import { shotDirections } from "@twobullets/shared/weapons/weaponStep";
import { PlayerInputRing } from "@twobullets/shared/inputRing";
import { describe, expect, it } from "vitest";
import { LocalPlayerNet, type PredictedBody } from "../../src/net/LocalPlayerNet";
import { NetClient } from "../../src/net/NetClient";
import { NetClock } from "../../src/net/NetClock";
import { NetCombat, type CombatFeedback, type NetDamageTaken, type NetHitConfirm, type NetKill, type NetOwnerVitals } from "../../src/net/NetCombat";
import { netInputButtons, netInputSelect, netMoveGates, viewOffset8 } from "../../src/net/netCombatRules";
import { RemoteRoster } from "../../src/net/RemoteRoster";

// Networked combat events through the real NetClient decode path (bit-packed snapshots with reliable resends, the
// KillFeed stream) into NetCombat, with the HUD/presentation side mocked.

const OWN = 0;
const SHOOTER = 2;
const VICTIM = 3;
const TICK = 5000;

class Recorder implements CombatFeedback {
  readonly shots: { shooter: number; shot: FiredShot }[] = [];
  readonly hits: { victim: number; zone: HitZone; armor: boolean; dirX: number; dirZ: number }[] = [];
  readonly confirms: NetHitConfirm[] = [];
  readonly damage: NetDamageTaken[] = [];
  readonly kills: NetKill[] = [];
  readonly feed: MatchEvent[] = [];
  readonly vitalsCalls: { vitals: NetOwnerVitals; previous: string }[] = [];
  welcomed: [number, number] | null = null;
  remoteShot(shooter: number, shot: FiredShot): void {
    this.shots.push({ shooter, shot });
  }
  remoteHit(victim: number, zone: HitZone, armor: boolean, dirX: number, dirZ: number): void {
    this.hits.push({ victim, zone, armor, dirX, dirZ });
  }
  hitConfirm(hit: NetHitConfirm): void {
    this.confirms.push(hit);
  }
  damageTaken(hit: NetDamageTaken): void {
    this.damage.push(hit);
  }
  kill(kill: NetKill): void {
    this.kills.push(kill);
  }
  killFeed(event: MatchEvent): void {
    this.feed.push(event);
  }
  vitals(vitals: Readonly<NetOwnerVitals>, previous: string): void {
    this.vitalsCalls.push({ vitals: { ...vitals }, previous });
  }
  welcome(slot: number, team: number): void {
    this.welcomed = [slot, team];
  }
}

const stubBody: PredictedBody = {
  tickFeet: { x: 0, y: 0, z: 0 },
  moveState: createMoveState(),
  weaponState: null,
  restoreMove() {},
  restoreWeapon() {},
  replayTick: () => createMoveState(),
  setRenderOffset() {},
};

function setup() {
  const clock = new ManualClock(1000);
  const [clientEnd, serverEnd] = createMemorySessionPair({ clock });
  const recorder = new Recorder();
  const combat = new NetCombat(recorder);
  const local = new LocalPlayerNet(stubBody);
  const client = new NetClient(clientEnd, {
    clock,
    netClock: new NetClock(),
    local,
    inputs: new PlayerInputRing(),
    roster: new RemoteRoster(),
    joinToken: "test",
    events: combat,
  });
  const w = createBitWriter(1500);
  serverEnd.onStream((bytes) => {
    if (bytes[0] !== MsgId.Hello) return;
    w.reset();
    encodeWelcome(w, {
      playerSlot: OWN,
      teamId: 1,
      serverTick: TICK,
      tickRate: 60,
      snapshotRate: 60,
      matchSeed: 1,
      phase: 0,
      phaseEndTick: 0,
      maxRewindMs: 200,
      interpFloorMs: 50,
      resumeToken: new Uint8Array(16),
      contentHash: 0,
      flags: 0,
    });
    serverEnd.sendStream(w.bytes());
  });
  client.start();
  return { clock, serverEnd, recorder, combat, client, w };
}

const SHOOTER_FEET = { x: 12.3, y: 0.5, z: -4.2 };
const VICTIM_FEET = { x: 20, y: 0.5, z: 3 };
const YAW = 1.1;
const PITCH = -0.05;

describe("NetCombat event decoding", () => {
  it("drives each HUD/presentation call once, with dequantized values, despite reliable resends", () => {
    const { serverEnd, recorder, combat, client, w } = setup();
    expect(recorder.welcomed).toEqual([OWN, 1]);

    const sender = new ReliableEventSender();
    const store = createReliableEventStore();
    sender.push(writeHitConfirm(VICTIM, 1, hitZoneMaskBit("head") | hitZoneMaskBit("body"), 42.5, false, true, true, false, store));
    sender.push(writeDamageTaken(SHOOTER, 17.3, "body", "bullet", 1, 0, store));
    sender.push(writeKill(SHOOTER, VICTIM, "rifle", false, true, false, 35, store));

    const move = createMoveState();
    const shooter = createEntityState();
    writeRemoteEntity(SHOOTER, SHOOTER_FEET, move, quantizeYaw(YAW), quantizePitch(PITCH), Btn.fire, shooter);
    const victim = createEntityState();
    writeRemoteEntity(VICTIM, VICTIM_FEET, move, 0, quantizePitch(0), 0, victim);
    const eye = { x: SHOOTER_FEET.x, y: SHOOTER_FEET.y + 1.62, z: SHOOTER_FEET.z };
    const shot = createShotEvent();
    writeShotEvent(SHOOTER, 1, "rifle", 7, 1.5, quantizeYaw(YAW), quantizePitch(PITCH), eye, shooter, shot);
    const ownShot = createShotEvent();
    writeShotEvent(OWN, 0, "rifle", 3, 1, 0, quantizePitch(0), eye, shooter, ownShot);
    const hit = createPlayerHitEvent();
    writePlayerHitEvent(VICTIM, "body", false, 0, 1, hit);
    const ownHit = createPlayerHitEvent();
    writePlayerHitEvent(OWN, "head", false, 1, 0, ownHit);
    const vitals = createOwnerVitalsBlock();
    vitals.life = LifeCode.downed;
    vitals.healthQ = 0;
    vitals.downedHealthQ = quantizeHealth(80, 10);
    vitals.reviveTicks = 30;

    for (let i = 0; i < 4; i++) {
      const tick = TICK + i;
      const reliable = sender.select(2000);
      const snapshot: Snapshot = {
        header: { serverTick: tick, baselineTick: null, lastProcessedInputTick: -1, clientTimeEcho: 0, serverHoldMs: 0, inputBufferDepthQ: 0, sections: 0 },
        owner: createOwnerBlock(),
        entities: [shooter, victim],
        vitals,
        // Unreliable events are sent once.
        shots: i === 0 ? [shot, ownShot] : [],
        hits: i === 0 ? [hit, ownHit] : [],
        reliable: [...reliable],
      };
      w.reset();
      encodeSnapshot(w, snapshot, null);
      sender.markSent(tick);
      serverEnd.sendDatagram(w.bytes());
    }
    w.reset();
    encodeKillFeed(w, killFeedOf(TICK + 2, SHOOTER, VICTIM, "rifle", SHOOTER, false, true, false, 35.2));
    serverEnd.sendStream(w.bytes());

    expect(client.receiver.stats.delivered).toBe(3);
    expect(client.receiver.stats.duplicates).toBeGreaterThan(0);
    expect(client.receiver.ackSeq).toBe(2);

    expect(recorder.confirms).toHaveLength(1);
    expect(recorder.confirms[0]).toMatchObject({ victim: VICTIM, pellets: 1, zone: "head", damage: 42.5, killed: false, downed: true, armorHit: true });
    expect(recorder.damage).toHaveLength(1);
    expect(recorder.damage[0]!.attacker).toBe(SHOOTER);
    expect(recorder.damage[0]!.amount).toBeCloseTo(17.3, 5);
    expect(recorder.damage[0]!.directionYaw!).toBeCloseTo(Math.PI / 2, 1);
    expect(recorder.damage[0]).toMatchObject({ zone: "body", kind: "bullet" });
    expect(recorder.kills).toEqual([{ killer: SHOOTER, victim: VICTIM, cause: "rifle", headshot: false, friendlyFire: true, knock: false, distanceM: 35 }]);
    expect(recorder.feed).toEqual([{ type: "kill", tick: TICK + 2, killer: SHOOTER, victim: VICTIM, cause: "rifle", headshot: false, knockedBy: SHOOTER, teamKill: true }]);
    // Same vitals in four snapshots: one call.
    expect(recorder.vitalsCalls).toHaveLength(1);
    expect(recorder.vitalsCalls[0]!.vitals).toMatchObject({ life: "downed", health: 0, downedHealth: 80, reviveSeconds: 0.5 });
    expect(recorder.vitalsCalls[0]!.previous).toBe("alive");

    // Shots and hits wait for the render timeline (fire tick = snapshot tick − tickOffset).
    expect(recorder.shots).toHaveLength(0);
    combat.update(TICK - 2);
    expect(recorder.shots).toHaveLength(0);
    combat.update(TICK);
    expect(recorder.shots).toHaveLength(1);
    expect(recorder.hits).toHaveLength(1);
    const played = recorder.shots[0]!;
    expect(played.shooter).toBe(SHOOTER);
    expect(played.shot.shotId).toBe(7);
    expect(played.shot.origin.x).toBeCloseTo(eye.x, 1);
    expect(played.shot.origin.y).toBeCloseTo(eye.y, 1);
    expect(played.shot.origin.z).toBeCloseTo(eye.z, 1);
    const expected = shotDirections(WEAPONS.rifle, 7, dequantizeYaw(quantizeYaw(YAW)), dequantizePitch(quantizePitch(PITCH)), 1.5);
    expect(played.shot.directions).toHaveLength(expected.length);
    expect(played.shot.directions[0]!.x).toBeCloseTo(expected[0]!.x, 4);
    expect(played.shot.directions[0]!.y).toBeCloseTo(expected[0]!.y, 4);
    expect(played.shot.directions[0]!.z).toBeCloseTo(expected[0]!.z, 4);
    expect(recorder.hits[0]).toMatchObject({ victim: VICTIM, zone: "body", armor: false });
    expect(recorder.hits[0]!.dirZ).toBeCloseTo(1, 1);

    // A Resync response resets the receiver (the server reset its sender).
    w.reset();
    encodeResyncResponse(w, { scope: ResyncScope.state, serverTick: TICK + 10 });
    serverEnd.sendStream(w.bytes());
    expect(client.receiver.ackSeq).toBe(-1);
  });

  it("a snapshot dropped for a missing baseline still delivers its shots, hits and reliable events", () => {
    const { serverEnd, recorder, combat, client, w } = setup();
    const move = createMoveState();
    const shooter = createEntityState();
    writeRemoteEntity(SHOOTER, SHOOTER_FEET, move, quantizeYaw(YAW), quantizePitch(PITCH), Btn.fire, shooter);
    const victim = createEntityState();
    writeRemoteEntity(VICTIM, VICTIM_FEET, move, 0, quantizePitch(0), 0, victim);
    const header = (tick: number) => ({ serverTick: tick, baselineTick: null, lastProcessedInputTick: -1, clientTimeEcho: 0, serverHoldMs: 0, inputBufferDepthQ: 0, sections: 0 });
    const state = (tick: number): Snapshot => ({ header: header(tick), owner: createOwnerBlock(), entities: [shooter, victim] });
    const send = (snapshot: Snapshot, baseline: Snapshot | null) => {
      w.reset();
      encodeSnapshot(w, snapshot, baseline);
      serverEnd.sendDatagram(w.bytes());
    };
    // A decoded snapshot first: the client knows where the shooter stands.
    send(state(TICK), null);
    expect(client.stats.decodeFailures).toBe(0);

    const sender = new ReliableEventSender();
    sender.push(writeHitConfirm(VICTIM, 1, hitZoneMaskBit("body"), 30, false, false, false, false, createReliableEventStore()));
    const eye = { x: SHOOTER_FEET.x, y: SHOOTER_FEET.y + 1.62, z: SHOOTER_FEET.z };
    const shot = createShotEvent();
    writeShotEvent(SHOOTER, 0, "rifle", 9, 1, quantizeYaw(YAW), quantizePitch(PITCH), eye, shooter, shot);
    const hit = createPlayerHitEvent();
    writePlayerHitEvent(VICTIM, "head", false, 0, 1, hit);
    // A shooter the client has never seen can't be placed.
    const stranger = createShotEvent();
    writeShotEvent(9, 0, "rifle", 1, 1, 0, quantizePitch(0), eye, shooter, stranger);
    // Delta against a tick the client never received: the state can't be decoded, the events can.
    send({ ...state(TICK + 1), shots: [shot, stranger], hits: [hit], reliable: [...sender.select(2000)] }, state(TICK - 4));
    expect(client.stats.decodeFailures).toBe(1);
    expect(client.store.newestTick).toBe(TICK);
    expect(client.receiver.stats.delivered).toBe(1);
    expect(recorder.confirms).toHaveLength(1);
    expect(recorder.confirms[0]).toMatchObject({ victim: VICTIM, zone: "body", damage: 30 });
    expect(client.stats.shotsReceived).toBe(2);
    expect(client.stats.hitsReceived).toBe(1);

    combat.update(TICK + 1);
    expect(recorder.shots).toHaveLength(1);
    expect(recorder.shots[0]!.shooter).toBe(SHOOTER);
    expect(recorder.shots[0]!.shot.shotId).toBe(9);
    expect(recorder.shots[0]!.shot.origin.x).toBeCloseTo(eye.x, 1);
    expect(recorder.shots[0]!.shot.origin.y).toBeCloseTo(eye.y, 1);
    expect(combat.stats.shotsDropped).toBe(1);
    expect(recorder.hits).toHaveLength(1);
    expect(recorder.hits[0]).toMatchObject({ victim: VICTIM, zone: "head" });

    // The resend in the next (decodable) snapshot is a duplicate.
    send({ ...state(TICK + 2), reliable: [...sender.select(2000)] }, null);
    expect(client.receiver.stats.delivered).toBe(1);
    expect(recorder.confirms).toHaveLength(1);
  });

  it("life rules: downed clears combat input and crawls, dead freezes, alive is open", () => {
    const all = Btn.fire | Btn.aim | Btn.reload | Btn.sprint | Btn.interact;
    expect(netInputButtons(all, LifeCode.alive)).toBe(all);
    expect(netInputButtons(all, LifeCode.downed)).toBe(Btn.sprint | Btn.interact);
    expect(netInputSelect(3, LifeCode.downed)).toBe(0);
    expect(netInputSelect(3, LifeCode.alive)).toBe(3);
    expect(netMoveGates(LifeCode.downed)).toMatchObject({ crawl: true, allowSprint: false, allowJump: false });
    expect(netMoveGates(LifeCode.dead).speedScale).toBe(0);
    expect(netMoveGates(LifeCode.alive)).toMatchObject({ crawl: false, allowSprint: true, speedScale: 1 });
    expect(viewOffset8(1010, 1004.5)).toBe(44);
    expect(viewOffset8(1000, 1001)).toBe(0);
    expect(viewOffset8(1100, 1000)).toBe(255);
  });
});
