import type {
  CharacterBoneRole,
  CharacterClipName,
  Credit,
  FrameRange,
  WeaponClipName,
  WeaponId,
  WeaponNodeRole,
} from "../../apps/client/src/assets/manifest.ts";
import type { TextureRule } from "./lib/textures.ts";

/** Bump to invalidate every cached output (e.g. after changing pipeline code). */
export const PIPELINE_VERSION = 3;

export const SRC_DIR = "assets-src";
export const OUT_DIR = "apps/client/public/assets";
export const CACHE_DIR = "node_modules/.cache/twobullets-assets";

export interface WeaponSpec {
  readonly id: WeaponId;
  readonly source: string;
  readonly fps: number;
  readonly clips: Readonly<Partial<Record<WeaponClipName, FrameRange>>>;
  /** Role → source node name. `muzzle`/`ejection` are generated. */
  readonly nodes: Readonly<Partial<Record<Exclude<WeaponNodeRole, "arms" | "muzzle" | "ejection">, string>>> & {
    readonly body: string;
  };
  /** Mesh node (under `body`) whose frontmost vertices define the muzzle. */
  readonly barrelMesh: string;
  /** Mesh node whose bounding-box center marks the ejection port. */
  readonly ejectionMesh: string;
  readonly credit: string;
}

/**
 * Clip tables. Pistol and sniper are the author's published ranges; rifle and shotgun were derived with
 * `pnpm assets:analyze` (see docs/assets-pipeline.md for the method and confidence).
 */
export const WEAPONS: readonly WeaponSpec[] = [
  {
    id: "rifle",
    source: "weapons/rifle/fps_animated_carbine.glb",
    fps: 30,
    clips: {
      fire: [0, 8],
      reloadEmpty: [9, 68],
      reload: [69, 134],
      hide: [135, 144],
      ready: [144, 177],
      idle: [178, 204],
      melee: [205, 222],
    },
    nodes: {
      body: "carbine",
      mag: "clip",
      bolt: "bolt",
      chargingHandle: "handle",
      shell: "bullet",
      trigger: "trigger",
      scope: "scope",
      scopeLens: "lens",
    },
    barrelMesh: "base_carbine_0",
    ejectionMesh: "bolt_carbine_0",
    credit: "djmaesen-carbine",
  },
  {
    id: "shotgun",
    source: "weapons/shotgun/shotgun_animated.glb",
    fps: 30,
    clips: {
      fire: [0, 12],
      pump: [13, 25],
      reload: [26, 71],
      reloadStart: [26, 34],
      reloadInsert: [35, 60],
      reloadEnd: [60, 71],
      hide: [72, 82],
      ready: [82, 102],
      idle: [103, 123],
      melee: [124, 140],
    },
    nodes: {
      body: "shotgun",
      pump: "pump",
      shell: "slug",
      trigger: "trigger",
    },
    barrelMesh: "base_shotgun_0",
    ejectionMesh: "slug_shotgun_0",
    credit: "djmaesen-shotgun",
  },
  {
    id: "pistol",
    source: "weapons/pistol/animated_pistol.glb",
    fps: 30,
    clips: {
      fire: [0, 11],
      reload: [12, 82],
      fireLast: [83, 94],
      reloadEmpty: [95, 175],
      hide: [176, 187],
      ready: [187, 233],
      idle: [234, 264],
    },
    nodes: {
      body: "pistol",
      mag: "mag",
      slide: "slide",
      shell: "shell_1",
      trigger: "trigger",
    },
    barrelMesh: "base_beretta_0",
    ejectionMesh: "shell_1_beretta_0",
    credit: "djmaesen-pistol",
  },
  {
    id: "sniper",
    source: "weapons/sniper/sniper_animated.glb",
    fps: 30,
    clips: {
      fire: [0, 11],
      bolt: [12, 60],
      reload: [61, 115],
      hide: [116, 127],
      ready: [127, 142],
      idle: [143, 165],
      melee: [166, 195],
    },
    nodes: {
      body: "sniper",
      mag: "mag",
      bolt: "bolt",
      shell: "bullet",
      trigger: "trigger",
      scope: "scope",
      scopeLens: "lens",
      reticle: "reticle",
    },
    barrelMesh: "base_sniper_0",
    ejectionMesh: "bullet_sniper_0",
    credit: "djmaesen-sniper",
  },
];

