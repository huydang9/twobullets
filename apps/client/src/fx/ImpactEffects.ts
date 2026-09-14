import { Color3, Vector3 } from "@babylonjs/core";
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

class Decal {
  readonly position = new Vector3();
  readonly normal = new Vector3(0, 1, 0);
  size = 0.05;
  rotation = 0;
  born = -Infinity;
}

/** World impact sparks, dust and bullet holes. Character hits are BloodEffects. */
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
