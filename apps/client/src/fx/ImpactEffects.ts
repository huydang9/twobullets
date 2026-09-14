import { Color3, Vector3 } from "@babylonjs/core";
import type { HitZone } from "@twobullets/shared";
import { FxCell } from "./fxAtlas";
import type { FxBatch } from "./FxBatch";
import type { ParticlePool } from "./ParticlePool";

const DECAL_CAPACITY = 64;
const DECAL_LIFE = 7;
const DECAL_FADE = 1.5;
const DECAL_SURFACE_OFFSET = 0.004;

const SPARK = Color3.FromHexString("#ffb347");
const SPARK_HOT = Color3.FromHexString("#ffe08a");
const DUST = Color3.FromHexString("#e6dcc6");
const HOLE = Color3.FromHexString("#1b1c22");
const HIT_BODY = Color3.FromHexString("#fff1a8");
const HIT_LIMB = Color3.FromHexString("#ffd36b");
const HIT_HEAD = Color3.FromHexString("#ff3d6e");
const KILL = Color3.FromHexString("#ffc93c");
const KILL_FLASH = Color3.FromHexString("#fff6d8");

class Decal {
  readonly position = new Vector3();
  readonly normal = new Vector3(0, 1, 0);
  size = 0.05;
  rotation = 0;
  born = -Infinity;
}

/** World impact sparks/dust/bullet holes and stylized (bloodless) target hit bursts. */
export class ImpactEffects {
  private readonly decals = Array.from({ length: DECAL_CAPACITY }, () => new Decal());
  private nextDecal = 0;
  private time = 0;
  private readonly dir = new Vector3();
  private readonly tangent = new Vector3();
  private readonly bitangent = new Vector3();

  constructor(
    private readonly additive: ParticlePool,
    private readonly dust: ParticlePool,
    private readonly decalBatch: FxBatch,
  ) {}

  world(point: Vector3, normal: Vector3, heavy: boolean): void {
    const scale = heavy ? 1.5 : 1;

    const flash = this.additive.spawn();
    offsetAlong(flash.position, point, normal, 0.02);
    flash.life = 0.07;
    flash.size0 = 0.09 * scale;
    flash.size1 = 0.14 * scale;
    flash.cell = FxCell.star;
    flash.rotation = Math.random() * Math.PI;
    flash.color.copyFrom(SPARK_HOT);
    flash.hot = 1.2;

    const sparks = Math.round((5 + Math.random() * 4) * scale);
    for (let i = 0; i < sparks; i++) {
      const p = this.additive.spawn();
      p.position.copyFrom(point);
      this.randomHemisphere(normal, 0.9, this.dir);
      p.velocity.copyFrom(this.dir).scaleInPlace(3 + Math.random() * 6);
      p.life = 0.18 + Math.random() * 0.22;
      p.size0 = 0.012;
      p.size1 = 0.006;
      p.gravity = 14;
      p.drag = 2.5;
      p.cell = FxCell.streak;
      p.streakSeconds = 0.035;
      p.color.copyFrom(SPARK);
      p.hot = 1;
      p.fadePower = 0.6;
    }

    const puffs = heavy ? 3 : 2;
    for (let i = 0; i < puffs; i++) {
      const p = this.dust.spawn();
      this.randomHemisphere(normal, 0.5, this.dir);
      offsetAlong(p.position, point, normal, 0.03);
      p.velocity.copyFrom(this.dir).scaleInPlace(0.6 + Math.random() * 0.8);
      p.life = 0.5 + Math.random() * 0.35;
      p.size0 = 0.05 * scale;
      p.size1 = (0.22 + Math.random() * 0.1) * scale;
      p.drag = 4;
      p.gravity = -0.25;
      p.cell = FxCell.puff;
      p.rotation = Math.random() * Math.PI * 2;
      p.spin = (Math.random() - 0.5) * 1.5;
      p.color.copyFrom(DUST);
      p.alpha = 0.55;
      p.fadePower = 1.4;
    }

    const decal = this.decals[this.nextDecal] as Decal;
    this.nextDecal = (this.nextDecal + 1) % DECAL_CAPACITY;
    offsetAlong(decal.position, point, normal, DECAL_SURFACE_OFFSET);
    decal.normal.copyFrom(normal);
    decal.size = (0.035 + Math.random() * 0.012) * scale;
    decal.rotation = Math.random() * Math.PI * 2;
    decal.born = this.time;
  }

