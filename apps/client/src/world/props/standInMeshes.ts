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
  /** Shaded foliage mass inside a hedge, and the slightly lit band of it. */
  hedge: [0.09, 0.16, 0.06],
  hedgeLight: [0.13, 0.21, 0.07],
  /** Glazing stays white: the shared glass material carries the tint. */
  pane: [1, 1, 1],
  /** Behind a mirror's silvered faces: never seen, but it is what casts the panel's shadow. */
  mirrorBack: [0.16, 0.16, 0.17],
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
  /** Glazed part, built as a second mesh with the shared glass material (`wall_glass`). */
  glass?(builder: Builder): void;
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

/**
 * Mirrored panel geometry (`wall_mirror`), prop-local meters: the silvered pane inside its frame. Shared by the frame
 * stand-in below and by the reflective faces MirrorWalls builds, so the two always line up. The pane sits 0.02 m inside
 * the frame: no z-fighting. The two faces are the whole body of the panel — there is nothing between them, so a hole
 * punched through both is a hole you see the corridor through.
 */
export const MIRROR_PANEL = {
  halfWidth: 1.88,
  bottom: 0.12,
  top: 2.44,
  /** Pane offset from the wall's center plane along local Z; a pane on each side. */
  faceOffset: 0.13,
  frameOffset: 0.15,
} as const;

/**
 * Glazed panel geometry (`wall_glass`), prop-local meters: the pane inside its frame. A pane looks exactly the same
 * whether it is stopping bullets or letting them through — that is the whole deception — so there is nothing here that
 * varies; what a round did to it is told by the flash where it struck (fx/ImpactEffects `paneStop`).
 */
export const GLASS_PANEL = {
  halfWidth: 1.86,
  bottom: 0.14,
  top: 2.44,
  /** Half the glass's own thickness: the surface a bullet hole sits on, either side of the centre plane. */
  paneOffset: 0.02,
} as const;

/**
 * Glazed wall panel (`wall_glass`): a metal frame (posts, sill, head rail, cap and a centre mullion) around a pane, at
 * wall_concrete's size. There is one glazed panel now — it used to be two look-alikes, one of which quietly stopped
 * bullets. What a pane does to a bullet changes on a clock instead (map/glassPhase.ts), and the tell is drawn over the
 * pane by `PhaseGlass`, not built into it here: the geometry is thin-instanced and shared by every pane in the maze.
 */
function glassPanel(): StandInSpec {
  const { halfWidth: w, bottom: y0, top: y1 } = GLASS_PANEL;
  const d = 0.12; // frame half depth (the concrete wall's cap reaches 0.18)
  const m = 0.05; // half a mullion
  const frame = (b: Builder, mullion: boolean) => {
    b.box([-2, -0.4, -d], [-w, 2.6, d], C.metal);
    b.box([w, -0.4, -d], [2, 2.6, d], C.metal);
    b.box([-w, -0.4, -d], [w, y0, d], C.metal);
    b.box([-w, y1, -d], [w, 2.6, d], C.metal);
    b.box([-2, 2.6, -d - 0.03], [2, 2.7, d + 0.03], C.metal);
    if (mullion) b.box([-m, y0, -0.08], [m, y1, 0.08], C.metal);
  };
  const g = GLASS_PANEL.paneOffset;
  const pane = (b: Builder, split: boolean) => {
    if (!split) {
      b.box([-w, y0, -g], [w, y1, g], C.pane);
      return;
    }
    b.box([-w, y0, -g], [-m, y1, g], C.pane);
    b.box([m, y0, -g], [w, y1, g], C.pane);
  };
  return {
    cullDistance: 700,
    // No shadow: the depth pass would cast an opaque slab.
    castShadow: false,
    levels: [
      { distance: 0, build: (b) => frame(b, true), glass: (b) => pane(b, true) },
      { distance: 60, build: (b) => frame(b, false), glass: (b) => pane(b, false) },
    ],
  };
}

/**
 * Grass wall (`wall_grass`), at wall_concrete's size so it drops into the same lattice: the only panel in the maze with
 * no collider, so you and your bullets go straight through it. That makes its looks the whole deception — it has to
 * read as a barrier you cannot pass and cannot see through, and only give itself away when you push into it.
 *
 * So the body is an opaque lofted slab, not a sparse curtain of blades: 12 segments across the 4 m span, each with its
 * own crown height and thickness from `hash2`, which gives a ragged hedge-top silhouette with no gap to see daylight
 * through at any angle. The blades stand off the crown and both faces to make it read as foliage rather than a painted
 * green box. Nothing is transparent and nothing alpha-tests, so this stays one ordinary opaque mesh per LOD inside the
 * thin-instance batch — hundreds of hedges are still the same handful of draw calls as hundreds of concrete panels.
 *
 * Cull distance and shadows deliberately match `wall_concrete` (720 m, casting): a hedge that faded out or stopped
 * casting where its neighbours did not would mark every walk-through wall on the map from across the maze.
 */
