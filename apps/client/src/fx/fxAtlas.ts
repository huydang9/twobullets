import { DynamicTexture, Texture, type Scene } from "@babylonjs/core";

export const ATLAS_COLUMNS = 4;
export const ATLAS_ROWS = 2;
const CELL = 128;

/** Cell indices into the effects atlas (row-major, top-left first). Shapes are white; color comes per instance. */
export const FxCell = {
  glow: 0,
  /** Soft line along U (for tracers and streak sparks). */
  streak: 1,
  ring: 2,
  star: 3,
  hole: 4,
  puff: 5,
  spark: 6,
  /** Flame tongue: wide at U = 0, tapering toward U = 1. */
  flame: 7,
} as const;
export type FxCell = (typeof FxCell)[keyof typeof FxCell];

type Ctx = CanvasRenderingContext2D;

/** Builds the 4 × 2 procedural sprite atlas once; only alpha is meaningful. */
export function createFxAtlas(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture(
    "fx_atlas",
    { width: CELL * ATLAS_COLUMNS, height: CELL * ATLAS_ROWS },
    scene,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  const ctx = texture.getContext() as Ctx;
  ctx.clearRect(0, 0, CELL * ATLAS_COLUMNS, CELL * ATLAS_ROWS);
  const draw: Record<FxCell, (c: Ctx) => void> = {
    [FxCell.glow]: drawGlow,
    [FxCell.streak]: drawStreak,
    [FxCell.ring]: drawRing,
    [FxCell.star]: drawStar,
    [FxCell.hole]: drawHole,
    [FxCell.puff]: drawPuff,
    [FxCell.spark]: drawSpark,
    [FxCell.flame]: drawFlame,
  };
  for (const [cell, painter] of Object.entries(draw)) {
    const index = Number(cell);
    ctx.save();
    ctx.translate((index % ATLAS_COLUMNS) * CELL, Math.floor(index / ATLAS_COLUMNS) * CELL);
    ctx.beginPath();
    ctx.rect(0, 0, CELL, CELL);
    ctx.clip();
    painter(ctx);
    ctx.restore();
  }
  // No Y flip: canvas row 0 is V = 0, which the batch shader's cell math assumes.
  texture.update(false);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.hasAlpha = true;
  return texture;
}

const H = CELL / 2;

function radial(ctx: Ctx, stops: readonly (readonly [number, number])[], radius = H - 2): void {
  const gradient = ctx.createRadialGradient(H, H, 0, H, H, radius);
  for (const [at, alpha] of stops) gradient.addColorStop(at, `rgba(255,255,255,${alpha})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, CELL, CELL);
}

function drawGlow(ctx: Ctx): void {
  radial(ctx, [
    [0, 1],
    [0.25, 0.75],
    [0.6, 0.22],
    [1, 0],
  ]);
}

function drawStreak(ctx: Ctx): void {
  const across = ctx.createLinearGradient(0, 0, 0, CELL);
  across.addColorStop(0, "rgba(255,255,255,0)");
  across.addColorStop(0.3, "rgba(255,255,255,0.35)");
  across.addColorStop(0.5, "rgba(255,255,255,1)");
  across.addColorStop(0.7, "rgba(255,255,255,0.35)");
  across.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = across;
  ctx.fillRect(4, 0, CELL - 8, CELL);
  // Soften both ends so short streaks don't look boxy.
  ctx.globalCompositeOperation = "destination-out";
  const ends = ctx.createLinearGradient(0, 0, CELL, 0);
  ends.addColorStop(0, "rgba(0,0,0,1)");
  ends.addColorStop(0.08, "rgba(0,0,0,0)");
  ends.addColorStop(0.92, "rgba(0,0,0,0)");
  ends.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = ends;
  ctx.fillRect(0, 0, CELL, CELL);
  ctx.globalCompositeOperation = "source-over";
}

function drawRing(ctx: Ctx): void {
  radial(ctx, [
    [0, 0],
    [0.62, 0],
    [0.8, 1],
    [0.9, 0.5],
    [1, 0],
  ]);
}

function drawStar(ctx: Ctx): void {
  radial(ctx, [
    [0, 1],
    [0.18, 0.8],
    [0.4, 0.1],
    [1, 0],
  ]);
  ctx.fillStyle = "rgba(255,255,255,1)";
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const long = i % 2 === 0 ? H - 4 : H * 0.7;
    ctx.beginPath();
    ctx.moveTo(H + Math.cos(angle) * long, H + Math.sin(angle) * long);
    ctx.lineTo(H + Math.cos(angle + 0.5) * 9, H + Math.sin(angle + 0.5) * 9);
    ctx.lineTo(H + Math.cos(angle - 0.5) * 9, H + Math.sin(angle - 0.5) * 9);
    ctx.closePath();
    ctx.fill();
  }
}

function drawHole(ctx: Ctx): void {
  radial(ctx, [
    [0, 1],
    [0.28, 1],
    [0.42, 0.55],
    [0.7, 0.18],
    [1, 0],
  ]);
  // A few chunky chips around the hole.
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + (i % 2) * 0.35;
    ctx.beginPath();
    ctx.moveTo(H + Math.cos(angle) * 44, H + Math.sin(angle) * 44);
    ctx.lineTo(H + Math.cos(angle + 0.22) * 16, H + Math.sin(angle + 0.22) * 16);
    ctx.lineTo(H + Math.cos(angle - 0.22) * 16, H + Math.sin(angle - 0.22) * 16);
    ctx.closePath();
    ctx.fill();
  }
}

function drawPuff(ctx: Ctx): void {
  const blobs: readonly (readonly [number, number, number])[] = [
    [H, H, 40],
    [H - 20, H + 8, 26],
    [H + 22, H + 6, 28],
    [H + 4, H - 20, 26],
  ];
  for (const [x, y, r] of blobs) {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, "rgba(255,255,255,0.55)");
    gradient.addColorStop(0.7, "rgba(255,255,255,0.3)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, CELL, CELL);
  }
}

function drawSpark(ctx: Ctx): void {
  radial(ctx, [
    [0, 1],
    [0.35, 1],
    [0.5, 0.4],
    [1, 0],
  ], H * 0.6);
}

function drawFlame(ctx: Ctx): void {
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.filter = "blur(6px)";
  ctx.beginPath();
  ctx.moveTo(8, H);
  ctx.quadraticCurveTo(CELL * 0.3, H - 34, CELL - 10, H);
  ctx.quadraticCurveTo(CELL * 0.3, H + 34, 8, H);
  ctx.fill();
  ctx.filter = "none";
}
