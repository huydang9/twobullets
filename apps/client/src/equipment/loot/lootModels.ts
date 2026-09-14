import { Color3, Matrix, Mesh, MeshBuilder, MultiMaterial, PBRMaterial, VertexBuffer, VertexData, type Material, type Scene, type TransformNode } from "@babylonjs/core";
import { ITEMS, type AmmoItemId, type ArmorLevel, type ConsumableItemId, type ItemId, type ThrowableKind, type WeaponId } from "@twobullets/shared";
import type { AssetLibrary, EquipmentModelId } from "../../assets";

/**
 * Ground-loot meshes, one template per item id: lying at rest, meters, origin on the floor contact point (+Y up).
 * Weapons reuse the gun body of the first-person GLBs; throwables and consumables come from the presentation layer's
 * {@link LootModelFactory} when it provides them; helmets, vests, backpacks and ammo use the equipment models
 * (`equipment/*.glb`) when they loaded. Everything else (and any missing model) is a small procedural, vertex-coloured
 * stand-in sharing one material.
 */

/** Throwable/consumable models built by the equipment presentation (grenades in hand, heal props). */
export interface LootModelFactory {
  /**
   * A template mesh for the item lying on the ground (rest pose, meters, origin at the floor contact), or null to use the
   * placeholder. The loot renderer takes ownership: it merges, instances and disposes it.
   */
  createLootModel(itemId: ThrowableKind | ConsumableItemId, scene: Scene): Mesh | null;
}

type Rgb = readonly [number, number, number];

const COLOR = {
  olive: [0.2, 0.23, 0.13],
  oliveLight: [0.3, 0.32, 0.2],
  tan: [0.42, 0.36, 0.24],
  black: [0.06, 0.065, 0.06],
  steel: [0.32, 0.33, 0.33],
  white: [0.75, 0.74, 0.7],
  red: [0.55, 0.06, 0.05],
  brass: [0.62, 0.46, 0.18],
  glass: [0.2, 0.13, 0.06],
  cloth: [0.62, 0.58, 0.48],
  teal: [0.05, 0.3, 0.36],
  orange: [0.7, 0.3, 0.05],
} as const satisfies Record<string, Rgb>;

/** Gear colour by level: worn tan, olive, black. */
const LEVEL_COLOR: Readonly<Record<ArmorLevel, Rgb>> = { 1: COLOR.tan, 2: COLOR.olive, 3: COLOR.black };

const AMMO_COLOR: Readonly<Record<AmmoItemId, Rgb>> = {
  ammo_556: [0.22, 0.28, 0.14],
  ammo_762: [0.3, 0.12, 0.07],
  ammo_9mm: [0.45, 0.36, 0.14],
  ammo_12g: [0.5, 0.07, 0.05],
};

/** Builds a template for `itemId`, or null if the item has no ground model (never for catalog items). */
export function createLootTemplate(itemId: ItemId, scene: Scene, sources: { readonly assets?: AssetLibrary | null; readonly models?: LootModelFactory | null }): Mesh {
  const def = ITEMS[itemId];
  let mesh: Mesh | null = null;
  switch (def.category) {
    case "weapon":
      mesh = sources.assets ? extractGun(sources.assets, def.weaponId) : null;
      mesh ??= placeholderGun(scene, def.weaponId);
      break;
    case "throwable":
    case "heal":
    case "boost":
      mesh = normalizeExternal(sources.models?.createLootModel(def.id, scene) ?? null) ?? PLACEHOLDERS[def.id](scene);
      break;
    case "ammo":
      mesh = gear(sources.assets, "ammo_can", itemId, AMMO_TINT[def.id]) ?? ammoBox(scene, def.id);
      break;
    case "helmet":
      mesh = gear(sources.assets, "helmet", itemId, LEVEL_TINT[def.level]) ?? helmet(scene, def.level);
      break;
    case "vest":
      mesh = gear(sources.assets, "vest", itemId, LEVEL_TINT[def.level]) ?? vest(scene, def.level);
      break;
    case "backpack":
      mesh = gear(sources.assets, "backpack", itemId, LEVEL_TINT[def.level]) ?? backpack(scene, def.level);
      break;
  }
  mesh.name = `loot_${itemId}`;
  mesh.isPickable = false;
  return mesh;
}

