import { Color3, Vector3 } from "@babylonjs/core";
import type { ThrowableKind, Vec3 } from "@twobullets/shared";
import type { EquipmentFx } from "./fxPools";
import { proximity, type CameraShake, type EquipmentLights } from "./support";
import { PCell, ScorchCell } from "./VfxLibrary";
import { VFX_SHEETS } from "./vfxManifest";
import { NO_FLOOR, type VfxParticle, type VfxParticlePool } from "./VfxParticles";
import { coneToRef, positionSeed } from "./vfxRandom";

const WHITE = new Color3(1, 1, 1);
const FRAG_LIGHT = Color3.FromHexString("#ffb46b");
const FLASH_LIGHT = Color3.FromHexString("#f2f5ff");
const FUEL_LIGHT = Color3.FromHexString("#ff9a3a");
const FIREBALL_TINT = new Color3(1.3, 1.22, 1.12);
const SPARK = new Color3(2, 1.35, 0.7);
const FLASH_SPARK = new Color3(1.5, 1.45, 1.3);
const FLASH_CORE = new Color3(1.8, 1.8, 1.9);
const FRAG_CORE = new Color3(1.8, 1.45, 1.0);
/** Glass: pale green, a little additive so shards glint. */
const GLASS = new Color3(0.95, 1.12, 1.0);
const FLAME_TINT = new Color3(1.35, 1.15, 1.0);

const EXPLOSION_LAST = VFX_SHEETS.explosion.frames - 1;
const DUST_LAST = VFX_SHEETS.explosionDust.frames - 1;
const SMOKE_FRAMES = VFX_SHEETS.smokeCloud.frames;
const FLAME_FRAMES = VFX_SHEETS.flame.frames;

/**
 * One-shot detonation visuals from CC0 flipbooks (docs/fx-throwables.md), all pooled and seeded from the detonation:
 * - frag: flash core and flare, a flipbook fireball that rolls into dark smoke (plus two offset lobes), a dust ring
 *   racing out along the ground, lingering blast dust, velocity-stretched sparks, soil chunks and dirt sprays, a lit
 *   burned-ground scorch decal, a short point light and camera shake/punch by distance;
 * - flashbang: white core, flare and star, sparks, a light puff, a faint mark and a bright light;
 * - smoke grenade: the canister pop (the cloud itself is SmokeRenderer);
 * - molotov: glass shards and glints plus a flipbook fuel whoomp (the burning area is FireRenderer).
 * In-hand explosions use the same effect at the hand.
 */
export class ExplosionEffects {
  private readonly position = new Vector3();
  private readonly contact = new Vector3();
  private readonly normal = new Vector3();
  private readonly direction = new Vector3();
  private readonly tangent = new Vector3();
  private readonly bitangent = new Vector3();
  private readonly tint = new Color3();
  private counter = 0;

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
    this.contact.set(position.x, position.y, position.z);
    // Lift off the surface like the gameplay blast origin, so sprites don't clip into it.
    this.position.set(position.x + this.normal.x * 0.12, position.y + this.normal.y * 0.12, position.z + this.normal.z * 0.12);
    this.fx.vfx.random.reseed(positionSeed(position.x, position.y, position.z, ++this.counter));
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
    const vfx = this.fx.vfx;
    const r = vfx.random;
    const p = this.position;
    const n = this.normal;
    const grounded = n.y > 0.6;
    const floor = grounded ? this.contact.y - 0.02 : NO_FLOOR;

    // Flash core and a horizontal flare, over within a few frames.
    const core = spawn(vfx.particles, p, 0.14, 0.6, 3.4, PCell.glow, FRAG_CORE, 1);
    core.position.addInPlaceFromFloats(n.x * 0.4, n.y * 0.4, n.z * 0.4);
    core.growPower = 3;
    core.fadePower = 2;
    core.additive0 = core.additive1 = 1;
    const flare = spawn(vfx.particles, core.position, 0.09, 3.5, 5, PCell.flare, FRAG_CORE, 0.9);
    flare.additive0 = flare.additive1 = 1;

