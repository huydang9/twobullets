import { INSTANCE_STRIDE, getMapProp, mapPaths, rectCorners } from "@twobullets/shared";
import type { MapWorldData } from "./types";

/** Side of the cached map image, px. It covers exactly the playable square (500 m), north up: ~2 px per meter. */
export const MAP_IMAGE_SIZE = 1024;
/** Terrain colour is computed at this resolution (≈1 m per pixel, the heightfield is 1.25 m) and upscaled. */
const TERRAIN_RESOLUTION = 512;
/** Longest the generator runs before yielding to the frame loop, ms. */
const SLICE_MS = 8;

export interface MapImageStats {
  /** Load start → image ready, ms (includes the frames in between). */
  readonly wallMs: number;
  /** Time spent generating, ms. */
  readonly busyMs: number;
  /** Longest single slice, ms. */
  readonly longestSliceMs: number;
  /** Retained canvas memory, MB. */
  readonly megabytes: number;
}

export interface MapImage {
  readonly canvas: HTMLCanvasElement;
  /** Half side of the covered square, m (the playable half extent). */
  readonly half: number;
  /** Image pixels per meter. */
  readonly pixelsPerMeter: number;
  readonly stats: MapImageStats;
}

// sRGB palette. Muted, slightly desaturated tones read like an aerial photo rather than a debug plot.
const GRASS: readonly number[] = [104, 121, 70];
const GRASS_DRY: readonly number[] = [132, 134, 84];
const GRASS_LUSH: readonly number[] = [84, 108, 60];
const DIRT: readonly number[] = [148, 128, 96];
const ROCK: readonly number[] = [140, 136, 126];
const ROAD: readonly number[] = [96, 94, 90];
const ROOFS = ["#9a968e", "#7c5a48", "#6c7076", "#a89f8c", "#86705a"] as const;
/** Light from the north-west, above the horizon (normalized). */
const LIGHT = normalize(-0.55, 0.75, 0.6);

/**
 * Renders the realistic top-down map once: terrain colour from the surface mask with hill shading and mottling, roads,
 * fences, trees with shadows, rocks, and building roofs with shadows. Works in slices of ≤ SLICE_MS so it never
 * blocks the frame loop for long.
 */
export async function renderMapImage(world: MapWorldData, size = MAP_IMAGE_SIZE): Promise<MapImage> {
  const clock = new SliceClock();
  const half = world.map.terrain.playableHalfExtent;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("[map] 2D canvas unavailable");

  const terrainCanvas = await renderTerrain(world, half, clock);
  await clock.slice();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(terrainCanvas, 0, 0, size, size);
  terrainCanvas.width = 0;

  // World meters from here on: +X right, +Z up.
  const ppm = size / (half * 2);
  ctx.setTransform(ppm, 0, 0, -ppm, size / 2, size / 2);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  await clock.slice();
  drawRoads(ctx, world);
  await drawProps(ctx, world, clock);
  await clock.slice();
  drawBuildings(ctx, world);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const stats = clock.finish(size);
  console.info(`[map] image ${size}² in ${Math.round(stats.wallMs)} ms (busy ${Math.round(stats.busyMs)} ms, longest slice ${Math.round(stats.longestSliceMs)} ms, ${stats.megabytes} MB)`);
  return { canvas, half, pixelsPerMeter: ppm, stats };
}