function grassWall(): StandInSpec {
  const SEED = 0x67_72_73;
  const SEGMENTS = 12;
  const rnd = (i: number, salt: number) => hash2(i, salt, SEED) / 4294967296;
  /** One column of the slab: its place along the wall, its crown height and half its thickness. */
  const column = (i: number) => ({ x: -2 + (i / SEGMENTS) * 4, top: 2.2 + 0.45 * rnd(i, 1), half: 0.24 + 0.16 * rnd(i, 2) });

  const slab = (b: Builder): void => {
    let a = column(0);
    // End caps: an edge's two pieces butt together and the next edge along may be concrete, so the run needs ends.
    b.quad([a.x, -0.5, -a.half], [a.x, -0.5, a.half], [a.x, a.top, a.half], [a.x, a.top, -a.half], C.hedge);
    for (let i = 1; i <= SEGMENTS; i++) {
      const c = column(i);
      const tint = i % 2 === 0 ? C.hedge : C.hedgeLight;
      b.quad([a.x, -0.5, a.half], [c.x, -0.5, c.half], [c.x, c.top, c.half], [a.x, a.top, a.half], tint);
      b.quad([a.x, -0.5, -a.half], [c.x, -0.5, -c.half], [c.x, c.top, -c.half], [a.x, a.top, -a.half], tint);
      b.quad([a.x, a.top, -a.half], [a.x, a.top, a.half], [c.x, c.top, c.half], [c.x, c.top, -c.half], C.grass);
      a = c;
    }
    b.quad([a.x, -0.5, -a.half], [a.x, -0.5, a.half], [a.x, a.top, a.half], [a.x, a.top, -a.half], C.hedge);
  };

  /** A tapered blade rooted at (x, y, z), leaning to (+lx, +ly, +lz). Two-sided, like the grass clumps. */
  const blade = (b: Builder, x: number, y: number, z: number, lx: number, ly: number, lz: number, half: number, color: Color): void => {
    b.tri([x - half, y, z], [x + lx, y + ly, z + lz], [x + half, y, z], color, true);
  };

  /** `crown` blades out of the top and `face` per side, so the outline frays instead of ending in a clean edge. */
  const foliage = (b: Builder, crown: number, face: number): void => {
    for (let i = 0; i < crown; i++) {
      const t = rnd(i, 3);
      const u = rnd(i, 4);
      const x = -1.94 + (3.88 * (i + t * 0.7)) / crown;
      const c = column(Math.min(SEGMENTS, Math.round(((x + 2) / 4) * SEGMENTS)));
      const z = (u * 2 - 1) * c.half;
      blade(b, x, c.top - 0.12, z, (t - 0.5) * 0.3, 0.3 + 0.45 * u, (u - 0.5) * 0.35, 0.05 + 0.04 * t, i % 3 === 0 ? C.grassTip : C.grass);
    }
    for (let i = 0; i < face; i++) {
      const t = rnd(i, 5);
      const u = rnd(i, 6);
      for (const side of [-1, 1] as const) {
        const x = -1.9 + (3.8 * (i + (side > 0 ? t : u) * 0.8)) / face;
        const c = column(Math.min(SEGMENTS, Math.round(((x + 2) / 4) * SEGMENTS)));
        const y = 0.2 + (c.top - 0.5) * (side > 0 ? t : u);
        blade(b, x, y, side * c.half * 0.9, (t - 0.5) * 0.25, 0.25 + 0.4 * u, side * (0.12 + 0.16 * t), 0.05 + 0.03 * u, i % 4 === 0 ? C.grassTip : C.grass);
      }
    }
  };

  return {
    cullDistance: 720,
    castShadow: true,
    levels: [
      { distance: 0, build: (b) => (slab(b), foliage(b, 34, 17)) },
      { distance: 45, build: (b) => (slab(b), foliage(b, 20, 0)) },
      // The slab survives to the cull distance: the silhouette is the lie, and it must never change shape.
      { distance: 150, build: slab },
    ],
  };
}

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
  // Same size as wall_concrete so they all swap in a lattice.
  wall_glass: glassPanel(),
  // Mirrored panel: the metal frame only, at wall_concrete's size so the three swap in a lattice. The two silvered
  // faces are NOT here — MirrorWalls draws them per mirror, because a reflection needs a per-plane material and cannot
  // live in a thin-instance batch, and because since 2026-09-18 a round punches a see-through hole in one, which is a
  // per-pane texture. Those faces are opaque and are what fills the frame; there is no shared core behind them any
  // more, since a core in this batch would still be standing behind every hole. One level only: a far level with a
  // plain solid box would swallow the faces.
  wall_mirror: solid(700, (b) => {
    const { halfWidth: w, bottom, top, frameOffset: f } = MIRROR_PANEL;
    b.box([-2, -0.4, -f], [-w, 2.6, f], C.metal);
    b.box([w, -0.4, -f], [2, 2.6, f], C.metal);
    b.box([-w, -0.4, -f], [w, bottom, f], C.metal);
    b.box([-w, top, -f], [w, 2.6, f], C.metal);
    b.box([-2, 2.6, -0.18], [2, 2.7, 0.18], C.metal);
  }),
  wall_grass: grassWall(),
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

export interface StandInMaterials {
  readonly solid: Material;
  /** Created on first use: only glazed props need it. */
  glass(): Material;
}

/** Builds the meshes for one stand-in level at the prop origin: the solid part, plus the glazed one where there is one. */
export function buildStandIn(scene: Scene, prop: string, level: number, name: string, materials: StandInMaterials): Mesh[] {
  const spec = standInSpec(prop).levels[level]!;
  const solidBuilder = new Builder();
  spec.build(solidBuilder);
  const meshes = [solidBuilder.build(name, scene, materials.solid)];
  if (spec.glass) {
    const glassBuilder = new Builder();
    spec.glass(glassBuilder);
    meshes.push(glassBuilder.build(`${name}_glass`, scene, materials.glass()));
  }
  return meshes;
}
