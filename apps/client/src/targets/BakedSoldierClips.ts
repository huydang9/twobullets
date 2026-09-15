import { Animation, AnimationGroup, type AnimationGroupMask, type Nullable, type TransformNode } from "@babylonjs/core";
import type { CharacterClipName, CharacterInstance } from "../assets";

/**
 * Soldier clips baked once into typed arrays and blended by hand, instead of Babylon AnimationGroups.
 *
 * Babylon evaluates every started group as one Animatable per bone channel (54 per soldier clip), each interpolating
 * with fresh Quaternion/Vector3 allocations, then blends them through per-frame "late binding" holder objects; starting
 * a group also re-sorts every active animatable in the scene. With 20 soldiers that was the largest CPU cost of a frame.
 *
 * Here every clip is resampled at its own frame rate (60 Hz) into one Float32Array per channel, shared by every soldier
 * of the scene. Each soldier owns lightweight clip groups (a clock and per-channel weights, with the AnimationGroup
 * members `SoldierAnimator` uses) and one mixer that samples the weighted groups, blends per bone with Babylon's math
 * (sequential slerps; the rest pose fills a total weight below 1) and writes the bone nodes. Nothing
 * allocates per frame, and a pose whose inputs didn't change since the last evaluation isn't recomputed.
 */

/** One animated bone channel of a baked clip; `target` and `animation` mirror Babylon's TargetedAnimation. */
export interface BakedTrack {
  readonly target: { readonly name: string };
  readonly animation: { readonly framePerSecond: number };
  /** Index into the mixer's bone list. */
  readonly bone: number;
  readonly rotation: boolean;
  /** One sample per clip frame: xyzw quaternions or xyz positions. */
  readonly data: Float32Array;
}

export interface BakedClip {
  readonly from: number;
  readonly to: number;
  readonly fps: number;
  /** Samples at frames from, from + 1, … (the last one at `to`). */
  readonly samples: number;
  readonly tracks: readonly BakedTrack[];
}

interface Interpolating {
  _interpolate(frame: number, state: { key: number; repeatCount: number; loopMode: number }): unknown;
}

export class BakedClipLibrary {
  readonly boneNames: readonly string[];
  readonly clips: ReadonlyMap<CharacterClipName, BakedClip>;

  private constructor(boneNames: string[], clips: Map<CharacterClipName, BakedClip>) {
    this.boneNames = boneNames;
    this.clips = clips;
  }

  /** Library of `character`'s clips (baked on first use per loaded asset), or null when they aren't bakeable Babylon groups. */
  static of(character: CharacterInstance): BakedClipLibrary | null {
    const first = character.animations.values().next().value;
    if (!(first instanceof AnimationGroup)) return null;
    const key = first.targetedAnimations[0]?.animation;
    if (!key) return null;
    let library = LIBRARIES.get(key);
    if (library === undefined) {
      library = BakedClipLibrary.bake(character);
      LIBRARIES.set(key, library);
    }
    return library;
  }

  private static bake(character: CharacterInstance): BakedClipLibrary | null {
    const boneNames: string[] = [];
    const boneIndex = new Map<string, number>();
    const clips = new Map<CharacterClipName, BakedClip>();
    const state = { key: 0, repeatCount: 0, loopMode: Animation.ANIMATIONLOOPMODE_CYCLE };
    for (const [name, group] of character.animations) {
      if (!(group instanceof AnimationGroup) || group.targetedAnimations.length === 0) return null;
      const from = group.from;
      const to = group.to;
      const fps = group.targetedAnimations[0]!.animation.framePerSecond;
      const samples = Math.max(2, Math.ceil((to - from) * SAMPLES_PER_FRAME) + 1);
      const tracks: BakedTrack[] = [];
      for (const { target, animation } of group.targetedAnimations) {
        const rotation = animation.targetProperty === "rotationQuaternion" && animation.dataType === Animation.ANIMATIONTYPE_QUATERNION;
        const position = animation.targetProperty === "position" && animation.dataType === Animation.ANIMATIONTYPE_VECTOR3;
        // Plain linear keys only (glTF LINEAR); anything else keeps Babylon's evaluation.
        const plain = animation.getKeys().every((k) => !k.interpolation && k.inTangent === undefined && k.outTangent === undefined && !k.easingFunction);
        if ((!rotation && !position) || !plain || animation.getEasingFunction() || animation.framePerSecond !== fps) return null;
        const targetName = (target as { name?: unknown }).name;
        if (typeof targetName !== "string") return null;
        let bone = boneIndex.get(targetName);
        if (bone === undefined) {
          bone = boneNames.length;
          boneNames.push(targetName);
          boneIndex.set(targetName, bone);
        }
        const width = rotation ? 4 : 3;
        const data = new Float32Array(samples * width);
        state.key = 0;
        const source = animation as unknown as Interpolating;
        for (let i = 0; i < samples; i++) {
          const value = source._interpolate(Math.min(from + i / SAMPLES_PER_FRAME, to), state) as { x: number; y: number; z: number; w?: number };
          const o = i * width;
          data[o] = value.x;
          data[o + 1] = value.y;
          data[o + 2] = value.z;
          if (rotation) {
            // Keep neighbours in the same hemisphere so sample interpolation never takes the long way round.
            let w = value.w!;
            if (i > 0 && data[o - 4]! * data[o]! + data[o - 3]! * data[o + 1]! + data[o - 2]! * data[o + 2]! + data[o - 1]! * w < 0) {
              data[o] = -data[o]!;
              data[o + 1] = -data[o + 1]!;
              data[o + 2] = -data[o + 2]!;
              w = -w;
            }
            data[o + 3] = w;
          }
        }
        tracks.push({ target: { name: targetName }, animation: { framePerSecond: fps }, bone, rotation, data });
      }
      clips.set(name, { from, to, fps, samples, tracks });
    }
    return new BakedClipLibrary(boneNames, clips);
  }
}

