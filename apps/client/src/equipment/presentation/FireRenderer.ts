import { Color3, Vector3, type Camera } from "@babylonjs/core";
import { FIRE, FIRE_CELL_STRIDE, type FirePatch } from "@twobullets/shared";
import type { EquipmentFx } from "./fxPools";
import { TICK_SECONDS, type EquipmentFxSettings, type EquipmentLights } from "./support";
import { VfxMode } from "./VfxBatch";
import { PCell, ScorchCell } from "./VfxLibrary";
import { VFX_SHEETS } from "./vfxManifest";
import { VfxRecord } from "./VfxParticles";
import { VfxRandom } from "./vfxRandom";

export const MAX_FIRE_PATCHES = 12;
const MAX_CELLS = FIRE.maxCells;
/** Flame billboards per burning cell on High (Balanced and Performance draw fewer). */
const FLAMES_PER_CELL = 3;
/** Flames drawn per frame across all patches. */
const MAX_FLAMES = 600;
const GROW_SECONDS = 0.35;
const DIE_SECONDS = 1.6;
const BURN_MARK_SECONDS = 28;

const FLAME = VFX_SHEETS.flame;
const WISPY = VFX_SHEETS.smokeWispy;
const FLAME_TINT = new Color3(1.3, 1.12, 1.0);
const BASE_GLOW = new Color3(1, 0.42, 0.12);
const EMBER = new Color3(2, 1.05, 0.4);
const WHITE = new Color3(1, 1, 1);
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
 * Molotov fire patches on their gameplay grid cells (docs/fx-throwables.md): per burning cell a few upright Flame03
 * flipbook billboards (they turn about world up, so they stand even when seen from above), spread and jittered over
 * the 1 m cell so the whole shared fire area reads as burning, each on its own frame offset and speed with a swaying
 * tip; an additive ground glow; rising ember streaks; a dark WispySmoke plume drifting off the top; and a lit
 * burned-ground decal per cell that outlives the fire. Ignition and burn-out follow the cells' igniteAt/dieAt, with
 * render-time ages interpolated between ticks. The nearest patches get a flickering point light. Heat distortion is
 * omitted: it needs a scene color copy every frame.
 */
export class FireRenderer {
  private readonly visuals = Array.from({ length: MAX_FIRE_PATCHES }, () => new FireVisual());
  private readonly random = new VfxRandom(0xf12e);
  private frame = 0;
  private time = 0;
  /** Flame billboards drawn last frame, for stats. */
  drawnTongues = 0;

  private readonly base = new Vector3();
  private readonly glow = new VfxRecord();
  private readonly flame = new VfxRecord();
  private readonly normal = new Vector3();
  private readonly centroid = new Vector3();
  private readonly smokeColor = new Color3();

