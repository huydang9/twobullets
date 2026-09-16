import type { PlayerInput } from "@twobullets/shared/input";
import { MAX_PLAYER_SLOTS } from "../src/codes";
import * as Q from "../src/quantize";
import { ReliableEventType, type PlayerHitEvent, type ReliableEvent, type ShotEvent } from "../src/messages/events";
import {
  EntityPresence,
  MAX_TEAMMATES,
  type EntityState,
  type OwnerItemsBlock,
  type OwnerMoveBlock,
  type OwnerVitalsBlock,
  type OwnerWeaponBlock,
  type Snapshot,
  type TeammateVitals,
} from "../src/messages/snapshot";
import { randInt } from "./rng";

type Rng = () => number;

export function randomInput(rng: Rng, tick: number, prev: PlayerInput | null): PlayerInput {
  if (prev !== null && rng() < 0.4) return { ...prev, tick };
  const buttons = randInt(rng, 0, 255);
  const aimSame = prev !== null && rng() < 0.3;
  return {
    tick,
    forward: (randInt(rng, 0, 2) - 1) as -1 | 0 | 1,
    right: (randInt(rng, 0, 2) - 1) as -1 | 0 | 1,
    buttons,
    select: randInt(rng, 0, 15),
    yawQ: aimSame ? prev.yawQ : randInt(rng, 0, 2 ** 20 - 1),
    pitchQ: aimSame ? prev.pitchQ : randInt(rng, 0, 2 ** 18 - 1),
    viewOffset8: (buttons & 8) !== 0 ? randInt(rng, 0, 255) : 0,
    action: rng() < 0.2 ? { type: randInt(rng, 1, 5) as 1 | 2 | 3 | 4 | 5, arg: randInt(rng, 0, 65535) } : null,
  };
}

interface SimPlayer {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  flags: number;
}

/** Ten players strafing, sprinting and jumping on a 500 m map; quantized per recipient 0 like the snapshot builder. */
export class SnapshotWorld {
  readonly players: SimPlayer[] = [];
  tick = 1000;
  private readonly rng: Rng;

  constructor(rng: Rng, count = 10) {
    this.rng = rng;
    for (let i = 0; i < count; i++) {
      this.players.push({ x: -400 + rng() * 800, y: 30 + rng() * 20, z: -400 + rng() * 800, vx: 0, vy: 0, vz: 0, yaw: rng() * 6, pitch: 0, flags: 1 << 4 });
    }
  }

  step(): void {
    const rng = this.rng;
    this.tick++;
    for (const p of this.players) {
      if (rng() < 0.03) {
        const speed = [0, 3.2, 3.7, 6.5, 9.5][randInt(rng, 0, 4)]!;
        const dir = rng() * Math.PI * 2;
        p.vx = Math.sin(dir) * speed;
        p.vz = Math.cos(dir) * speed;
        p.flags = (p.flags & ~0x23) | (speed === 3.2 ? 1 : 0) | (speed === 9.5 ? 1 << 5 : 0);
      }
      p.yaw += (rng() - 0.5) * 0.05;
      p.pitch = Math.max(-1.5, Math.min(1.5, p.pitch + (rng() - 0.5) * 0.01));
      p.x += p.vx / 60;
      p.z += p.vz / 60;
      p.y += Math.sin(this.tick / 30) * 0.004;
    }
  }

  owner(i: number): OwnerMoveBlock {
    const p = this.players[i]!;
    return {
      xMm: Q.quantizePosXZ(p.x),
      yMm: Q.quantizePosY(p.y),
      zMm: Q.quantizePosXZ(p.z),
      vxMmS: Q.quantizeOwnerVel(p.vx),
      vyMmS: Q.quantizeOwnerVel(p.vy),
      vzMmS: Q.quantizeOwnerVel(p.vz),
      stance: p.flags & 3,
      grounded: true,
      sprinting: (p.flags & (1 << 5)) !== 0,
      jumpHeld: false,
      moveMode: 0,
      coyoteTicks: 6,
      jumpBufferTicks: 0,
      groundIgnoreTicks: 0,
    };
  }