/**
 * `out[o..o+3] = slerp(out, b, t)` as Babylon's Quaternion.SlerpToRef computes it. Chained over the weighted clips (each
 * at its share of the running total) it is the same sequential blend Babylon's late animation binding does.
 */
function slerpInto(out: Float32Array, o: number, bx: number, by: number, bz: number, bw: number, t: number): void {
  const ax = out[o]!;
  const ay = out[o + 1]!;
  const az = out[o + 2]!;
  const aw = out[o + 3]!;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  const flip = dot < 0;
  if (flip) dot = -dot;
  let sa: number;
  let sb: number;
  if (dot > 0.999999) {
    sa = 1 - t;
    sb = t;
  } else {
    const angle = Math.acos(dot);
    const inv = 1 / Math.sin(angle);
    sa = Math.sin((1 - t) * angle) * inv;
    sb = Math.sin(t * angle) * inv;
  }
  if (flip) sb = -sb;
  out[o] = ax * sa + bx * sb;
  out[o + 1] = ay * sa + by * sb;
  out[o + 2] = az * sa + bz * sb;
  out[o + 3] = aw * sa + bw * sb;
}

const SAMPLES_PER_FRAME = 2;

/** Keyed by a shared source Animation, so every instance of one loaded asset reuses the bake. */
const LIBRARIES = new WeakMap<object, BakedClipLibrary | null>();

/** Weights below this don't count as a change worth re-posing for. */
const WEIGHT_TOLERANCE = 1e-4;
const FRAME_TOLERANCE = 1e-3;

/** A soldier's copy of one clip: the AnimationGroup members `SoldierAnimator` drives, over a baked clip. */
export class BakedClipGroup {
  readonly name: CharacterClipName;
  readonly clip: BakedClip;
  readonly from: number;
  readonly to: number;
  readonly targetedAnimations: readonly BakedTrack[];
  /** Per-track influence, same order as `targetedAnimations`. */
  readonly animatables: readonly { weight: number }[];
  weight = 0;
  speedRatio = 1;
  /** Tracks the mask lets through (1) or filters out (0). */
  readonly retained: Uint8Array;
  private started = false;
  private loop = true;
  private frame = 0;
  /** Started since the last advance: Babylon's first evaluation of a started group shows its start frame, unadvanced. */
  private fresh = false;
  private currentMask: Nullable<AnimationGroupMask> = null;
  /** Inputs of the last evaluated pose, for change detection. */
  evaluatedFrame = 0;
  evaluatedContributing = false;
  readonly evaluatedWeights: Float32Array;

  constructor(name: CharacterClipName, clip: BakedClip) {
    this.name = name;
    this.clip = clip;
    this.from = clip.from;
    this.to = clip.to;
    this.targetedAnimations = clip.tracks;
    this.animatables = clip.tracks.map(() => ({ weight: 0 }));
    this.retained = new Uint8Array(clip.tracks.length).fill(1);
    this.evaluatedWeights = new Float32Array(clip.tracks.length);
  }

  get isStarted(): boolean {
    return this.started;
  }

  get mask(): Nullable<AnimationGroupMask> {
    return this.currentMask;
  }

  set mask(mask: Nullable<AnimationGroupMask>) {
    this.currentMask = mask;
    const tracks = this.targetedAnimations;
    for (let i = 0; i < tracks.length; i++) this.retained[i] = !mask || mask.disabled || mask.retainsTarget(tracks[i]!.target.name) ? 1 : 0;
  }

