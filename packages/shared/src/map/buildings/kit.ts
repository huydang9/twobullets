import type { Vec3Tuple } from "../../level/types";
import type {
  Axis2,
  BoxPart,
  BuildingMaterialId,
  BuildingOpening,
  BuildingPart,
  BuildingPrefab,
  BuildingRoom,
  BuildingStairFlight,
  FaceDir,
  HorizontalDir,
  PartRole,
} from "./types";

/** Modular kit dimensions, m. Sized against the character controller (0.35 m radius, 1.8/1.1 m capsule, 0.35 m step). */
export const KIT = {
  wallThickness: 0.2,
  partitionThickness: 0.15,
  storyHeight: 3.0,
  slabThickness: 0.2,
  foundationDepth: 0.8,
  /** Clear openings, inside the frame. Crouched capsule + skin is 1.2 m tall, so a window can be vaulted crouched. */
  door: { width: 1.1, height: 2.2 },
  interiorDoor: { width: 1.0, height: 2.2 },
  window: { width: 1.2, sill: 1.0, head: 2.3 },
  frame: { width: 0.08, protrusion: 0.03 },
  stairs: { maxRise: 0.3, run: 0.3, width: 1.1 },
  railing: { height: 1.05, post: 0.06, rail: 0.04, spacing: 1.5, midRail: 0.5 },
  /** Stepped balustrade panel on open stair sides. */
  balustrade: { thickness: 0.05, height: 1.0 },
} as const;

export type Range = readonly [min: number, max: number];

export interface OpeningSpec {
  readonly kind: "door" | "window" | "hole";
  /** Center along the wall axis (prefab-local coordinate). Alternatively give `u`. */
  readonly at?: number;
  readonly width?: number;
  /** Explicit range along the wall axis; used by holes. */
  readonly u?: Range;
  /** Bottom and top of the clear opening, relative to the wall base. Doors default to the base and door height. */
  readonly sill?: number;
  readonly head?: number;
}

export interface WallSpec {
  /** Axis the wall runs along. */
  readonly axis: Axis2;
  /** Extent along `axis`. */
  readonly along: Range;
  /** Extent across (thickness), on the other horizontal axis. */
  readonly across: Range;
  readonly y: Range;
  readonly openings?: readonly OpeningSpec[];
  /** Direction the exterior face points. Omit for partitions (all faces use `interior`). */
  readonly outside?: HorizontalDir;
  readonly exterior?: BuildingMaterialId;
  readonly interior: BuildingMaterialId;
  readonly frame?: BuildingMaterialId;
  readonly role?: PartRole;
}

export interface ShellSpec {
  /** Outer footprint of the walls. */
  readonly x: Range;
  readonly z: Range;
  readonly y: Range;
  readonly thickness?: number;
  readonly exterior: BuildingMaterialId;
  readonly interior: BuildingMaterialId;
  readonly frame: BuildingMaterialId;
  readonly openings?: Partial<Record<HorizontalDir, readonly OpeningSpec[]>>;
}

export interface SlabSpec {
  readonly x: Range;
  readonly z: Range;
  readonly y: Range;
  readonly holes?: readonly { readonly x: Range; readonly z: Range }[];
  readonly top: BuildingMaterialId;
  readonly bottom: BuildingMaterialId;
  readonly side: BuildingMaterialId;
  readonly role?: PartRole;
}

export interface FlightSpec {
  /** Climbing direction. */
  readonly dir: HorizontalDir;
  /** Coordinate on the climbing axis where the first tread starts. */
  readonly start: number;
  /** Extent across the climbing direction. */
  readonly across: Range;
  readonly fromY: number;
  readonly toY: number;
  readonly run?: number;
  /** Solid steps reach down to `fromY`; floating block treads are one rise thick. */
  readonly solid: boolean;
  readonly material: BuildingMaterialId;
  /** Open sides that get a stepped balustrade panel: the low or high end of the `across` range. */
  readonly balustrade?: readonly ("min" | "max")[];
}