/** Textures for first-person weapons: 2K color, 1K normals (UASTC keeps them artifact-free), small extras. */
export const WEAPON_TEXTURES: readonly TextureRule[] = [
  { slot: "normal", maxSize: 1024, codec: "uastc" },
  { material: /^(lens|scopereticle)$/, slot: "baseColor", maxSize: 1024, codec: "uastc" },
  { material: /^arms$/, slot: "orm", maxSize: 1024, codec: "etc1s" },
  { slot: "orm", maxSize: 2048, codec: "etc1s" },
  { slot: "baseColor", maxSize: 2048, codec: "etc1s" },
];

export const CHARACTER_TEXTURES: readonly TextureRule[] = [
  { slot: "normal", maxSize: 1024, codec: "uastc" },
  { slot: "orm", maxSize: 1024, codec: "etc1s" },
  { slot: "baseColor", maxSize: 2048, codec: "etc1s" },
];

export interface CharacterClipSpec {
  readonly file: string;
  /** Folder under SRC_DIR holding `file`. Defaults to the character's `animDir`. */
  readonly dir?: string;
  readonly loop: boolean;
  /** Strip horizontal hips drift (clips exported without "In Place"). */
  readonly inPlace: boolean;
  /** Inclusive source frame range to keep (at `CLIP_FPS`); the clip is re-timed to start at 0. */
  readonly frames?: FrameRange;
  /**
   * Horizontal hips placement: "anchor" shifts the whole clip so the first hips key sits over the origin (keeps sway),
   * "lock" pins the hips over the origin on every key (for falls that travel).
   */
  readonly root?: "anchor" | "lock";
  /** Turns the whole clip about +Y (degrees, right-handed glTF space: +90 takes +X to −Z), after `root`. */
  readonly yaw?: number;
}

/** Mixamo downloads are 30 fps. */
export const CLIP_FPS = 30;

export interface CharacterSpec {
  readonly id: "swat";
  readonly mesh: string;
  readonly animDir: string;
  readonly clips: Readonly<Record<CharacterClipName, CharacterClipSpec>>;
  readonly bones: Readonly<Record<CharacterBoneRole, string>>;
  readonly credit: string;
}

const loop = (file: string, inPlace = false): CharacterClipSpec => ({ file, loop: true, inPlace });
const once = (file: string): CharacterClipSpec => ({ file, loop: false, inPlace: false });
/** Second Mixamo batch (docs/assets-pipeline.md, "Knocked, revive, item and throw clips"). */
const MIXAMO = "animations/mixamo";
const extra = (file: string, isLoop: boolean, frames: FrameRange, options: Pick<CharacterClipSpec, "root" | "yaw"> = {}): CharacterClipSpec => ({
  file,
  dir: MIXAMO,
  loop: isLoop,
  inPlace: false,
  frames,
  ...options,
});

export function characterClipPath(spec: CharacterSpec, clip: CharacterClipSpec): string {
  return `${clip.dir ?? spec.animDir}/${clip.file}`;
}

