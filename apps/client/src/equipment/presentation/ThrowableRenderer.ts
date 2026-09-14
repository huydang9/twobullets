import { Color3, Matrix, Quaternion, Vector3, type Mesh } from "@babylonjs/core";
import { THROWABLE_KINDS, type ThrowableSnapshot, type Vec3 } from "@twobullets/shared";
import type { Environment } from "../../world/environment";
import { EqCell, FLAME_FRAMES } from "./equipmentAtlas";
import { randomCone, type EquipmentFx } from "./fxPools";
import { THROWABLE_SHAPE, type ItemMeshLibrary } from "./itemMeshes";
import { TICK_SECONDS } from "./support";

/** Matches EquipmentWorld's default capacity. */
const MAX_SLOTS = 64;
/** Drawn per kind; beyond this a kind's extra grenades are simulated but not drawn. */
const INSTANCES_PER_KIND = 24;
const SQUASH_SECONDS = 0.09;
const SETTLE_SECONDS = 0.18;

const DUST = Color3.FromHexString("#b9ab92");
const SCUFF = new Color3(1, 1, 1);
const FLAME = new Color3(1, 1, 1);
const EMBER = Color3.FromHexString("#ff9a3c");
const UP = new Vector3(0, 1, 0);

class Slot {
  active = false;
  id = 0;
  kindIndex = 0;
  seenTick = 0;
  readonly previous = new Vector3();
  readonly current = new Vector3();
  readonly velocity = new Vector3();
  readonly render = new Vector3();
  rolling = false;
  resting = false;
  readonly tumble = new Quaternion();
  readonly spinAxis = new Vector3(1, 0, 0);
  spinRate = 0;
  heading = 0;
  roll = 0;
  settle = 0;
  squash = 0;
  readonly squashNormal = new Vector3(0, 1, 0);
  emberTimer = 0;
}

/**
 * Thrown grenades in flight and on the ground, interpolated between the last two tick states (like the camera) for
 * smooth high-refresh motion. Meshes are thin instances per kind (sun shadows included), tumbling by throw speed,
 * rolling by ground speed, and settling on their side at rest. Bounces squash the mesh briefly and leave a scuff and
 * dust; molotov rags burn in flight.
 */
export class ThrowableRenderer {
  private readonly slots = Array.from({ length: MAX_SLOTS }, () => new Slot());
  private readonly meshes: Mesh[];
  private readonly matrices: Float32Array[];
  private readonly counts = new Int32Array(THROWABLE_KINDS.length);
  private tick = 0;
  private time = 0;

  private readonly matrix = new Matrix();
  private readonly lie = new Quaternion();
  private readonly spin = new Quaternion();
  private readonly orientation = new Quaternion();
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tmp3 = new Vector3();
  private readonly tangent = new Vector3();
  private readonly bitangent = new Vector3();
  private readonly min = new Vector3();
  private readonly max = new Vector3();

  constructor(
    library: ItemMeshLibrary,
    environment: Pick<Environment, "skyFill" | "addShadowCaster">,
    private readonly fx: EquipmentFx,
  ) {
    this.meshes = THROWABLE_KINDS.map((kind) => {
      const mesh = library.createWorldTemplate(kind);
      mesh.isPickable = false;
      mesh.doNotSyncBoundingInfo = true;
      mesh.alwaysSelectAsActiveMesh = true;
      environment.skyFill.excludedMeshes.push(mesh);
      environment.addShadowCaster(mesh);
      return mesh;
    });
    this.matrices = this.meshes.map((mesh) => {
      const buffer = new Float32Array(INSTANCES_PER_KIND * 16);
      mesh.thinInstanceSetBuffer("matrix", buffer, 16, false);
      mesh.thinInstanceCount = 0;
      mesh.isVisible = false;
      return buffer;
    });
  }

  /** Throwables currently tracked (for stats and checks). */
  get active(): number {
    let n = 0;
    for (const slot of this.slots) if (slot.active) n++;
    return n;
  }