    // Fireball: the flipbook's fire burns out in its first third, then the smoke rolls on; frames ease out so the fire
    // is brief (~0.5 s) and the smoke lingers. A slightly additive start makes the fire glow over the dust.
    const lobes = vfx.count(3, 2);
    for (let i = 0; i < lobes; i++) {
      const main = i === 0;
      const scale = r.range(0.9, 1.15) * (main ? 1 : 0.62);
      const ball = spawn(vfx.explosion, p, main ? 2.4 : r.range(1.8, 2.1), 2.1 * scale, 3.0 * scale, 0, FIREBALL_TINT, 1);
      if (main) {
        ball.position.addInPlaceFromFloats(n.x * 1.3, n.y * 1.3, n.z * 1.3);
        ball.velocity.set(n.x * 0.5, n.y * 0.5 + 0.25, n.z * 0.5);
      } else {
        coneToRef(n, 1.2, r, this.direction, this.tangent, this.bitangent);
        ball.position.addInPlaceFromFloats(n.x * 0.9 + this.direction.x * 0.8, n.y * 0.9 + this.direction.y * 0.5, n.z * 0.9 + this.direction.z * 0.8);
        ball.velocity.copyFrom(this.direction).scaleInPlace(1.4);
        ball.delay = r.range(0.02, 0.06);
      }
      ball.frame0 = main ? 0 : r.range(0.5, 2);
      ball.frame1 = EXPLOSION_LAST;
      ball.framePower = 1.9;
      ball.growPower = 2;
      ball.rotation = r.signed() * 0.3;
      ball.spin = r.signed() * 0.05;
      ball.drag = 1.2;
      ball.gravity = -0.25;
      ball.fadePower = 1.6;
      ball.additive0 = 0.35;
      ball.additive1 = 0;
      ball.floorY = floor;
      ball.softness = 0.6;
      ball.nearFade = 1.5;
    }

    // Dust ring racing out along the ground.
    if (grounded) {
      Vector3.CrossToRef(Math.abs(n.y) < 0.95 ? Vector3.UpReadOnly : Vector3.RightReadOnly, n, this.tangent);
      this.tangent.normalize();
      Vector3.CrossToRef(n, this.tangent, this.bitangent);
      this.dustColor(0.4, 0.34, 0.26, VFX_SHEETS.explosionDust.meanLuma, this.tint);
      const count = vfx.count(10, 5);
      for (let i = 0; i < count; i++) {
        const a = ((i + r.range(-0.3, 0.3)) / count) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        this.direction.set(this.tangent.x * c + this.bitangent.x * s, this.tangent.y * c + this.bitangent.y * s, this.tangent.z * c + this.bitangent.z * s);
        const dust = spawn(vfx.dust, p, r.range(2.4, 3.2), 0.5, r.range(2, 2.8), 3, this.tint, 0.75);
        dust.position.addInPlaceFromFloats(this.direction.x * 0.6, 0.35, this.direction.z * 0.6);
        dust.velocity.copyFrom(this.direction).scaleInPlace(r.range(6, 10));
        dust.velocity.y += 0.6;
        dust.frame1 = DUST_LAST;
        dust.framePower = 1.4;
        dust.growPower = 2.5;
        dust.rotation = r.next() * Math.PI * 2;
        dust.spin = r.signed() * 0.15;
        dust.drag = 2.8;
        dust.gravity = -0.15;
        dust.fadeIn = 0.05;
        dust.fadePower = 1.3;
        dust.floorY = floor;
        dust.softness = 0.45;
        dust.nearFade = 1.5;
      }
    }

    // Lingering blast dust rising out of the fireball.
    this.dustColor(0.5, 0.46, 0.4, VFX_SHEETS.explosionDust.meanLuma, this.tint);
    const lingering = vfx.count(4, 2);
    for (let i = 0; i < lingering; i++) {
      const puff = spawn(vfx.dust, p, r.range(5, 7), 1.6, r.range(3.2, 4), 8, this.tint, 0.5);
      puff.position.addInPlaceFromFloats(r.signed() * 0.8 + n.x * 1.2, r.range(0.8, 1.6) * Math.max(0.3, n.y), r.signed() * 0.8 + n.z * 1.2);
      puff.velocity.set(r.signed() * 0.35, r.range(0.4, 0.8), r.signed() * 0.35);
      puff.frame1 = DUST_LAST;
      puff.growPower = 1.5;
      puff.rotation = r.next() * Math.PI * 2;
      puff.spin = r.signed() * 0.08;
      puff.drag = 0.4;
      puff.delay = 0.15;
      puff.fadeIn = 0.35;
      puff.fadePower = 1.6;
      puff.floorY = floor;
      puff.softness = 0.8;
      puff.nearFade = 2;
    }

    // Hot fragments: streaks stretched along their velocity.
    const sparks = vfx.count(30, 12);
    for (let i = 0; i < sparks; i++) {
      const spark = spawn(vfx.particles, p, r.range(0.12, 0.4), 0.045, 0.02, PCell.trace, SPARK, 1);
      coneToRef(n, 1.5, r, spark.velocity, this.tangent, this.bitangent).scaleInPlace(r.range(16, 42));
      spark.streakSeconds = 0.03;
      spark.gravity = 9.8;
      spark.drag = 1;
      spark.additive0 = spark.additive1 = 1;
    }

