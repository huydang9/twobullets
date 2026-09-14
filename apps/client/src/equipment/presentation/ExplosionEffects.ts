import { Color3, Vector3 } from "@babylonjs/core";
import type { ThrowableKind, Vec3 } from "@twobullets/shared";
import type { Particle } from "../../fx/ParticlePool";
import { EqCell } from "./equipmentAtlas";
import { randomCone, type EquipmentFx } from "./fxPools";
import { proximity, type CameraShake, type EquipmentLights } from "./support";

const FLASH_CORE = Color3.FromHexString("#fff4d6");
const FIREBALL = Color3.FromHexString("#ffb060");
const SPARK = Color3.FromHexString("#ffc266");
const BLAST_SMOKE = Color3.FromHexString("#4a443d");
const DIRT = Color3.FromHexString("#5b4c3a");
const DUST = Color3.FromHexString("#b3a58c");
const SCORCH = new Color3(1, 1, 1);
const GLASS = Color3.FromHexString("#cfe8d0");
const FUEL = Color3.FromHexString("#ff9a3a");
const WHITE = new Color3(1, 1, 1);
const FRAG_LIGHT = Color3.FromHexString("#ffb46b");
const FLASH_LIGHT = Color3.FromHexString("#f2f5ff");

/**
 * One-shot detonation visuals, all pooled: frag (flash, fireball, hot fragments, thrown dirt, ground dust ring, lingering
 * blast smoke, scorch decal, a short light, camera shake/punch by distance), flashbang (white burst, sparks, a puff), a
 * smoke grenade's pop, and a molotov's glass shatter and fuel burst. In-hand explosions use the same effect at the hand.
 */
export class ExplosionEffects {
  private readonly position = new Vector3();
  private readonly normal = new Vector3();
  private readonly direction = new Vector3();
  private readonly tangent = new Vector3();
  private readonly bitangent = new Vector3();

  constructor(
    private readonly fx: EquipmentFx,
    private readonly lights: EquipmentLights,
    private readonly shake: CameraShake,
    private readonly listener: Vector3,
  ) {}

  detonate(kind: ThrowableKind, position: Vec3, normal: Vec3): void {
    this.normal.set(normal.x, normal.y, normal.z);
    if (this.normal.lengthSquared() < 1e-6) this.normal.set(0, 1, 0);
    this.normal.normalize();
    // Lift off the surface like the gameplay blast origin, so sprites don't clip into it.
    this.position.set(position.x + this.normal.x * 0.12, position.y + this.normal.y * 0.12, position.z + this.normal.z * 0.12);
    const distance = Vector3.Distance(this.position, this.listener);
    switch (kind) {
      case "frag":
        this.frag(distance);
        break;
      case "flash":
        this.flashbang(distance);
        break;
      case "smoke":
        this.smokePop();
        break;
      case "molotov":
        this.shatter(distance);
        break;
    }
  }

