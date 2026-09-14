import type { Credit } from "../../../apps/client/src/assets/manifest.ts";
import type {
  EquipmentModelId,
  EquipmentPartRole,
  ThrowArmsClipName,
} from "../../../apps/client/src/assets/equipmentManifest.ts";
import type { TextureRule } from "../lib/textures.ts";

/** Bump to invalidate every cached equipment output. */
export const EQUIPMENT_PIPELINE_VERSION = 1;
export const EQUIPMENT_OUT = "equipment";

export type TextureTier = "held" | "consumable" | "gear" | "arms";

/**
 * - held: throwables seen up close in first person (2K color).
 * - consumable: heal items (in hand while used, small on the ground).
 * - gear: loot-only models.
 * UASTC keeps normals artifact-free; ETC1S everything else.
 */
export const EQUIPMENT_TEXTURES: Readonly<Record<TextureTier, readonly TextureRule[]>> = {
  held: [
    { slot: "normal", maxSize: 1024, codec: "uastc" },
    { slot: "orm", maxSize: 1024, codec: "etc1s" },
    { slot: "baseColor", maxSize: 2048, codec: "etc1s" },
  ],
  consumable: [
    { slot: "normal", maxSize: 1024, codec: "uastc" },
    { slot: "orm", maxSize: 1024, codec: "etc1s" },
    { slot: "baseColor", maxSize: 1024, codec: "etc1s" },
  ],
  gear: [
    { slot: "normal", maxSize: 512, codec: "uastc" },
    { slot: "orm", maxSize: 512, codec: "etc1s" },
    { slot: "baseColor", maxSize: 1024, codec: "etc1s" },
  ],
  arms: [
    { slot: "normal", maxSize: 1024, codec: "uastc" },
    { slot: "orm", maxSize: 1024, codec: "etc1s" },
    { slot: "baseColor", maxSize: 2048, codec: "etc1s" },
  ],
};

export interface EquipmentItemSpec {
  readonly id: EquipmentModelId;
  readonly source: string;
  /** Mesh nodes to keep, tested against the mesh node's name and its ancestors'. Sources often hold extra copies. */
  readonly keep?: RegExp;
  readonly drop?: RegExp;
  /** Parts split off the body (tested like `keep`). */
  readonly parts?: Readonly<Partial<Record<Exclude<EquipmentPartRole, "body">, RegExp>>>;
  /** XYZ Euler degrees applied after baking, turning the source into item space (+Y up / fuse axis, +Z front). */
  readonly rotate?: readonly [number, number, number];
  /** Real-world size: the bounding-box extent along `axis` (after rotation), meters. */
  readonly size: { readonly axis: "x" | "y" | "z" | "max"; readonly meters: number };
  readonly maxTriangles: number;
  readonly textures: TextureTier;
  readonly fixes?: {
    /** DirectX-style normal map: invert green. */
    readonly flipNormalGreen?: boolean;
    /** Paints over light printed marks (a real product's label) on the base color with the surrounding colour. */
    readonly removeLabel?: boolean;
    /** Force alpha mode OPAQUE (Sketchfab exports sometimes mark solid models BLEND). */
    readonly opaque?: boolean;
    /** Fallbacks when the source has no roughness/metalness texture. */
    readonly roughness?: number;
    readonly metallic?: number;
  };
  readonly credit: string;
}

const THROWABLE_TRIS = 10_000;
const LOOT_TRIS = 5_000;
const E = "equipment";