export const CHARACTER: CharacterSpec = {
  id: "swat",
  mesh: "characters/swat/swat.fbx",
  animDir: "characters/swat/anims",
  clips: {
    rifle_idle: loop("Rifle Aiming Idle.fbx"),
    walk_fwd: loop("Walk Forward.fbx", true),
    walk_back: loop("Walk Backward.fbx", true),
    walk_left: loop("Walk Left.fbx", true),
    walk_right: loop("Walk Right.fbx", true),
    crouch_walk_fwd: loop("Walk Crouching Forward.fbx", true),
    run_fwd: loop("Run Forward.fbx", true),
    run_back: loop("Run Backward.fbx", true),
    run_left: loop("Run Left.fbx", true),
    run_right: loop("Run Right.fbx", true),
    sprint_fwd: loop("Sprint Forward.fbx", true),
    crouch_idle: loop("Idle Crouching.fbx"),
    jump_up: once("Jump Up.fbx"),
    jump_loop: loop("Jump Loop.fbx"),
    jump_down: once("Jump Down.fbx"),
    fire: once("Firing Rifle.fbx"),
    reload: once("Reloading.fbx"),
    hit: once("Hit Reaction.fbx"),
    death_front: once("Death From The Front.fbx"),
    death_back: once("Death From The Back.fbx"),
    // Falls backward and rolls onto the stomach (settled by frame 65). The fall travels 1.6 m, so the hips are pinned.
    knock_down: extra("Knocked Down.fbx", false, [0, 66], { root: "lock" }),
    // On the back, head −Z already.
    writhe: extra("Writhing In Pain.fbx", true, [0, 170], { root: "anchor" }),
    // Hands and knees, authored head +Z and exported In Place: turned so it matches the other lying clips.
    crawl: extra("Crawling.fbx", true, [0, 54], { yaw: 180 }),
    // From the back (head −Z) to standing facing +Z; still from frame 55.
    get_up: extra("Getting Up.fbx", false, [0, 62]),
    // Kneeling, compressions then breaths then compressions; the patient lies 0.45 m ahead of the hips.
    cpr_give: extra("Administering Cpr.fbx", true, [0, 259], { root: "anchor" }),
    // Authored lying along X beside the giver (head −X); turned to head −Z. Nearly static, so 5 s is plenty.
    cpr_receive: extra("Receiving Cpr.fbx", true, [0, 150], { root: "anchor", yaw: -90 }),
    heal_kneel: extra("Kneeling Inspecting.fbx", true, [0, 148], { root: "anchor" }),
    bandage: extra("Searching Pockets.fbx", true, [0, 150]),
    // The source idles 2 s on either side of the drink.
    drink: extra("Drinking.fbx", true, [55, 180]),
    // Rifle-aimed idle on both ends trimmed; the hand leaves the grenade around source frame 56.
    throw_stand: extra("Toss Grenade.fbx", false, [30, 84]),
    throw_crouch: extra("Throw Grenade.fbx", false, [30, 90]),
    pick_up: extra("Pick Up Item.fbx", false, [0, 36]),
  },
  bones: {
    hips: "mixamorig:Hips",
    spine: "mixamorig:Spine",
    chest: "mixamorig:Spine2",
    neck: "mixamorig:Neck",
    head: "mixamorig:Head",
    leftUpperArm: "mixamorig:LeftArm",
    leftForeArm: "mixamorig:LeftForeArm",
    leftHand: "mixamorig:LeftHand",
    rightUpperArm: "mixamorig:RightArm",
    rightForeArm: "mixamorig:RightForeArm",
    rightHand: "mixamorig:RightHand",
    leftUpLeg: "mixamorig:LeftUpLeg",
    leftLeg: "mixamorig:LeftLeg",
    leftFoot: "mixamorig:LeftFoot",
    rightUpLeg: "mixamorig:RightUpLeg",
    rightLeg: "mixamorig:RightLeg",
    rightFoot: "mixamorig:RightFoot",
  },
  credit: "mixamo-swat",
};

const CC_BY = { license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attributionRequired: true };
const DJMAESEN = { author: "DJMaesen", authorUrl: "https://sketchfab.com/bumstrum" };
const CONVERTED = "Converted, compressed and split into clips for twobullets.";

export const CREDITS: readonly Credit[] = [
  {
    id: "djmaesen-carbine",
    title: "fps animated carbine",
    url: "https://sketchfab.com/3d-models/fps-animated-carbine-62977bb4c53047a185b9f3a0cdf56b87",
    ...DJMAESEN,
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "djmaesen-shotgun",
    title: "shotgun animated",
    url: "https://sketchfab.com/3d-models/shotgun-animated-c3d3cf425869463a84d650c15e3af0d2",
    ...DJMAESEN,
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "djmaesen-pistol",
    title: "animated pistol",
    url: "https://sketchfab.com/3d-models/animated-pistol-bd896167e7ca44f19597d3afe6a8d83f",
    ...DJMAESEN,
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "djmaesen-sniper",
    title: "sniper animated",
    url: "https://sketchfab.com/3d-models/sniper-animated-eae1ba5b43ae4bc89b0647fb5d8a2d27",
    ...DJMAESEN,
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "mixamo-swat",
    title: "Swat (character and animations)",
    author: "Adobe Mixamo",
    url: "https://www.mixamo.com",
    license: "Mixamo terms (royalty-free, no attribution required)",
    attributionRequired: false,
  },
];