/** True for meshes built here from parts with vertex colours (they share the loot material). */
export function usesLootMaterial(mesh: Mesh): boolean {
  return mesh.metadata?.lootVertexColors === true;
}

// ---- Weapons -------------------------------------------------------------------------------------------------------

/**
 * The first-person GLB is arms plus gun; the gun (`nodes.body` and its parts) is merged at the idle pose, like the
 * soldiers' third-person rifle (targets/SoldierResources.ts), then laid on its side on the floor.
 */
function extractGun(assets: AssetLibrary, id: WeaponId): Mesh | null {
  const weapon = assets.instantiateWeapon(id);
  try {
    const idle = weapon.asset.clips.idle;
    if (idle) weapon.goToFrame(idle[0]);
    computeWorldMatrices(weapon.root);
    const parts = weapon.nodes.body.getChildMeshes(false).filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
    if (parts.length === 0) return null;
    const mesh = mergeStatic(parts, `loot_${id}`, weapon.root.getScene());
    layOnSide(mesh);
    return mesh;
  } catch (error) {
    console.warn(`[loot] no ground model for ${id}; using a placeholder`, error);
    return null;
  } finally {
    weapon.dispose();
  }
}

/** Vertex attributes kept on merged gun parts when every part has them (bones and extra UV sets are dropped). */
const GUN_ATTRIBUTES = [VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind, VertexBuffer.TangentKind] as const;

/**
 * Bakes posed parts into one static mesh (a sub-mesh per material). Works on copies of the vertex data, since the parts
 * share geometry with the viewmodel's templates, and keeps only attributes every part has (MergeMeshes requires it).
 */
function mergeStatic(parts: readonly Mesh[], name: string, scene: Scene): Mesh {
  const kinds = GUN_ATTRIBUTES.filter((kind) => parts.every((part) => part.isVerticesDataPresent(kind)));
  const copies = parts.map((part) => {
    const data = new VertexData();
    for (const kind of kinds) data.set(part.getVerticesData(kind, true, true)!, kind);
    data.indices = part.getIndices(true, true);
    data.transform(part.computeWorldMatrix(true));
    const copy = new Mesh(`${name}_part`, scene);
    data.applyToMesh(copy);
    copy.material = part.material;
    return copy;
  });
  const multiMaterial = new Set(parts.map((part) => part.material)).size > 1;
  return Mesh.MergeMeshes(copies, true, true, undefined, false, multiMaterial)!;
}

/** Gun space is +Z forward, +Y up: roll it onto its left side, centred, resting on y = 0. */
function layOnSide(mesh: Mesh): void {
  const center = mesh.getBoundingInfo().boundingBox.center;
  mesh.bakeTransformIntoVertices(Matrix.Translation(-center.x, -center.y, -center.z).multiply(Matrix.RotationZ(Math.PI / 2)));
  mesh.refreshBoundingInfo();
  const min = mesh.getBoundingInfo().boundingBox.minimum;
  mesh.bakeTransformIntoVertices(Matrix.Translation(0, -min.y, 0));
  mesh.refreshBoundingInfo();
}

// ---- Gear models ---------------------------------------------------------------------------------------------------

/**
 * Resting pose on the floor: XYZ rotation (radians, item space) and a vertical squash. The helmet sits on its rim and
 * the ammo can stands; the vest lies on its back and the pack on its harness, flattened because the models keep the
 * worn, filled shape (a real carrier or empty pack slumps).
 */
