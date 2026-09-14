import { createBitReader, createBitWriter } from "@twobullets/protocol/bits";
import { killCauseOfCode, LifeCode, weaponIdOfCode, WORLD_SLOT_CODE } from "@twobullets/protocol/codes";
import { createReliableEventStore, createShotEvent, ReliableEventType } from "@twobullets/protocol/messages/events";
import {
  createOwnerVitalsBlock,
  createOwnerWeaponBlock,
  createSnapshotBuffer,
  decodeSnapshotInto,
  encodeSnapshot,
  type Snapshot,
} from "@twobullets/protocol/messages/snapshot";
import { quantizePosXZ, quantizePosY, RemoteFlags } from "@twobullets/protocol/quantize";
import { dequantizePitch, dequantizeYaw, quantizePitch, quantizeYaw } from "@twobullets/shared/aim";
import { createArmorPiece } from "@twobullets/shared/equipment/armor";
import { createVitals } from "@twobullets/shared/equipment/vitals";
import type { MoveState } from "@twobullets/shared/movement/types";
import { diffWeaponState, restoreWeapon } from "@twobullets/shared/weapons/reconcile";
import type { WeaponId, WeaponPhase, WeaponState } from "@twobullets/shared/weapons/types";
import { shotDirections } from "@twobullets/shared/weapons/weaponStep";
import { WEAPONS } from "@twobullets/shared/weapons/weapons";
import { describe, expect, it } from "vitest";
import {
  createEntityState,
  createOwnerBlock,
  killFeedOf,
  remoteLifeCode,
  remoteWeaponId,
  shotOriginInto,
  shotSpreadDegrees,
  unwrapShotId,
  weaponStateFromOwner,
  writeDamageTaken,
  writeKill,
  writeOwnerMove,
  writeOwnerVitals,
  writeOwnerWeapon,
  writeRemoteEntity,
  writeShotEvent,
} from "../src/replication";
import { createSeededRng } from "../src/testing/rng";

const IDS: WeaponId[] = ["pistol", "rifle", "shotgun", "sniper"];
const PHASES: WeaponPhase[] = ["ready", "equipping", "reloading"];

function randomWeapon(next: () => number, shotCounter: number): WeaponState {
  const slots = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
    next() < 0.2 ? null : { id: IDS[Math.floor(next() * 4)]!, magazine: Math.floor(next() * 31), reserve: Math.floor(next() * 400) },
  );
  const phase = PHASES[Math.floor(next() * 3)]!;
  return {
    slots,
    activeIndex: Math.floor(next() * slots.length),
    phase,
    // Timers as the sim leaves them: whole ticks for phase timers, fractional overshoot for the cooldown.
    phaseTimer: phase === "ready" ? 0 : Math.floor(next() * 180) / 60 + (next() - 0.5) * 1e-9,
    cooldown: next() < 0.5 ? 0 : next() * 1.2,
    triggerHeld: next() < 0.5,
    bloom: next() * 2.2,
    adsBlend: next() < 0.3 ? 0 : next() < 0.3 ? 1 : next(),
    shotCounter,
  };
}

const move: MoveState = {
  velocity: { x: 3.2, y: -1.25, z: -0.5 },
  stance: "crouch",
  grounded: true,
  sprinting: false,
  jumpHeld: false,
  coyoteTimer: 0.1,
  jumpBufferTimer: 0,
  groundIgnoreTimer: 0,
  fallSpeed: 0,
};

