import { Color3, Vector3, type Scene, type Texture } from "@babylonjs/core";
import { FxBatch, type FxDecal, type FxSprite } from "../../fx/FxBatch";
import { ParticlePool } from "../../fx/ParticlePool";
import { VIEWMODEL_RENDERING_GROUP } from "../../viewmodel/renderGroups";
import { EQ_ATLAS_COLUMNS, EQ_ATLAS_ROWS } from "./equipmentAtlas";

/** Pool caps (see docs in the final report): particles recycle the oldest, decals overwrite the oldest. */
export const EQ_POOL_CAPS = {
  additiveParticles: 640,
  alphaParticles: 420,
  decals: 160,
  additiveSprites: 1400,
  alphaSprites: 900,
  viewmodelSprites: 24,
  arcSprites: 128,
} as const;

/**
 * alphaIndex order in rendering group 0 (lower first): existing decals 0 / dust 1 / glow 2, then ours. The smoke
 * volume draws after the particles so smoke hides what is inside or behind it; the arc draws last.
 */
export const EQ_ALPHA_INDEX = { decals: 0, alpha: 1, additive: 2, smokeBillows: 3, smoke: 4, arc: 5 } as const;

class TimedDecal implements FxDecal {
  readonly position = new Vector3();
  readonly normal = new Vector3(0, 1, 0);
  readonly color = new Color3();
  halfSize = 0;
  rotation = 0;
  cell = 0;
  alpha = 0;
  baseAlpha = 0;
  born = -Infinity;
  life = 0;
  fadeIn = 0;
  fadeOut = 1;
  /** Grows from `startScale` × size to full size over `fadeIn`. */
  startScale = 1;
  size = 0;
}

/** Ring buffer of timed surface decals (scorch, burn, scuff) drawn through one FxBatch. */
export class DecalStore {
  private readonly decals: TimedDecal[];
  private next = 0;
  private time = 0;

  constructor(
    capacity: number,
    private readonly batch: FxBatch,
  ) {
    this.decals = Array.from({ length: capacity }, () => new TimedDecal());
  }

  add(position: Vector3, normal: Vector3, halfSize: number, cell: number, color: Color3, alpha: number, life: number, fadeIn: number, fadeOut: number, startScale = 1): void {
    const decal = this.decals[this.next]!;
    this.next = (this.next + 1) % this.decals.length;
    decal.position.copyFrom(normal).scaleInPlace(0.01).addInPlace(position);
    decal.normal.copyFrom(normal);
    decal.size = halfSize;
    decal.rotation = Math.random() * Math.PI * 2;
    decal.cell = cell;
    decal.color.copyFrom(color);
    decal.baseAlpha = alpha;
    decal.born = this.time;
    decal.life = life;
    decal.fadeIn = Math.max(1e-3, fadeIn);
    decal.fadeOut = Math.max(1e-3, fadeOut);
    decal.startScale = startScale;
  }

  get active(): number {
    let n = 0;
    for (const decal of this.decals) if (this.time - decal.born < decal.life) n++;
    return n;
  }

  get capacity(): number {
    return this.decals.length;
  }

  update(dt: number): void {
    this.time += dt;
    const decals = this.decals;
    for (let i = 0; i < decals.length; i++) {
      const decal = decals[i]!;
      const age = this.time - decal.born;
      if (age >= decal.life) continue;
      const fadeIn = Math.min(1, age / decal.fadeIn);
      const grow = fadeIn * (2 - fadeIn);
      decal.halfSize = decal.size * (decal.startScale + (1 - decal.startScale) * grow);
      decal.alpha = decal.baseAlpha * fadeIn * Math.min(1, (decal.life - age) / decal.fadeOut);
      this.batch.decalFrom(decal);
    }
  }

  clear(): void {
    for (const decal of this.decals) decal.born = -Infinity;
  }
}

/** The batches, particle pools and decals every equipment effect draws through. One begin/end per frame. */
export class EquipmentFx {
  readonly decalBatch: FxBatch;
  readonly alphaBatch: FxBatch;
  readonly additiveBatch: FxBatch;
  /** Additive sprites in the viewmodel group (burning rag in hand). */
  readonly viewmodelBatch: FxBatch;
  readonly arcBatch: FxBatch;
  readonly additive: ParticlePool;
  readonly alpha: ParticlePool;
  readonly decals: DecalStore;