  private frag(distance: number): void {
    const p = this.position;
    const n = this.normal;
    const grounded = n.y > 0.6;
    const fx = this.fx;

    this.sprite(fx.additive.spawn(), p, 0.09, 2.2, 4.2, EqCell.fireball, FLASH_CORE, 1, 0).fadePower = 2;
    for (let i = 0; i < 12; i++) {
      const ball = this.sprite(fx.additive.spawn(), p, 0.35 + Math.random() * 0.3, 0.5, 1.3 + Math.random() * 1.2, EqCell.fireball, FIREBALL, 0.9, 1.2);
      randomCone(n, 1.3, ball.velocity, this.tangent, this.bitangent).scaleInPlace(3 + Math.random() * 7);
      ball.drag = 7;
      ball.gravity = -1.5;
      ball.spin = (Math.random() - 0.5) * 3;
      ball.fadePower = 1.6;
    }
    // Hot fragments.
    for (let i = 0; i < 26; i++) {
      const spark = fx.additive.spawn();
      spark.position.copyFrom(p);
      randomCone(n, 1.6, spark.velocity, this.tangent, this.bitangent).scaleInPlace(14 + Math.random() * 26);
      spark.life = 0.15 + Math.random() * 0.35;
      spark.size0 = 0.02;
      spark.size1 = 0.008;
      spark.gravity = 9.8;
      spark.drag = 1.2;
      spark.cell = EqCell.dot;
      spark.streakSeconds = 0.03;
      spark.color.copyFrom(SPARK);
    }
    // Thrown dirt and debris chunks.
    for (let i = 0; i < 22; i++) {
      const chunk = fx.alpha.spawn();
      chunk.position.copyFrom(p);
      randomCone(n, 0.9, chunk.velocity, this.tangent, this.bitangent).scaleInPlace(4 + Math.random() * 10);
      chunk.life = 0.8 + Math.random() * 0.9;
      chunk.size0 = chunk.size1 = 0.025 + Math.random() * 0.05;
      chunk.gravity = 9.8;
      chunk.drag = 0.6;
      chunk.cell = EqCell.chunk;
      chunk.rotation = Math.random() * Math.PI * 2;
      chunk.spin = (Math.random() - 0.5) * 16;
      chunk.color.copyFrom(DIRT);
      chunk.alpha = 1;
      chunk.fadePower = 0.3;
    }
    // Blast smoke rising slowly out of the fireball.
    for (let i = 0; i < 10; i++) {
      const puff = this.sprite(fx.alpha.spawn(), p, 2.6 + Math.random() * 1.6, 0.6, 2.6 + Math.random() * 1.4, EqCell.smoke, BLAST_SMOKE, 0.7, 0.9);
      randomCone(n, 1.2, puff.velocity, this.tangent, this.bitangent).scaleInPlace(1.5 + Math.random() * 3);
      puff.velocity.y += 0.8;
      puff.drag = 2.2;
      puff.gravity = -0.35;
      puff.spin = (Math.random() - 0.5) * 0.5;
      puff.fadePower = 1.4;
    }
    // Dust ring racing out along the ground.
    if (grounded) {
      Vector3.CrossToRef(Math.abs(n.y) < 0.95 ? Vector3.UpReadOnly : Vector3.RightReadOnly, n, this.tangent);
      this.tangent.normalize();
      Vector3.CrossToRef(n, this.tangent, this.bitangent);
      const count = 18;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + Math.random() * 0.2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        this.direction.set(this.tangent.x * c + this.bitangent.x * s, this.tangent.y * c + this.bitangent.y * s, this.tangent.z * c + this.bitangent.z * s);
        const dust = this.sprite(fx.alpha.spawn(), p, 1.3 + Math.random() * 0.8, 0.3, 1.4 + Math.random() * 0.6, EqCell.dust, DUST, 0.65, 0);
        dust.position.addInPlaceFromFloats(this.direction.x * 0.4, this.direction.y * 0.4 - 0.05, this.direction.z * 0.4);
        dust.velocity.copyFrom(this.direction).scaleInPlace(9 + Math.random() * 4);
        dust.velocity.addInPlaceFromFloats(n.x * 0.4, n.y * 0.4, n.z * 0.4);
        dust.drag = 4.5;
        dust.gravity = -0.1;
        dust.fadePower = 1.2;
      }
    }
    fx.decals.add(p, n, 1.35 + Math.random() * 0.35, EqCell.scorch, SCORCH, 0.92, 32, 0.08, 6, 0.6);
    this.lights.flash(p, FRAG_LIGHT, 90, 18, 0.32);
    this.shake.add(proximity(distance, 3, 32));
  }

  private flashbang(distance: number): void {
    const p = this.position;
    const n = this.normal;
    const fx = this.fx;
    this.sprite(fx.additive.spawn(), p, 0.12, 1.5, 3.2, EqCell.fireball, WHITE, 1, 0).fadePower = 2.5;
    this.sprite(fx.additive.spawn(), p, 0.3, 0.3, 0.9, EqCell.dot, WHITE, 1, 0);
    for (let i = 0; i < 18; i++) {
      const spark = fx.additive.spawn();
      spark.position.copyFrom(p);
      randomCone(n, 1.5, spark.velocity, this.tangent, this.bitangent).scaleInPlace(6 + Math.random() * 10);
      spark.life = 0.12 + Math.random() * 0.25;
      spark.size0 = 0.018;
      spark.size1 = 0.006;
      spark.gravity = 6;
      spark.drag = 2;
      spark.cell = EqCell.dot;
      spark.streakSeconds = 0.025;
      spark.color.copyFrom(WHITE);
    }
    for (let i = 0; i < 4; i++) {
      const puff = this.sprite(fx.alpha.spawn(), p, 1.8 + Math.random(), 0.2, 1 + Math.random() * 0.6, EqCell.smoke, DUST, 0.45, 0.5);
      puff.velocity.y += 0.4;
      puff.drag = 2.5;
      puff.gravity = -0.2;
    }
    fx.decals.add(p, n, 0.35, EqCell.scorch, SCORCH, 0.5, 20, 0.05, 5);
    this.lights.flash(p, FLASH_LIGHT, 160, 22, 0.18);
    this.shake.add(proximity(distance, 2, 14) * 0.35);
  }

  private smokePop(): void {
    const p = this.position;
    for (let i = 0; i < 6; i++) {
      const puff = this.sprite(this.fx.alpha.spawn(), p, 0.9 + Math.random() * 0.5, 0.1, 0.9, EqCell.smoke, DUST, 0.6, 1.2);
      randomCone(this.normal, 1.2, puff.velocity, this.tangent, this.bitangent).scaleInPlace(1 + Math.random() * 2);
      puff.drag = 3;
      puff.gravity = -0.3;
    }
  }

  private shatter(distance: number): void {
    const p = this.position;
    const n = this.normal;
    const fx = this.fx;
    for (let i = 0; i < 28; i++) {
      const shard = fx.alpha.spawn();
      shard.position.copyFrom(p);
      randomCone(n, 1.5, shard.velocity, this.tangent, this.bitangent).scaleInPlace(2 + Math.random() * 5);
      shard.life = 0.5 + Math.random() * 0.6;
      shard.size0 = shard.size1 = 0.012 + Math.random() * 0.025;
      shard.gravity = 9.8;
      shard.drag = 0.5;
      shard.cell = EqCell.shard;
      shard.rotation = Math.random() * Math.PI * 2;
      shard.spin = (Math.random() - 0.5) * 24;
      shard.color.copyFrom(GLASS);
      shard.alpha = 0.9;
      shard.fadePower = 0.4;
    }
    // Glints.
    for (let i = 0; i < 10; i++) {
      const glint = fx.additive.spawn();
      glint.position.copyFrom(p);
      randomCone(n, 1.4, glint.velocity, this.tangent, this.bitangent).scaleInPlace(2 + Math.random() * 4);
      glint.life = 0.2 + Math.random() * 0.3;
      glint.size0 = 0.02;
      glint.size1 = 0.005;
      glint.gravity = 9.8;
      glint.cell = EqCell.dot;
      glint.color.copyFrom(WHITE);
    }
    // Fuel igniting: a quick low whoomp of flame over the splash.
    for (let i = 0; i < 9; i++) {
      const burst = this.sprite(fx.additive.spawn(), p, 0.45 + Math.random() * 0.3, 0.3, 1.2 + Math.random() * 0.8, EqCell.fireball, FUEL, 0.85, 0.8);
      randomCone(n, 1.4, burst.velocity, this.tangent, this.bitangent).scaleInPlace(1.5 + Math.random() * 3);
      burst.drag = 5;
      burst.gravity = -2;
      burst.fadePower = 1.3;
    }
    this.lights.flash(p, FUEL, 30, 12, 0.6);
    this.shake.add(proximity(distance, 1.5, 8) * 0.15);
  }

  private sprite(particle: Particle, position: Vector3, life: number, size0: number, size1: number, cell: number, color: Color3, alpha: number, jitter: number): Particle {
    particle.position.copyFrom(position);
    if (jitter > 0) particle.position.addInPlaceFromFloats((Math.random() - 0.5) * jitter, (Math.random() - 0.5) * jitter * 0.6, (Math.random() - 0.5) * jitter);
    particle.life = life;
    particle.size0 = size0;
    particle.size1 = size1;
    particle.cell = cell;
    particle.rotation = Math.random() * Math.PI * 2;
    particle.color.copyFrom(color);
    particle.alpha = alpha;
    return particle;
  }
}
