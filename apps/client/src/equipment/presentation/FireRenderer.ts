import { Color3, Vector3, type Camera } from "@babylonjs/core";
import { FIRE, FIRE_CELL_STRIDE, type FirePatch } from "@twobullets/shared";
import { EqCell, FLAME_FRAMES } from "./equipmentAtlas";
import { SpriteRecord, type EquipmentFx } from "./fxPools";
import { TICK_SECONDS, type EquipmentFxSettings, type EquipmentLights } from "./support";

export const MAX_FIRE_PATCHES = 12;
const MAX_CELLS = FIRE.maxCells;
const TONGUES_PER_CELL = 3;
/** Flames drawn per frame across all patches (the additive batch has room for embers and explosions too). */
const MAX_TONGUES = 600;
const GROW_SECONDS = 0.35;
const DIE_SECONDS = 1.6;
const BURN_MARK_SECONDS = 28;

const FLAME = new Color3(1, 1, 1);
const BASE_GLOW = Color3.FromHexString("#ff7a22");
const EMBER = Color3.FromHexString("#ff9d42");
const SMOKE = Color3.FromHexString("#3a3632");
const BURN = new Color3(1, 1, 1);
const UP = new Vector3(0, 1, 0);

class FireVisual {
  active = false;
  id = 0;
  seenFrame = 0;
  age = 0;
  cellCount = 0;
  readonly cells = new Float32Array(MAX_CELLS * FIRE_CELL_STRIDE);
  readonly normals = new Float32Array(MAX_CELLS * 3);
  readonly phase = new Float32Array(MAX_CELLS);
  readonly marked = new Uint8Array(MAX_CELLS);
  emberTimer = 0;
  smokeTimer = 0;
  flickerSeed = 0;
}

/**
 * Molotov fire patches on their gameplay grid cells: per burning cell a few camera-facing flame tongues (vertical
 * ribbons, so they stand up even when seen from above) animated from a 6-frame procedural flipbook, a ground glow,
 * rising embers and a dark smoke plume, plus a charred burn decal per cell that outlives the fire. Ignition and
 * burn-out follow the cells' igniteAt/dieAt, with render-time ages interpolated between ticks. The nearest patches
 * get a flickering point light. Heat distortion is omitted: it needs a scene color copy every frame.
 */
export class FireRenderer {
  private readonly visuals = Array.from({ length: MAX_FIRE_PATCHES }, () => new FireVisual());
  private frame = 0;
  private time = 0;
  /** Flame tongues drawn last frame, for stats. */
  drawnTongues = 0;

  private readonly base = new Vector3();
  private readonly glow = spriteRecord(EqCell.fireball, BASE_GLOW);
  private readonly flame = spriteRecord(EqCell.flame0, FLAME, 0.85);
  private readonly normal = new Vector3();
  private readonly centroid = new Vector3();

  constructor(
    private readonly camera: Camera,
    private readonly fx: EquipmentFx,
    private readonly lights: EquipmentLights,
    private readonly settings: EquipmentFxSettings,
  ) {}

  get activePatches(): number {
    let n = 0;
    for (const visual of this.visuals) if (visual.active) n++;
    return n;
  }

  beginFrame(): void {
    this.frame++;
  }

  syncList(patches: readonly FirePatch[], alpha: number): void {
    for (let i = 0; i < patches.length; i++) {
      const patch = patches[i]!;
      const visual = this.find(patch.id) ?? this.allocate(patch);
      if (!visual) continue;
      visual.seenFrame = this.frame;
      visual.age = patch.age + alpha * TICK_SECONDS;
    }
  }