export const EQUIPMENT_ITEMS: readonly EquipmentItemSpec[] = [
  {
    id: "frag",
    source: `${E}/m67/m67.glb`,
    // The file has an assembled grenade and an exploded copy (".001").
    drop: /\.001/,
    parts: { spoon: /^m67_spoon$/, ring: /^m67_(ring|safety_pin)$/ },
    size: { axis: "y", meters: 0.089 },
    // Also a loot item on the ground.
    maxTriangles: LOOT_TRIS,
    textures: "held",
    credit: "firewarden3d-m67",
  },
  {
    id: "smoke",
    source: `${E}/m18-smoke/m18_smoke_grenade.glb`,
    keep: /^SM_SmokeGrenade_PainterExport$/,
    size: { axis: "y", meters: 0.145 },
    maxTriangles: LOOT_TRIS,
    textures: "held",
    fixes: { flipNormalGreen: true },
    credit: "vanillatography-m18",
  },
  {
    id: "flash",
    source: `${E}/m84-flashbang/m84_stun_grenade_flashbang.glb`,
    keep: /\.001$/,
    parts: { spoon: /^SafetyLever(Bump)?_low\.001$/, ring: /^Pin(Connect)?_low\.001$/ },
    size: { axis: "y", meters: 0.15 },
    maxTriangles: LOOT_TRIS,
    textures: "held",
    credit: "vanillatography-m84",
  },
  {
    id: "molotov",
    source: `${E}/molotov/molotov_cocktail.glb`,
    size: { axis: "y", meters: 0.29 },
    maxTriangles: LOOT_TRIS,
    textures: "held",
    credit: "godlike-molotov",
  },
  {
    id: "bandage",
    source: `${E}/bandage/bandage_game_ready.glb`,
    // A flat vacuum pack; turn its face toward +Z.
    rotate: [0, 90, 0],
    size: { axis: "max", meters: 0.14 },
    maxTriangles: LOOT_TRIS,
    textures: "consumable",
    fixes: { removeLabel: true },
    credit: "dwalsh-bandage",
  },
  {
    id: "first_aid",
    source: `${E}/first-aid-kit/tactical_first_aid_kit.glb`,
    size: { axis: "max", meters: 0.19 },
    maxTriangles: LOOT_TRIS,
    textures: "consumable",
    credit: "ruskoschey-first-aid-kit",
  },
  {
    id: "medkit",
    source: "environment/models/medical_box/medical_box_2k.gltf",
    // Poly Haven scans are real scale (52.5 cm wide); a carried kit reads better a little smaller.
    size: { axis: "x", meters: 0.4 },
    maxTriangles: LOOT_TRIS,
    textures: "consumable",
    credit: "polyhaven-medical-box",
  },
  {
    id: "energy_drink",
    source: `${E}/energy-drink/energy_drink_game_ready_model.glb`,
    size: { axis: "y", meters: 0.168 },
    maxTriangles: LOOT_TRIS,
    textures: "consumable",
    credit: "dwalsh-energy-drink",
  },
  {
    id: "painkiller",
    source: `${E}/pain-pills/simple_pain_pills.glb`,
    size: { axis: "y", meters: 0.085 },
    maxTriangles: LOOT_TRIS,
    textures: "consumable",
    credit: "blender3d-pain-pills",
  },
  {
    id: "helmet",
    source: `${E}/helmet-k6-3/combat_helmet_k6-3.glb`,
    size: { axis: "z", meters: 0.29 },
    maxTriangles: LOOT_TRIS,
    textures: "gear",
    fixes: { opaque: true },
    credit: "shamanoff-helmet",
  },
  {
    id: "vest",
    source: `${E}/plate-carrier-vest/tactical_plate_carrier_vest_-_game_ready.glb`,
    // Plates face ±X in the source.
    rotate: [0, 90, 0],
    size: { axis: "y", meters: 0.5 },
    maxTriangles: LOOT_TRIS,
    textures: "gear",
    fixes: { roughness: 0.88, metallic: 0 },
    credit: "exactly-vest",
  },
  {
    id: "backpack",
    source: `${E}/tactical-backpack/low_poly_game_ready_military_tactical_backpack.glb`,
    size: { axis: "y", meters: 0.55 },
    maxTriangles: LOOT_TRIS,
    textures: "gear",
    credit: "danlyvostok-backpack",
  },
  {
    id: "ammo_can",
    source: `${E}/ammo-can/ammocans_gameready_animated_pbr_free.glb`,
    size: { axis: "max", meters: 0.3 },
    maxTriangles: LOOT_TRIS,
    textures: "gear",
    credit: "dt7-ammo-cans",
  },
];