    // Soil chunks and dirt sprays.
    vfx.lighting.displayToRef(0.07, 0.06, 0.05, 0.9, 1, 0.2, this.tint).scaleInPlace(1 / VFX_SHEETS.particles.meanLuma);
    const chunks = vfx.count(22, 8);
    for (let i = 0; i < chunks; i++) {
      const size = r.range(0.03, 0.08);
      const chunk = spawn(vfx.particles, p, r.range(1, 1.9), size, size, PCell.chunk0 + r.int(4), this.tint, 1);
      coneToRef(n, 0.95, r, chunk.velocity, this.tangent, this.bitangent).scaleInPlace(r.range(5, 15));
      chunk.gravity = 9.8;
      chunk.drag = 0.5;
      chunk.rotation = r.next() * Math.PI * 2;
      chunk.spin = r.signed() * 14;
      chunk.fadePower = 0.3;
    }
    const sprays = vfx.count(5, 2);
    for (let i = 0; i < sprays; i++) {
      const spray = spawn(vfx.particles, p, r.range(0.5, 0.8), 0.25, r.range(0.6, 0.8), PCell.dirtCluster, this.tint, 0.9);
      coneToRef(n, 0.6, r, spray.velocity, this.tangent, this.bitangent).scaleInPlace(r.range(6, 11));
      spray.gravity = 9.8;
      spray.drag = 2;
      spray.rotation = r.next() * Math.PI * 2;
      spray.fadePower = 1.2;
    }

