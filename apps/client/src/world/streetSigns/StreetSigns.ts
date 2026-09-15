import { DynamicTexture, Mesh, PBRMaterial, Texture, VertexBuffer, VertexData, type Scene, type Vector3 } from "@babylonjs/core";
import { planStreetSigns, type MapData, type MapLayout, type StreetSign, type Terrain } from "@twobullets/shared";
import type { Environment } from "../environment";

/** Signs show within this camera distance and hide past `HIDE_DISTANCE` (hysteresis), m. */
const SHOW_DISTANCE = 120;
const HIDE_DISTANCE = 124;
/** The camera moves this far before visibility is re-checked, m. */
const RECHECK_MOVE = 1;

/** Street blade: 4:1 like its atlas cell, m. */
const BLADE = { width: 1.1, height: 0.275, thickness: 0.025 };
/** Facade name board, m; its center stands this high above the building floor. */
const FACADE = { width: 2.8, height: 0.7, thickness: 0.05, lift: 2.6 };
const POLE = { radius: 0.038, sides: 6, below: 0.3 };
/** Blade center heights above the pole foot, top blade first, m. */
const BLADE_HEIGHTS = [3, 2.66] as const;

/** Atlas: 512 × 128 cells, two columns; the last cell holds the plain blue and pole grey swatches. */
const CELL_W = 512;
const CELL_H = 128;
const COLUMNS = 2;
const BLUE = "rgb(18, 76, 158)";
const WHITE = "rgb(238, 240, 242)";
const GREY = "rgb(140, 143, 146)";
/** Fonts with full Vietnamese coverage on every desktop OS; the first one present wins. */
const SIGN_FONT = 'Arial, "Helvetica Neue", Helvetica, Roboto, "Noto Sans", "Segoe UI", sans-serif';

interface Uv {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/**
 * Street name signs in the world (real-world maps): Vietnamese-style blue blades with white names on thin poles at
 * labeled road crossings and along long roads, plus landmark name boards on facades (`planStreetSigns`). Everything is one
 * merged mesh with a canvas-baked name atlas: one material, one draw call. Signs beyond ~120 m are hidden by collapsing
 * their vertices onto a visible sign's point (rewritten only when the visible set changes), so the mesh bounds and
 * frustum culling follow the nearby signs. No colliders.
 */
export class StreetSigns {
  readonly signs: readonly StreetSign[];
  private readonly visible: Uint8Array;
  private lastX = Infinity;
  private lastZ = Infinity;
  private visibleCount = 0;

  private constructor(
    private readonly mesh: Mesh | null,
    private readonly material: PBRMaterial | null,
    private readonly texture: DynamicTexture | null,
    signs: readonly StreetSign[],
    /** Sign pivot XZ, two per sign. */
    private readonly pivots: Float32Array,
    /** First vertex of each sign, plus the total at the end. */
    private readonly ranges: Uint32Array,
    private readonly full: Float32Array,
    private readonly live: Float32Array,
  ) {
    this.signs = signs;
    this.visible = new Uint8Array(signs.length);
  }

  static create(scene: Scene, environment: Environment, map: MapData, layout: MapLayout, terrain: Terrain): StreetSigns {
    const signs = planStreetSigns(map, layout.buildings);
    if (signs.length === 0) return new StreetSigns(null, null, null, signs, new Float32Array(0), new Uint32Array(1), new Float32Array(0), new Float32Array(0));

    const names = [...new Set(signs.flatMap((s) => s.blades.map((b) => b.name)))];
    const { texture, cells, blue, grey } = createAtlas(scene, names);
    const floors = new Map(layout.buildings.map((b) => [b.id, b.position[1]] as const));
    const builder = new Builder();
    const pivots = new Float32Array(signs.length * 2);
    const ranges = new Uint32Array(signs.length + 1);
    signs.forEach((sign, i) => {
      ranges[i] = builder.vertexCount;
      const [x, z] = sign.position;
      pivots[i * 2] = x;
      pivots[i * 2 + 1] = z;
      if (sign.kind === "facade") {
        const blade = sign.blades[0]!;
        const y = (floors.get(sign.building ?? "") ?? terrain.sampleHeight(x, z)) + FACADE.lift;
        builder.board(x, y, z, blade.dir[0], blade.dir[1], FACADE.width / 2, FACADE.height / 2, FACADE.thickness / 2, cells.get(blade.name)!, blue);
        return;
      }
      const ground = terrain.sampleHeight(x, z);
      const top = BLADE_HEIGHTS[0] + BLADE.height / 2 + 0.03;
      builder.pole(x, ground - POLE.below, z, POLE.below + top, grey);
      sign.blades.forEach((blade, k) => {
        const [dx, dz] = blade.dir;
        // Mounted beside the pole, on the blade's own normal side, so the pole never crosses the name.
        const out = POLE.radius + BLADE.thickness / 2 + 0.004;
        builder.board(x + dz * out, ground + BLADE_HEIGHTS[Math.min(k, BLADE_HEIGHTS.length - 1)]!, z - dx * out, dx, dz, BLADE.width / 2, BLADE.height / 2, BLADE.thickness / 2, cells.get(blade.name)!, blue);
      });
    });
    ranges[signs.length] = builder.vertexCount;

    const mesh = new Mesh("streetSigns", scene);
    const data = new VertexData();
    const full = new Float32Array(builder.positions);
    const live = new Float32Array(full);
    data.positions = live;
    data.normals = builder.normals;
    data.uvs = builder.uvs;
    data.indices = builder.indices;
    data.applyToMesh(mesh, true);
    mesh.isPickable = false;
    mesh.receiveShadows = true;

    const material = new PBRMaterial("mat_streetSigns", scene);
    material.albedoTexture = texture;
    material.metallic = 0;
    material.roughness = 0.55;
    material.backFaceCulling = false;
    mesh.material = material;
    environment.skyFill.excludedMeshes.push(mesh);
    mesh.setEnabled(false);
    return new StreetSigns(mesh, material, texture, signs, pivots, ranges, full, live);
  }

