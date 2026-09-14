import { DynamicTexture, Texture, type Scene } from "@babylonjs/core";

export const BLOOD_ATLAS_COLUMNS = 4;
export const BLOOD_ATLAS_ROWS = 2;
const CELL = 256;
const H = CELL / 2;

/**
 * Cells of the blood atlas. Unlike the glow atlas, RGB carries shading (thick blood darker, thin spray lighter) and
 * is multiplied with the instance color (FxBatch `textureColor`).
 */
export const BloodCell = {
  mist: 0,
  /** Droplet streak along U, head at U = 1. */
  droplet: 1,
  /** Round impact spatter with satellites, for walls behind a hit. */
  spatter: 2,
  /** Directional spray cone travelling toward +U. */
  spray: 3,
  /** Heavier cluster of blots. */
  cluster: 4,
  /** Single drop landed on the ground. */
  splat: 5,
  pool: 6,
  wound: 7,
} as const;
export type BloodCell = (typeof BloodCell)[keyof typeof BloodCell];

type Ctx = CanvasRenderingContext2D;
type Rng = () => number;

/** Paints the 4 × 2 blood atlas (256 px cells, mipmapped) once, from a fixed seed so every session looks the same. */
export function createBloodAtlas(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture(
    "fx_bloodAtlas",
    { width: CELL * BLOOD_ATLAS_COLUMNS, height: CELL * BLOOD_ATLAS_ROWS },
    scene,
    true,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  const ctx = texture.getContext() as Ctx;
  ctx.clearRect(0, 0, CELL * BLOOD_ATLAS_COLUMNS, CELL * BLOOD_ATLAS_ROWS);
  const painters: Record<BloodCell, (c: Ctx, rng: Rng) => void> = {
    [BloodCell.mist]: drawMist,
    [BloodCell.droplet]: drawDroplet,
    [BloodCell.spatter]: drawSpatter,
    [BloodCell.spray]: drawSpray,
    [BloodCell.cluster]: drawCluster,
    [BloodCell.splat]: drawSplat,
    [BloodCell.pool]: drawPool,
    [BloodCell.wound]: drawWound,
  };
  for (const [key, paint] of Object.entries(painters)) {
    const index = Number(key);
    ctx.save();
    ctx.translate((index % BLOOD_ATLAS_COLUMNS) * CELL, Math.floor(index / BLOOD_ATLAS_COLUMNS) * CELL);
    ctx.beginPath();
    // A transparent margin keeps mip levels from bleeding between cells.
    ctx.rect(4, 4, CELL - 8, CELL - 8);
    ctx.clip();
    paint(ctx, mulberry32(0xb100d + index * 7919));
    ctx.restore();
  }
  // No Y flip: canvas row 0 is V = 0, which the batch shader's cell math assumes.
  texture.update(false);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.hasAlpha = true;
  return texture;
}

// --- Painters (coordinates in cell pixels; shade 1 = the instance color, lower = darker) ------------------------------

function drawMist(ctx: Ctx, rng: Rng): void {
  for (let i = 0; i < 9; i++) {
    const angle = rng() * Math.PI * 2;
    const distance = rng() * H * 0.38;
    const x = H + Math.cos(angle) * distance;
    const y = H + Math.sin(angle) * distance;
    const radius = H * (0.32 + rng() * 0.3);
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    const shade = 0.85 + rng() * 0.15;
    g.addColorStop(0, gray(shade, 0.34));
    g.addColorStop(0.55, gray(shade, 0.16));
    g.addColorStop(1, gray(shade, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CELL, CELL);
  }
  // Fine specks inside the cloud break up the soft gradient.
  for (let i = 0; i < 140; i++) {
    const angle = rng() * Math.PI * 2;
    const distance = Math.sqrt(rng()) * H * 0.7;
    dot(ctx, H + Math.cos(angle) * distance, H + Math.sin(angle) * distance, 0.8 + rng() * 1.6, 0.75, 0.25 + rng() * 0.35);
  }
}

function drawDroplet(ctx: Ctx): void {
  const tail = 12;
  const radius = 30;
  const head = CELL - 8 - radius;
  const g = ctx.createLinearGradient(tail, 0, head, 0);
  g.addColorStop(0, gray(1, 0));
  g.addColorStop(0.6, gray(0.95, 0.55));
  g.addColorStop(1, gray(0.8, 1));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(tail, H);
  ctx.quadraticCurveTo(head * 0.7, H - radius * 0.75, head, H - radius);
  ctx.arc(head, H, radius, -Math.PI / 2, Math.PI / 2);
  ctx.quadraticCurveTo(head * 0.7, H + radius * 0.75, tail, H);
  ctx.fill();
}

function drawSpatter(ctx: Ctx, rng: Rng): void {
  const core = H * 0.28;
  // Satellites thin out and shrink with distance; the core paints over the innermost.
  for (let i = 0; i < 260; i++) {
    const angle = rng() * Math.PI * 2;
    // Stays inside ~0.9 of the cell so no drop is cut by the cell border.
    const distance = core * (0.9 + Math.pow(rng(), 1.8) * 2.3);
    const falloff = Math.max(0, 1 - (distance - core) / (core * 2.4));
    dot(ctx, H + Math.cos(angle) * distance, H + Math.sin(angle) * distance, 0.6 + rng() * 2.6 * falloff, 0.75 + rng() * 0.25, 0.5 + rng() * 0.5);
  }
  for (let i = 0; i < 8; i++) {
    const angle = rng() * Math.PI * 2;
    const from = core * (0.8 + rng() * 0.2);
    tear(ctx, H, H, angle, from, from + core * (0.3 + rng() * 1.1), 1.2 + rng() * 2.2, 0.7);
  }
  for (let i = 0; i < 4; i++) {
    const angle = rng() * Math.PI * 2;
    const distance = core * (0.55 + rng() * 0.35);
    blot(ctx, rng, H + Math.cos(angle) * distance, H + Math.sin(angle) * distance, core * (0.25 + rng() * 0.2), 0.5, 0.62);
  }
  blot(ctx, rng, H, H, core, 0.45, 0.6);
  blot(ctx, rng, H + (rng() - 0.5) * core * 0.3, H + (rng() - 0.5) * core * 0.3, core * 0.5, 0.5, 0.52);
}

function drawSpray(ctx: Ctx, rng: Rng): void {
  const originX = CELL * 0.14;
  // Drops fly toward +U and stretch along their path; farther ones are smaller.
  for (let i = 0; i < 180; i++) {
    const spread = (rng() - 0.5) * (rng() < 0.7 ? 0.55 : 1.1);
    const reach = Math.pow(rng(), 0.8) * CELL * 0.8;
    const x = originX + Math.cos(spread) * reach;
    const y = H + Math.sin(spread) * reach;
    const size = (1 - reach / (CELL * 0.85)) * 3.2 + 0.6;
    if (rng() < 0.3) tear(ctx, originX, H, spread, reach - size * (3 + rng() * 5), reach, size, 0.8 + rng() * 0.2);
    else dot(ctx, x, y, size * (0.5 + rng() * 0.6), 0.8 + rng() * 0.2, 0.6 + rng() * 0.4);
  }
  for (let i = 0; i < 7; i++) {
    const spread = (rng() - 0.5) * 0.45;
    const from = H * 0.12;
    tear(ctx, originX, H, spread, from, from + H * (0.3 + rng() * 0.6), 2 + rng() * 3, 0.65);
  }
  blot(ctx, rng, originX + H * 0.14, H, H * 0.16, 0.45, 0.55);
}

function drawCluster(ctx: Ctx, rng: Rng): void {
  for (let i = 0; i < 140; i++) {
    const angle = rng() * Math.PI * 2;
    const distance = H * (0.22 + Math.pow(rng(), 1.4) * 0.7);
    dot(ctx, H + Math.cos(angle) * distance, H + Math.sin(angle) * distance, 0.6 + rng() * 2.2, 0.8, 0.5 + rng() * 0.5);
  }
  for (let i = 0; i < 5; i++) {
    const angle = rng() * Math.PI * 2;
    tear(ctx, H, H, angle, H * 0.28, H * (0.4 + rng() * 0.35), 1.2 + rng() * 2, 0.72);
  }
  for (let i = 0; i < 6; i++) {
    const angle = rng() * Math.PI * 2;
    const distance = rng() * H * 0.38;
    blot(ctx, rng, H + Math.cos(angle) * distance, H + Math.sin(angle) * distance, H * (0.07 + rng() * 0.13), 0.5, 0.5 + rng() * 0.2);
  }
}

function drawSplat(ctx: Ctx, rng: Rng): void {
  const radius = H * 0.32;
  for (let i = 0; i < 22; i++) {
    const angle = rng() * Math.PI * 2;
    const distance = radius * (1.3 + Math.pow(rng(), 1.5) * 1.6);
    dot(ctx, H + Math.cos(angle) * distance, H + Math.sin(angle) * distance, 0.8 + rng() * 2.6, 0.8, 0.85);
  }
  for (let i = 0; i < 6; i++) {
    const angle = rng() * Math.PI * 2;
    tear(ctx, H, H, angle, radius * 0.85, radius * (1.2 + rng() * 0.45), 1.5 + rng() * 2, 0.62);
  }
  // Scalloped rim where the drop's crown fell back.
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2 + rng() * 0.25;
    const at = radius * (0.92 + rng() * 0.12);
    dot(ctx, H + Math.cos(angle) * at, H + Math.sin(angle) * at, radius * (0.05 + rng() * 0.07), 0.6, 1);
  }
  blot(ctx, rng, H, H, radius, 0.2, 0.55);
}

function drawPool(ctx: Ctx, rng: Rng): void {
  const phases = [rng() * 6.28, rng() * 6.28, rng() * 6.28, rng() * 6.28];
  const outline = (scale: number) => {
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const wobble =
        1 + 0.13 * Math.sin(3 * a + phases[0]!) + 0.08 * Math.sin(5 * a + phases[1]!) + 0.05 * Math.sin(8 * a + phases[2]!) + 0.025 * Math.sin(15 * a + phases[3]!);
      const r = H * 0.72 * scale * wobble;
      if (i === 0) ctx.moveTo(H + Math.cos(a) * r, H + Math.sin(a) * r);
      else ctx.lineTo(H + Math.cos(a) * r, H + Math.sin(a) * r);
    }
    ctx.closePath();
  };
  // Darker, drying rim, then the wet body, slightly thinner (lighter) toward its edge.
  outline(1);
  ctx.fillStyle = gray(0.5, 0.92);
  ctx.fill();
  const body = ctx.createRadialGradient(H, H, 0, H, H, H * 0.8);
  body.addColorStop(0, gray(0.58, 1));
  body.addColorStop(0.7, gray(0.72, 1));
  body.addColorStop(1, gray(0.84, 1));
  outline(0.95);
  ctx.fillStyle = body;
  ctx.fill();
  // Uneven depth: a few soft darker patches.
  for (let i = 0; i < 5; i++) {
    const angle = rng() * Math.PI * 2;
    const distance = rng() * H * 0.4;
    const x = H + Math.cos(angle) * distance;
    const y = H + Math.sin(angle) * distance;
    const g = ctx.createRadialGradient(x, y, 0, x, y, H * (0.15 + rng() * 0.2));
    g.addColorStop(0, gray(0.45, 0.5));
    g.addColorStop(1, gray(0.45, 0));
    ctx.fillStyle = g;
    outline(0.93);
    ctx.fill();
  }
}