export interface GableRoofSpec {
  /** Outer wall footprint the roof sits on. */
  readonly x: Range;
  readonly z: Range;
  readonly baseY: number;
  readonly ridge: Axis2;
  readonly pitchDeg: number;
  /** Overhang past the eave walls and past the gable walls. */
  readonly eave: number;
  readonly gable: number;
  readonly roof: BuildingMaterialId;
  /** Gable ends and underside. */
  readonly body: BuildingMaterialId;
  readonly fascia: BuildingMaterialId;
}

interface Rect {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
}

const EPS = 1e-6;
const OPPOSITE: Record<HorizontalDir, HorizontalDir> = { "+x": "-x", "-x": "+x", "+z": "-z", "-z": "+z" };

/** Rounds away float noise from derived coordinates so touching parts share bit-identical planes. */
export function snap(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** Accumulates parts and metadata for one prefab. All coordinates are prefab-local. */
export class PrefabBuilder {
  private readonly parts: BuildingPart[] = [];
  private readonly rooms: BuildingRoom[] = [];
  private readonly openings: BuildingOpening[] = [];
  private readonly stairs: BuildingStairFlight[] = [];
  private readonly entrances: Vec3Tuple[] = [];
  private readonly crouchPassages: { min: Vec3Tuple; max: Vec3Tuple }[] = [];

  readonly id: string;
  readonly name: string;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  box(x: Range, y: Range, z: Range, material: BuildingMaterialId, role: PartRole, faces?: BoxPart["faces"]): this {
    const min: Vec3Tuple = [snap(x[0]), snap(y[0]), snap(z[0])];
    const max: Vec3Tuple = [snap(x[1]), snap(y[1]), snap(z[1])];
    if (max[0] - min[0] < EPS || max[1] - min[1] < EPS || max[2] - min[2] < EPS) {
      throw new Error(`${this.id}: degenerate ${role} box [${min}] - [${max}]`);
    }
    this.parts.push(faces ? { kind: "box", min, max, material, role, faces } : { kind: "box", min, max, material, role });
    return this;
  }

  wedge(x: Range, y: Range, z: Range, rises: HorizontalDir, material: BuildingMaterialId, slopeMaterial: BuildingMaterialId, role: PartRole): this {
    this.parts.push({
      kind: "wedge",
      min: [snap(x[0]), snap(y[0]), snap(z[0])],
      max: [snap(x[1]), snap(y[1]), snap(z[1])],
      rises,
      material,
      slopeMaterial,
      role,
    });
    return this;
  }

  /** Foundation block under the footprint; its top is the ground-floor finish. */
  foundation(x: Range, z: Range, floor: BuildingMaterialId, sides: BuildingMaterialId = "concrete", topY = 0): this {
    return this.box(x, [topY - KIT.foundationDepth, topY], z, sides, "foundation", { "+y": floor });
  }

  /** Wall with framed openings, decomposed into the minimum set of solid boxes around them. */
  wall(spec: WallSpec): this {
    const { axis, along, across, y } = spec;
    const role = spec.role ?? "wall";
    const faces = wallFaces(spec);
    const baseMaterial = spec.outside ? (spec.exterior ?? spec.interior) : spec.interior;
    const frameMaterial = spec.frame ?? baseMaterial;
    const holes: Rect[] = [];
    const frames: { rect: Rect; through: Range }[] = [];

    for (const opening of spec.openings ?? []) {
      const clear = this.clearRect(opening, along, y);
      const framed = opening.kind !== "hole";
      const f = framed ? KIT.frame.width : 0;
      const hole: Rect = { u0: clear.u0 - f, u1: clear.u1 + f, v0: opening.kind === "door" ? clear.v0 : clear.v0 - f, v1: clear.v1 + f };
      if (framed && (hole.u0 < along[0] - EPS || hole.u1 > along[1] + EPS || hole.v0 < y[0] - EPS || hole.v1 > y[1] + EPS)) {
        throw new Error(`${this.id}: ${opening.kind} at ${opening.at ?? opening.u} does not fit its wall`);
      }
      holes.push(hole);
      const p = framed ? KIT.frame.protrusion : 0;
      const through: Range = [snap(across[0] - p), snap(across[1] + p)];
      this.openings.push({ kind: opening.kind, axis, u: [snap(clear.u0), snap(clear.u1)], y: [snap(clear.v0), snap(clear.v1)], through });
      if (!framed) continue;
      frames.push(
        { rect: { u0: hole.u0, u1: clear.u0, v0: hole.v0, v1: hole.v1 }, through },
        { rect: { u0: clear.u1, u1: hole.u1, v0: hole.v0, v1: hole.v1 }, through },
        { rect: { u0: clear.u0, u1: clear.u1, v0: clear.v1, v1: hole.v1 }, through },
      );
      if (opening.kind === "window") frames.push({ rect: { u0: clear.u0, u1: clear.u1, v0: hole.v0, v1: clear.v0 }, through });
    }

    const solid = subtractRects({ u0: along[0], u1: along[1], v0: y[0], v1: y[1] }, holes);
    for (const r of solid) this.planar(axis, r, across, baseMaterial, role, faces);
    for (const { rect, through } of frames) this.planar(axis, rect, through, frameMaterial, "frame");
    return this;
  }

  /** Four outer walls: ±z walls span the full x range, ±x walls fit between them. */
  shell(spec: ShellSpec): this {
    const t = spec.thickness ?? KIT.wallThickness;
    const [x0, x1] = spec.x;
    const [z0, z1] = spec.z;
    const common = { y: spec.y, exterior: spec.exterior, interior: spec.interior, frame: spec.frame };
    const o = spec.openings ?? {};
    this.wall({ ...common, axis: "x", along: [x0, x1], across: [z1 - t, z1], outside: "+z", openings: o["+z"] });
    this.wall({ ...common, axis: "x", along: [x0, x1], across: [z0, z0 + t], outside: "-z", openings: o["-z"] });
    this.wall({ ...common, axis: "z", along: [z0 + t, z1 - t], across: [x1 - t, x1], outside: "+x", openings: o["+x"] });
    this.wall({ ...common, axis: "z", along: [z0 + t, z1 - t], across: [x0, x0 + t], outside: "-x", openings: o["-x"] });
    return this;
  }

  /** Floor/ceiling slab with rectangular holes (stair openings), decomposed into boxes. */
  slab(spec: SlabSpec): this {
    const holes = (spec.holes ?? []).map((h) => ({ u0: h.x[0], u1: h.x[1], v0: h.z[0], v1: h.z[1] }));
    for (const r of subtractRects({ u0: spec.x[0], u1: spec.x[1], v0: spec.z[0], v1: spec.z[1] }, holes)) {
      this.box([r.u0, r.u1], spec.y, [r.v0, r.v1], spec.side, spec.role ?? "floor", { "+y": spec.top, "-y": spec.bottom });
    }
    return this;
  }

  /**
   * Straight flight between two floor heights. The rise is split evenly (≤ KIT.stairs.maxRise) and the last rise is onto
   * the destination floor or landing, which must start at the returned coordinate.
   */
  flight(spec: FlightSpec): number {
    const run = spec.run ?? KIT.stairs.run;
    const height = spec.toY - spec.fromY;
    const rises = Math.ceil(height / KIT.stairs.maxRise - 1e-9);
    const rise = height / rises;
    const sign = spec.dir[0] === "+" ? 1 : -1;
    const alongX = spec.dir[1] === "x";
    const panel = KIT.balustrade.thickness;
    const sides = spec.balustrade ?? [];
    const treadAcross: Range = [spec.across[0] + (sides.includes("min") ? panel : 0), spec.across[1] - (sides.includes("max") ? panel : 0)];
    const treads: { min: Vec3Tuple; max: Vec3Tuple }[] = [];

    for (let k = 1; k < rises; k++) {
      const a = spec.start + sign * (k - 1) * run;
      const b = spec.start + sign * k * run;
      const along: Range = [Math.min(a, b), Math.max(a, b)];
      const top = spec.fromY + k * rise;
      const bottom = spec.solid ? spec.fromY : top - rise;
      const place = (acrossRange: Range, y: Range, material: BuildingMaterialId, role: PartRole) =>
        alongX ? this.box(along, y, acrossRange, material, role) : this.box(acrossRange, y, along, material, role);
      place(treadAcross, [bottom, top], spec.material, "stairs");
      const last = this.parts[this.parts.length - 1]!;
      treads.push({ min: last.min, max: last.max });
      for (const side of sides) {
        const range: Range = side === "min" ? [spec.across[0], treadAcross[0]] : [treadAcross[1], spec.across[1]];
        place(range, [bottom, top + KIT.balustrade.height], spec.material, "railing");
      }
    }
    this.stairs.push({ fromY: spec.fromY, toY: spec.toY, treads });
    return snap(spec.start + sign * (rises - 1) * run);
  }

  /** Post-and-rail guard along an axis-aligned polyline of (x, z) points. */
  railing(points: readonly (readonly [x: number, z: number])[], baseY: number, material: BuildingMaterialId): this {
    const { height, post, rail, spacing, midRail } = KIT.railing;
    const posts: [number, number][] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i]!;
      const [bx, bz] = points[i + 1]!;
      const length = Math.hypot(bx - ax, bz - az);
      const count = Math.max(1, Math.ceil(length / spacing - 1e-9));
      for (let k = i === 0 ? 0 : 1; k <= count; k++) posts.push([ax + ((bx - ax) * k) / count, az + ((bz - az) * k) / count]);
    }
    const hp = post / 2;
    const hr = rail / 2;
    for (const [px, pz] of posts) this.box([px - hp, px + hp], [baseY, baseY + height], [pz - hp, pz + hp], material, "railing");
    for (let i = 0; i < posts.length - 1; i++) {
      const [ax, az] = posts[i]!;
      const [bx, bz] = posts[i + 1]!;
      for (const [y0, y1] of [
        [height - rail, height],
        [midRail - hr, midRail + hr],
      ] as const) {
        const y: Range = [baseY + y0, baseY + y1];
        if (Math.abs(bz - az) < EPS) this.box([Math.min(ax, bx) + hp, Math.max(ax, bx) - hp], y, [az - hr, az + hr], material, "railing");
        else this.box([ax - hr, ax + hr], y, [Math.min(az, bz) + hp, Math.max(az, bz) - hp], material, "railing");
      }
    }
    return this;
  }

  /** Two wedges meeting at the ridge, plus fascia boards under the eaves. Returns the ridge height. */
  gableRoof(spec: GableRoofSpec): number {
    const { baseY, eave, gable } = spec;
    const alongX = spec.ridge === "x";
    const along = alongX ? spec.x : spec.z;
    const across = alongX ? spec.z : spec.x;
    const ridgeAt = (across[0] + across[1]) / 2;
    const halfSpan = ridgeAt - (across[0] - eave);
    const top = snap(baseY + halfSpan * Math.tan((spec.pitchDeg * Math.PI) / 180));
    const alongRange: Range = [along[0] - gable, along[1] + gable];
    const lowSide: Range = [across[0] - eave, ridgeAt];
    const highSide: Range = [ridgeAt, across[1] + eave];
    const y: Range = [baseY, top];
    const fasciaY: Range = [baseY - 0.2, baseY];
    if (alongX) {
      this.wedge(alongRange, y, lowSide, "+z", spec.body, spec.roof, "roof");
      this.wedge(alongRange, y, highSide, "-z", spec.body, spec.roof, "roof");
      this.box(alongRange, fasciaY, [across[0] - eave, across[0]], spec.fascia, "roof");
      this.box(alongRange, fasciaY, [across[1], across[1] + eave], spec.fascia, "roof");
    } else {
      this.wedge(lowSide, y, alongRange, "+x", spec.body, spec.roof, "roof");
      this.wedge(highSide, y, alongRange, "-x", spec.body, spec.roof, "roof");
      this.box([across[0] - eave, across[0]], fasciaY, alongRange, spec.fascia, "roof");
      this.box([across[1], across[1] + eave], fasciaY, alongRange, spec.fascia, "roof");
    }
    return top;
  }

  room(id: string, floorY: number, x: Range, z: Range, indoor = true): this {
    this.rooms.push({ id, floorY, min: [x[0], z[0]], max: [x[1], z[1]], indoor });
    return this;
  }

  /** Declares a clear volume that is meant to be passable only while crouched. */
  crouchPassage(x: Range, y: Range, z: Range): this {
    this.crouchPassages.push({ min: [x[0], y[0], z[0]], max: [x[1], y[1], z[1]] });
    return this;
  }

  entrance(x: number, y: number, z: number): this {
    this.entrances.push([x, y, z]);
    return this;
  }

  build(): BuildingPrefab {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const part of this.parts) {
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i]!, part.min[i]!);
        max[i] = Math.max(max[i]!, part.max[i]!);
      }
    }
    return {
      id: this.id,
      name: this.name,
      parts: this.parts,
      rooms: this.rooms,
      openings: this.openings,
      stairs: this.stairs,
      crouchPassages: this.crouchPassages,
      entrances: this.entrances,
      bounds: { min, max },
    };
  }

  private clearRect(opening: OpeningSpec, along: Range, y: Range): Rect {
    const defaults = opening.kind === "door" ? { width: KIT.door.width, sill: 0, head: KIT.door.height } : KIT.window;
    let u: Range;
    if (opening.u) u = opening.u;
    else if (opening.at !== undefined) {
      const w = opening.width ?? defaults.width;
      u = [opening.at - w / 2, opening.at + w / 2];
    } else throw new Error(`${this.id}: opening needs "at" or "u"`);
    const sill = opening.sill ?? defaults.sill;
    const head = opening.head ?? defaults.head;
    return {
      u0: Math.max(along[0], u[0]),
      u1: Math.min(along[1], u[1]),
      v0: y[0] + sill,
      v1: Math.min(y[1], y[0] + head),
    };
  }

  /** Box from a rect in wall coordinates (u along `axis`, v = height) and a range across the wall. */
  private planar(axis: Axis2, r: Rect, across: Range, material: BuildingMaterialId, role: PartRole, faces?: BoxPart["faces"]): void {
    if (axis === "x") this.box([r.u0, r.u1], [r.v0, r.v1], across, material, role, faces);
    else this.box(across, [r.v0, r.v1], [r.u0, r.u1], material, role, faces);
  }
}