  /** Shows the signs near the camera. Allocation-free; the vertex buffer is rewritten only when the visible set changes. */
  update(camera: Vector3): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const mx = camera.x - this.lastX;
    const mz = camera.z - this.lastZ;
    if (mx * mx + mz * mz < RECHECK_MOVE * RECHECK_MOVE) return;
    this.lastX = camera.x;
    this.lastZ = camera.z;

    let changed = false;
    let count = 0;
    let anchor = -1;
    for (let i = 0; i < this.visible.length; i++) {
      const dx = this.pivots[i * 2]! - camera.x;
      const dz = this.pivots[i * 2 + 1]! - camera.z;
      const limit = this.visible[i] ? HIDE_DISTANCE : SHOW_DISTANCE;
      const show = dx * dx + dz * dz < limit * limit ? 1 : 0;
      if (show !== this.visible[i]) {
        this.visible[i] = show;
        changed = true;
      }
      if (show) {
        count++;
        if (anchor < 0) anchor = i;
      }
    }
    if (!changed) return;
    this.visibleCount = count;
    if (count === 0) {
      mesh.setEnabled(false);
      return;
    }
    const { full, live, ranges } = this;
    const ax = full[ranges[anchor]! * 3]!;
    const ay = full[ranges[anchor]! * 3 + 1]!;
    const az = full[ranges[anchor]! * 3 + 2]!;
    for (let i = 0; i < this.visible.length; i++) {
      const from = ranges[i]! * 3;
      const to = ranges[i + 1]! * 3;
      if (this.visible[i]) for (let p = from; p < to; p++) live[p] = full[p]!;
      else
        for (let p = from; p < to; p += 3) {
          live[p] = ax;
          live[p + 1] = ay;
          live[p + 2] = az;
        }
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, live, true);
    mesh.setEnabled(true);
  }

  stats(): { signs: number; visible: number; drawCalls: number } {
    return { signs: this.signs.length, visible: this.visibleCount, drawCalls: this.mesh?.isEnabled() ? 1 : 0 };
  }

  dispose(): void {
    this.mesh?.dispose();
    this.material?.dispose();
    this.texture?.dispose();
  }
}