function drawWound(ctx: Ctx, rng: Rng): void {
  for (let i = 0; i < 50; i++) {
    const angle = rng() * Math.PI * 2;
    const distance = H * (0.35 + Math.pow(rng(), 1.5) * 0.5);
    dot(ctx, H + Math.cos(angle) * distance, H + Math.sin(angle) * distance, 0.8 + rng() * 2.4, 0.8, 0.4 + rng() * 0.4);
  }
  // Blood soaked into the fabric around the hole, then the wet stain and the dark entry.
  const soak = ctx.createRadialGradient(H, H, 0, H, H, H * 0.66);
  soak.addColorStop(0, gray(0.7, 0.9));
  soak.addColorStop(0.55, gray(0.8, 0.55));
  soak.addColorStop(1, gray(0.9, 0));
  ctx.fillStyle = soak;
  ctx.fillRect(0, 0, CELL, CELL);
  blot(ctx, rng, H, H, H * 0.3, 0.55, 0.5, false);
  blot(ctx, rng, H + (rng() - 0.5) * 6, H + (rng() - 0.5) * 6, H * 0.11, 0.5, 0.14, false);
}

// --- Shapes ------------------------------------------------------------------------------------------------------------

function gray(shade: number, alpha: number): string {
  const v = Math.round(Math.min(1, Math.max(0, shade)) * 255);
  return `rgba(${v},${v},${v},${alpha.toFixed(3)})`;
}