  entity(i: number, presence: EntityPresence = EntityPresence.full): EntityState {
    const p = this.players[i]!;
    return {
      slot: i,
      presence,
      xMm: Q.quantizePosXZ(p.x),
      yMm: Q.quantizePosY(p.y),
      zMm: Q.quantizePosXZ(p.z),
      yawQ: Q.quantizeYaw(p.yaw, 12),
      pitchQ: Q.quantizePitch(p.pitch, 10),
      vxQ: Q.quantizeRemoteVel(p.vx),
      vyQ: Q.quantizeRemoteVel(p.vy),
      vzQ: Q.quantizeRemoteVel(p.vz),
      flags: p.flags,
      noiseClass: 0,
    };
  }

  snapshot(recipient: number, extras = false): Snapshot {
    const entities: EntityState[] = [];
    for (let i = 0; i < this.players.length; i++) {
      if (i === recipient) continue;
      if (extras && i === 7 && this.tick % 3 === 0) continue;
      if (extras && i === 8 && this.tick % 5 === 0) {
        entities.push({ ...this.entity(i), presence: EntityPresence.removed });
        continue;
      }
      if (extras && i === 9 && this.tick % 2 === 0) {
        entities.push({ ...this.entity(i), presence: EntityPresence.audibleOnly, noiseClass: this.tick % 8 });
        continue;
      }
      entities.push(this.entity(i));
    }
    return {
      header: {
        serverTick: this.tick,
        baselineTick: null,
        lastProcessedInputTick: this.tick - 1,
        clientTimeEcho: (this.tick * 17) & 0xffff,
        serverHoldMs: this.tick % 200,
        inputBufferDepthQ: (this.tick % 64) - 32,
        sections: 3,
      },
      owner: this.owner(recipient),
      entities,
    };
  }
}

// ---- Combat content (M4) ------------------------------------------------------------------------------------------

export function randomWeaponBlock(rng: Rng): OwnerWeaponBlock {
  const slotCount = randInt(rng, 0, 4);
  const slotWeapon: number[] = [];
  const slotMagazine: number[] = [];
  const slotReserve: number[] = [];
  for (let i = 0; i < slotCount; i++) {
    const w = rng() < 0.2 ? 0 : randInt(rng, 1, 4);
    slotWeapon.push(w);
    slotMagazine.push(w === 0 ? 0 : randInt(rng, 0, 127));
    slotReserve.push(w === 0 ? 0 : randInt(rng, 0, 1023));
  }
  return {
    phase: randInt(rng, 0, 2),
    activeIndex: slotCount === 0 ? 0 : randInt(rng, 0, slotCount - 1),
    phaseTimerTicks: randInt(rng, 0, 511),
    cooldownQ: randInt(rng, 0, 8191),
    triggerHeld: rng() < 0.5,
    bloomQ: randInt(rng, 0, 255),
    adsQ: randInt(rng, 0, 255),
    shotCounter16: randInt(rng, 0, 65535),
    slotCount,
    slotWeapon,
    slotMagazine,
    slotReserve,
  };
}

export function randomVitalsBlock(rng: Rng): OwnerVitalsBlock {
  const life = randInt(rng, 0, 2);
  const helmetLevel = randInt(rng, 0, 3);
  const vestLevel = randInt(rng, 0, 3);
  return {
    life,
    healthQ: randInt(rng, 0, 1000),
    boost: randInt(rng, 0, 100),
    downedHealthQ: life === 1 ? randInt(rng, 0, 1000) : 0,
    reviveTicks: life === 1 ? randInt(rng, 0, 300) : 0,
    helmetLevel,
    helmetDurability: helmetLevel ? randInt(rng, 1, 110) : 0,
    vestLevel,
    vestDurability: vestLevel ? randInt(rng, 1, 150) : 0,
  };
}

export function randomItemsBlock(rng: Rng): OwnerItemsBlock {
  const useItem = rng() < 0.5 ? 0 : randInt(rng, 1, 5);
  return {
    useItem,
    useTicks: useItem !== 0 ? randInt(rng, 0, 1023) : 0,
    counts: Array.from({ length: 5 }, () => (rng() < 0.3 ? 0 : randInt(rng, 1, 127))),
    backpack: randInt(rng, 0, 3),
    ammo: Array.from({ length: 4 }, () => (rng() < 0.3 ? 0 : randInt(rng, 1, 999))),
  };
}