describe("replication", () => {
  it("owner weapon group survives the wire within diffWeaponState tolerance (shot counter unwraps past 16 bits)", () => {
    const rng = createSeededRng(9);
    const next = () => rng.next();
    const block = createOwnerWeaponBlock();
    const w = createBitWriter(1500);
    const out = createSnapshotBuffer();
    const header = { serverTick: 77, baselineTick: null, lastProcessedInputTick: -1, clientTimeEcho: 0, serverHoldMs: 0, inputBufferDepthQ: 0, sections: 0 };
    const owner = createOwnerBlock();
    for (let i = 0; i < 5000; i++) {
      const server = randomWeapon(next, Math.floor(next() * 300_000));
      writeOwnerWeapon(server, block);
      w.reset();
      const snap: Snapshot = { header, owner, entities: [], weapon: block };
      encodeSnapshot(w, snap, null);
      expect(decodeSnapshotInto(createBitReader(w.bytes()), 77, () => null, out)).toBe(true);
      // The client predicted the same tick exactly: within tolerance, nothing to correct.
      const auth = weaponStateFromOwner(out.weapon!, server.shotCounter + Math.floor((next() - 0.5) * 2000));
      expect(diffWeaponState(server, auth)).toBe(0);
      expect(auth.shotCounter).toBe(server.shotCounter);
      // restoreWeapon keeps the full-precision prediction.
      expect(restoreWeapon(auth, server)).toEqual({ ...server, phaseTimer: server.phase === "ready" ? 0 : server.phaseTimer });
    }
    // A misprediction shows up.
    const s = randomWeapon(next, 10);
    writeOwnerWeapon({ ...s, shotCounter: 11 }, block);
    expect(diffWeaponState(s, weaponStateFromOwner(block, 10))).not.toBe(0);
    expect(unwrapShotId(3, 65534)).toBe(65539);
    expect(unwrapShotId(65535, 65537)).toBe(65535);
  });

  it("owner vitals and remote flags", () => {
    const v = createOwnerVitalsBlock();
    const armor = { helmet: createArmorPiece("helmet", 2), vest: { level: 3 as const, durability: 0.3 } };
    writeOwnerVitals({ ...createVitals(), health: 73.25, boost: 12.1 }, armor, v);
    expect(v).toEqual({ life: LifeCode.alive, healthQ: 733, boost: 13, downedHealthQ: 0, reviveTicks: 0, helmetLevel: 2, helmetDurability: 70, vestLevel: 3, vestDurability: 1 });
    writeOwnerVitals({ ...createVitals(), life: "downed", health: 0, downedHealth: 55.5, reviveProgress: 2.5 }, null, v);
    expect([v.life, v.healthQ, v.downedHealthQ, v.reviveTicks, v.helmetLevel]).toEqual([LifeCode.downed, 0, 555, 150, 0]);

    const e = createEntityState();
    const feet = { x: 12.5, y: 3, z: -40 };
    writeRemoteEntity(4, feet, move, quantizeYaw(1), quantizePitch(0.2), 16, e);
    const m3Flags = e.flags;
    expect(remoteWeaponId(m3Flags)).toBeNull();
    expect(remoteLifeCode(m3Flags)).toBe(LifeCode.alive);
    const weapon = randomWeapon(() => 0.5, 0);
    writeRemoteEntity(4, feet, move, quantizeYaw(1), quantizePitch(0.2), 16, e, weapon, "downed", armor);
    expect(e.flags & 0x7f).toBe(m3Flags & 0x7f);
    expect(remoteWeaponId(e.flags)).toBe(weapon.slots[weapon.activeIndex]?.id ?? null);
    expect(remoteLifeCode(e.flags)).toBe(LifeCode.downed);
    expect((e.flags & RemoteFlags.helmetMask) >>> RemoteFlags.helmetShift).toBe(2);
    expect((e.flags & RemoteFlags.vestMask) >>> RemoteFlags.vestShift).toBe(3);
    expect((e.flags & RemoteFlags.weaponPhaseMask) >>> RemoteFlags.weaponPhaseShift).toBe(1); // equipping

    const o = createOwnerBlock();
    writeOwnerMove(feet, move, o);
    expect([o.xMm, o.yMm, o.zMm, o.stance, o.coyoteTicks]).toEqual([quantizePosXZ(12.5), quantizePosY(3), quantizePosXZ(-40), 1, 6]);
  });

  it("Shot events rebuild the pellets and origin (spread cosmetically exact)", () => {
    const rng = createSeededRng(21);
    const shot = createShotEvent();
    const origin = { x: 0, y: 0, z: 0 };
    let worstDeg = 0;
    let worstOriginM = 0;
    let lastSeen = 70_000;
    for (let i = 0; i < 3000; i++) {
      const id = IDS[Math.floor(rng.next() * 4)]!;
      const def = WEAPONS[id];
      const shotId = lastSeen + 1 + Math.floor(rng.next() * 3);
      const yawQ = Math.floor(rng.next() * 2 ** 20);
      const pitchQ = quantizePitch((rng.next() - 0.5) * 3);
      const spread = rng.next() * 12;
      const feet = { x: (rng.next() - 0.5) * 900, y: rng.next() * 60, z: (rng.next() - 0.5) * 900 };
      const eye = { x: feet.x + (rng.next() - 0.5) * 0.2, y: feet.y + 1.55, z: feet.z + (rng.next() - 0.5) * 0.2 };
      const entity = { xMm: quantizePosXZ(feet.x), yMm: quantizePosY(feet.y), zMm: quantizePosXZ(feet.z) };
      writeShotEvent(3, 1, id, shotId, spread, yawQ, pitchQ, eye, entity, shot);
      const server = shotDirections(def, shotId, dequantizeYaw(yawQ), dequantizePitch(pitchQ), spread);
      const fullId = unwrapShotId(shot.shotId, lastSeen);
      expect(fullId).toBe(shotId);
      const remote = shotDirections(WEAPONS[weaponIdOfCode(shot.weapon)!], fullId, dequantizeYaw(shot.yawQ), dequantizePitch(shot.pitchQ), shotSpreadDegrees(shot));
      for (let p = 0; p < server.length; p++) {
        const a = server[p]!;
        const b = remote[p]!;
        const dot = Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z);
        worstDeg = Math.max(worstDeg, (Math.acos(dot) * 180) / Math.PI);
      }
      shotOriginInto(shot, entity, origin);
      worstOriginM = Math.max(worstOriginM, Math.sqrt((origin.x - eye.x) ** 2 + (origin.y - eye.y) ** 2 + (origin.z - eye.z) ** 2));
      lastSeen = shotId;
    }
    expect(worstDeg).toBeLessThan(0.02);
    expect(worstOriginM).toBeLessThan(0.0095);
  });

  it("kill, damage and kill feed codes", () => {
    const store = createReliableEventStore();
    const kill = writeKill(-1, 5, "zone", false, false, false, 1500.4, store);
    expect(kill.type).toBe(ReliableEventType.Kill);
    if (kill.type === ReliableEventType.Kill) {
      expect([kill.killer, kill.victim, killCauseOfCode(kill.cause), kill.distanceM]).toEqual([WORLD_SLOT_CODE, 5, "zone", 1023]);
    }
    const dmg = writeDamageTaken(2, 22.04, "head", "bullet", 0, -1, store);
    if (dmg.type === ReliableEventType.DamageTaken) expect([dmg.attacker, dmg.amountQ, dmg.zone, dmg.kind, dmg.dirYawQ]).toEqual([2, 220, 1, 0, 128]);
    expect(killFeedOf(900, 3, 4, "rifle", -1, true, true, true, 42.25)).toEqual({
      serverTick: 900,
      killer: 3,
      victim: 4,
      cause: 2,
      knockedBy: WORLD_SLOT_CODE,
      headshot: true,
      friendlyFire: true,
      knock: true,
      distanceDm: 423,
    });
  });
});