  constructor(scene: Scene, atlas: Texture) {
    const layout = { atlasColumns: EQ_ATLAS_COLUMNS, atlasRows: EQ_ATLAS_ROWS, textureColor: true } as const;
    this.decalBatch = new FxBatch("eq_decals", scene, atlas, { ...layout, fog: true, capacity: EQ_POOL_CAPS.decals, blend: "alpha", renderingGroupId: 0, alphaIndex: EQ_ALPHA_INDEX.decals, zOffset: -2 });
    this.alphaBatch = new FxBatch("eq_alpha", scene, atlas, { ...layout, fog: true, capacity: EQ_POOL_CAPS.alphaSprites, blend: "alpha", renderingGroupId: 0, alphaIndex: EQ_ALPHA_INDEX.alpha });
    this.additiveBatch = new FxBatch("eq_additive", scene, atlas, { ...layout, capacity: EQ_POOL_CAPS.additiveSprites, blend: "additive", renderingGroupId: 0, alphaIndex: EQ_ALPHA_INDEX.additive });
    this.viewmodelBatch = new FxBatch("eq_viewmodel", scene, atlas, { ...layout, capacity: EQ_POOL_CAPS.viewmodelSprites, blend: "additive", renderingGroupId: VIEWMODEL_RENDERING_GROUP, alphaIndex: 2 });
    this.arcBatch = new FxBatch("eq_arc", scene, atlas, { ...layout, capacity: EQ_POOL_CAPS.arcSprites, blend: "alpha", renderingGroupId: 0, alphaIndex: EQ_ALPHA_INDEX.arc, minSpritePixels: 1.5 });
    this.additive = new ParticlePool(EQ_POOL_CAPS.additiveParticles, this.additiveBatch);
    this.alpha = new ParticlePool(EQ_POOL_CAPS.alphaParticles, this.alphaBatch);
    this.decals = new DecalStore(EQ_POOL_CAPS.decals, this.decalBatch);
  }

  begin(): void {
    this.decalBatch.begin();
    this.alphaBatch.begin();
    this.additiveBatch.begin();
    this.viewmodelBatch.begin();
    this.arcBatch.begin();
  }

  /** Steps pooled particles and decals into the batches (renderers push their own sprites between begin and end). */
  step(dt: number): void {
    this.additive.update(dt);
    this.alpha.update(dt);
    this.decals.update(dt);
  }

  end(): void {
    this.decalBatch.end();
    this.alphaBatch.end();
    this.additiveBatch.end();
    this.viewmodelBatch.end();
    this.arcBatch.end();
  }

  clear(): void {
    this.additive.clear();
    this.alpha.clear();
    this.decals.clear();
  }

  dispose(): void {
    for (const batch of [this.decalBatch, this.alphaBatch, this.additiveBatch, this.viewmodelBatch, this.arcBatch]) batch.dispose();
  }
}

/**
 * Reusable sprite/streak record for `FxBatch.spriteFrom` / `streakFrom`. Loops that draw hundreds of quads a frame fill
 * one of these instead of calling `sprite(...)` with loose doubles, which V8 boxes when it declines to inline the call.
 */
export class SpriteRecord implements FxSprite {
  readonly position = new Vector3();
  readonly color = new Color3(1, 1, 1);
  drawSize = 0;
  rotation = 0;
  cell = 0;
  drawAlpha = 1;
  hot = 0;
}

/** Random unit vector in a cone around `axis` (spread 0 = along it, ~1.5 = nearly flat). */
export function randomCone(axis: Vector3, spread: number, result: Vector3, tangent: Vector3, bitangent: Vector3): Vector3 {
  const reference = Math.abs(axis.y) < 0.95 ? Vector3.UpReadOnly : Vector3.RightReadOnly;
  Vector3.CrossToRef(reference, axis, tangent);
  tangent.normalize();
  Vector3.CrossToRef(axis, tangent, bitangent);
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.random() * spread;
  const c = Math.cos(angle) * radius;
  const s = Math.sin(angle) * radius;
  result.set(axis.x + tangent.x * c + bitangent.x * s, axis.y + tangent.y * c + bitangent.y * s, axis.z + tangent.z * c + bitangent.z * s);
  return result.normalize();
}