/** 1..MAX_TEAMMATES teammates with unique sorted slots; `downedChance` of each being knocked. */
export function randomTeammates(rng: Rng, count = randInt(rng, 1, MAX_TEAMMATES), downedChance = 0.4): TeammateVitals[] {
  const slots = new Set<number>();
  while (slots.size < count) slots.add(randInt(rng, 0, MAX_PLAYER_SLOTS - 1));
  return [...slots]
    .sort((a, b) => a - b)
    .map((slot) => {
      const life = rng() < downedChance ? 1 : randInt(rng, 0, 1) * 2;
      const downed = life === 1;
      return {
        slot,
        life,
        health: life === 0 ? randInt(rng, 1, 100) : 0,
        downedHealth: downed ? randInt(rng, 0, 100) : 0,
        reviveQ: downed ? randInt(rng, 0, 63) : 0,
        reviverIsMe: downed && rng() < 0.5,
      };
    });
}

export function randomShot(rng: Rng): ShotEvent {
  return {
    shooter: randInt(rng, 0, MAX_PLAYER_SLOTS - 1),
    weapon: randInt(rng, 1, 4),
    tickOffset: randInt(rng, 0, 3),
    shotId: randInt(rng, 0, 65535),
    yawQ: randInt(rng, 0, 2 ** 20 - 1),
    pitchQ: randInt(rng, 0, 2 ** 18 - 2),
    spreadQ: randInt(rng, 0, 2047),
    originDxCm: randInt(rng, -127, 127),
    originDyCm: randInt(rng, -255, 255),
    originDzCm: randInt(rng, -127, 127),
  };
}

export function randomPlayerHit(rng: Rng): PlayerHitEvent {
  return { victim: randInt(rng, 0, MAX_PLAYER_SLOTS - 1), zone: randInt(rng, 0, 3), armor: rng() < 0.5, dirYawQ: randInt(rng, 0, 31) };
}

export function randomReliable(rng: Rng, seq: number): ReliableEvent {
  const kind = randInt(rng, 1, 3);
  if (kind === ReliableEventType.HitConfirm) {
    return {
      type: ReliableEventType.HitConfirm,
      seq,
      victim: randInt(rng, 0, MAX_PLAYER_SLOTS - 1),
      pellets: randInt(rng, 1, 8),
      zones: randInt(rng, 1, 7),
      damageQ: randInt(rng, 0, 2047),
      killed: rng() < 0.2,
      downed: rng() < 0.2,
      armorHit: rng() < 0.5,
      armorBroken: rng() < 0.1,
    };
  }
  if (kind === ReliableEventType.DamageTaken) {
    return {
      type: ReliableEventType.DamageTaken,
      seq,
      attacker: rng() < 0.1 ? 31 : randInt(rng, 0, MAX_PLAYER_SLOTS - 1),
      dirYawQ: randInt(rng, 0, 255),
      amountQ: randInt(rng, 0, 2047),
      zone: randInt(rng, 0, 3),
      kind: randInt(rng, 0, 5),
    };
  }
  return {
    type: ReliableEventType.Kill,
    seq,
    killer: rng() < 0.1 ? 31 : randInt(rng, 0, MAX_PLAYER_SLOTS - 1),
    victim: randInt(rng, 0, MAX_PLAYER_SLOTS - 1),
    cause: randInt(rng, 0, 11),
    headshot: rng() < 0.3,
    friendlyFire: rng() < 0.1,
    knock: rng() < 0.4,
    distanceM: randInt(rng, 0, 1023),
  };
}

/** Wire value of a weapon block (only the first slotCount entries and non-empty slots' ammo count). */
export function weaponWire(b: OwnerWeaponBlock): unknown {
  const slots = [];
  for (let i = 0; i < b.slotCount; i++) {
    const w = b.slotWeapon[i]!;
    slots.push([w, w ? b.slotMagazine[i] : 0, w ? b.slotReserve[i] : 0]);
  }
  return { ...b, slotWeapon: undefined, slotMagazine: undefined, slotReserve: undefined, slots };
}

