import { Mesh, VertexData, type Material, type Scene } from "@babylonjs/core";
import { getMapProp, hash2, type PropCategory } from "@twobullets/shared";

/**
 * Procedural low-poly stand-ins for props without a ready environment asset: faceted, vertex-coloured, one mesh per
 * LOD. Shapes follow the category (cone firs, blob broadleaves and bushes, jittered rocks, post-and-rail fences) and
 * the sizes of the environment manifest, so layout and silhouettes read correctly before real models land.
 */

type Color = readonly [number, number, number];

const C = {
  bark: [0.2, 0.13, 0.08],
  fir: [0.07, 0.17, 0.08],
  firLight: [0.1, 0.22, 0.09],
  leaf: [0.14, 0.25, 0.08],
  leafLight: [0.2, 0.3, 0.1],
  bush: [0.16, 0.26, 0.09],
  grass: [0.26, 0.36, 0.12],
  grassTip: [0.42, 0.45, 0.2],
  rock: [0.33, 0.32, 0.3],
  moss: [0.22, 0.27, 0.15],
  concrete: [0.5, 0.49, 0.46],
  wood: [0.32, 0.22, 0.13],
  metal: [0.25, 0.27, 0.25],
  olive: [0.2, 0.23, 0.13],
  rust: [0.33, 0.16, 0.08],
  car: [0.24, 0.22, 0.2],
  hay: [0.62, 0.5, 0.24],
  sand: [0.45, 0.39, 0.27],
} as const satisfies Record<string, Color>;

class Builder {
  readonly positions: number[] = [];
  readonly colors: number[] = [];

  /** Flat-shaded triangle; `twoSided` adds the reversed face. */
  tri(a: readonly number[], b: readonly number[], c: readonly number[], color: Color, twoSided = false): void {
    for (const p of [a, b, c]) this.positions.push(p[0]!, p[1]!, p[2]!);
    for (let i = 0; i < 3; i++) this.colors.push(color[0], color[1], color[2], 1);
    if (twoSided) this.tri(a, c, b, color);
  }

  quad(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[], color: Color): void {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  box(min: readonly number[], max: readonly number[], color: Color): void {
    const [x0, y0, z0] = min as [number, number, number];
    const [x1, y1, z1] = max as [number, number, number];
    const p = (x: number, y: number, z: number) => [x, y, z];
    // Left-handed winding (Babylon): counter-clockwise seen from outside is back-facing, so faces run clockwise.
    this.quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), color);
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), color);
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), color);
    this.quad(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0), color);
    this.quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1), color);
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), color);
  }

  /** Frustum around the Y axis (a cone when `top` is 0). */
  frustum(y0: number, y1: number, bottom: number, top: number, sides: number, color: Color, phase = 0): void {
    for (let i = 0; i < sides; i++) {
      const a0 = phase + (i / sides) * Math.PI * 2;
      const a1 = phase + ((i + 1) / sides) * Math.PI * 2;
      const b0 = [Math.cos(a0) * bottom, y0, Math.sin(a0) * bottom];
      const b1 = [Math.cos(a1) * bottom, y0, Math.sin(a1) * bottom];
      const t0 = [Math.cos(a0) * top, y1, Math.sin(a0) * top];
      const t1 = [Math.cos(a1) * top, y1, Math.sin(a1) * top];
      if (top > 0) this.quad(b0, t0, t1, b1, color);
      else this.tri(b0, [0, y1, 0], b1, color);
      this.tri(b0, b1, [0, y0, 0], color);
    }
  }

  /** Horizontal cylinder along X. */
  log(length: number, radius: number, y: number, sides: number, color: Color): void {
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const p = (x: number, a: number) => [x, y + Math.sin(a) * radius, Math.cos(a) * radius];
      this.quad(p(-length / 2, a0), p(length / 2, a0), p(length / 2, a1), p(-length / 2, a1), color);
      this.tri(p(length / 2, a0), [length / 2, y, 0], p(length / 2, a1), color);
      this.tri(p(-length / 2, a1), [-length / 2, y, 0], p(-length / 2, a0), color);
    }
  }

  /** Ellipsoid blob from a jittered octahedron subdivided once (32 faces), or a plain octahedron (`detail` 0). */
  blob(center: readonly number[], radii: readonly number[], color: Color, seed: number, detail: 0 | 1 = 1, jitter = 0.18, light?: Color): void {
    const octa = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]];
    let faces: number[][][] = [];
    for (let i = 0; i < 4; i++) {
      const a = octa[i]!;
      const b = octa[(i + 1) % 4]!;
      faces.push([[0, 1, 0], b, a], [[0, -1, 0], a, b]);
    }
    if (detail === 1) {
      const mid = (p: number[], q: number[]) => normalize([(p[0]! + q[0]!) / 2, (p[1]! + q[1]!) / 2, (p[2]! + q[2]!) / 2]);
      faces = faces.flatMap(([a, b, c]) => {
        const ab = mid(a!, b!);
        const bc = mid(b!, c!);
        const ca = mid(c!, a!);
        return [[a!, ab, ca], [ab, b!, bc], [ca, bc, c!], [ab, bc, ca]];
      });
    }
    const displace = (p: number[]) => {
      const h = hash2(Math.round(p[0]! * 1000), Math.round(p[1]! * 1000) * 31 + Math.round(p[2]! * 1000), seed) / 4294967296;
      const k = 1 - jitter + 2 * jitter * h;
      return [center[0]! + p[0]! * radii[0]! * k, center[1]! + p[1]! * radii[1]! * k, center[2]! + p[2]! * radii[2]! * k];
    };
    for (const [a, b, c] of faces) {
      const upper = a![1]! + b![1]! + c![1]! > 0.9;
      this.tri(displace(a!), displace(b!), displace(c!), light && upper ? light : color);
    }
  }

  build(name: string, scene: Scene, material: Material): Mesh {
    const mesh = new Mesh(name, scene);
    const indices = Array.from({ length: this.positions.length / 3 }, (_, i) => i);
    const normals: number[] = [];
    VertexData.ComputeNormals(this.positions, indices, normals);
    const data = new VertexData();
    Object.assign(data, { positions: this.positions, indices, normals, colors: this.colors });
    data.applyToMesh(mesh, false);
    mesh.material = material;
    mesh.isPickable = false;
    return mesh;
  }
}