function dot(ctx: Ctx, x: number, y: number, radius: number, shade: number, alpha: number): void {
  ctx.fillStyle = gray(shade, alpha);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** Irregular liquid blob (a few low-frequency waves on the radius), optionally with a thinner, lighter rim. */
function blot(ctx: Ctx, rng: Rng, x: number, y: number, radius: number, roughness: number, shade: number, rim = true): void {
  const k1 = 2 + Math.floor(rng() * 2);
  const k2 = 5 + Math.floor(rng() * 2);
  const k3 = 9 + Math.floor(rng() * 5);
  const p1 = rng() * 6.28;
  const p2 = rng() * 6.28;
  const p3 = rng() * 6.28;
  const path = (scale: number) => {
    ctx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const wave = 0.5 * Math.sin(k1 * a + p1) + 0.3 * Math.sin(k2 * a + p2) + 0.2 * Math.sin(k3 * a + p3);
      const r = radius * scale * (1 + roughness * 0.5 * wave);
      if (i === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
  };
  if (rim) {
    path(1.06);
    ctx.fillStyle = gray(Math.min(1, shade + 0.12), 0.45);
    ctx.fill();
  }
  path(1);
  ctx.fillStyle = gray(shade, 1);
  ctx.fill();
}

/** Tapered drop moving outward along `angle` from (cx, cy): thin tail at `from`, round head at `to`. */
function tear(ctx: Ctx, cx: number, cy: number, angle: number, from: number, to: number, width: number, shade: number): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hx = cx + cos * to;
  const hy = cy + sin * to;
  const tx = cx + cos * from;
  const ty = cy + sin * from;
  const nx = -sin * width;
  const ny = cos * width;
  ctx.fillStyle = gray(shade, 0.95);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.quadraticCurveTo((tx + hx) / 2 + nx * 0.5, (ty + hy) / 2 + ny * 0.5, hx + nx, hy + ny);
  ctx.arc(hx, hy, width, angle + Math.PI / 2, angle - Math.PI / 2, true);
  ctx.quadraticCurveTo((tx + hx) / 2 - nx * 0.5, (ty + hy) / 2 - ny * 0.5, tx, ty);
  ctx.fill();
}

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
