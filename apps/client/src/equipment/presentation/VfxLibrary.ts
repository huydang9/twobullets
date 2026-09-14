import { Texture, type Scene } from "@babylonjs/core";
import { graphicsOf } from "../../perf/graphicsSettings";
import { VfxBatch } from "./VfxBatch";
import { VfxLighting } from "./vfxLighting";
import { VFX_ASSET_ROOT, VFX_SHEETS, type VfxSheet } from "./vfxManifest";
import { VfxParticlePool } from "./VfxParticles";
import { VfxRandom } from "./vfxRandom";

/**
 * alphaIndex order in rendering group 0 (lower first). Blood and equipment atlas batches use 0 (decals), 1 (alpha)
 * and 2 (additive); the flipbooks slot in after them. The fire plume draws before the flames (emissive tips stay bright
 * over soot), and the smoke cloud after every fire and explosion so it hides what burns inside it. The analytic smoke passes stay at EQ_ALPHA_INDEX.smoke (4), the throw arc at 5.
 */
export const VFX_ALPHA_INDEX = { decals: 0.5, particles: 2.2, wispy: 2.3, flame: 2.4, explosion: 2.5, dust: 2.6, smoke: 3 } as const;

/** Instance caps per batch (a batch is one draw call) and CPU particle pools feeding them. */
export const VFX_CAPS = {
  particlesBatch: 1600,
  particlesPool: 1000,
  explosionBatch: 48,
  explosionPool: 48,
  dustBatch: 420,
  dustPool: 360,
  wispyBatch: 700,
  wispyPool: 640,
  flameBatch: 900,
  flamePool: 160,
  smokeBatch: 2800,
  smokePool: 400,
  decals: 160,
} as const;

/** Atlas cells of `particles.ktx2` and `scorch.ktx2`. */
export const PCell = VFX_SHEETS.particles.cells;
export const ScorchCell = VFX_SHEETS.scorch.cells;

/** Particle counts and sizes scale with the graphics preset. */
const QUALITY = { high: 1, balanced: 0.65, performance: 0.4 } as const;

function loadSheet(scene: Scene, sheet: VfxSheet): Texture {
  const texture = new Texture(`${VFX_ASSET_ROOT}${sheet.url}?v=${sheet.hash}`, scene, {
    noMipmap: false,
    invertY: false,
    samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
    forcedExtension: ".ktx2",
    onError: (message?: string) => console.warn(`[vfx] ${sheet.url} failed to load: ${message ?? "unknown error"}`),
  });
  texture.name = `vfx_${sheet.url}`;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.hasAlpha = true;
  return texture;
}

/**
 * The flipbook effects' textures, batches (one draw call each), particle pools, lit scorch decals, lighting and RNG.
 * Owned by EquipmentFx; everything is created up front and reused.
 */
export class VfxLibrary {
  readonly lighting = new VfxLighting();
  readonly random = new VfxRandom();
  readonly textures: Texture[] = [];

  /** Kenney atlas: sparks, debris, glass, glows, flares. */
  readonly particlesBatch: VfxBatch;
  readonly explosionBatch: VfxBatch;
  readonly dustBatch: VfxBatch;
  readonly wispyBatch: VfxBatch;
  readonly flameBatch: VfxBatch;
  readonly smokeBatch: VfxBatch;
  readonly decalBatch: VfxBatch;
  private readonly batches: VfxBatch[];

  readonly particles: VfxParticlePool;
  readonly explosion: VfxParticlePool;
  readonly dust: VfxParticlePool;
  readonly wispy: VfxParticlePool;
  readonly flame: VfxParticlePool;
  readonly smoke: VfxParticlePool;
  private readonly pools: VfxParticlePool[];