async function renderTerrain(world: MapWorldData, half: number, clock: SliceClock): Promise<HTMLCanvasElement> {
  const n = TERRAIN_RESOLUTION;
  const { terrain } = world;
  const mpp = (half * 2) / n;
  const heights = new Float32Array(n * n);
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let py = 0; py < n; py++) {
    const z = half - (py + 0.5) * mpp;
    const row = py * n;
    for (let px = 0; px < n; px++) {
      const h = terrain.sampleHeight(-half + (px + 0.5) * mpp, z);
      heights[row + px] = h;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
    if (clock.due()) await clock.slice();
  }

  const canvas = document.createElement("canvas");
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("[map] 2D canvas unavailable");
  const image = ctx.createImageData(n, n);
  const data = image.data;
  const weights = new Float32Array(4);
  const heightRange = Math.max(1, maxHeight - minHeight);
  // Gradients over ±2 px (≈4 m) keep sub-meter bumps out of the shading; ×1.6 exaggerates relief for readability.
  const gradientScale = 1.6 / (4 * mpp);
  const flat = LIGHT[1]!;
  for (let py = 0; py < n; py++) {
    const z = half - (py + 0.5) * mpp;
    const up = Math.max(0, py - 2) * n;
    const down = Math.min(n - 1, py + 2) * n;
    for (let px = 0; px < n; px++) {
      const x = -half + (px + 0.5) * mpp;
      terrain.surfaceWeightsAt(x, z, weights);
      const grass = weights[0]!;
      const dirt = weights[1]!;
      const rock = weights[2]!;
      const road = weights[3]!;

      // Grass varies between dry and lush patches (two octaves of value noise).
      const patch = 0.5 + (valueNoise(x, z, 46) * 0.7 + valueNoise(x + 311, z - 173, 11) * 0.3 - 0.5) * 0.8;
      const lush = patch < 0.5 ? (0.5 - patch) * 2 : 0;
      const dry = patch > 0.5 ? (patch - 0.5) * 2 : 0;
      const grain = 0.94 + valueNoise(x - 57, z + 91, 3) * 0.12;

      const dhdx = (heights[py * n + Math.min(n - 1, px + 2)]! - heights[py * n + Math.max(0, px - 2)]!) * gradientScale;
      const dhdz = (heights[up + px]! - heights[down + px]!) * gradientScale;
      // Normal (-dhdx, 1, -dhdz) against the light, relative to flat ground.
      const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
      const lambert = (-dhdx * LIGHT[0]! + LIGHT[1]! - dhdz * LIGHT[2]!) * inv;
      const elevation = (heights[py * n + px]! - minHeight) / heightRange;
      const shade = clampRange((1 + (lambert - flat) * 1.05) * (0.94 + elevation * 0.1) * grain, 0.62, 1.3);

      const i = (py * n + px) * 4;
      for (let c = 0; c < 3; c++) {
        const grassColour = GRASS[c]! + (GRASS_LUSH[c]! - GRASS[c]!) * lush + (GRASS_DRY[c]! - GRASS[c]!) * dry;
        const base = grassColour * grass + DIRT[c]! * dirt + ROCK[c]! * rock + ROAD[c]! * road;
        data[i + c] = base * shade;
      }
      data[i + 3] = 255;
    }
    if (clock.due()) await clock.slice();
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function drawRoads(ctx: CanvasRenderingContext2D, world: MapWorldData): void {
  const paths = mapPaths(world.map);
  const trace = (points: readonly (readonly [number, number])[]): void => {
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const [x, z] = points[i]!;
      if (i === 0) ctx.moveTo(x, z);
      else ctx.lineTo(x, z);
    }
  };
  for (const path of paths) {
    if (path.kind !== "dirt") continue;
    trace(path.points);
    ctx.strokeStyle = "rgba(150, 128, 94, 0.85)";
    ctx.lineWidth = path.halfWidth * 2;
    ctx.stroke();
  }
  for (const path of paths) {
    if (path.kind !== "asphalt") continue;
    trace(path.points);
    ctx.strokeStyle = "rgba(62, 62, 60, 0.95)";
    ctx.lineWidth = path.halfWidth * 2 + 0.9;
    ctx.stroke();
    ctx.strokeStyle = "#6a6966";
    ctx.lineWidth = path.halfWidth * 2;
    ctx.stroke();
    ctx.strokeStyle = "rgba(214, 208, 190, 0.35)";
    ctx.lineWidth = 0.35;
    ctx.stroke();
  }
}

async function drawProps(ctx: CanvasRenderingContext2D, world: MapWorldData, clock: SliceClock): Promise<void> {
  // Fences and walls first, then ground cover, tree shadows, canopies and highlights, so canopies overlap cleanly.
  const passes = ["line", "bush", "rock", "prop", "shadow", "canopyDark", "canopyLight", "highlight"] as const;
  for (const pass of passes) {
    ctx.beginPath();
    let pending = 0;
    const flush = (): void => {
      if (pending === 0) return;
      if (pass === "line") ctx.stroke();
      else ctx.fill();
      ctx.beginPath();
      pending = 0;
    };
    switch (pass) {
      case "line":
        ctx.strokeStyle = "rgba(58, 48, 38, 0.85)";
        ctx.lineWidth = 0.5;
        break;
      case "bush":
        ctx.fillStyle = "rgba(78, 102, 56, 0.85)";
        break;
      case "rock":
        ctx.fillStyle = "#8a877f";
        break;
      case "prop":
        ctx.fillStyle = "#5a5046";
        break;
      case "shadow":
        ctx.fillStyle = "rgba(18, 26, 12, 0.32)";
        break;
      case "canopyDark":
        ctx.fillStyle = "#3a5a30";
        break;
      case "canopyLight":
        ctx.fillStyle = "#4a6b3a";
        break;
      case "highlight":
        ctx.fillStyle = "rgba(226, 236, 180, 0.1)";
        break;
    }
    for (const set of world.layout.props) {
      const def = getMapProp(set.prop);
      if (def.category === "grass") continue;
      const line = def.collision.kind === "box" && def.collision.size[0] >= 3 * def.collision.size[2];
      const tree = !line && def.category === "tree";
      const matches =
        pass === "line" ? line : pass === "shadow" || pass === "canopyDark" || pass === "canopyLight" || pass === "highlight" ? tree : !line && !tree && def.category === pass;
      if (!matches) continue;
      const data = set.data;
      for (let i = 0; i < data.length; i += INSTANCE_STRIDE) {
        const x = data[i]!;
        const z = data[i + 2]!;
        const yaw = data[i + 3]!;
        const scale = data[i + 4]!;
        if (line && def.collision.kind === "box") {
          const hx = (def.collision.size[0] / 2) * scale;
          const dx = Math.cos(yaw) * hx;
          const dz = -Math.sin(yaw) * hx;
          ctx.moveTo(x - dx, z - dz);
          ctx.lineTo(x + dx, z + dz);
        } else if (tree) {
          const r = def.footprint * scale * 1.2;
          const light = hashCoords(x, z) > 0.5;
          if (pass === "shadow") circle(ctx, x + r * 0.35, z - r * 0.35, r);
          else if (pass === "canopyDark" && !light) circle(ctx, x, z, r);
          else if (pass === "canopyLight" && light) circle(ctx, x, z, r);
          else if (pass === "highlight") circle(ctx, x - r * 0.3, z + r * 0.3, r * 0.5);
          else continue;
        } else {
          circle(ctx, x, z, def.category === "bush" ? Math.max(0.6, def.footprint * scale) : Math.max(0.5, def.footprint * scale * 0.8));
        }
        if (++pending >= 400) {
          flush();
          if (clock.due()) await clock.slice();
        }
      }
    }
    flush();
    if (clock.due()) await clock.slice();
  }
}

function drawBuildings(ctx: CanvasRenderingContext2D, world: MapWorldData): void {
  const buildings = world.layout.buildings;
  ctx.fillStyle = "rgba(10, 12, 8, 0.38)";
  for (const building of buildings) {
    const corners = rectCorners(building.bounds);
    polygon(ctx, corners, 1.4, -1.4);
    ctx.fill();
  }
  ctx.lineWidth = 0.4;
  ctx.strokeStyle = "rgba(28, 26, 24, 0.9)";
  for (const building of buildings) {
    const corners = rectCorners(building.bounds);
    polygon(ctx, corners, 0, 0);
    ctx.fillStyle = ROOFS[Math.floor(hashString(building.id) * ROOFS.length)]!;
    ctx.fill();
    ctx.stroke();
    // Ridge along the long axis: a light line reads as a pitched roof.
    const { center, halfExtents, yaw } = building.bounds;
    const alongX = halfExtents[0] >= halfExtents[1];
    const length = (alongX ? halfExtents[0] : halfExtents[1]) * 0.85;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Local +X turns to (cos, -sin), local +Z to (sin, cos) (see layout/geometry rotate).
    const dx = alongX ? cos * length : sin * length;
    const dz = alongX ? -sin * length : cos * length;
    ctx.beginPath();
    ctx.moveTo(center[0] - dx, center[1] - dz);
    ctx.lineTo(center[0] + dx, center[1] + dz);
    ctx.strokeStyle = "rgba(235, 230, 215, 0.35)";
    ctx.stroke();
    ctx.strokeStyle = "rgba(28, 26, 24, 0.9)";
  }
}

function polygon(ctx: CanvasRenderingContext2D, corners: readonly (readonly [number, number])[], ox: number, oz: number): void {
  ctx.beginPath();
  for (let i = 0; i < corners.length; i++) {
    const [x, z] = corners[i]!;
    if (i === 0) ctx.moveTo(x + ox, z + oz);
    else ctx.lineTo(x + ox, z + oz);
  }
  ctx.closePath();
}

function circle(ctx: CanvasRenderingContext2D, x: number, z: number, r: number): void {
  ctx.moveTo(x + r, z);
  ctx.arc(x, z, r, 0, Math.PI * 2);
}

/** Wall-clock budget: `due()` once the current slice is over SLICE_MS, `slice()` yields a macrotask. */
class SliceClock {
  private readonly started = performance.now();
  private sliceStart = this.started;
  private busy = 0;
  private longest = 0;
  private readonly channel = new MessageChannel();

  due(): boolean {
    return performance.now() - this.sliceStart >= SLICE_MS;
  }

  /** Yields through a message task: runs in hidden tabs too, unlike rAF, and isn't clamped like setTimeout. */
  async slice(): Promise<void> {
    this.endSlice();
    await new Promise<void>((resolve) => {
      this.channel.port1.onmessage = () => resolve();
      this.channel.port2.postMessage(null);
    });
    this.sliceStart = performance.now();
  }

  finish(size: number): MapImageStats {
    this.endSlice();
    this.channel.port1.close();
    return { wallMs: performance.now() - this.started, busyMs: this.busy, longestSliceMs: this.longest, megabytes: Math.round(((size * size * 4) / 1048576) * 10) / 10 };
  }

  private endSlice(): void {
    const spent = performance.now() - this.sliceStart;
    this.busy += spent;
    if (spent > this.longest) this.longest = spent;
    this.sliceStart = performance.now();
  }
}

/** Smooth value noise in 0..1 with `cell`-meter lattice spacing. */
function valueNoise(x: number, z: number, cell: number): number {
  const gx = x / cell;
  const gz = z / cell;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  let fx = gx - ix;
  let fz = gz - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  const top = a + (b - a) * fx;
  return top + (c + (d - c) * fx - top) * fz;
}

function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hashCoords(x: number, z: number): number {
  return hash2(Math.round(x * 10), Math.round(z * 10));
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function normalize(x: number, y: number, z: number): readonly [number, number, number] {
  const length = Math.sqrt(x * x + y * y + z * z);
  return [x / length, y / length, z / length];
}

function clampRange(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