  /** Last rendered position of throwable `id`, for checks. */
  getRenderPosition(id: number): Vector3 | null {
    for (const slot of this.slots) if (slot.active && slot.id === id) return slot.render;
    return null;
  }

  /** Starts a tick sync: call `syncList` for every source, then `endTick`. */
  beginTick(): void {
    this.tick++;
  }

  syncList(list: readonly ThrowableSnapshot[]): void {
    for (let i = 0; i < list.length; i++) {
      const snapshot = list[i]!;
      const slot = this.find(snapshot.id) ?? this.allocate(snapshot);
      if (!slot) continue;
      const { position, velocity } = snapshot;
      if (slot.seenTick === 0) {
        // First sight is already one tick into the flight; start the interpolation from the launch point.
        slot.previous.set(position.x - velocity.x * TICK_SECONDS, position.y - velocity.y * TICK_SECONDS, position.z - velocity.z * TICK_SECONDS);
        slot.render.copyFrom(slot.previous);
      } else {
        slot.previous.copyFrom(slot.current);
      }
      slot.current.set(position.x, position.y, position.z);
      slot.velocity.set(velocity.x, velocity.y, velocity.z);
      slot.rolling = snapshot.rolling;
      slot.resting = snapshot.resting;
      slot.seenTick = this.tick;
    }
  }

