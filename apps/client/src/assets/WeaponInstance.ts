import type { AbstractMesh, AnimationGroup, AssetContainer, Observer, Scene, Skeleton, TransformNode } from "@babylonjs/core";
import type { WeaponAsset, WeaponClipName, WeaponId, WeaponNodeRole } from "./manifest";
import { instantiate, type Instantiated } from "./instantiate";

export interface PlayClipOptions {
  /** Loop the clip's frame range. Default false. */
  readonly loop?: boolean;
  /** Playback speed multiplier. Default 1. */
  readonly speed?: number;
  /**
   * Called once when a non-looping clip reaches its last frame (not when interrupted by another play/stop). Runs at
   * the start of the next animation step, so it may start another clip.
   */
  readonly onEnd?: () => void;
}

/**
 * One first-person arms + gun instance. All clips live in a single AnimationGroup and are played as frame ranges.
 * Parent `root` to the camera/viewmodel rig; the asset is authored in meters looking down +Z.
 */
export class WeaponInstance {
  readonly id: WeaponId;
  readonly asset: WeaponAsset;
  /** Loader root (handles glTF → left-handed conversion). */
  readonly root: TransformNode;
  readonly meshes: readonly AbstractMesh[];
  readonly skeleton: Skeleton | null;
  readonly animation: AnimationGroup;
  /** Nodes by role; required roles are always present. `arms` is the skinned Mesh. */
  readonly nodes: Readonly<Partial<Record<WeaponNodeRole, TransformNode>>> & {
    readonly body: TransformNode;
    readonly arms: TransformNode;
    readonly muzzle: TransformNode;
    readonly ejection: TransformNode;
  };

  private readonly entries: Instantiated;
  private endObserver: Observer<AnimationGroup> | null = null;
  private deferredEnd: Observer<Scene> | null = null;
  private clip: WeaponClipName | null = null;

  constructor(id: WeaponId, asset: WeaponAsset, container: AssetContainer) {
    this.id = id;
    this.asset = asset;
    this.entries = instantiate(container);
    this.root = this.entries.root;
    this.meshes = this.entries.meshes;
    this.skeleton = this.entries.skeletons[0] ?? null;

    const animation = this.entries.animationGroups.find((g) => g.name === asset.animation);
    if (!animation) throw new Error(`Weapon ${id}: animation "${asset.animation}" missing`);
    this.animation = animation;

    const nodes: Partial<Record<WeaponNodeRole, TransformNode>> = {};
    for (const [role, name] of Object.entries(asset.nodes) as [WeaponNodeRole, string][]) {
      nodes[role] = this.entries.node(name);
    }
    this.nodes = nodes as WeaponInstance["nodes"];
  }

  get currentClip(): WeaponClipName | null {
    return this.clip;
  }

  hasClip(clip: WeaponClipName): boolean {
    return this.asset.clips[clip] !== undefined;
  }

  /** Clip length in seconds at speed 1. */
  clipDuration(clip: WeaponClipName): number {
    const [start, end] = this.range(clip);
    return (end - start) / this.asset.fps;
  }

  /** Starts `clip` from its first frame, interrupting whatever was playing. */
  play(clip: WeaponClipName, options: PlayClipOptions = {}): void {
    const [start, end] = this.range(clip);
    const { loop = false, speed = 1, onEnd } = options;
    this.stop();
    const toGroupFrame = this.groupFrameScale();
    this.clip = clip;
    this.animation.start(loop, speed, start * toGroupFrame, end * toGroupFrame);
    if (onEnd && !loop) {
      const scene = this.root.getScene();
      this.endObserver = this.animation.onAnimationGroupEndObservable.addOnce(() => {
        this.endObserver = null;
        // Babylon empties the group's animatable list right after this notification, so a clip started from here
        // would keep running untracked (and unstoppable). Hand the callback to the next animation step instead.
        this.deferredEnd = scene.onBeforeAnimationsObservable.addOnce(() => {
          this.deferredEnd = null;
          onEnd();
        });
      });
    }
  }

  /** Stops playback and leaves the pose on the current frame. */
  stop(): void {
    this.endObserver?.remove();
    this.endObserver = null;
    this.deferredEnd?.remove();
    this.deferredEnd = null;
    this.clip = null;
    if (this.animation.isStarted) this.animation.stop(true);
  }

  /** Poses the rig on a source frame without playing (e.g. to hold the first idle frame). */
  goToFrame(frame: number): void {
    this.stop();
    const scale = this.groupFrameScale();
    this.animation.start(false, 1, frame * scale, frame * scale);
    this.animation.goToFrame(frame * scale);
    this.animation.stop(true);
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  dispose(): void {
    this.stop();
    this.entries.dispose();
  }

  private range(clip: WeaponClipName): readonly [number, number] {
    const range = this.asset.clips[clip];
    if (!range) throw new Error(`Weapon ${this.id} has no "${clip}" clip`);
    return range;
  }

  /** Babylon's glTF loader keys animations at its own frame rate (60 by default), not the source fps. */
  private groupFrameScale(): number {
    const fps = this.animation.targetedAnimations[0]?.animation.framePerSecond ?? this.asset.fps;
    return fps / this.asset.fps;
  }
}