/** Names baked once at load: blue plate, thin white border, the name in white capitals squeezed to fit. */
function createAtlas(scene: Scene, names: readonly string[]): { texture: DynamicTexture; cells: Map<string, Uv>; blue: Uv; grey: Uv } {
  const rows = Math.ceil((names.length + 1) / COLUMNS);
  const width = CELL_W * COLUMNS;
  let height = 1;
  while (height < rows * CELL_H) height *= 2;
  const texture = new DynamicTexture("streetSignAtlas", { width, height }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 8;
  texture.hasAlpha = false;
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = BLUE;
  ctx.fillRect(0, 0, width, height);

  const cellUv = (index: number, x0 = 0, x1 = CELL_W, inset = 1.5): Uv => {
    const left = (index % COLUMNS) * CELL_W;
    const top = Math.floor(index / COLUMNS) * CELL_H;
    return { u0: (left + x0 + inset) / width, u1: (left + x1 - inset) / width, v0: 1 - (top + CELL_H - inset) / height, v1: 1 - (top + inset) / height };
  };
  const cells = new Map<string, Uv>();
  names.forEach((name, index) => {
    const left = (index % COLUMNS) * CELL_W;
    const top = Math.floor(index / COLUMNS) * CELL_H;
    ctx.fillStyle = BLUE;
    ctx.fillRect(left, top, CELL_W, CELL_H);
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 5;
    ctx.strokeRect(left + 9.5, top + 9.5, CELL_W - 19, CELL_H - 19);

    const text = name.toLocaleUpperCase("vi");
    let fontPx = 54;
    ctx.font = `700 ${fontPx}px ${SIGN_FONT}`;
    const available = CELL_W - 48;
    let measured = ctx.measureText(text);
    // Squeeze long names horizontally down to 60 %, then shrink the type.
    if (measured.width * 0.6 > available) {
      fontPx = Math.max(26, Math.floor((fontPx * available) / (measured.width * 0.6)));
      ctx.font = `700 ${fontPx}px ${SIGN_FONT}`;
      measured = ctx.measureText(text);
    }
    const squeeze = Math.min(1, available / measured.width);
    const ascent = measured.actualBoundingBoxAscent || fontPx * 0.9;
    const descent = measured.actualBoundingBoxDescent || fontPx * 0.2;
    ctx.save();
    ctx.translate(left + CELL_W / 2, top + CELL_H / 2 + (ascent - descent) / 2);
    ctx.scale(squeeze, 1);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = WHITE;
    ctx.fillText(text, 0, 0);
    ctx.restore();
    cells.set(name, cellUv(index));
  });
  const swatch = names.length;
  const left = (swatch % COLUMNS) * CELL_W;
  const top = Math.floor(swatch / COLUMNS) * CELL_H;
  ctx.fillStyle = GREY;
  ctx.fillRect(left + CELL_W / 2, top, CELL_W / 2, CELL_H);
  texture.update();
  const blue = cellUv(swatch, 16, CELL_W / 2 - 16, 0);
  const grey = cellUv(swatch, CELL_W / 2 + 16, CELL_W - 16, 0);
  return { texture, cells, blue: centerOf(blue), grey: centerOf(grey) };
}

/** A swatch sampled at its middle only (no mip bleed from the neighbouring cells). */
function centerOf(uv: Uv): Uv {
  const u = (uv.u0 + uv.u1) / 2;
  const v = (uv.v0 + uv.v1) / 2;
  return { u0: u, u1: u, v0: v, v1: v };
}

class Builder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Quad from four corners in order (a, b, c, d), all with one normal and UVs (u0,v0) (u1,v0) (u1,v1) (u0,v1). */
  private quad(corners: readonly (readonly number[])[], normal: readonly number[], uv: Uv): void {
    const base = this.vertexCount;
    const uvList = [uv.u0, uv.v0, uv.u1, uv.v0, uv.u1, uv.v1, uv.u0, uv.v1];
    for (let i = 0; i < 4; i++) {
      const c = corners[i]!;
      this.positions.push(c[0]!, c[1]!, c[2]!);
      this.normals.push(normal[0]!, normal[1]!, normal[2]!);
      this.uvs.push(uvList[i * 2]!, uvList[i * 2 + 1]!);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * A board centered at (x, y, z) whose width runs along (dx, dz). The name reads correctly on both faces: a viewer on
   * the normal side (dz, -dx) has +dir on their right, one on the other side has -dir.
   */
  board(x: number, y: number, z: number, dx: number, dz: number, hw: number, hh: number, ht: number, name: Uv, edge: Uv): void {
    const nx = dz;
    const nz = -dx;
    const at = (w: number, h: number, t: number) => [x + dx * w + nx * t, y + h, z + dz * w + nz * t];
    // Front (normal side): left edge at -dir.
    this.quad([at(-hw, -hh, ht), at(hw, -hh, ht), at(hw, hh, ht), at(-hw, hh, ht)], [nx, 0, nz], name);
    // Back: left edge at +dir.
    this.quad([at(hw, -hh, -ht), at(-hw, -hh, -ht), at(-hw, hh, -ht), at(hw, hh, -ht)], [-nx, 0, -nz], name);
    this.quad([at(-hw, hh, ht), at(hw, hh, ht), at(hw, hh, -ht), at(-hw, hh, -ht)], [0, 1, 0], edge);
    this.quad([at(-hw, -hh, -ht), at(hw, -hh, -ht), at(hw, -hh, ht), at(-hw, -hh, ht)], [0, -1, 0], edge);
    this.quad([at(hw, -hh, ht), at(hw, -hh, -ht), at(hw, hh, -ht), at(hw, hh, ht)], [dx, 0, dz], edge);
    this.quad([at(-hw, -hh, -ht), at(-hw, -hh, ht), at(-hw, hh, ht), at(-hw, hh, -ht)], [-dx, 0, -dz], edge);
  }

  /** Flat-shaded prism from (x, y0, z) up `height` m, with a top cap. */
  pole(x: number, y0: number, z: number, height: number, uv: Uv): void {
    const r = POLE.radius;
    const y1 = y0 + height;
    for (let i = 0; i < POLE.sides; i++) {
      const a0 = (i / POLE.sides) * Math.PI * 2;
      const a1 = ((i + 1) / POLE.sides) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const p0 = [x + Math.cos(a0) * r, z + Math.sin(a0) * r];
      const p1 = [x + Math.cos(a1) * r, z + Math.sin(a1) * r];
      this.quad(
        [
          [p0[0]!, y0, p0[1]!],
          [p1[0]!, y0, p1[1]!],
          [p1[0]!, y1, p1[1]!],
          [p0[0]!, y1, p0[1]!],
        ],
        [Math.cos(am), 0, Math.sin(am)],
        uv,
      );
      const base = this.vertexCount;
      this.positions.push(x, y1, z, p1[0]!, y1, p1[1]!, p0[0]!, y1, p0[1]!);
      this.normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      this.uvs.push(uv.u0, uv.v0, uv.u0, uv.v0, uv.u0, uv.v0);
      this.indices.push(base, base + 1, base + 2);
    }
  }
}