  constructor(
    private readonly camera: Camera,
    private readonly fx: EquipmentFx,
    private readonly lights: EquipmentLights,
    private readonly settings: EquipmentFxSettings,
  ) {
    this.glow.frame = PCell.glow;
    this.glow.additive = 1;
    this.glow.color.copyFrom(BASE_GLOW);
    this.glow.axis.set(-1e6, 1, 0);
    this.flame.mode = VfxMode.upright;
    this.flame.additive = 0.82;
    this.flame.color.copyFrom(FLAME_TINT);
  }

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
    const vfx = this.fx.vfx;
    let flames = 0;
    const camera = this.camera.globalPosition;
    const flameBatch = vfx.flameBatch;
    const glowBatch = vfx.particlesBatch;
    const glow = this.glow;
    const flame = this.flame;
    const perCell = vfx.count(FLAMES_PER_CELL, 1);
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
          this.fx.scorch.add(this.base, this.normal, 0.78 + 0.22 * phase, ScorchCell.burn, WHITE, 0.9, dieAt - igniteAt + BURN_MARK_SECONDS, 1.2, 6, 0.4);
        }
        const intensity = Math.min(1, (age - igniteAt) / GROW_SECONDS) * Math.min(1, Math.max(0, (dieAt - age) / DIE_SECONDS));
        if (intensity <= 0) continue;
        burning++;
        intensitySum += intensity;
        this.centroid.addInPlaceFromFloats(x, y, z);

        // Low ground glow under the flames.
        glow.position.set(x, y + 0.25, z);
        glow.drawSize = 0.95 * intensity;
        glow.rotation = phase * 6;
        glow.drawAlpha = 0.16 * intensity;
        glowBatch.push(glow);

        for (let i = 0; i < perCell && flames < MAX_FLAMES; i++, flames++) {
          const seed = phase * 7.13 + i * 2.39;
          const main = i === 0;
          // Spread over the cell (1 m grid) so neighbouring cells' flames interleave.
          const ox = Math.sin(seed * 3.7) * (main ? 0.18 : 0.42);
          const oz = Math.cos(seed * 5.1) * (main ? 0.18 : 0.42);
          const flicker = 1 + 0.12 * Math.sin(time * (7.5 + i * 1.9) + seed * 4);
          // Half width; the sheet's 1:2 cells make the flame four half-widths tall.
          const half = (main ? 0.3 : 0.2 + 0.08 * fract(seed * 1.93)) * (0.45 + 0.55 * intensity) * flicker;
          flame.position.set(x + ox, y - 0.04, z + oz);
          const sway = Math.sin(time * 2.1 + seed) * 0.1 + Math.sin(time * 5.3 + seed * 2) * 0.04;
          flame.axis.set(sway, 0, sway * 0.6);
          flame.drawSize = half;
          flame.rotation = 0;
          flame.frame = (fract(seed * 0.37) * FLAME.frames + time * FLAME.fps * (0.75 + 0.5 * fract(seed * 2.71))) % FLAME.frames;
          flame.drawAlpha = Math.min(1, intensity * 1.4);
          flameBatch.push(flame);
        }
      }
      if (burning === 0) continue;
      this.centroid.scaleInPlace(1 / burning);
      this.emit(visual, dt, burning, intensitySum / burning);
      const flicker = 0.72 + 0.16 * Math.sin(time * 13.1 + visual.flickerSeed) + 0.08 * Math.sin(time * 7.3 + visual.flickerSeed * 2) + 0.04 * Math.sin(time * 23.7);
      this.centroid.y += 0.8;
      this.lights.requestFire(this.centroid, 5 * Math.sqrt(intensitySum) * flicker, Vector3.Distance(this.centroid, camera));
    }
    this.drawnTongues = flames;
  }

  clear(): void {
    for (const visual of this.visuals) visual.active = false;
  }

  private emit(visual: FireVisual, dt: number, burning: number, intensity: number): void {
    const vfx = this.fx.vfx;
    const r = this.random;
    const quality = vfx.quality;
    // Rates saturate on big patches: the pools recycle anyway, and every spawn costs a little.
    visual.emberTimer -= dt * Math.min(burning, 10) * quality;
    while (visual.emberTimer <= 0) {
      visual.emberTimer += 0.22;
      const k = this.randomBurningCell(visual);
      if (k < 0) break;
      const o = k * FIRE_CELL_STRIDE;
      const ember = vfx.particles.spawn();
      ember.position.set(visual.cells[o]! + r.signed() * 0.45, visual.cells[o + 1]! + r.range(0.2, 0.8), visual.cells[o + 2]! + r.signed() * 0.45);
      ember.velocity.set(r.signed() * 0.5, r.range(1.5, 3.2), r.signed() * 0.5);
      ember.life = r.range(0.8, 1.8);
      ember.size0 = 0.022;
      ember.size1 = 0.008;
      ember.drag = 0.9;
      ember.gravity = -0.6;
      ember.frame0 = ember.frame1 = PCell.trace;
      ember.streakSeconds = 0.05;
      ember.color.copyFrom(EMBER);
      ember.additive0 = ember.additive1 = 1;
      ember.fadePower = 0.7;
    }
    // Dark plume: soot from the fuel, lit by the sky from above.
    vfx.lighting.displayToRef(0.05, 0.048, 0.045, 0.6, 1, 0.3, this.smokeColor).scaleInPlace(1 / WISPY.meanLuma);
    visual.smokeTimer -= dt * Math.min(Math.sqrt(burning), 3) * intensity * quality;
    while (visual.smokeTimer <= 0) {
      visual.smokeTimer += 0.3;
      const k = this.randomBurningCell(visual);
      if (k < 0) break;
      const o = k * FIRE_CELL_STRIDE;
      const puff = vfx.wispy.spawn();
      puff.position.set(visual.cells[o]! + r.signed() * 0.3, visual.cells[o + 1]! + 1.3, visual.cells[o + 2]! + r.signed() * 0.3);
      puff.velocity.set(r.signed() * 0.25 + 0.25, r.range(1.1, 1.8), r.signed() * 0.25);
      puff.life = r.range(4, 6);
      puff.size0 = 0.45;
      puff.size1 = r.range(2.2, 3);
      puff.growPower = 1.6;
      puff.drag = 0.3;
      puff.gravity = -0.1;
      puff.frame0 = r.next() * WISPY.frames;
      puff.frameRate = WISPY.fps;
      puff.frameCount = WISPY.frames;
      puff.rotation = r.signed() * 0.6;
      puff.spin = r.signed() * 0.15;
      puff.color.copyFrom(this.smokeColor);
      puff.alpha = 0.5;
      puff.fadeIn = 0.5;
      puff.fadePower = 1.3;
      puff.nearFade = 1.2;
    }
  }

  private randomBurningCell(visual: FireVisual): number {
    const start = this.random.int(visual.cellCount);
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
    visual.flickerSeed = fract(Math.sin((patch.id + 7) * 91.345) * 47453.5453) * 10;
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

function fract(x: number): number {
  return x - Math.floor(x);
}