  constructor(private readonly scene: Scene) {
    const sheet = (s: VfxSheet) => {
      const texture = loadSheet(scene, s);
      this.textures.push(texture);
      return texture;
    };
    const S = VFX_SHEETS;
    this.particlesBatch = new VfxBatch("vfx_particles", scene, sheet(S.particles), S.particles, { capacity: VFX_CAPS.particlesBatch, alphaIndex: VFX_ALPHA_INDEX.particles, fog: true });
    this.explosionBatch = new VfxBatch("vfx_explosion", scene, sheet(S.explosion), S.explosion, { capacity: VFX_CAPS.explosionBatch, alphaIndex: VFX_ALPHA_INDEX.explosion, frameBlend: true, soft: true, fog: true, sort: true });
    this.dustBatch = new VfxBatch("vfx_dust", scene, sheet(S.explosionDust), S.explosionDust, { capacity: VFX_CAPS.dustBatch, alphaIndex: VFX_ALPHA_INDEX.dust, frameBlend: true, soft: true, fog: true, sort: true });
    this.wispyBatch = new VfxBatch("vfx_wispy", scene, sheet(S.smokeWispy), S.smokeWispy, { capacity: VFX_CAPS.wispyBatch, alphaIndex: VFX_ALPHA_INDEX.wispy, frameBlend: true, loop: true, soft: true, fog: true, sort: true });
    this.flameBatch = new VfxBatch("vfx_flame", scene, sheet(S.flame), S.flame, { capacity: VFX_CAPS.flameBatch, alphaIndex: VFX_ALPHA_INDEX.flame, frameBlend: true, loop: true, fog: true });
    this.smokeBatch = new VfxBatch("vfx_smoke", scene, sheet(S.smokeCloud), S.smokeCloud, { capacity: VFX_CAPS.smokeBatch, alphaIndex: VFX_ALPHA_INDEX.smoke, frameBlend: true, loop: true, soft: true, fog: true, sort: true });
    this.decalBatch = new VfxBatch("vfx_decals", scene, sheet(S.scorch), S.scorch, { capacity: VFX_CAPS.decals, alphaIndex: VFX_ALPHA_INDEX.decals, fog: true, lighting: this.lighting, zOffset: -2 });
    this.batches = [this.particlesBatch, this.explosionBatch, this.dustBatch, this.wispyBatch, this.flameBatch, this.smokeBatch, this.decalBatch];

    this.particles = new VfxParticlePool(VFX_CAPS.particlesPool, this.particlesBatch);
    this.explosion = new VfxParticlePool(VFX_CAPS.explosionPool, this.explosionBatch);
    this.dust = new VfxParticlePool(VFX_CAPS.dustPool, this.dustBatch);
    this.wispy = new VfxParticlePool(VFX_CAPS.wispyPool, this.wispyBatch);
    this.flame = new VfxParticlePool(VFX_CAPS.flamePool, this.flameBatch);
    this.smoke = new VfxParticlePool(VFX_CAPS.smokePool, this.smokeBatch);
    this.pools = [this.particles, this.explosion, this.dust, this.wispy, this.flame, this.smoke];
  }

  /** 1 on High, fewer particles on Balanced and Performance. */
  get quality(): number {
    return QUALITY[graphicsOf(this.scene)?.current.preset ?? "high"];
  }

  /** Scales a count by the preset (at least `min`). */
  count(high: number, min = 1): number {
    return Math.max(min, Math.round(high * this.quality));
  }

  begin(): void {
    for (let i = 0; i < this.batches.length; i++) this.batches[i]!.begin();
  }

  step(dt: number): void {
    for (let i = 0; i < this.pools.length; i++) this.pools[i]!.update(dt);
  }

  end(): void {
    for (let i = 0; i < this.batches.length; i++) this.batches[i]!.end();
  }

  clear(): void {
    for (const pool of this.pools) pool.clear();
  }

  /** Live particles and drawn quads per batch, for stats. */
  stats(): string {
    const names = ["particles", "explosion", "dust", "wispy", "flame", "smoke", "decals"];
    const quads = this.batches.map((b, i) => `${names[i]} ${b.drawn}`).join(", ");
    const live = this.pools.map((p, i) => `${names[i]} ${p.active}/${p.capacity}`).join(", ");
    return `quads: ${quads} · particles: ${live}`;
  }

  dispose(): void {
    for (const batch of this.batches) batch.dispose();
    for (const texture of this.textures) texture.dispose();
  }
}