  endTick(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.active && slot.seenTick !== this.tick) slot.active = false;
    }
  }

  /** A tracked throwable hit something: squash, scuff and dust scaled by impact speed. */
  bounce(id: number, position: Vec3, normal: Vec3, impactSpeed: number): void {
    const strength = Math.min(1, impactSpeed / 9);
    const slot = this.find(id);
    if (slot) {
      slot.squash = SQUASH_SECONDS * (0.4 + 0.6 * strength);
      slot.squashNormal.set(normal.x, normal.y, normal.z);
      slot.spinRate *= 0.55;
      randomCone(slot.spinAxis, 0.8, slot.spinAxis, this.tangent, this.bitangent);
    }
    if (impactSpeed < 1.2) return;
    const n = this.tmp.set(normal.x, normal.y, normal.z);
    const p = this.tmp2.set(position.x, position.y, position.z);
    this.fx.decals.add(p, n, 0.05 + 0.05 * strength, EqCell.scuff, SCUFF, 0.5 * strength + 0.2, 6, 0.02, 2);
    const puffs = 1 + Math.round(strength * 3);
    for (let i = 0; i < puffs; i++) {
      const puff = this.fx.alpha.spawn();
      puff.position.set(p.x + n.x * 0.03, p.y + n.y * 0.03, p.z + n.z * 0.03);
      randomCone(n, 1.1, puff.velocity, this.tangent, this.bitangent).scaleInPlace(0.3 + Math.random() * (0.5 + strength));
      puff.life = 0.5 + Math.random() * 0.5;
      puff.size0 = 0.04;
      puff.size1 = 0.18 + 0.2 * strength;
      puff.drag = 4;
      puff.gravity = -0.2;
      puff.cell = EqCell.dust;
      puff.rotation = Math.random() * Math.PI * 2;
      puff.spin = (Math.random() - 0.5) * 1.5;
      puff.color.copyFrom(DUST);
      puff.alpha = 0.35 + 0.35 * strength;
      puff.fadePower = 1.5;
    }
  }

  /** Per frame: interpolated pose, spin, squash and molotov flames into the thin instances and FX batches. */
  render(dt: number, alpha: number): void {
    this.time += dt;
    this.counts.fill(0);
    this.min.setAll(Infinity);
    this.max.setAll(-Infinity);
    const slots = this.slots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      if (!slot.active) continue;
      Vector3.LerpToRef(slot.previous, slot.current, alpha, slot.render);
      this.orient(slot, dt);
      const kind = THROWABLE_KINDS[slot.kindIndex]!;
      if (kind === "molotov") this.burnRag(slot, dt);
      const count = this.counts[slot.kindIndex]!;
      if (count >= INSTANCES_PER_KIND) continue;
      this.writeMatrix(slot, this.matrices[slot.kindIndex]!, count * 16, dt);
      this.counts[slot.kindIndex] = count + 1;
      this.min.minimizeInPlace(slot.render);
      this.max.maximizeInPlace(slot.render);
    }
    for (let k = 0; k < this.meshes.length; k++) {
      const mesh = this.meshes[k]!;
      const count = this.counts[k]!;
      mesh.thinInstanceCount = count;
      mesh.isVisible = count > 0;
      if (count === 0) continue;
      mesh.thinInstanceBufferUpdated("matrix");
      // Shadow cascade culling reads the mesh bounds: cover every instance (identity world matrix).
      this.tmp.set(this.min.x - 0.2, this.min.y - 0.2, this.min.z - 0.2);
      this.tmp2.set(this.max.x + 0.2, this.max.y + 0.2, this.max.z + 0.2);
      mesh.getBoundingInfo().reConstruct(this.tmp, this.tmp2, mesh.getWorldMatrix());
    }
  }

  clear(): void {
    for (const slot of this.slots) slot.active = false;
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
  }

  private find(id: number): Slot | null {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.active && slot.id === id) return slot;
    }
    return null;
  }

  private allocate(snapshot: ThrowableSnapshot): Slot | null {
    let slot: Slot | null = null;
    for (const candidate of this.slots) {
      if (candidate.active) continue;
      slot = candidate;
      break;
    }
    if (!slot) return null;
    slot.active = true;
    slot.id = snapshot.id;
    slot.kindIndex = THROWABLE_KINDS.indexOf(snapshot.kind);
    slot.seenTick = 0;
    slot.squash = 0;
    slot.settle = 0;
    slot.roll = 0;
    slot.emberTimer = 0;
    const { velocity } = snapshot;
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    // End-over-end tumble around the throw's side axis, with some wobble; bottles spin slower.
    slot.spinAxis.set(velocity.z, 0, -velocity.x);
    if (slot.spinAxis.lengthSquared() < 1e-6) slot.spinAxis.set(1, 0, 0);
    slot.spinAxis.normalize();
    randomCone(slot.spinAxis, 0.35, slot.spinAxis, this.tangent, this.bitangent);
    slot.spinRate = (snapshot.kind === "molotov" ? 0.45 : 0.75) * Math.min(18, speed);
    Quaternion.RotationYawPitchRollToRef(Math.atan2(velocity.x, velocity.z), -0.4, 0, slot.tumble);
    return slot;
  }

  private orient(slot: Slot, dt: number): void {
    const kind = THROWABLE_KINDS[slot.kindIndex]!;
    const shape = THROWABLE_SHAPE[kind];
    const v = slot.velocity;
    const groundSpeed = Math.hypot(v.x, v.z);
    const onGround = slot.rolling || slot.resting;
    if (!onGround) {
      Quaternion.RotationAxisToRef(slot.spinAxis, slot.spinRate * dt, this.spin);
      this.spin.multiplyToRef(slot.tumble, slot.tumble);
      slot.settle = Math.max(0, slot.settle - dt / SETTLE_SECONDS);
    } else if (!shape.cylinder) {
      // A ball rolls about the horizontal axis across its motion.
      if (slot.rolling && groundSpeed > 1e-3) {
        this.tmp3.set(v.z, 0, -v.x).scaleInPlace(1 / groundSpeed);
        Quaternion.RotationAxisToRef(this.tmp3, (groundSpeed * dt) / shape.rollRadius, this.spin);
        this.spin.multiplyToRef(slot.tumble, slot.tumble);
      }
    } else {
      if (slot.rolling && groundSpeed > 0.05) {
        slot.heading = Math.atan2(v.x, v.z);
        slot.roll += (groundSpeed * dt) / shape.rollRadius;
      } else if (slot.settle === 0) {
        slot.heading = Math.atan2(v.x, v.z) || Math.random() * Math.PI;
      }
      slot.settle = Math.min(1, slot.settle + dt / SETTLE_SECONDS);
    }

    if (shape.cylinder && slot.settle > 0) {
      // Lying on its side (long axis across the motion), spinning about that axis.
      Quaternion.RotationYawPitchRollToRef(slot.heading, 0, Math.PI / 2, this.lie);
      Quaternion.RotationAxisToRef(UP, slot.roll, this.spin);
      this.lie.multiplyToRef(this.spin, this.lie);
      Quaternion.SlerpToRef(slot.tumble, this.lie, slot.settle, this.orientation);
    } else {
      this.orientation.copyFrom(slot.tumble);
    }
  }

  private writeMatrix(slot: Slot, buffer: Float32Array, offset: number, dt: number): void {
    const m = this.matrix;
    this.orientation.toRotationMatrix(m);
    if (slot.squash > 0) {
      const t = 1 - slot.squash / SQUASH_SECONDS;
      const pulse = Math.sin(Math.max(0, Math.min(1, t)) * Math.PI);
      slot.squash = Math.max(0, slot.squash - dt);
      // Scale along the contact normal (flatten) and slightly across it, after the rotation.
      const along = 1 - 0.16 * pulse;
      const across = 1 + 0.06 * pulse;
      const n = slot.squashNormal;
      const k = along - across;
      const a = m.m;
      for (let row = 0; row < 3; row++) {
        const o = row * 4;
        const x = a[o]!;
        const y = a[o + 1]!;
        const z = a[o + 2]!;
        const d = (x * n.x + y * n.y + z * n.z) * k;
        buffer[offset + o] = x * across + n.x * d;
        buffer[offset + o + 1] = y * across + n.y * d;
        buffer[offset + o + 2] = z * across + n.z * d;
        buffer[offset + o + 3] = 0;
      }
    } else {
      const a = m.m;
      for (let i = 0; i < 12; i++) buffer[offset + i] = a[i]!;
    }
    buffer[offset + 12] = slot.render.x;
    buffer[offset + 13] = slot.render.y;
    buffer[offset + 14] = slot.render.z;
    buffer[offset + 15] = 1;
  }

  private burnRag(slot: Slot, dt: number): void {
    const tip = THROWABLE_SHAPE.molotov.flameTip as Vector3;
    this.orientation.toRotationMatrix(this.matrix);
    Vector3.TransformCoordinatesToRef(tip, this.matrix, this.tmp);
    this.tmp.addInPlace(slot.render);
    const v = slot.velocity;
    for (let i = 0; i < 2; i++) {
      const height = 0.13 + 0.05 * Math.sin(this.time * 17 + i * 2.1);
      this.tmp2.set(this.tmp.x - v.x * 0.025 + Math.sin(this.time * 9 + i) * 0.02, this.tmp.y + height - v.y * 0.02, this.tmp.z - v.z * 0.025);
      const frame = EqCell.flame0 + (Math.floor(this.time * 18 + i * 3) % FLAME_FRAMES);
      this.fx.additiveBatch.streak(this.tmp, this.tmp2, 0.045 - i * 0.012, frame, FLAME, 0.9, 1);
    }
    slot.emberTimer -= dt;
    if (slot.emberTimer > 0) return;
    slot.emberTimer = 0.06 + Math.random() * 0.08;
    const ember = this.fx.additive.spawn();
    ember.position.copyFrom(this.tmp);
    ember.velocity.set(v.x * 0.3 + (Math.random() - 0.5) * 0.6, 0.8 + Math.random() * 0.8, v.z * 0.3 + (Math.random() - 0.5) * 0.6);
    ember.life = 0.4 + Math.random() * 0.4;
    ember.size0 = 0.012;
    ember.size1 = 0.004;
    ember.drag = 1.5;
    ember.cell = EqCell.dot;
    ember.color.copyFrom(EMBER);
  }
}