const GEAR_REST: Readonly<Record<"helmet" | "vest" | "backpack" | "ammo_can", { readonly rotation: readonly [number, number, number]; readonly squash: number }>> = {
  helmet: { rotation: [0, 0, 0], squash: 1 },
  vest: { rotation: [Math.PI / 2, 0, 0], squash: 0.4 },
  backpack: { rotation: [-Math.PI / 2, 0, 0], squash: 0.55 },
  ammo_can: { rotation: [0, 0, 0], squash: 1 },
};

/**
 * One model serves every level, so levels read by tint (albedo multiplier on a material copy): level 1 worn tan, level 2
 * olive, level 3 the model's own colours. Values above 1 brighten the dark source textures.
 */
const LEVEL_TINT: Readonly<Record<ArmorLevel, Rgb | null>> = { 1: [1.7, 1.45, 1.05], 2: [1.05, 1.2, 0.8], 3: null };

/** Ammo cans tinted per calibre so piles stay readable. */
const AMMO_TINT: Readonly<Record<AmmoItemId, Rgb | null>> = {
  ammo_556: null,
  ammo_762: [1.25, 0.9, 0.75],
  ammo_9mm: [1.3, 1.2, 0.8],
  ammo_12g: [1.35, 0.7, 0.6],
};

const tintedMaterials = new Map<string, Material>();

function gear(assets: AssetLibrary | null | undefined, model: keyof typeof GEAR_REST, itemId: ItemId, tint: Rgb | null): Mesh | null {
  if (!assets?.hasEquipment(model as EquipmentModelId)) return null;
  try {
    const mesh = assets.createEquipmentMesh(model as EquipmentModelId, `loot_${itemId}`);
    if (!mesh) return null;
    const { rotation, squash } = GEAR_REST[model];
    mesh.bakeTransformIntoVertices(Matrix.RotationYawPitchRoll(rotation[1], rotation[0], rotation[2]).multiply(Matrix.Scaling(1, squash, 1)));
    mesh.refreshBoundingInfo();
    const box = mesh.getBoundingInfo().boundingBox;
    mesh.bakeTransformIntoVertices(Matrix.Translation(-box.center.x, -box.minimum.y, -box.center.z));
    mesh.refreshBoundingInfo();
    if (tint && mesh.material) mesh.material = tinted(mesh.material, tint);
    return mesh;
  } catch (error) {
    console.warn(`[loot] ${model} model failed; using a placeholder`, error);
    return null;
  }
}

/** A cached copy of `material` (or of each sub-material) with its albedo multiplied by `tint`. */
function tinted(material: Material, tint: Rgb): Material {
  const key = `${material.uniqueId}:${tint.join(",")}`;
  let copy = tintedMaterials.get(key);
  if (copy) return copy;
  if (material instanceof MultiMaterial) {
    const multi = new MultiMaterial(`${material.name}_tint`, material.getScene());
    multi.subMaterials = material.subMaterials.map((sub) => (sub ? tinted(sub, tint) : sub));
    copy = multi;
  } else if (material instanceof PBRMaterial) {
    const pbr = material.clone(`${material.name}_tint`);
    pbr.albedoColor = new Color3(pbr.albedoColor.r * tint[0], pbr.albedoColor.g * tint[1], pbr.albedoColor.b * tint[2]);
    copy = pbr;
  } else {
    copy = material;
  }
  tintedMaterials.set(key, copy);
  return copy;
}

function normalizeExternal(mesh: Mesh | null): Mesh | null {
  if (!mesh) return null;
  mesh.setEnabled(true);
  mesh.parent = null;
  return mesh;
}

function computeWorldMatrices(root: TransformNode): void {
  root.computeWorldMatrix(true);
  for (const node of root.getDescendants(false)) node.computeWorldMatrix(true);
}

// ---- Procedural parts ----------------------------------------------------------------------------------------------

/** Collects coloured primitive parts and merges them into one vertex-coloured template. */
class Parts {
  private readonly meshes: Mesh[] = [];

  constructor(private readonly scene: Scene) {}