  render(dt: number): void {
    this.time += dt;
    const time = this.time;
    let tongues = 0;
    const camera = this.camera.globalPosition;
    const batch = this.fx.additiveBatch;
    const glow = this.glow;
    const flame = this.flame;
    const visuals = this.visuals;
    for (let v = 0; v < visuals.length; v++) {
      const visual = visuals[v]!;
      if (!visual.active) continue;
      if (visual.seenFrame !== this.frame) {
        visual.active = false;
        continue;
      }
      if (!this.settings.fire) continue;
      const age = visual.age;
      const cells = visual.cells;
      let burning = 0;
      let intensitySum = 0;
      this.centroid.setAll(0);
      for (let k = 0; k < visual.cellCount; k++) {
        const o = k * FIRE_CELL_STRIDE;
        const igniteAt = cells[o + 3]!;
        const dieAt = cells[o + 4]!;
        if (age < igniteAt || age >= dieAt + 0.2) continue;
        const x = cells[o]!;
        const y = cells[o + 1]!;
        const z = cells[o + 2]!;
        const phase = visual.phase[k]!;
        if (visual.marked[k] === 0) {
          visual.marked[k] = 1;
          this.normal.set(visual.normals[k * 3]!, visual.normals[k * 3 + 1]!, visual.normals[k * 3 + 2]!);
          this.base.set(x, y, z);
          this.fx.decals.add(this.base, this.normal, 0.62 + 0.2 * phase, EqCell.burn, BURN, 0.85, dieAt - igniteAt + BURN_MARK_SECONDS, 1.2, 6, 0.4);
        }
        const intensity = Math.min(1, (age - igniteAt) / GROW_SECONDS) * Math.min(1, Math.max(0, (dieAt - age) / DIE_SECONDS));
        if (intensity <= 0) continue;
        burning++;
        intensitySum += intensity;
        this.centroid.addInPlaceFromFloats(x, y, z);

        // Low ground glow under the flames.
        glow.position.set(x, y + 0.15, z);
        glow.drawSize = 0.55 * intensity;
        glow.rotation = phase * 6;
        glow.drawAlpha = 0.22 * intensity;
        batch.spriteFrom(glow);
        for (let i = 0; i < TONGUES_PER_CELL && tongues < MAX_TONGUES; i++, tongues++) {
          const seed = phase * 7.13 + i * 2.39;
          const ox = Math.sin(seed * 3.7) * 0.34;
          const oz = Math.cos(seed * 5.1) * 0.34;
          const flicker = 1 + 0.18 * Math.sin(time * (8.5 + i * 1.7) + seed * 4);
          const height = (0.55 + 0.45 * fract(seed * 1.93)) * intensity * flicker * (i === 0 ? 1.2 : 1);
          this.base.set(x + ox, y + 0.02, z + oz);
          // Tips sway with a slow gust and lean a little toward the cell centre.
          const sway = Math.sin(time * 2.1 + seed) * 0.1 + Math.sin(time * 5.3 + seed * 2) * 0.04;
          flame.position.set(x + ox * 0.6 + sway, y + height, z + oz * 0.6 + sway * 0.6);
          flame.cell = EqCell.flame0 + (Math.floor(time * 16 + seed * 5) % FLAME_FRAMES);
          flame.drawSize = (0.2 + 0.12 * fract(seed * 3.3)) * (0.6 + 0.4 * intensity);
          batch.streakFrom(this.base, flame, 1);
        }
      }
      if (burning === 0) continue;
      this.centroid.scaleInPlace(1 / burning);
      this.emit(visual, dt, burning, intensitySum / burning);
      const flicker = 0.72 + 0.16 * Math.sin(time * 13.1 + visual.flickerSeed) + 0.08 * Math.sin(time * 7.3 + visual.flickerSeed * 2) + 0.04 * Math.sin(time * 23.7);
      this.centroid.y += 0.8;
      this.lights.requestFire(this.centroid, 5 * Math.sqrt(intensitySum) * flicker, Vector3.Distance(this.centroid, camera));
    }
    this.drawnTongues = tongues;
  }

  clear(): void {
    for (const visual of this.visuals) visual.active = false;
  }

  private emit(visual: FireVisual, dt: number, burning: number, intensity: number): void {
    // Rates saturate on big patches: the pools recycle anyway, and every spawn costs a little.
    visual.emberTimer -= dt * Math.min(burning, 10);
    while (visual.emberTimer <= 0) {
      visual.emberTimer += 0.28;
      const k = this.randomBurningCell(visual);
      if (k < 0) break;
      const o = k * FIRE_CELL_STRIDE;
      const ember = this.fx.additive.spawn();
      ember.position.set(visual.cells[o]! + (Math.random() - 0.5) * 0.8, visual.cells[o + 1]! + 0.2 + Math.random() * 0.5, visual.cells[o + 2]! + (Math.random() - 0.5) * 0.8);
      ember.velocity.set((Math.random() - 0.5) * 0.8, 1.2 + Math.random() * 2, (Math.random() - 0.5) * 0.8);
      ember.life = 0.7 + Math.random() * 1.1;
      ember.size0 = 0.014;
      ember.size1 = 0.004;
      ember.drag = 0.9;
      ember.gravity = -0.4;
      ember.cell = EqCell.dot;
      ember.streakSeconds = 0.025;
      ember.color.copyFrom(EMBER);
      ember.fadePower = 0.7;
    }
    visual.smokeTimer -= dt * Math.min(Math.sqrt(burning), 3) * intensity;
    while (visual.smokeTimer <= 0) {
      visual.smokeTimer += 0.35;
      const k = this.randomBurningCell(visual);
      if (k < 0) break;
      const o = k * FIRE_CELL_STRIDE;
      const puff = this.fx.alpha.spawn();
      puff.position.set(visual.cells[o]!, visual.cells[o + 1]! + 1.1, visual.cells[o + 2]!);
      puff.velocity.set((Math.random() - 0.5) * 0.4 + 0.25, 1 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4);
      puff.life = 3 + Math.random() * 1.5;
      puff.size0 = 0.35;
      puff.size1 = 2.2 + Math.random();
      puff.drag = 0.25;
      puff.gravity = -0.12;
      puff.cell = EqCell.smoke;
      puff.rotation = Math.random() * Math.PI * 2;
      puff.spin = (Math.random() - 0.5) * 0.4;
      puff.color.copyFrom(SMOKE);
      puff.alpha = 0.4;
      puff.fadePower = 1.3;
    }
  }

