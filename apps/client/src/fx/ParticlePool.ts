import { Color3, Vector3 } from "@babylonjs/core";
import { FxCell } from "./fxAtlas";
import type { FxBatch } from "./FxBatch";

export class Particle {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly color = new Color3(1, 1, 1);
  age = 0;
  life = 1;
  size0 = 0.05;
  size1 = 0.05;
  alpha = 1;
  /** Exponent on the remaining-life fade (higher = fades earlier). */
  fadePower = 1;
  rotation = 0;
  spin = 0;
  gravity = 0;
  /** Velocity damping per second. */
  drag = 0;
  hot = 0;
  cell: FxCell = FxCell.glow;
  /** > 0 renders a velocity-aligned streak this many seconds long; 0 renders a sprite. */
  streakSeconds = 0;

  reset(): this {
    this.age = 0;
    this.life = 1;
    this.size0 = this.size1 = 0.05;
    this.alpha = 1;
    this.fadePower = 1;
    this.rotation = this.spin = 0;
    this.gravity = this.drag = this.hot = 0;
    this.cell = FxCell.glow;
    this.streakSeconds = 0;
    this.velocity.setAll(0);
    this.color.set(1, 1, 1);
    return this;
  }
}

/** Fixed-capacity CPU particles rendered through an FxBatch. When full, new spawns recycle the oldest particle. */
export class ParticlePool {
  private readonly particles: Particle[];
  private count = 0;
  private readonly tail = new Vector3();

  constructor(
    capacity: number,
    private readonly batch: FxBatch,
  ) {
    this.particles = Array.from({ length: capacity }, () => new Particle());
  }

  spawn(): Particle {
    if (this.count < this.particles.length) {
      const particle = this.particles[this.count++] as Particle;
      return particle.reset();
    }
    // Full: reuse the particle closest to death.
    let oldest = this.particles[0] as Particle;
    for (const particle of this.particles) {
      if (particle.age / particle.life > oldest.age / oldest.life) oldest = particle;
    }
    return oldest.reset();
  }

  /** Integrates, retires dead particles and pushes the survivors into the batch. */
  update(dt: number): void {
    const particles = this.particles;
    let i = 0;
    while (i < this.count) {
      const p = particles[i] as Particle;
      p.age += dt;
      if (p.age >= p.life) {
        this.count--;
        particles[i] = particles[this.count] as Particle;
        particles[this.count] = p;
        continue;
      }
      const damping = p.drag > 0 ? Math.exp(-p.drag * dt) : 1;
      p.velocity.x *= damping;
      p.velocity.z *= damping;
      p.velocity.y = p.velocity.y * damping - p.gravity * dt;
      p.position.addInPlaceFromFloats(p.velocity.x * dt, p.velocity.y * dt, p.velocity.z * dt);
      p.rotation += p.spin * dt;

      const t = p.age / p.life;
      const size = p.size0 + (p.size1 - p.size0) * t;
      const alpha = p.alpha * Math.pow(1 - t, p.fadePower);
      if (p.streakSeconds > 0) {
        const s = p.streakSeconds;
        this.tail.set(p.position.x - p.velocity.x * s, p.position.y - p.velocity.y * s, p.position.z - p.velocity.z * s);
        this.batch.streak(this.tail, p.position, size, p.cell, p.color, alpha, 0.1, p.hot);
      } else {
        this.batch.sprite(p.position, size, p.rotation, p.cell, p.color, alpha, p.hot);
      }
      i++;
    }
  }

  clear(): void {
    this.count = 0;
  }
}