  /** Always spans the whole clip (the animator only starts groups over `from`–`to`). */
  start(loop = false, speedRatio = 1, from = this.from): this {
    if (this.started) return this;
    this.started = true;
    this.loop = loop;
    this.speedRatio = speedRatio;
    this.frame = Math.min(Math.max(from, this.from), this.to);
    this.fresh = true;
    return this;
  }

  stop(): this {
    this.started = false;
    return this;
  }

  goToFrame(frame: number): this {
    if (!this.started) return this;
    this.frame = Math.min(Math.max(frame, this.from), this.to);
    return this;
  }

  getCurrentFrame(): number {
    return this.started ? this.frame : 0;
  }

  /** The clock step Babylon's animation pass would make for this render. */
  advance(dt: number): void {
    if (!this.started) return;
    if (this.fresh) {
      this.fresh = false;
      return;
    }
    let frame = this.frame + dt * this.clip.fps * this.speedRatio;
    const range = this.to - this.from;
    if (frame >= this.to) frame = this.loop && range > 0 ? this.from + ((frame - this.from) % range) : this.to;
    this.frame = frame;
  }
}

/**
 * One soldier's clip groups and the mixer that turns their weights into bone transforms. `advance` every render
 * (cheap: clocks only), `evaluate` when the pose should be shown (the owner's level of detail).
 */
export class BakedPoseMixer {
  readonly groups: ReadonlyMap<CharacterClipName, BakedClipGroup>;
  private readonly list: BakedClipGroup[] = [];
  private readonly nodes: TransformNode[];
  /** Per bone: rest rotation xyzw and position xyz, from the node values at construction. */
  private readonly rest: Float32Array;
  /** Per bone blend accumulators, same layout as `rest`. */
  private readonly acc: Float32Array;
  private readonly rotationWeight: Float32Array;
  private readonly positionWeight: Float32Array;
  private evaluatedOnce = false;

  private constructor(library: BakedClipLibrary, nodes: TransformNode[]) {
    const groups = new Map<CharacterClipName, BakedClipGroup>();
    for (const [name, clip] of library.clips) {
      const group = new BakedClipGroup(name, clip);
      groups.set(name, group);
      this.list.push(group);
    }
    this.groups = groups;
    this.nodes = nodes;
    const bones = nodes.length;
    this.rest = new Float32Array(bones * 7);
    this.acc = new Float32Array(bones * 7);
    this.rotationWeight = new Float32Array(bones);
    this.positionWeight = new Float32Array(bones);
    for (let b = 0; b < bones; b++) {
      const node = nodes[b]!;
      const q = node.rotationQuaternion;
      const o = b * 7;
      this.rest[o + 3] = 1;
      if (q) {
        this.rest[o] = q.x;
        this.rest[o + 1] = q.y;
        this.rest[o + 2] = q.z;
        this.rest[o + 3] = q.w;
      }
      this.rest[o + 4] = node.position.x;
      this.rest[o + 5] = node.position.y;
      this.rest[o + 6] = node.position.z;
    }
  }

  /** A mixer over `character`'s bones, or null when its clips can't be baked (they then play as Babylon groups). */
  static create(character: CharacterInstance): BakedPoseMixer | null {
    const library = BakedClipLibrary.of(character);
    if (!library) return null;
    const byName = new Map<string, TransformNode>();
    for (const group of character.animations.values()) {
      for (const { target } of group.targetedAnimations) {
        const node = target as TransformNode;
        if (!byName.has(node.name)) byName.set(node.name, node);
      }
    }
    const nodes: TransformNode[] = [];
    for (const name of library.boneNames) {
      const node = byName.get(name);
      if (!node || !node.position) return null;
      nodes.push(node);
    }
    // Rotation tracks need a quaternion to write into.
    for (const clip of library.clips.values()) for (const track of clip.tracks) if (track.rotation && !nodes[track.bone]!.rotationQuaternion) return null;
    return new BakedPoseMixer(library, nodes);
  }

  advance(dt: number): void {
    const list = this.list;
    for (let i = 0; i < list.length; i++) list[i]!.advance(dt);
  }