    this.fx.scorch.add(this.contact, n, r.range(1.5, 1.9), ScorchCell.blast, WHITE, 0.95, 45, 0.04, 10, 0.5);
    this.lights.flash(p, FRAG_LIGHT, 90, 18, 0.32);
    this.shake.add(proximity(distance, 3, 32));
  }

  private flashbang(distance: number): void {
    const vfx = this.fx.vfx;
    const r = vfx.random;
    const p = this.position;
    const n = this.normal;

    const burst = spawn(vfx.particles, p, 0.16, 0.4, 4.5, PCell.glow, FLASH_CORE, 1);
    burst.growPower = 4;
    burst.fadePower = 2.5;
    burst.additive0 = burst.additive1 = 1;
    const core = spawn(vfx.particles, p, 0.35, 0.35, 0.8, PCell.glow, FLASH_CORE, 1);
    core.additive0 = core.additive1 = 1;
    const flare = spawn(vfx.particles, p, 0.14, 5, 7, PCell.flare, FLASH_CORE, 1);
    flare.additive0 = flare.additive1 = 1;
    const star = spawn(vfx.particles, p, 0.12, 1.6, 2.4, PCell.star, FLASH_CORE, 1);
    star.rotation = r.next() * Math.PI;
    star.additive0 = star.additive1 = 1;

    const sparks = vfx.count(22, 8);
    for (let i = 0; i < sparks; i++) {
      const spark = spawn(vfx.particles, p, r.range(0.1, 0.3), 0.03, 0.012, PCell.trace, FLASH_SPARK, 1);
      coneToRef(n, 1.5, r, spark.velocity, this.tangent, this.bitangent).scaleInPlace(r.range(8, 20));
      spark.streakSeconds = 0.025;
      spark.gravity = 6;
      spark.drag = 2;
      spark.additive0 = spark.additive1 = 1;
    }

    this.dustColor(0.6, 0.6, 0.58, VFX_SHEETS.explosionDust.meanLuma, this.tint);
    const puffs = vfx.count(3, 1);
    for (let i = 0; i < puffs; i++) {
      const puff = spawn(vfx.dust, p, r.range(2, 2.6), 0.4, r.range(1.3, 1.7), 10, this.tint, 0.5);
      coneToRef(n, 1.2, r, puff.velocity, this.tangent, this.bitangent).scaleInPlace(r.range(0.8, 1.6));
      puff.velocity.y += 0.3;
      puff.frame1 = DUST_LAST;
      puff.growPower = 2;
      puff.rotation = r.next() * Math.PI * 2;
      puff.drag = 2.5;
      puff.gravity = -0.2;
      puff.fadeIn = 0.05;
      puff.floorY = n.y > 0.6 ? this.contact.y : NO_FLOOR;
      puff.softness = 0.3;
      puff.nearFade = 1;
    }

    this.fx.scorch.add(this.contact, n, 0.4, ScorchCell.blast, WHITE, 0.55, 20, 0.03, 5);
    this.lights.flash(p, FLASH_LIGHT, 160, 22, 0.18);
    this.shake.add(proximity(distance, 2, 14) * 0.35);
  }

  private smokePop(): void {
    const vfx = this.fx.vfx;
    const r = vfx.random;
    const lighting = vfx.lighting;
    const tint = this.tint;
    Color3.LerpToRef(lighting.shade, lighting.lit, 0.6, tint);
    tint.scaleInPlace(0.8 / VFX_SHEETS.smokeCloud.meanLuma);
    const count = vfx.count(6, 3);
    for (let i = 0; i < count; i++) {
      const puff = spawn(vfx.smoke, this.position, r.range(1.2, 1.8), 0.2, r.range(1.1, 1.4), r.int(SMOKE_FRAMES), tint, 0.65);
      coneToRef(this.normal, 1.3, r, puff.velocity, this.tangent, this.bitangent).scaleInPlace(r.range(1, 3));
      puff.frameRate = 12;
      puff.frameCount = SMOKE_FRAMES;
      puff.growPower = 2;
      puff.rotation = r.next() * Math.PI * 2;
      puff.drag = 3;
      puff.gravity = -0.3;
      puff.fadeIn = 0.05;
      puff.floorY = this.contact.y - 0.02;
      puff.softness = 0.3;
      puff.nearFade = 1;
    }
  }

  private shatter(distance: number): void {
    const vfx = this.fx.vfx;
    const r = vfx.random;
    const p = this.position;
    const n = this.normal;

    const shards = vfx.count(26, 10);
    for (let i = 0; i < shards; i++) {
      const size = r.range(0.012, 0.03);
      const shard = spawn(vfx.particles, p, r.range(0.6, 1.1), size, size, PCell.shard0 + r.int(4), GLASS, 0.85);
      coneToRef(n, 1.5, r, shard.velocity, this.tangent, this.bitangent).scaleInPlace(r.range(2, 6.5));
      shard.gravity = 9.8;
      shard.drag = 0.5;
      shard.rotation = r.next() * Math.PI * 2;
      shard.spin = r.signed() * 24;
      shard.additive0 = shard.additive1 = 0.35;
      shard.fadePower = 0.4;
    }
    const glints = vfx.count(10, 4);
    for (let i = 0; i < glints; i++) {
      const glint = spawn(vfx.particles, p, r.range(0.15, 0.35), 0.03, 0.008, PCell.glow, WHITE, 1);
      coneToRef(n, 1.4, r, glint.velocity, this.tangent, this.bitangent).scaleInPlace(r.range(2, 5));
      glint.gravity = 9.8;
      glint.additive0 = glint.additive1 = 1;
    }

    // Fuel igniting: a quick flipbook whoomp over the splash.
    const bursts = vfx.count(7, 3);
    for (let i = 0; i < bursts; i++) {
      const burst = spawn(vfx.flame, p, r.range(0.45, 0.75), 0.18, r.range(0.35, 0.5), r.int(FLAME_FRAMES), FLAME_TINT, 1);
      burst.position.addInPlaceFromFloats(r.signed() * 0.3 + n.x * 0.2, n.y * 0.2, r.signed() * 0.3 + n.z * 0.2);
      coneToRef(n, 1.2, r, burst.velocity, this.tangent, this.bitangent).scaleInPlace(r.range(1, 2.5));
      burst.velocity.y += 1;
      burst.frameRate = 30;
      burst.frameCount = FLAME_FRAMES;
      burst.growPower = 2;
      burst.rotation = r.signed() * 0.3;
      burst.drag = 3;
      burst.gravity = -2;
      burst.fadePower = 1.4;
      burst.additive0 = burst.additive1 = 0.8;
    }
    this.lights.flash(p, FUEL_LIGHT, 30, 12, 0.6);
    this.shake.add(proximity(distance, 1.5, 8) * 0.15);
  }

  /** Lit dust color for a flipbook with the given baked brightness. */
  private dustColor(r: number, g: number, b: number, meanLuma: number, result: Color3): Color3 {
    return this.fx.vfx.lighting.displayToRef(r, g, b, 0.8, 1, 0.25, result).scaleInPlace(1 / meanLuma);
  }
}

/** Takes a particle from `pool` with the common fields set (frame0 = frame1 = `frame`). */
function spawn(pool: VfxParticlePool, position: Vector3, life: number, size0: number, size1: number, frame: number, color: Color3, alpha: number): VfxParticle {
  const p = pool.spawn();
  p.position.copyFrom(position);
  p.life = life;
  p.size0 = size0;
  p.size1 = size1;
  p.frame0 = p.frame1 = frame;
  p.color.copyFrom(color);
  p.alpha = alpha;
  return p;
}