  private randomBurningCell(visual: FireVisual): number {
    const start = Math.floor(Math.random() * visual.cellCount);
    for (let n = 0; n < visual.cellCount; n++) {
      const k = (start + n) % visual.cellCount;
      const o = k * FIRE_CELL_STRIDE;
      if (visual.age >= visual.cells[o + 3]! && visual.age < visual.cells[o + 4]!) return k;
    }
    return -1;
  }

  private find(id: number): FireVisual | null {
    for (let i = 0; i < this.visuals.length; i++) {
      const visual = this.visuals[i]!;
      if (visual.active && visual.id === id) return visual;
    }
    return null;
  }

  private allocate(patch: FirePatch): FireVisual | null {
    let visual: FireVisual | null = null;
    for (const candidate of this.visuals) {
      if (!candidate.active) {
        visual = candidate;
        break;
      }
    }
    if (!visual) return null;
    visual.active = true;
    visual.id = patch.id;
    visual.cellCount = Math.min(MAX_CELLS, patch.cellCount);
    visual.cells.set(patch.cells.subarray(0, visual.cellCount * FIRE_CELL_STRIDE));
    visual.marked.fill(0);
    visual.emberTimer = 0;
    visual.smokeTimer = 0;
    visual.flickerSeed = Math.random() * 10;
    const cells = visual.cells;
    for (let k = 0; k < visual.cellCount; k++) {
      visual.phase[k] = fract(Math.sin((patch.id + 1) * 12.9898 + k * 78.233) * 43758.5453);
      // Surface normal from the neighbouring cells' heights (the grid is 1 m, axis-aligned from the impact).
      const o = k * FIRE_CELL_STRIDE;
      const gx = heightSlope(cells, visual.cellCount, cells[o]!, cells[o + 1]!, cells[o + 2]!, 1, 0);
      const gz = heightSlope(cells, visual.cellCount, cells[o]!, cells[o + 1]!, cells[o + 2]!, 0, 1);
      this.normal.set(-gx, 1, -gz).normalize();
      if (this.normal.y < FIRE.minNormalY) this.normal.copyFrom(UP);
      visual.normals[k * 3] = this.normal.x;
      visual.normals[k * 3 + 1] = this.normal.y;
      visual.normals[k * 3 + 2] = this.normal.z;
    }
    return visual;
  }
}

/** dy/dx along (dx, dz) from grid neighbours present in the patch (central or one-sided difference), else 0. */
function heightSlope(cells: Float32Array, count: number, x: number, y: number, z: number, dx: number, dz: number): number {
  let ahead = NaN;
  let behind = NaN;
  const step = FIRE.cellSize;
  for (let k = 0; k < count; k++) {
    const o = k * FIRE_CELL_STRIDE;
    const ex = cells[o]! - x;
    const ez = cells[o + 2]! - z;
    if (Math.abs(ex - dx * step) < 0.05 && Math.abs(ez - dz * step) < 0.05) ahead = cells[o + 1]!;
    else if (Math.abs(ex + dx * step) < 0.05 && Math.abs(ez + dz * step) < 0.05) behind = cells[o + 1]!;
  }
  if (!Number.isNaN(ahead) && !Number.isNaN(behind)) return (ahead - behind) / (2 * step);
  if (!Number.isNaN(ahead)) return (ahead - y) / step;
  if (!Number.isNaN(behind)) return (y - behind) / step;
  return 0;
}

function spriteRecord(cell: number, color: Color3, alpha = 1): SpriteRecord {
  const record = new SpriteRecord();
  record.cell = cell;
  record.color.copyFrom(color);
  record.drawAlpha = alpha;
  return record;
}

function fract(x: number): number {
  return x - Math.floor(x);
}