function wallFaces(spec: WallSpec): BoxPart["faces"] | undefined {
  if (!spec.outside) return undefined;
  const faces: Partial<Record<FaceDir, BuildingMaterialId>> = { [OPPOSITE[spec.outside]]: spec.interior };
  return faces;
}

/**
 * Outer rectangle minus holes, as non-overlapping rectangles: split into columns at every hole edge, subtract the
 * holes' vertical ranges per column, then merge neighboring columns with identical solid ranges.
 */
export function subtractRects(outer: Rect, holes: readonly Rect[]): Rect[] {
  const clipped = holes
    .map((h) => ({ u0: Math.max(h.u0, outer.u0), u1: Math.min(h.u1, outer.u1), v0: Math.max(h.v0, outer.v0), v1: Math.min(h.v1, outer.v1) }))
    .filter((h) => h.u1 - h.u0 > EPS && h.v1 - h.v0 > EPS);
  const cuts = [...new Set([outer.u0, outer.u1, ...clipped.flatMap((h) => [h.u0, h.u1])].map(snap))].sort((a, b) => a - b);

  const columns: { u0: number; u1: number; spans: [number, number][] }[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const u0 = cuts[i]!;
    const u1 = cuts[i + 1]!;
    const mid = (u0 + u1) / 2;
    let spans: [number, number][] = [[outer.v0, outer.v1]];
    for (const h of clipped) {
      if (mid <= h.u0 || mid >= h.u1) continue;
      spans = spans.flatMap(([a, b]): [number, number][] => {
        if (h.v1 <= a || h.v0 >= b) return [[a, b]];
        const out: [number, number][] = [];
        if (h.v0 - a > EPS) out.push([a, h.v0]);
        if (b - h.v1 > EPS) out.push([h.v1, b]);
        return out;
      });
    }
    const previous = columns[columns.length - 1];
    if (previous && previous.u1 === u0 && sameSpans(previous.spans, spans)) previous.u1 = u1;
    else columns.push({ u0, u1, spans });
  }
  return columns.flatMap((c) => c.spans.map(([v0, v1]) => ({ u0: c.u0, u1: c.u1, v0: snap(v0), v1: snap(v1) })));
}

function sameSpans(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[]): boolean {
  return a.length === b.length && a.every(([a0, a1], i) => Math.abs(a0 - b[i]![0]) < EPS && Math.abs(a1 - b[i]![1]) < EPS);
}
