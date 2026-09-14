import { faceImpostor, type ImpostorPlanes } from "./impostor";
import { CULLED, type LodBands } from "./lodBands";

export interface LodCellSpec {
  /** Switch distance per level (the first is 0) and cull distance, m. */
  readonly switches: readonly number[];
  readonly cullDistance: number;
  /** Bands with hysteresis, and exact ones for when hysteresis is off. */
  readonly bands: LodBands;
  readonly exactBands: LodBands;
  /** Per level; set for crossed-quad impostor levels that should turn a plane toward the camera on entry. */
  readonly impostors: readonly (ImpostorPlanes | null)[];
}

export interface LodStep {
  x: number;
  y: number;
  z: number;
  /** Camera magnification (see lodZoom): distances count as this many times shorter. */
  zoom: number;
  /** Re-run level selection (the camera moved); otherwise only fades advance. */
  select: boolean;
  hysteresis: boolean;
  /** Fade progress added this frame (frame time ÷ fade time); 1 or more switches instantly. */
  fadeStep: number;
  faceImpostors: boolean;
}

/** Running totals since construction. */
export interface LodCounters {
  switches: number;
  shadowSwitches: number;
}

/** Called on every level change: instance, previous level, new level, squared camera distance (divided by the zoom). */
export type LodSwitchListener = (instance: number, from: number, to: number, distanceSq: number) => void;

/** `uniform` when a cell's instances aren't all settled in one (level, shadow) state. */
const MIXED = -1;

/**
 * Densely packed instance copies of one (level, shadow) bucket with swap-remove, so membership changes touch a few
 * slots instead of rebuilding the buffer. Owners are `instance × 2 + (fade-out copy ? 1 : 0)`.
 */
export class InstanceBatch {
  count = 0;
  matrices: Float32Array;
  /** Per-slot dither fade: p in [0, 1] shows the fraction p of a fading-in copy; 1 + p hides it from a fading-out one. */
  fades: Float32Array;
  owners: Int32Array;
  /** Slot ranges [from, to) changed since `clean`. */
  matrixFrom = Infinity;
  matrixTo = 0;
  fadeFrom = Infinity;
  fadeTo = 0;
  membershipChanged = false;

  constructor(
    readonly level: number,
    readonly shadow: boolean,
    private readonly maxCapacity: number,
  ) {
    const capacity = Math.min(maxCapacity, 16);
    this.matrices = new Float32Array(capacity * 16);
    this.fades = new Float32Array(capacity);
    this.owners = new Int32Array(capacity);
  }

  get capacity(): number {
    return this.owners.length;
  }

  get dirty(): boolean {
    return this.membershipChanged || this.matrixTo > 0 || this.fadeTo > 0;
  }

  /** Appends a copy of the 16 floats at `source[offset]`; returns its slot. */
  add(owner: number, source: Float32Array, offset: number, fade: number): number {
    if (this.count === this.owners.length) this.grow();
    const slot = this.count++;
    const m = this.matrices;
    const o = slot * 16;
    for (let k = 0; k < 16; k++) m[o + k] = source[offset + k]!;
    this.fades[slot] = fade;
    this.owners[slot] = owner;
    this.touch(slot, true);
    this.membershipChanged = true;
    return slot;
  }

  /** Removes a slot by moving the last copy into it; returns the owner that moved (or -1). */
  remove(slot: number): number {
    const last = --this.count;
    this.membershipChanged = true;
    if (slot === last) return -1;
    const m = this.matrices;
    for (let k = 0; k < 16; k++) m[slot * 16 + k] = m[last * 16 + k]!;
    this.fades[slot] = this.fades[last]!;
    const owner = this.owners[last]!;
    this.owners[slot] = owner;
    this.touch(slot, true);
    return owner;
  }

  setFade(slot: number, fade: number): void {
    if (this.fades[slot] === fade) return;
    this.fades[slot] = fade;
    this.touch(slot, false);
  }

  /** Marks the batch uploaded. */
  clean(): void {
    this.matrixFrom = this.fadeFrom = Infinity;
    this.matrixTo = this.fadeTo = 0;
    this.membershipChanged = false;
  }

  private touch(slot: number, matrix: boolean): void {
    if (matrix) {
      if (slot < this.matrixFrom) this.matrixFrom = slot;
      if (slot >= this.matrixTo) this.matrixTo = slot + 1;
    }
    if (slot < this.fadeFrom) this.fadeFrom = slot;
    if (slot >= this.fadeTo) this.fadeTo = slot + 1;
  }

  private grow(): void {
    const capacity = Math.min(this.maxCapacity, this.owners.length * 2);
    const matrices = new Float32Array(capacity * 16);
    const fades = new Float32Array(capacity);
    const owners = new Int32Array(capacity);
    matrices.set(this.matrices);
    fades.set(this.fades);
    owners.set(this.owners);
    this.matrices = matrices;
    this.fades = fades;
    this.owners = owners;
  }
}

