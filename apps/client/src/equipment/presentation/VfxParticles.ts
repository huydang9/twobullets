import { Color3, Vector3 } from "@babylonjs/core";
import { VfxMode, type VfxBatch, type VfxQuad } from "./VfxBatch";

/** Floor height that disables the soft ground fade. */
export const NO_FLOOR = -1e6;

export class VfxParticle implements VfxQuad {
  mode: number = VfxMode.sprite;
  readonly position = new Vector3();
  readonly axis = new Vector3();
  readonly velocity = new Vector3();
  readonly color = new Color3(1, 1, 1);
  drawSize = 0;
  rotation = 0;
  frame = 0;
  drawAlpha = 0;
  additive = 0;
  tailAlpha = 1;

  age = 0;
  life = 1;
  /** Seconds before the particle appears (it neither moves nor draws until then). */
  delay = 0;
  size0 = 0.1;
  size1 = 0.1;
  /** Growth easing: size follows 1 - (1 - t)^growPower (1 = linear, higher = fast start). */
  growPower = 1;
  alpha = 1;
  fadeIn = 0;
  /** Exponent on the remaining-life fade (higher = fades earlier). */
  fadePower = 1;
  spin = 0;
  gravity = 0;
  /** Velocity damping per second. */
  drag = 0;
  /** Frames: frame0 → frame1 over the life, or looping from frame0 at frameRate over frameCount when frameRate > 0. */
  frame0 = 0;
  frame1 = 0;
  frameRate = 0;
  frameCount = 1;
  /** Easing of frame0 → frame1: 1 - (1 - t)^framePower (higher = early frames play faster). */
  framePower = 1;
  additive0 = 0;
  additive1 = 0;
  /** > 0 draws a velocity-aligned streak this many seconds long. */
  streakSeconds = 0;
  floorY = NO_FLOOR;
  softness = 0;
  /** Fades the sprite out when its depth is under this distance (0 = off). */
  nearFade = 0;

  reset(): this {
    this.mode = VfxMode.sprite;
    this.age = this.delay = 0;
    this.life = 1;
    this.size0 = this.size1 = 0.1;
    this.growPower = this.alpha = this.fadePower = 1;
    this.fadeIn = this.rotation = this.spin = this.gravity = this.drag = 0;
    this.frame0 = this.frame1 = this.frameRate = 0;
    this.frameCount = this.framePower = 1;
    this.additive0 = this.additive1 = 0;
    this.streakSeconds = 0;
    this.floorY = NO_FLOOR;
    this.softness = this.nearFade = 0;
    this.tailAlpha = 1;
    this.velocity.setAll(0);
    this.color.set(1, 1, 1);
    return this;
  }
}

const STREAK_TAIL_ALPHA = 0.05;

/** Fixed-capacity CPU particles drawn through one VfxBatch. When full, a spawn recycles the particle closest to death. */
export class VfxParticlePool {
  private readonly particles: VfxParticle[];
  private count = 0;

  constructor(
    capacity: number,
    private readonly batch: VfxBatch,
  ) {
    this.particles = Array.from({ length: capacity }, () => new VfxParticle());
  }

  get active(): number {
    return this.count;
  }

  get capacity(): number {
    return this.particles.length;
  }

  spawn(): VfxParticle {
    if (this.count < this.particles.length) return this.particles[this.count++]!.reset();
    let oldest = this.particles[0]!;
    for (let i = 1; i < this.particles.length; i++) {
      const p = this.particles[i]!;
      if ((p.age - p.delay) / p.life > (oldest.age - oldest.delay) / oldest.life) oldest = p;
    }
    return oldest.reset();
  }

  update(dt: number): void {
    const particles = this.particles;
    let i = 0;
    while (i < this.count) {
      const p = particles[i]!;
      p.age += dt;
      const age = p.age - p.delay;
      if (age >= p.life) {
        this.count--;
        particles[i] = particles[this.count]!;
        particles[this.count] = p;
        continue;
      }
      i++;
      if (age < 0) continue;
      const step = Math.min(dt, age);
      const damping = p.drag > 0 ? Math.exp(-p.drag * step) : 1;
      const v = p.velocity;
      v.x *= damping;
      v.z *= damping;
      v.y = v.y * damping - p.gravity * step;
      p.position.addInPlaceFromFloats(v.x * step, v.y * step, v.z * step);
      p.rotation += p.spin * step;

      const t = age / p.life;
      const grow = p.growPower === 1 ? t : 1 - Math.pow(1 - t, p.growPower);
      p.drawSize = p.size0 + (p.size1 - p.size0) * grow;
      const fadeIn = p.fadeIn > 0 ? Math.min(1, age / p.fadeIn) : 1;
      p.drawAlpha = p.alpha * fadeIn * (p.fadePower === 1 ? 1 - t : Math.pow(1 - t, p.fadePower));
      p.frame = p.frameRate > 0 ? (p.frame0 + age * p.frameRate) % p.frameCount : p.frame0 + (p.frame1 - p.frame0) * (p.framePower === 1 ? t : 1 - Math.pow(1 - t, p.framePower));
      p.additive = p.additive0 + (p.additive1 - p.additive0) * t;
      if (p.streakSeconds > 0) {
        const s = p.streakSeconds;
        p.mode = VfxMode.streak;
        p.tailAlpha = STREAK_TAIL_ALPHA;
        p.axis.set(p.position.x - v.x * s, p.position.y - v.y * s, p.position.z - v.z * s);
      } else {
        p.axis.set(p.floorY, p.softness, p.nearFade);
      }
      this.batch.push(p);
    }
  }

  clear(): void {
    this.count = 0;
  }
}

/** Reusable quad record for renderers that push computed quads directly (flames, smoke sprites, glows). */
export class VfxRecord implements VfxQuad {
  mode: number = VfxMode.sprite;
  readonly position = new Vector3();
  readonly axis = new Vector3();
  readonly color = new Color3(1, 1, 1);
  drawSize = 0;
  rotation = 0;
  frame = 0;
  drawAlpha = 1;
  additive = 0;
  tailAlpha = 1;
}
