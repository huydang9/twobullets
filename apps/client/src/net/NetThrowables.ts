import type { BitReader } from "@twobullets/protocol/bits";
import {
  createThrowableUpdateBuffer,
  decodeThrowableUpdateInto,
  flashSecondsOf,
  ThrowableOpCode,
  throwableKindOfCode,
} from "@twobullets/protocol/messages/throwables";
import type { FlashExposure, ThrowableKind, Vec3 } from "@twobullets/shared";

/**
 * What the net throwable mirror drives: the local `EquipmentSystem` in `serverThrowables` mode, which owns the
 * presentation (models in flight, explosions, smoke, fire, the flash overlay) and the hands' carried counts.
 */
export interface NetThrowableTarget {
  netSpawnThrowable(id: number, owner: number, kind: ThrowableKind, position: Vec3, velocity: Vec3, fuse: number): void;
  netMoveThrowable(id: number, position: Vec3, velocity: Vec3): void;
  netRemoveThrowable(id: number): void;
  netDetonate(id: number, owner: number, kind: ThrowableKind, position: Vec3, normal: Vec3): void;
  netSmokeStart(id: number, position: Vec3, seed: number): void;
  netSmokeEnd(id: number): void;
  netFireStart(id: number, owner: number, position: Vec3, normal: Vec3, seed: number): void;
  netFireEnd(id: number): void;
  netFlash(exposure: FlashExposure): void;
  netClear(): void;
  setThrowableCounts(counts: readonly number[]): void;
  setNetLife(life: "alive" | "downed" | "dead"): void;
}

export interface NetThrowableStats {
  messages: number;
  bytes: number;
  malformed: number;
  spawns: number;
  detonations: number;
  smokes: number;
  fires: number;
  flashes: number;
}

/**
 * The server's throwables as this client hears them (protocol v9 `ThrowableUpdate`): grenades in flight, the
 * detonation that ends each one, the smoke clouds and fire areas it leaves, and a flash when this player was the one
 * blinded. Everything is handed to the local `EquipmentSystem`, which is the only presentation source — so the
 * throwable renderer, the VFX library, the smoke and fire renderers and the flash overlay work exactly as offline.
 * Nothing here simulates gameplay: the client flies a grenade between the server's corrections (so it moves every
 * frame), but damage, detonation and every area effect come from the server. A message that fails to decode changes
 * nothing.
 */
export class NetThrowables {
  readonly stats: NetThrowableStats = { messages: 0, bytes: 0, malformed: 0, spawns: 0, detonations: 0, smokes: 0, fires: 0, flashes: 0 };
  private readonly buffer = createThrowableUpdateBuffer();
  private readonly equipment: NetThrowableTarget;

  constructor(equipment: NetThrowableTarget) {
    this.equipment = equipment;
  }

  /** Applies one `ThrowableUpdate` (the reader positioned at its id byte). Returns false when malformed. */
  apply(reader: BitReader, byteLength: number): boolean {
    this.stats.messages++;
    this.stats.bytes += byteLength;
    const buf = this.buffer;
    if (!decodeThrowableUpdateInto(reader, buf)) {
      this.stats.malformed++;
      return false;
    }
    const equipment = this.equipment;
    for (let i = 0; i < buf.count; i++) {
      const op = buf.ops[i]!;
      switch (op.op) {
        case ThrowableOpCode.spawn: {
          const kind = throwableKindOfCode(op.kind);
          if (kind === null) break;
          equipment.netSpawnThrowable(op.id, op.owner, kind, { x: op.x, y: op.y, z: op.z }, { x: op.vx, y: op.vy, z: op.vz }, op.fuse);
          this.stats.spawns++;
          break;
        }
        case ThrowableOpCode.move:
          equipment.netMoveThrowable(op.id, { x: op.x, y: op.y, z: op.z }, { x: op.vx, y: op.vy, z: op.vz });
          break;
        case ThrowableOpCode.remove:
          equipment.netRemoveThrowable(op.id);
          break;
        case ThrowableOpCode.detonate: {
          const kind = throwableKindOfCode(op.kind);
          if (kind === null) break;
          equipment.netDetonate(op.id, op.owner, kind, { x: op.x, y: op.y, z: op.z }, { x: op.nx, y: op.ny, z: op.nz });
          this.stats.detonations++;
          break;
        }
        case ThrowableOpCode.smokeStart:
          equipment.netSmokeStart(op.id, { x: op.x, y: op.y, z: op.z }, op.seed);
          this.stats.smokes++;
          break;
        case ThrowableOpCode.smokeEnd:
          equipment.netSmokeEnd(op.id);
          break;
        case ThrowableOpCode.fireStart:
          equipment.netFireStart(op.id, op.owner, { x: op.x, y: op.y, z: op.z }, { x: op.nx, y: op.ny, z: op.nz }, op.seed);
          this.stats.fires++;
          break;
        case ThrowableOpCode.fireEnd:
          equipment.netFireEnd(op.id);
          break;
        case ThrowableOpCode.flash: {
          const { blindSeconds, deafSeconds } = flashSecondsOf(op);
          equipment.netFlash({ blind: op.blind, blindSeconds, deaf: op.deaf, deafSeconds });
          this.stats.flashes++;
          break;
        }
        case ThrowableOpCode.clear:
          equipment.netClear();
          break;
      }
    }
    return true;
  }

  /** Disconnect or rejoin: forget every grenade and area effect. */
  clear(): void {
    this.equipment.netClear();
  }
}
