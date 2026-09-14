import type { PlayerInput } from "@twobullets/shared/input";
import * as Q from "../src/quantize";
import { EntityPresence, type EntityState, type OwnerMoveBlock, type Snapshot } from "../src/messages/snapshot";
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

/** Ten players strafing, sprinting and jumping on a 1 km map; quantized per recipient 0 like the snapshot builder. */
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