  box(size: readonly [number, number, number], at: readonly [number, number, number], color: Rgb, rotationY = 0): this {
    const mesh = MeshBuilder.CreateBox("lootPart", { width: size[0], height: size[1], depth: size[2] }, this.scene);
    return this.add(mesh, at, color, [0, rotationY, 0]);
  }

  /** Cylinder along Y, or lying along X/Z. */
  cylinder(height: number, diameter: number, at: readonly [number, number, number], color: Rgb, axis: "y" | "x" | "z" = "y", top = diameter): this {
    const mesh = MeshBuilder.CreateCylinder("lootPart", { height, diameterBottom: diameter, diameterTop: top, tessellation: 12 }, this.scene);
    return this.add(mesh, at, color, axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0]);
  }

  sphere(diameter: number, at: readonly [number, number, number], color: Rgb, scaleY = 1, slice = 1): this {
    const mesh = MeshBuilder.CreateSphere("lootPart", { diameter, segments: 8, slice, sideOrientation: slice < 1 ? Mesh.DOUBLESIDE : Mesh.FRONTSIDE }, this.scene);
    mesh.scaling.y = scaleY;
    return this.add(mesh, at, color, [0, 0, 0]);
  }

  build(): Mesh {
    const mesh = Mesh.MergeMeshes(this.meshes, true, true)!;
    mesh.metadata = { lootVertexColors: true };
    return mesh;
  }

  private add(mesh: Mesh, at: readonly [number, number, number], color: Rgb, rotation: readonly [number, number, number]): this {
    mesh.position.set(at[0], at[1], at[2]);
    mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    const colors = new Float32Array(mesh.getTotalVertices() * 4);
    for (let i = 0; i < colors.length; i += 4) colors.set([color[0], color[1], color[2], 1], i);
    mesh.setVerticesData(VertexBuffer.ColorKind, colors);
    this.meshes.push(mesh);
    return this;
  }
}

function placeholderGun(scene: Scene, id: WeaponId): Mesh {
  const length = id === "pistol" ? 0.2 : id === "sniper" ? 1.1 : id === "shotgun" ? 0.95 : 0.85;
  const parts = new Parts(scene).box([0.05, 0.06, length], [0, 0.03, 0], COLOR.black);
  if (id !== "pistol") parts.box([0.045, 0.14, 0.05], [0, 0.07, -length * 0.1], COLOR.black).box([0.05, 0.08, length * 0.28], [0, 0.04, -length * 0.4], COLOR.steel);
  return parts.build();
}

function ammoBox(scene: Scene, id: AmmoItemId): Mesh {
  return new Parts(scene)
    .box([0.2, 0.1, 0.12], [0, 0.05, 0], AMMO_COLOR[id])
    .box([0.12, 0.004, 0.08], [0, 0.101, 0], COLOR.brass)
    .build();
}

function helmet(scene: Scene, level: ArmorLevel): Mesh {
  const color = LEVEL_COLOR[level];
  const parts = new Parts(scene).sphere(0.25, [0, 0, 0], color, 0.78, 0.5).cylinder(0.012, 0.255, [0, 0.006, 0], COLOR.black);
  // Level 3 gets the visor mount and side rails of a modern shell.
  if (level === 3) parts.box([0.05, 0.03, 0.02], [0, 0.13, 0.115], COLOR.steel).box([0.012, 0.03, 0.12], [0.118, 0.05, 0], COLOR.steel).box([0.012, 0.03, 0.12], [-0.118, 0.05, 0], COLOR.steel);
  return parts.build();
}