function normalize(v: number[]): number[] {
  const l = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

export interface StandInLevel {
  /** Camera distance from which this level is used, m. */
  readonly distance: number;
  build(builder: Builder): void;
}

export interface StandInSpec {
  readonly levels: readonly StandInLevel[];
  readonly cullDistance: number;
  readonly castShadow: boolean;
}

const fir = (height: number, radius: number): StandInSpec => ({
  cullDistance: 1200,
  castShadow: true,
  levels: [
    {
      distance: 0,
      build: (b) => {
        b.frustum(-0.3, height * 0.3, radius * 0.1, radius * 0.07, 6, C.bark);
        for (let k = 0; k < 4; k++) {
          const y0 = height * (0.18 + k * 0.19);
          b.frustum(y0, Math.min(height, y0 + height * 0.36), radius * (1 - k * 0.2), 0, 9, k % 2 ? C.firLight : C.fir, k * 0.4);
        }
      },
    },
    { distance: 70, build: (b) => (b.frustum(-0.3, height * 0.25, radius * 0.1, radius * 0.1, 4, C.bark), b.frustum(height * 0.18, height * 0.62, radius, 0, 6, C.fir), b.frustum(height * 0.5, height, radius * 0.6, 0, 6, C.firLight, 0.5)) },
    { distance: 260, build: (b) => b.frustum(height * 0.1, height, radius, 0, 4, C.fir) },
  ],
});

const broadleaf = (height: number, radius: number, seed: number): StandInSpec => ({
  cullDistance: 1200,
  castShadow: true,
  levels: [
    {
      distance: 0,
      build: (b) => {
        b.frustum(-0.3, height * 0.55, radius * 0.1, radius * 0.06, 6, C.bark);
        b.blob([0, height * 0.62, 0], [radius, height * 0.3, radius], C.leaf, seed, 1, 0.2, C.leafLight);
        b.blob([radius * 0.35, height * 0.8, -radius * 0.2], [radius * 0.6, height * 0.2, radius * 0.6], C.leafLight, seed + 1, 0);
      },
    },
    { distance: 70, build: (b) => (b.frustum(-0.3, height * 0.5, radius * 0.1, radius * 0.1, 4, C.bark), b.blob([0, height * 0.62, 0], [radius, height * 0.32, radius], C.leaf, seed, 0)) },
    { distance: 260, build: (b) => b.blob([0, height * 0.6, 0], [radius, height * 0.36, radius], C.leaf, seed, 0, 0) },
  ],
});

const bush = (height: number, radius: number, seed: number, color: Color = C.bush): StandInSpec => ({
  cullDistance: 180,
  castShadow: true,
  levels: [
    { distance: 0, build: (b) => b.blob([0, height * 0.45, 0], [radius, height * 0.55, radius], color, seed, 1, 0.25, C.leafLight) },
    { distance: 40, build: (b) => b.blob([0, height * 0.45, 0], [radius, height * 0.55, radius], color, seed, 0) },
  ],
});

const grass = (height: number, blades: number, seed: number): StandInSpec => ({
  cullDistance: 60,
  castShadow: false,
  levels: [
    {
      distance: 0,
      build: (b) => {
        for (let i = 0; i < blades; i++) {
          const h = hash2(i, 7, seed) / 4294967296;
          const a = (i / blades) * Math.PI + h;
          const r = 0.08 + 0.12 * h;
          const lean = 0.1 + 0.15 * h;
          const [cx, cz] = [Math.cos(a * 2.3) * r, Math.sin(a * 2.3) * r];
          const [dx, dz] = [Math.cos(a) * 0.05, Math.sin(a) * 0.05];
          b.tri([cx - dx, 0, cz - dz], [cx + Math.cos(a * 2.3) * lean, height * (0.7 + 0.3 * h), cz + Math.sin(a * 2.3) * lean], [cx + dx, 0, cz + dz], i % 3 ? C.grass : C.grassTip, true);
        }
      },
    },
  ],
});

const rock = (size: readonly [number, number, number], seed: number, mossy: boolean, cull: number): StandInSpec => ({
  cullDistance: cull,
  castShadow: true,
  levels: [
    { distance: 0, build: (b) => b.blob([0, size[1] * 0.38, 0], [size[0] / 2, size[1] * 0.62, size[2] / 2], C.rock, seed, 1, 0.22, mossy ? C.moss : undefined) },
    { distance: 60, build: (b) => b.blob([0, size[1] * 0.38, 0], [size[0] / 2, size[1] * 0.62, size[2] / 2], C.rock, seed, 0, 0.1) },
  ],
});

const solid = (cull: number, build: (b: Builder) => void, far?: (b: Builder) => void): StandInSpec => ({
  cullDistance: cull,
  castShadow: true,
  levels: far ? [{ distance: 0, build }, { distance: 60, build: far }] : [{ distance: 0, build }],
});

const SPECS: Readonly<Record<string, StandInSpec>> = {
  tree_fir_a: fir(19, 3),
  tree_fir_b: fir(15, 2.5),
  tree_fir_young: fir(8, 1.5),
  tree_broadleaf_a: broadleaf(9, 3.5, 11),
  tree_broadleaf_b: broadleaf(5.5, 2.25, 12),
  bush_a: bush(1.5, 0.65, 21),
  bush_b: bush(1.2, 0.65, 22, C.leaf),
  bush_c: bush(2, 0.8, 23),
  fern: { ...bush(0.45, 0.5, 24, C.leafLight), cullDistance: 100, castShadow: false },
  grass_clump_short: grass(0.22, 6, 31),
  grass_clump_medium: grass(0.45, 8, 32),
  grass_clump_tall: grass(0.9, 9, 33),
  rock_small: rock([0.5, 0.3, 0.5], 41, false, 120),
  rock_moss_b: rock([1.5, 0.9, 1.5], 42, true, 400),
  rock_boulder_a: rock([1.27, 1.0, 1.83], 43, false, 500),
  rock_moss_a: rock([2.5, 1.4, 2.5], 44, true, 500),
  rock_boulder_b: rock([2.5, 1.9, 2.5], 45, false, 700),
  rock_pile: solid(
    600,
    (b) => {
      for (let i = 0; i < 6; i++) b.blob([Math.cos(i * 1.9) * 1.4, 0.5, Math.sin(i * 1.9) * 1.1], [1.2, 1.0, 1.1], C.rock, 50 + i, 0, 0.2);
      b.blob([0, 0.9, 0], [1.8, 1.0, 1.5], C.sand, 57, 1, 0.2);
    },
    (b) => b.blob([0, 0.6, 0], [2.6, 1.2, 2.1], C.rock, 58, 0),
  ),
  road_barrier: solid(300, (b) => (b.box([-0.78, 0, -0.22], [0.78, 0.35, 0.22], C.concrete), b.box([-0.78, 0.35, -0.1], [0.78, 1.11, 0.1], C.concrete))),
  fence_chainlink: solid(200, (b) => {
    b.box([-1.25, 0, -0.03], [-1.19, 2.5, 0.03], C.metal);
    b.box([1.19, 0, -0.03], [1.25, 2.5, 0.03], C.metal);
    for (const y of [0.1, 1.25, 2.45]) b.box([-1.25, y - 0.02, -0.02], [1.25, y + 0.02, 0.02], C.metal);
    for (let i = 0; i < 6; i++) {
      const x = -1.2 + i * 0.4;
      b.quad([x, 0.1, 0], [x + 0.4, 2.45, 0], [x + 0.43, 2.45, 0], [x + 0.03, 0.1, 0], C.metal);
      b.quad([x + 0.03, 0.1, 0], [x + 0.43, 2.45, 0], [x + 0.4, 2.45, 0], [x, 0.1, 0], C.metal);
    }
  }),
  car_covered: solid(
    500,
    (b) => {
      b.box([-0.9, 0.3, -2.19], [0.9, 0.95, 2.19], C.car);
      b.box([-0.8, 0.95, -1.1], [0.8, 1.41, 0.9], C.car);
      for (const [x, z] of [[-0.8, -1.4], [0.8, -1.4], [-0.8, 1.4], [0.8, 1.4]] as const) b.box([x - 0.12, 0, z - 0.33], [x + 0.12, 0.62, z + 0.33], C.metal);
    },
    (b) => b.box([-0.9, 0, -2.19], [0.9, 1.2, 2.19], C.car),
  ),
  log_fallen: solid(300, (b) => b.log(4.05, 0.45, 0.45, 8, C.bark)),
  tree_stump: solid(200, (b) => b.frustum(0, 0.57, 0.7, 0.5, 8, C.bark)),
  crate_military: solid(150, (b) => b.box([-0.62, 0, -0.26], [0.62, 0.47, 0.26], C.olive)),
  crate_military_long: solid(150, (b) => b.box([-0.91, 0, -0.49], [0.91, 0.3, 0.49], C.olive)),
  barrel_rusty: solid(180, (b) => b.frustum(0, 0.93, 0.32, 0.32, 10, C.rust)),
  utility_box: solid(200, (b) => b.box([-0.46, 0, -0.21], [0.46, 1.12, 0.21], C.metal)),
  fence_wood: solid(300, (b) => {
    for (const x of [-1.95, 0, 1.95]) b.box([x - 0.06, -0.1, -0.06], [x + 0.06, 1.1, 0.06], C.wood);
    for (const y of [0.45, 0.95]) b.box([-2, y - 0.06, -0.03], [2, y + 0.06, 0.03], C.wood);
  }),
  wall_concrete: solid(
    700,
    (b) => (b.box([-2, -0.4, -0.15], [2, 2.6, 0.15], C.concrete), b.box([-2, 2.6, -0.18], [2, 2.7, 0.18], C.concrete)),
    (b) => b.box([-2, -0.4, -0.15], [2, 2.7, 0.15], C.concrete),
  ),
  sandbags: solid(250, (b) => {
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 4 - (row % 2); i++) {
        const x = -1.2 + (row % 2) * 0.3 + i * 0.6;
        b.blob([x + 0.3, 0.15 + row * 0.3, 0], [0.32, 0.16, 0.35], C.sand, 60 + row * 4 + i, 0, 0.05);
      }
    }
  }),
  hay_bale: solid(400, (b) => b.log(1.3, 0.75, 0.75, 10, C.hay)),
  hay_stack: solid(400, (b) => {
    b.box([-1.3, 0, -0.65], [0, 0.65, 0.65], C.hay);
    b.box([0, 0, -0.65], [1.3, 0.65, 0.65], C.hay);
    b.box([-0.65, 0.65, -0.65], [0.65, 1.3, 0.65], C.hay);
    b.box([-0.3, 1.3, -0.6], [0.9, 1.9, 0.6], C.hay);
  }),
};

const CATEGORY_FALLBACK: Readonly<Record<PropCategory, StandInSpec>> = {
  tree: SPECS.tree_fir_b!,
  bush: SPECS.bush_a!,
  grass: SPECS.grass_clump_medium!,
  rock: SPECS.rock_boulder_a!,
  prop: SPECS.crate_military!,
};

export function standInSpec(prop: string): StandInSpec {
  return SPECS[prop] ?? CATEGORY_FALLBACK[getMapProp(prop).category];
}

/** Builds the mesh for one stand-in level, disabled, at the prop origin. */
export function buildStandIn(scene: Scene, prop: string, level: number, name: string, material: Material): Mesh {
  const builder = new Builder();
  standInSpec(prop).levels[level]!.build(builder);
  return builder.build(name, scene, material);
}