export interface ThrowArmsSpec {
  readonly id: "throw_arms";
  /**
   * Sketchfab's GLB of the model. The original FBX in `original-fbx/` holds the same single 21-frame clip (identical key
   * times), skin and texture set; the GLB already has them as glTF with metal/rough materials, so it goes through the
   * same restructuring as the DJMaesen weapons.
   */
  readonly source: string;
  readonly fps: number;
  /** Source frames, inclusive (see docs/equipment/art.md and `pnpm assets:analyze throw_arms`). */
  readonly clips: Readonly<Record<ThrowArmsClipName, readonly [number, number]>>;
  /** Frame where the fingers are open far enough to let go. */
  readonly releaseFrame: number;
  readonly nodes: {
    readonly body: string;
    readonly rightShoulder: string;
    readonly rightHand: string;
    readonly leftShoulder: string;
    readonly leftHand: string;
  };
  /** Right-hand joints whose centroid (at the ready frame) is the grip point. */
  readonly gripJoints: RegExp;
  readonly maxTriangles: number;
  readonly credit: string;
}

export const THROW_ARMS: ThrowArmsSpec = {
  id: "throw_arms",
  source: `${E}/arms-throwing/arms_throwing.glb`,
  fps: 30,
  clips: {
    ready: [0, 0],
    windup: [0, 3],
    throw: [3, 5],
    follow: [5, 13],
    recover: [13, 20],
  },
  releaseFrame: 4.5,
  nodes: {
    body: "R_wrist_025",
    rightShoulder: "R_arm_023",
    rightHand: "R_wrist_025",
    leftShoulder: "L_arm_01",
    leftHand: "L_wrist_03",
  },
  gripJoints: /^R_(thumb2|point1|point2|middle1|middle2|ring1|ring2|pink1|pink2)_\d+$/,
  maxTriangles: THROWABLE_TRIS,
  credit: "djmaesen-arms-throwing",
};

const CC_BY = { license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attributionRequired: true };
const CONVERTED = "Converted, resized and compressed for twobullets.";