function vest(scene: Scene, level: ArmorLevel): Mesh {
  const color = LEVEL_COLOR[level];
  const pouch = level === 1 ? COLOR.oliveLight : color;
  const parts = new Parts(scene)
    .box([0.44, 0.05, 0.52], [0, 0.025, 0], color)
    .box([0.16, 0.012, 0.18], [0, 0.056, 0.24], COLOR.black)
    .box([0.1, 0.045, 0.12], [-0.12, 0.072, -0.08], pouch)
    .box([0.1, 0.045, 0.12], [0.12, 0.072, -0.08], pouch);
  if (level >= 2) parts.box([0.1, 0.045, 0.12], [0, 0.072, -0.08], pouch);
  if (level === 3) parts.box([0.38, 0.02, 0.2], [0, 0.06, 0.1], COLOR.black);
  return parts.build();
}

function backpack(scene: Scene, level: ArmorLevel): Mesh {
  const color = LEVEL_COLOR[level];
  const height = 0.36 + level * 0.06;
  const parts = new Parts(scene)
    .box([0.32, 0.16, height], [0, 0.08, 0], color)
    .box([0.26, 0.06, height * 0.4], [0, 0.19, -height * 0.18], color)
    .box([0.05, 0.02, height * 0.8], [-0.09, 0.01, 0], COLOR.black)
    .box([0.05, 0.02, height * 0.8], [0.09, 0.01, 0], COLOR.black);
  if (level >= 2) parts.box([0.06, 0.1, height * 0.45], [0.19, 0.06, 0], color).box([0.06, 0.1, height * 0.45], [-0.19, 0.06, 0], color);
  return parts.build();
}

/** Stand-ins until the presentation layer's models exist. */
const PLACEHOLDERS: Readonly<Record<ThrowableKind | ConsumableItemId, (scene: Scene) => Mesh>> = {
  frag: (scene) => new Parts(scene).sphere(0.065, [0, 0.036, 0], COLOR.olive, 1.1).cylinder(0.025, 0.022, [0, 0.075, 0], COLOR.steel).build(),
  smoke: (scene) => new Parts(scene).cylinder(0.13, 0.06, [0, 0.03, 0], COLOR.oliveLight, "x").cylinder(0.02, 0.062, [0.02, 0.03, 0], COLOR.white, "x").build(),
  flash: (scene) => new Parts(scene).cylinder(0.12, 0.045, [0, 0.0225, 0], COLOR.black, "x").cylinder(0.03, 0.047, [-0.02, 0.0225, 0], COLOR.steel, "x").build(),
  molotov: (scene) =>
    new Parts(scene)
      .cylinder(0.16, 0.07, [0, 0.035, 0], COLOR.glass, "z")
      .cylinder(0.06, 0.026, [0, 0.035, 0.11], COLOR.glass, "z")
      .cylinder(0.05, 0.03, [0, 0.035, 0.16], COLOR.cloth, "z")
      .build(),
  bandage: (scene) => new Parts(scene).cylinder(0.07, 0.055, [0, 0.0275, 0], COLOR.cloth, "x").build(),
  first_aid: (scene) =>
    new Parts(scene)
      .box([0.18, 0.06, 0.12], [0, 0.03, 0], COLOR.white)
      .box([0.08, 0.004, 0.022], [0, 0.062, 0], COLOR.red)
      .box([0.022, 0.004, 0.08], [0, 0.062, 0], COLOR.red)
      .build(),
  medkit: (scene) =>
    new Parts(scene)
      .box([0.3, 0.12, 0.2], [0, 0.06, 0], COLOR.red)
      .box([0.12, 0.004, 0.035], [0, 0.122, 0], COLOR.white)
      .box([0.035, 0.004, 0.12], [0, 0.122, 0], COLOR.white)
      .box([0.1, 0.03, 0.02], [0, 0.13, 0], COLOR.black)
      .build(),
  energy_drink: (scene) => new Parts(scene).cylinder(0.12, 0.055, [0, 0.06, 0], COLOR.teal).cylinder(0.008, 0.05, [0, 0.124, 0], COLOR.steel).build(),
  painkiller: (scene) => new Parts(scene).cylinder(0.08, 0.042, [0, 0.021, 0], COLOR.white, "x").cylinder(0.022, 0.044, [0.05, 0.021, 0], COLOR.orange, "x").build(),
};