/**
 * Per-instance LOD, shadow band and dithered cross-fade state of one prop's instances in one world cell. Selection runs
 * per instance against hysteresis bands; a level change moves the instance into the new level's batch at fade 0 and
 * leaves a fade-out copy in the old level's shadowless batch until the fade completes. Cells whose whole bounding box
 * stays inside the current band are skipped without per-instance work. Pure (no Babylon), allocation-free once batches
 * have grown.
 */
export class LodCell {
  readonly count: number;
  readonly counters: LodCounters = { switches: 0, shadowSwitches: 0 };
  onSwitch: LodSwitchListener | null = null;
  /** Some batch changed since the owner last uploaded. */
  dirty = false;
  /** Batches by `level × 2 + shadow`. */
  readonly batches: (InstanceBatch | null)[];

  private readonly level: Int8Array;
  private readonly shadow: Uint8Array;
  /** Level of the fade-out copy, or CULLED. */
  private readonly outLevel: Int8Array;
  /** Fade progress of the current level; 1 when settled. */
  private readonly progress: Float32Array;
  private readonly slot: Int32Array;
  private readonly outSlot: Int32Array;
  private readonly fading: Int32Array;
  private fadingCount = 0;
  /** Shared (level + 1) × 2 + shadow of every instance while all are settled alike, else MIXED. */
  private uniform = 0;
  private readonly min: Float64Array;
  private readonly max: Float64Array;

  /**
   * @param positions pivot per instance, 3 floats each
   * @param matrices world matrix per instance, 16 floats each
   */
  constructor(
    readonly spec: LodCellSpec,
    readonly positions: Float32Array,
    readonly matrices: Float32Array,
  ) {
    const n = positions.length / 3;
    this.count = n;
    this.level = new Int8Array(n).fill(CULLED);
    this.shadow = new Uint8Array(n);
    this.outLevel = new Int8Array(n).fill(CULLED);
    this.progress = new Float32Array(n).fill(1);
    this.slot = new Int32Array(n).fill(-1);
    this.outSlot = new Int32Array(n).fill(-1);
    this.fading = new Int32Array(n);
    this.batches = new Array<InstanceBatch | null>(spec.bands.levelCount * 2).fill(null);
    this.min = new Float64Array([Infinity, Infinity, Infinity]);
    this.max = new Float64Array([-Infinity, -Infinity, -Infinity]);
    for (let i = 0; i < n * 3; i++) {
      const axis = i % 3;
      this.min[axis] = Math.min(this.min[axis]!, positions[i]!);
      this.max[axis] = Math.max(this.max[axis]!, positions[i]!);
    }
  }

  /** Instances currently fading between levels. */
  get fadingInstances(): number {
    return this.fadingCount;
  }

  levelOf(instance: number): number {
    return this.level[instance]!;
  }

  castsShadow(instance: number): boolean {
    return this.shadow[instance] === 1;
  }

  step(s: LodStep): void {
    if (s.select) this.select(s);
    if (this.fadingCount > 0) this.advanceFades(s.fadeStep);
  }

  /** Squared distance from a point to this cell's instance pivots' bounding box: nearest, or farthest when `far`. */
  boxDistanceSq(x: number, y: number, z: number, far: boolean): number {
    const dx = axisDistance(x, this.min[0]!, this.max[0]!, far);
    const dy = axisDistance(y, this.min[1]!, this.max[1]!, far);
    const dz = axisDistance(z, this.min[2]!, this.max[2]!, far);
    return dx * dx + dy * dy + dz * dz;
  }

  private select(s: LodStep): void {
    const bands = s.hysteresis ? this.spec.bands : this.spec.exactBands;
    const zoomSq = s.zoom * s.zoom;
    if (this.uniform !== MIXED && this.fadingCount === 0 && this.fitsBand(bands, s, zoomSq)) return;

    const { positions, level, shadow } = this;
    let uniform = -2;
    for (let i = 0; i < this.count; i++) {
      const dx = positions[i * 3]! - s.x;
      const dy = positions[i * 3 + 1]! - s.y;
      const dz = positions[i * 3 + 2]! - s.z;
      const d2 = (dx * dx + dy * dy + dz * dz) / zoomSq;
      const current = level[i]!;
      const casting = shadow[i] === 1;
      const next = bands.select(d2, current);
      const nextShadow = bands.casts(d2, next, casting);
      if (next !== current) this.switchLevel(i, next, nextShadow, d2, s);
      else if (nextShadow !== casting) this.moveShadow(i, nextShadow);
      const code = (level[i]! + 1) * 2 + shadow[i]!;
      uniform = uniform === -2 || uniform === code ? code : MIXED;
    }
    this.uniform = this.fadingCount > 0 || uniform < 0 ? MIXED : uniform;
  }