  target(point: Vector3, normal: Vector3, zone: HitZone | null): void {
    const head = zone === "head";
    const color = head ? HIT_HEAD : zone === "limb" ? HIT_LIMB : HIT_BODY;
    const scale = head ? 1.6 : 1;

    const core = this.additive.spawn();
    offsetAlong(core.position, point, normal, 0.03);
    core.life = head ? 0.12 : 0.08;
    core.size0 = 0.1 * scale;
    core.size1 = 0.16 * scale;
    core.cell = FxCell.star;
    core.rotation = Math.random() * Math.PI;
    core.color.copyFrom(color);
    core.hot = head ? 1.5 : 1;

    const ring = this.additive.spawn();
    ring.position.copyFrom(core.position);
    ring.life = 0.18;
    ring.size0 = 0.05 * scale;
    ring.size1 = 0.32 * scale;
    ring.cell = FxCell.ring;
    ring.color.copyFrom(color);
    ring.fadePower = 1.5;

    const shards = head ? 12 : 7;
    for (let i = 0; i < shards; i++) {
      const p = this.additive.spawn();
      p.position.copyFrom(point);
      this.randomHemisphere(normal, 1.2, this.dir);
      p.velocity.copyFrom(this.dir).scaleInPlace(2.5 + Math.random() * 3.5);
      p.life = 0.2 + Math.random() * 0.15;
      p.size0 = 0.022 * scale;
      p.size1 = 0.004;
      p.gravity = 6;
      p.drag = 4;
      p.cell = FxCell.spark;
      p.color.copyFrom(color);
      p.hot = 0.6;
    }
  }

  kill(point: Vector3): void {
    const flash = this.additive.spawn();
    flash.position.copyFrom(point);
    flash.life = 0.16;
    flash.size0 = 0.3;
    flash.size1 = 0.5;
    flash.cell = FxCell.glow;
    flash.color.copyFrom(KILL_FLASH);
    flash.hot = 0.8;
    flash.alpha = 0.9;

    for (let r = 0; r < 2; r++) {
      const ring = this.additive.spawn();
      ring.position.copyFrom(point);
      ring.life = 0.28 + r * 0.1;
      ring.size0 = 0.1;
      ring.size1 = 0.9 + r * 0.4;
      ring.cell = FxCell.ring;
      ring.color.copyFrom(KILL);
      ring.fadePower = 1.2;
    }

    for (let i = 0; i < 22; i++) {
      const p = this.additive.spawn();
      p.position.copyFrom(point);
      this.dir.set(Math.random() * 2 - 1, Math.random() * 1.6 - 0.3, Math.random() * 2 - 1).normalize();
      p.velocity.copyFrom(this.dir).scaleInPlace(3 + Math.random() * 5);
      p.life = 0.35 + Math.random() * 0.3;
      p.size0 = 0.03;
      p.size1 = 0.006;
      p.gravity = 9;
      p.drag = 2.5;
      p.cell = Math.random() < 0.5 ? FxCell.spark : FxCell.star;
      p.spin = (Math.random() - 0.5) * 12;
      p.color.copyFrom(KILL);
      p.hot = 0.7;
    }
  }

  update(dt: number): void {
    this.time += dt;
    for (const decal of this.decals) {
      const age = this.time - decal.born;
      if (age >= DECAL_LIFE) continue;
      const alpha = Math.min(1, (DECAL_LIFE - age) / DECAL_FADE) * 0.9;
      this.decalBatch.decal(decal.position, decal.normal, decal.size, decal.rotation, FxCell.hole, HOLE, alpha);
    }
  }

  clear(): void {
    for (const decal of this.decals) decal.born = -Infinity;
  }

  private buildBasis(normal: Vector3): void {
    const ref = Math.abs(normal.y) < 0.95 ? Vector3.UpReadOnly : Vector3.RightReadOnly;
    Vector3.CrossToRef(ref, normal, this.tangent);
    this.tangent.normalize();
    Vector3.CrossToRef(normal, this.tangent, this.bitangent);
  }

  /** Random unit vector around `normal`, spread 0 (along the normal) .. ~1.5 (nearly flat). */
  private randomHemisphere(normal: Vector3, spread: number, result: Vector3): Vector3 {
    this.buildBasis(normal);
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * spread;
    result.copyFrom(normal);
    result.addInPlaceFromFloats(
      (this.tangent.x * Math.cos(angle) + this.bitangent.x * Math.sin(angle)) * radius,
      (this.tangent.y * Math.cos(angle) + this.bitangent.y * Math.sin(angle)) * radius,
      (this.tangent.z * Math.cos(angle) + this.bitangent.z * Math.sin(angle)) * radius,
    );
    return result.normalize();
  }
}

function offsetAlong(result: Vector3, point: Vector3, normal: Vector3, distance: number): void {
  result.set(point.x + normal.x * distance, point.y + normal.y * distance, point.z + normal.z * distance);
}