interface Gunner {
  firing: number;
  shotCounter: number;
  magazine: number;
  reserve: number;
  bloom: number;
  ads: number;
  cooldown: number;
}

/**
 * netcode.md §2.4 combat mix on top of SnapshotWorld: rifle bursts (~30% of the time at 700 rpm), ADS blends, reloads,
 * bloom; shots from every remote player, 25% of the recipient's shots produce a reliable hit/damage event.
 */
export class CombatWorld {
  readonly world: SnapshotWorld;
  private readonly rng: Rng;
  private readonly gunners: Gunner[] = [];
  private seq = 0;
  private readonly pendingReliable: ReliableEvent[] = [];

  constructor(rng: Rng, count = 10) {
    this.rng = rng;
    this.world = new SnapshotWorld(rng, count);
    for (let i = 0; i < count; i++) this.gunners.push({ firing: 0, shotCounter: 0, magazine: 30, reserve: 120, bloom: 0, ads: 0, cooldown: 0 });
  }

  snapshot(recipient: number): Snapshot {
    const rng = this.rng;
    this.world.step();
    const shots: ShotEvent[] = [];
    for (let i = 0; i < this.gunners.length; i++) {
      const g = this.gunners[i]!;
      if (g.firing <= 0 && rng() < 0.3 / 60) g.firing = randInt(rng, 30, 90);
      g.cooldown = Math.max(0, g.cooldown - 1);
      g.ads = g.firing > 0 ? Math.min(255, g.ads + 24) : Math.max(0, g.ads - 24);
      g.bloom = Math.max(0, g.bloom - 1);
      if (g.firing > 0) {
        g.firing--;
        if (g.cooldown === 0 && g.magazine > 0) {
          g.cooldown = 5;
          g.magazine--;
          g.shotCounter++;
          g.bloom = Math.min(140, g.bloom + 14);
          if (i !== recipient) shots.push({ shooter: i, weapon: 2, tickOffset: 0, shotId: g.shotCounter & 0xffff, yawQ: randInt(rng, 0, 2 ** 20 - 1), pitchQ: randInt(rng, 0, 2 ** 18 - 2), spreadQ: randInt(rng, 5, 200), originDxCm: randInt(rng, -10, 10), originDyCm: 160, originDzCm: randInt(rng, -10, 10) });
          else if (rng() < 0.25) this.pendingReliable.push(randomReliable(rng, this.seq++ & 0xfff));
        }
        if (g.magazine === 0 && g.reserve > 0) {
          g.magazine = 30;
          g.reserve -= 30;
        }
      }
    }
    // ~4 sends per reliable event at 60 ms RTT.
    const reliable = this.pendingReliable.filter((e) => (this.seq - e.seq) < 2 || rng() < 0.5);
    while (this.pendingReliable.length > 0 && rng() < 0.25) this.pendingReliable.shift();
    const base = this.world.snapshot(recipient);
    const g = this.gunners[recipient]!;
    const weapon: OwnerWeaponBlock = {
      phase: 0,
      activeIndex: 0,
      phaseTimerTicks: 0,
      cooldownQ: g.cooldown * 64,
      triggerHeld: g.firing > 0,
      bloomQ: g.bloom,
      adsQ: g.ads,
      shotCounter16: g.shotCounter & 0xffff,
      slotCount: 3,
      slotWeapon: [2, 3, 1],
      slotMagazine: [g.magazine, 7, 12],
      slotReserve: [g.reserve, 28, 48],
    };
    const vitals: OwnerVitalsBlock = { life: 0, healthQ: 1000 - (g.shotCounter % 50) * 10, boost: 40, downedHealthQ: 0, reviveTicks: 0, helmetLevel: 2, helmetDurability: 70, vestLevel: 2, vestDurability: 100 };
    const entities = base.entities.map((e) => {
      const gg = this.gunners[e.slot]!;
      return { ...e, flags: e.flags | (2 << Q.RemoteFlags.weaponIdShift) | (gg.ads > 128 ? Q.RemoteFlags.ads : 0) };
    });
    return { ...base, entities, weapon, vitals, shots, reliable: [...reliable].sort((a, b) => a.seq - b.seq) };
  }
}