  /** Whether every instance keeps its (shared) level and shadow state wherever it is in the cell's box. */
  private fitsBand(bands: LodBands, s: LodStep, zoomSq: number): boolean {
    const level = (this.uniform >> 1) - 1;
    const casting = (this.uniform & 1) === 1;
    const near = this.boxDistanceSq(s.x, s.y, s.z, false) / zoomSq;
    const far = this.boxDistanceSq(s.x, s.y, s.z, true) / zoomSq;
    return (
      bands.select(near, level) === level &&
      bands.select(far, level) === level &&
      bands.casts(near, level, casting) === casting &&
      bands.casts(far, level, casting) === casting
    );
  }

  private switchLevel(i: number, next: number, nextShadow: boolean, d2: number, s: LodStep): void {
    const current = this.level[i]!;
    this.counters.switches++;
    this.onSwitch?.(i, current, next, d2);

    if (s.fadeStep >= 1) {
      if (this.outLevel[i] !== CULLED) this.removeOut(i);
      if (current !== CULLED) this.removeMain(i);
      this.level[i] = next;
      this.shadow[i] = nextShadow ? 1 : 0;
      this.progress[i] = 1;
      if (next !== CULLED) this.addMain(i, s);
      return;
    }

    // Mid-fade: the old fade-out copy goes, and the new one starts where the current level's visibility is.
    let progress = 0;
    if (this.progress[i]! < 1) {
      if (this.outLevel[i] !== CULLED) this.removeOut(i);
      progress = 1 - this.progress[i]!;
    } else {
      this.fading[this.fadingCount++] = i;
    }
    if (current !== CULLED) {
      this.addOut(i, progress);
      this.removeMain(i);
    }
    this.level[i] = next;
    this.shadow[i] = nextShadow ? 1 : 0;
    this.progress[i] = progress;
    if (next !== CULLED) this.addMain(i, s);
  }

  private moveShadow(i: number, casting: boolean): void {
    this.counters.shadowSwitches++;
    const from = this.batches[this.level[i]! * 2 + this.shadow[i]!]!;
    const slot = this.slot[i]!;
    const to = this.batch(this.level[i]!, casting);
    const moved = to.add(i * 2, from.matrices, slot * 16, from.fades[slot]!);
    this.relink(from.remove(slot), slot);
    this.slot[i] = moved;
    this.shadow[i] = casting ? 1 : 0;
    this.dirty = true;
  }

  private advanceFades(step: number): void {
    const { fading, progress, level, outLevel } = this;
    for (let k = this.fadingCount - 1; k >= 0; k--) {
      const i = fading[k]!;
      const p = Math.min(1, progress[i]! + step);
      progress[i] = p;
      if (p >= 1) {
        if (outLevel[i] !== CULLED) this.removeOut(i);
        fading[k] = fading[--this.fadingCount]!;
      } else if (outLevel[i] !== CULLED) {
        this.batches[outLevel[i]! * 2]!.setFade(this.outSlot[i]!, 1 + p);
      }
      if (level[i] !== CULLED) this.batches[level[i]! * 2 + this.shadow[i]!]!.setFade(this.slot[i]!, p);
    }
    this.dirty = true;
  }

  private addMain(i: number, s: LodStep): void {
    const level = this.level[i]!;
    const batch = this.batch(level, this.shadow[i] === 1);
    const slot = batch.add(i * 2, this.matrices, i * 16, this.progress[i]!);
    const planes = this.spec.impostors[level];
    if (planes && s.faceImpostors) faceImpostor(batch.matrices, slot * 16, s.x, s.z, planes);
    this.slot[i] = slot;
    this.dirty = true;
  }

  private removeMain(i: number): void {
    const slot = this.slot[i]!;
    this.relink(this.batches[this.level[i]! * 2 + this.shadow[i]!]!.remove(slot), slot);
    this.slot[i] = -1;
    this.dirty = true;
  }

  /** Copies the current level's instance (turned impostor included) into its shadowless batch as a fade-out copy. */
  private addOut(i: number, progress: number): void {
    const level = this.level[i]!;
    const from = this.batches[level * 2 + this.shadow[i]!]!;
    this.outSlot[i] = this.batch(level, false).add(i * 2 + 1, from.matrices, this.slot[i]! * 16, 1 + progress);
    this.outLevel[i] = level;
  }

  private removeOut(i: number): void {
    const slot = this.outSlot[i]!;
    this.relink(this.batches[this.outLevel[i]! * 2]!.remove(slot), slot);
    this.outSlot[i] = -1;
    this.outLevel[i] = CULLED;
    this.dirty = true;
  }

  private relink(owner: number, slot: number): void {
    if (owner < 0) return;
    if (owner & 1) this.outSlot[owner >> 1] = slot;
    else this.slot[owner >> 1] = slot;
  }

  private batch(level: number, shadow: boolean): InstanceBatch {
    const index = level * 2 + (shadow ? 1 : 0);
    // One copy per instance, plus a moment of two while a fade-out copy is added before its main copy is removed.
    return (this.batches[index] ??= new InstanceBatch(level, shadow, this.count + 1));
  }
}

function axisDistance(p: number, min: number, max: number, far: boolean): number {
  return far ? Math.max(Math.abs(p - min), Math.abs(p - max)) : Math.max(min - p, 0, p - max);
}