  /**
   * Blends the weighted groups onto the bones. Returns false (and writes nothing) when no group's frame or weights
   * moved since the last evaluation, e.g. a corpse held on its final frame.
   */
  evaluate(): boolean {
    if (this.evaluatedOnce && !this.changed()) return false;
    this.evaluatedOnce = true;
    const acc = this.acc;
    const rotationWeight = this.rotationWeight;
    const positionWeight = this.positionWeight;
    acc.fill(0);
    rotationWeight.fill(0);
    positionWeight.fill(0);

    const list = this.list;
    for (let g = 0; g < list.length; g++) {
      const group = list[g]!;
      const weights = group.evaluatedWeights;
      if (!group.isStarted) {
        if (group.evaluatedContributing) {
          weights.fill(0);
          group.evaluatedContributing = false;
        }
        continue;
      }
      const clip = group.clip;
      const frame = group.getCurrentFrame();
      const x = (frame - clip.from) * SAMPLES_PER_FRAME;
      let index = Math.floor(x);
      let t = x - index;
      if (index < 0) {
        index = 0;
        t = 0;
      } else if (index >= clip.samples - 1) {
        index = clip.samples - 2;
        t = 1;
      }
      const tracks = clip.tracks;
      const animatables = group.animatables;
      const retained = group.retained;
      let contributing = false;
      for (let k = 0; k < tracks.length; k++) {
        const w = retained[k] === 1 ? animatables[k]!.weight : 0;
        weights[k] = w;
        if (!(w > 0)) continue;
        contributing = true;
        const track = tracks[k]!;
        const data = track.data;
        const o = track.bone * 7;
        if (track.rotation) {
          const a = index * 4;
          const b = a + 4;
          const qx = data[a]! + (data[b]! - data[a]!) * t;
          const qy = data[a + 1]! + (data[b + 1]! - data[a + 1]!) * t;
          const qz = data[a + 2]! + (data[b + 2]! - data[a + 2]!) * t;
          const qw = data[a + 3]! + (data[b + 3]! - data[a + 3]!) * t;
          const inv = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
          const total = rotationWeight[track.bone]! + w;
          if (total === w) {
            acc[o] = qx * inv;
            acc[o + 1] = qy * inv;
            acc[o + 2] = qz * inv;
            acc[o + 3] = qw * inv;
          } else {
            slerpInto(acc, o, qx * inv, qy * inv, qz * inv, qw * inv, w / total);
          }
          rotationWeight[track.bone] = total;
        } else {
          const a = index * 3;
          const b = a + 3;
          acc[o + 4] = acc[o + 4]! + (data[a]! + (data[b]! - data[a]!) * t) * w;
          acc[o + 5] = acc[o + 5]! + (data[a + 1]! + (data[b + 1]! - data[a + 1]!) * t) * w;
          acc[o + 6] = acc[o + 6]! + (data[a + 2]! + (data[b + 2]! - data[a + 2]!) * t) * w;
          positionWeight[track.bone] = positionWeight[track.bone]! + w;
        }
      }
      group.evaluatedFrame = frame;
      group.evaluatedContributing = contributing;
    }

    const rest = this.rest;
    const nodes = this.nodes;
    for (let bone = 0; bone < nodes.length; bone++) {
      const rw = rotationWeight[bone]!;
      const pw = positionWeight[bone]!;
      if (rw === 0 && pw === 0) continue;
      const node = nodes[bone]!;
      const o = bone * 7;
      if (rw > 0) {
        // Under-weighted: the rest pose fills in the remainder.
        if (rw < 1) slerpInto(acc, o, rest[o]!, rest[o + 1]!, rest[o + 2]!, rest[o + 3]!, 1 - rw);
        const x = acc[o]!;
        const y = acc[o + 1]!;
        const z = acc[o + 2]!;
        const w = acc[o + 3]!;
        const length = Math.sqrt(x * x + y * y + z * z + w * w);
        if (length > 1e-8) node.rotationQuaternion!.set(x / length, y / length, z / length, w / length);
      }
      if (pw > 0) {
        if (pw < 1) {
          const s = 1 - pw;
          node.position.set(acc[o + 4]! + rest[o + 4]! * s, acc[o + 5]! + rest[o + 5]! * s, acc[o + 6]! + rest[o + 6]! * s);
        } else {
          node.position.set(acc[o + 4]! / pw, acc[o + 5]! / pw, acc[o + 6]! / pw);
        }
      }
      node.markAsDirty();
    }
    return true;
  }

  /** Whether any group started, stopped, moved its frame or changed a weight since the last evaluation. */
  private changed(): boolean {
    const list = this.list;
    for (let g = 0; g < list.length; g++) {
      const group = list[g]!;
      if (!group.isStarted) {
        if (group.evaluatedContributing) return true;
        continue;
      }
      const weights = group.evaluatedWeights;
      const animatables = group.animatables;
      const retained = group.retained;
      let contributing = false;
      for (let k = 0; k < weights.length; k++) {
        const w = retained[k] === 1 ? animatables[k]!.weight : 0;
        if (Math.abs(w - weights[k]!) > WEIGHT_TOLERANCE) return true;
        if (w > 0) contributing = true;
      }
      if (contributing !== group.evaluatedContributing) return true;
      if (contributing && Math.abs(group.getCurrentFrame() - group.evaluatedFrame) > FRAME_TOLERANCE) return true;
    }
    return false;
  }
}