export const EQUIPMENT_CREDITS: readonly Credit[] = [
  {
    id: "djmaesen-arms-throwing",
    title: "Arms throwing",
    author: "DJMaesen",
    authorUrl: "https://sketchfab.com/bumstrum",
    url: "https://sketchfab.com/3d-models/arms-throwing-1f9a5c717aae4d0f9b77232b7da4b875",
    ...CC_BY,
    notes: "Converted, compressed and split into throw phases for twobullets.",
  },
  {
    id: "firewarden3d-m67",
    title: "M67",
    author: "Firewarden3D",
    authorUrl: "https://sketchfab.com/Firewarden",
    url: "https://sketchfab.com/3d-models/m67-52dc34ff97984927b0322326e3171467",
    ...CC_BY,
    notes: `${CONVERTED} Simplified slightly.`,
  },
  {
    id: "vanillatography-m18",
    title: "M18 Smoke Grenade",
    author: "Vanillatography",
    authorUrl: "https://sketchfab.com/vanillatography",
    url: "https://sketchfab.com/3d-models/m18-smoke-grenade-46343925ad0e47cf927e66da7953c372",
    ...CC_BY,
    notes: `${CONVERTED} Normal map converted to OpenGL orientation.`,
  },
  {
    id: "vanillatography-m84",
    title: 'M84 Stun Grenade "Flashbang"',
    author: "Vanillatography",
    authorUrl: "https://sketchfab.com/vanillatography",
    url: "https://sketchfab.com/3d-models/m84-stun-grenade-flashbang-3dbda8fe68ff4efdbf59f7d414c5619c",
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "godlike-molotov",
    title: "Molotov Cocktail",
    author: "godlike",
    authorUrl: "https://sketchfab.com/thisisruslan",
    url: "https://sketchfab.com/3d-models/molotov-cocktail-d78c0bfaf7e2448cbd98a485ab079ad2",
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "dwalsh-bandage",
    title: "Bandage Game Ready",
    author: "dwalsh",
    authorUrl: "https://sketchfab.com/dwalsh",
    url: "https://sketchfab.com/3d-models/bandage-game-ready-1ef457cb19484eb7bf826dd0bb973ede",
    ...CC_BY,
    notes: `${CONVERTED} Printed product label painted out.`,
  },
  {
    id: "ruskoschey-first-aid-kit",
    title: "Tactical FIRST AID KIT",
    author: "Ruslan Koschey",
    authorUrl: "https://sketchfab.com/ruskoschey",
    url: "https://sketchfab.com/3d-models/tactical-first-aid-kit-011c33c121284bc88bb765a85511dae1",
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "polyhaven-medical-box",
    title: "Medical Box",
    author: "Ulan Cabanilla (Poly Haven)",
    authorUrl: "https://polyhaven.com",
    url: "https://polyhaven.com/a/medical_box",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    attributionRequired: false,
    notes: CONVERTED,
  },
  {
    id: "dwalsh-energy-drink",
    title: "Energy Drink Game Ready Model",
    author: "dwalsh",
    authorUrl: "https://sketchfab.com/dwalsh",
    url: "https://sketchfab.com/3d-models/energy-drink-game-ready-model-83676feb8b0a4589952cf3676299311b",
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "blender3d-pain-pills",
    title: "Simple Pain Pills",
    author: "Blender3D",
    authorUrl: "https://sketchfab.com/Blender3D",
    url: "https://sketchfab.com/3d-models/simple-pain-pills-e8ff733b5a184335aac1e59d4c0820e0",
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "shamanoff-helmet",
    title: "Combat helmet K6-3",
    author: "shamanoff",
    authorUrl: "https://sketchfab.com/shamanoff",
    url: "https://sketchfab.com/3d-models/combat-helmet-k6-3-94701874d8b949718708b018c8d4f61d",
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "exactly-vest",
    title: "Tactical Plate Carrier Vest - Game Ready",
    author: "Exactly",
    authorUrl: "https://sketchfab.com/txyrm70",
    url: "https://sketchfab.com/3d-models/tactical-plate-carrier-vest-game-ready-3b51e6329dbb4b0aa14e43f12eb6c42a",
    ...CC_BY,
    notes: CONVERTED,
  },
  {
    id: "danlyvostok-backpack",
    title: "Low Poly Game Ready Military Tactical Backpack",
    author: "DanlyVostok",
    authorUrl: "https://sketchfab.com/1799danly",
    url: "https://sketchfab.com/3d-models/low-poly-game-ready-military-tactical-backpack-95a4fc7300584384b56ce3add58dbc9f",
    ...CC_BY,
    notes: `${CONVERTED} Retopology of the "Military Tactical Backpack" scan by Liam3D (CC BY 4.0): https://sketchfab.com/3d-models/military-tactical-backpack-9fa2da2c42234b58896e8d23393cac24`,
  },
  {
    id: "dt7-ammo-cans",
    title: "AmmoCans_GameReady_Animated_PBR_FREE!",
    author: "Alexandr Chub",
    authorUrl: "https://sketchfab.com/DT7",
    url: "https://sketchfab.com/3d-models/ammocans-gameready-animated-pbr-free-4d14272e44bd4bb6898d91b223296606",
    ...CC_BY,
    notes: `${CONVERTED} Original: https://sketchfab.com/3d-models/ammocans-gameready-animated-pbr-free-4d14272e44bd4bb6898d91b223296606`,
  },
];
