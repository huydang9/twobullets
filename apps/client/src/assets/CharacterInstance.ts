import type { AbstractMesh, AnimationGroup, AssetContainer, Observer, Scene, Skeleton, TransformNode } from "@babylonjs/core";
import { instantiate, type Instantiated } from "./instantiate";
import type { CharacterAsset, CharacterBoneRole, CharacterClipName, CharacterId } from "./manifest";

export interface PlayCharacterClipOptions {
  /** Defaults to the manifest's `loop` flag for the clip. */
  readonly loop?: boolean;
  /** Playback speed multiplier. Default 1. */
  readonly speed?: number;
  /** Cross-fade time from the previous clip in seconds. Default 0.15; 0 snaps. */
  readonly blend?: number;
  /** Restart the clip if it is already the current one. Default false (only speed/loop are updated). */
  readonly restart?: boolean;
  /** Called once when a non-looping clip finishes (not when interrupted). */
  readonly onEnd?: () => void;
}

interface Fade {
  readonly group: AnimationGroup;
  /** Weight change per second (positive fades in, negative fades out). */
  readonly rate: number;
}

/**
 * One third-person character: its own cloned skeleton, bone nodes and animation groups, so any number of
 * instances can animate independently. Feet at the root origin, facing +Z, meters.
 */
export class CharacterInstance {
  readonly id: CharacterId;
  readonly asset: CharacterAsset;
  readonly root: TransformNode;
  readonly meshes: readonly AbstractMesh[];
  readonly skeleton: Skeleton;
  readonly animations: ReadonlyMap<CharacterClipName, AnimationGroup>;
  /** Animated bone nodes; parent attachments to them or read `getAbsolutePosition()` for hitboxes. */
  readonly bones: Readonly<Record<CharacterBoneRole, TransformNode>>;

  private readonly entries: Instantiated;
  private readonly scene: Scene;
  private readonly fades = new Map<AnimationGroup, Fade>();
  private readonly updateObserver: Observer<Scene>;
  private endObserver: Observer<AnimationGroup> | null = null;
  private clip: CharacterClipName | null = null;

  constructor(id: CharacterId, asset: CharacterAsset, container: AssetContainer, scene: Scene) {
    this.id = id;
    this.asset = asset;
    this.scene = scene;
    this.entries = instantiate(container);
    this.root = this.entries.root;
    this.meshes = this.entries.meshes;
    const skeleton = this.entries.skeletons[0];
    if (!skeleton || this.entries.skeletons.length !== 1) throw new Error(`Character ${id}: expected one skeleton`);
    this.skeleton = skeleton;

    const animations = new Map<CharacterClipName, AnimationGroup>();
    for (const name of Object.keys(asset.clips) as CharacterClipName[]) {
      const group = this.entries.animationGroups.find((g) => g.name === name);
      if (!group) throw new Error(`Character ${id}: animation "${name}" missing`);
      animations.set(name, group);
    }
    this.animations = animations;

    const bones = {} as Record<CharacterBoneRole, TransformNode>;
    for (const [role, name] of Object.entries(asset.bones) as [CharacterBoneRole, string][]) {
      bones[role] = this.entries.node(name);
    }
    this.bones = bones;

    this.updateObserver = scene.onBeforeAnimationsObservable.add(() => this.updateFades());
  }

  get currentClip(): CharacterClipName | null {
    return this.clip;
  }

  play(clip: CharacterClipName, options: PlayCharacterClipOptions = {}): AnimationGroup {
    const group = this.animations.get(clip);
    if (!group) throw new Error(`Character ${this.id} has no "${clip}" clip`);
    const { loop = this.asset.clips[clip].loop, speed = 1, blend = 0.15, restart = false, onEnd } = options;

    this.endObserver?.remove();
    this.endObserver = null;
    if (this.clip === clip && group.isStarted && !restart) {
      group.speedRatio = speed;
      group.loopAnimation = loop;
    } else {
      for (const other of this.animations.values()) {
        if (other === group || !other.isStarted) continue;
        if (blend > 0) {
          if (other.weight < 0) other.weight = 1; // -1 means "unweighted", i.e. full influence
          this.fades.set(other, { group: other, rate: -1 / blend });
        } else {
          this.stopGroup(other);
        }
      }
      if (group.isStarted) group.stop(true);
      group.start(loop, speed, group.from, group.to);
      group.weight = blend > 0 ? 0 : 1;
      if (blend > 0) this.fades.set(group, { group, rate: 1 / blend });
      else this.fades.delete(group);
      this.clip = clip;
    }

    if (onEnd && !loop) {
      this.endObserver = group.onAnimationGroupEndObservable.addOnce(() => {
        this.endObserver = null;
        onEnd();
      });
    }
    return group;
  }

  stop(): void {
    this.endObserver?.remove();
    this.endObserver = null;
    for (const group of this.animations.values()) this.stopGroup(group);
    this.clip = null;
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  dispose(): void {
    this.stop();
    this.updateObserver.remove();
    this.entries.dispose();
  }

  private updateFades(): void {
    if (this.fades.size === 0) return;
    const dt = this.scene.getEngine().getDeltaTime() / 1000;
    for (const fade of this.fades.values()) {
      const weight = Math.min(1, Math.max(0, fade.group.weight + fade.rate * dt));
      fade.group.weight = weight;
      if (fade.rate > 0 && weight >= 1) this.fades.delete(fade.group);
      if (fade.rate < 0 && weight <= 0) this.stopGroup(fade.group);
    }
  }

  private stopGroup(group: AnimationGroup): void {
    this.fades.delete(group);
    if (group.isStarted) group.stop(true);
    group.weight = -1;
  }
}
