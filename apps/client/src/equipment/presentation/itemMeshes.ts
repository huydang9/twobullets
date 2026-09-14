import { Color3, CreateBox, CreateCylinder, CreateSphere, CreateTorus, Matrix, Mesh, PBRMaterial, TransformNode, Vector3, type Scene } from "@babylonjs/core";
import type { ConsumableItemId, ThrowableKind } from "@twobullets/shared";
import { AssetLibrary, type EquipmentModelInstance, type EquipmentPartRole } from "../../assets";

/** Anything the hands can hold: a throwable or a consumable. */
export type HeldItemKind = ThrowableKind | ConsumableItemId;

/**
 * One item in the hands: the body plus the separately animated grenade parts. Local space: meters, +Y is the
 * grenade's fuse axis (item "up"), −Z faces the viewer in the default hold, origin at the grip centre.
 */
export interface HeldItem {
  readonly kind: HeldItemKind;
  readonly root: TransformNode;
  readonly meshes: readonly Mesh[];
  /** Grenade lever; flies off on cook or release. */
  readonly spoon: TransformNode | null;
  /** Pin and ring; pulled off by the left hand. */
  readonly ring: TransformNode | null;
  /** Rest transforms of the animated parts (in their parent's space). */
  readonly spoonRest: Vector3;
  readonly ringRest: Vector3;
  /** Molotov rag tip, local space (flame emitter), else null. */
  readonly flameTip: Vector3 | null;
  /** True for the downloaded model, false for the procedural stand-in. */
  readonly real: boolean;
}

export interface ThrowableShape {
  /** Radius used for rolling spin, m. */
  readonly rollRadius: number;
  /** Lies on its side at rest (a can or bottle) rather than rolling like a ball. */
  readonly cylinder: boolean;
  /** Rag tip of a thrown molotov, local space. */
  readonly flameTip: Vector3 | null;
}

/** Procedural shapes (the fallback); `ItemMeshLibrary.shape` measures the real models instead. */
export const THROWABLE_SHAPE: Readonly<Record<ThrowableKind, ThrowableShape>> = {
  frag: { rollRadius: 0.032, cylinder: false, flameTip: null },
  smoke: { rollRadius: 0.031, cylinder: true, flameTip: null },
  flash: { rollRadius: 0.022, cylinder: true, flameTip: null },
  molotov: { rollRadius: 0.035, cylinder: true, flameTip: new Vector3(0, 0.16, 0) },
};

/**
 * How a real model rests as ground loot: XYZ rotation (radians) applied in item space before it is dropped onto the
 * floor. Grenades, cans and bottles lie on their side; flat packs lie on their face.
 */
const LOOT_REST: Readonly<Record<HeldItemKind, readonly [number, number, number]>> = {
  frag: [0, 0, Math.PI / 2],
  smoke: [0, 0, Math.PI / 2],
  flash: [0, 0, Math.PI / 2],
  molotov: [0, 0, Math.PI / 2],
  bandage: [Math.PI / 2, 0, 0],
  first_aid: [Math.PI / 2, 0, 0],
  medkit: [0, 0, 0],
  energy_drink: [0, 0, Math.PI / 2],
  painkiller: [0, 0, Math.PI / 2],
};

type MaterialKey =
  | "olive"
  | "steel"
  | "darkSteel"
  | "yellow"
  | "smokeBand"
  | "hole"
  | "glass"
  | "rag"
  | "cloth"
  | "pouch"
  | "red"
  | "patch"
  | "case"
  | "canGreen"
  | "canBlack"
  | "silver"
  | "amberPlastic"
  | "whitePlastic";

/** Linear albedo, roughness, metallic. Plain PBR: lit by the sun, IBL and shadows like everything else. */
const MATERIALS: Readonly<Record<MaterialKey, readonly [r: number, g: number, b: number, roughness: number, metallic: number]>> = {
  olive: [0.13, 0.15, 0.08, 0.62, 0.05],
  steel: [0.5, 0.5, 0.5, 0.38, 0.9],
  darkSteel: [0.09, 0.09, 0.09, 0.5, 0.6],
  yellow: [0.5, 0.38, 0.05, 0.6, 0],
  smokeBand: [0.62, 0.62, 0.6, 0.7, 0],
  hole: [0.012, 0.012, 0.012, 0.9, 0],
  glass: [0.035, 0.09, 0.04, 0.06, 0],
  rag: [0.36, 0.3, 0.2, 0.95, 0],
  cloth: [0.72, 0.7, 0.64, 0.92, 0],
  pouch: [0.19, 0.18, 0.1, 0.85, 0],
  red: [0.5, 0.02, 0.02, 0.55, 0],
  patch: [0.8, 0.8, 0.78, 0.7, 0],
  case: [0.62, 0.62, 0.6, 0.42, 0],
  canGreen: [0.05, 0.3, 0.1, 0.3, 0.75],
  canBlack: [0.02, 0.02, 0.02, 0.35, 0.6],
  silver: [0.78, 0.78, 0.8, 0.28, 1],
  amberPlastic: [0.42, 0.15, 0.02, 0.22, 0],
  whitePlastic: [0.82, 0.82, 0.8, 0.4, 0],
};

interface Part {
  readonly mesh: Mesh;
  readonly group: "body" | "spoon" | "ring";
}

/**
 * Throwable (frag, smoke, flashbang, molotov) and consumable models: the downloaded, pipeline-built GLBs from the
 * AssetLibrary when they loaded (`equipment/*.glb`), else procedural PBR stand-ins. Throwables have a merged world
 * template (drawn thin-instanced in flight, without pin and ring; the spoon has its own template) and held variants with
 * a separate spoon and pin ring. Real models share the library's template materials; procedural ones share one cache.
 */
export class ItemMeshLibrary {
  private readonly materials = new Map<MaterialKey, PBRMaterial>();
  private readonly owned: (Mesh | TransformNode)[] = [];
  private readonly instances: EquipmentModelInstance[] = [];
  private readonly shapes = new Map<ThrowableKind, ThrowableShape>();

  constructor(
    private readonly scene: Scene,
    private readonly assets: AssetLibrary | null = AssetLibrary.forScene(scene),
  ) {}

  /** True when `kind` is drawn with its downloaded model. */
  hasModel(kind: HeldItemKind): boolean {
    return this.assets?.hasEquipment(kind) ?? false;
  }

  /** Rolling radius, resting style and rag tip of a thrown `kind`, measured from the model in use. */
  shape(kind: ThrowableKind): ThrowableShape {
    let shape = this.shapes.get(kind);
    if (shape) return shape;
    const asset = this.hasModel(kind) ? this.assets!.equipment!.items[kind]! : null;
    if (!asset) {
      shape = THROWABLE_SHAPE[kind];
    } else {
      const { min, max } = asset.bodyBounds;
      const radius = Math.max(max[0] - min[0], max[2] - min[2]) / 2;
      shape = {
        rollRadius: radius,
        cylinder: THROWABLE_SHAPE[kind].cylinder,
        // The rag hangs from the bottle's neck: burn just below the top of the whole model.
        flameTip: kind === "molotov" ? new Vector3(0, asset.bounds.max[1] - 0.02, 0) : null,
      };
    }
    this.shapes.set(kind, shape);
    return shape;
  }

  /** A merged, invisible-until-instanced template of a thrown `kind` (no pin or spoon: they stay behind). */
  createWorldTemplate(kind: ThrowableKind): Mesh {
    const real = this.assets?.hasEquipment(kind) ? this.assets.createEquipmentMesh(kind, `eq_world_${kind}`, ["body"]) : null;
    const mesh = real ?? this.proceduralWorldTemplate(kind);
    // Nothing draws until the caller instances or clones it.
    mesh.isVisible = false;
    mesh.isPickable = false;
    this.owned.push(mesh);
    return mesh;
  }

  /** The spoon alone (item-space rest transform baked), for the lever that flies off a thrown grenade; null if none. */
  createSpoonTemplate(kind: ThrowableKind): Mesh | null {
    if (!this.assets?.hasEquipment(kind) || !this.assets.equipment?.items[kind]?.nodes.spoon) return null;
    const mesh = this.assets.createEquipmentMesh(kind, `eq_spoon_${kind}`, ["spoon"]);
    if (!mesh) return null;
    mesh.isVisible = false;
    this.owned.push(mesh);
    return mesh;
  }

  /** A held copy of `kind` under its own root node, disabled until the caller parents and enables it. */
  createHeld(kind: HeldItemKind): HeldItem {
    const instance = this.assets?.hasEquipment(kind) ? this.instantiate(kind) : null;
    return instance ? this.heldFromInstance(kind, instance) : this.proceduralHeld(kind);
  }

  /**
   * A ground-loot template for a throwable or consumable with its real model (every part, resting on its side or face,
   * origin on the floor contact, +Y up), or null to let the loot code use the procedural path. The caller owns it.
   */
  createLootModel(itemId: HeldItemKind): Mesh | null {
    if (!this.assets?.hasEquipment(itemId)) return null;
    const mesh = this.assets.createEquipmentMesh(itemId, `loot_${itemId}_model`);
    if (!mesh) return null;
    const [x, y, z] = LOOT_REST[itemId];
    restOnFloor(mesh, Matrix.RotationYawPitchRoll(y, x, z));
    return mesh;
  }

  dispose(): void {
    for (const instance of this.instances) instance.dispose();
    for (const node of this.owned) node.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.instances.length = 0;
    this.owned.length = 0;
    this.materials.clear();
  }

  private instantiate(kind: HeldItemKind): EquipmentModelInstance | null {
    try {
      return this.assets?.instantiateEquipment(kind) ?? null;
    } catch (error) {
      console.warn(`[equipment] ${kind}: model instance failed; using the procedural stand-in`, error);
      return null;
    }
  }

  private heldFromInstance(kind: HeldItemKind, instance: EquipmentModelInstance): HeldItem {
    const root = new TransformNode(`eq_held_${kind}`, this.scene);
    root.setEnabled(false);
    instance.root.parent = root;
    this.instances.push(instance);
    this.owned.push(root);
    const meshes = instance.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh);
    for (const mesh of meshes) mesh.isPickable = false;
    const part = (role: EquipmentPartRole) => instance.parts[role] ?? null;
    const spoon = part("spoon");
    const ring = part("ring");
    return {
      kind,
      root,
      meshes,
      spoon,
      ring,
      spoonRest: spoon ? spoon.position.clone() : Vector3.Zero(),
      ringRest: ring ? ring.position.clone() : Vector3.Zero(),
      flameTip: kind === "molotov" ? this.shape("molotov").flameTip : null,
      real: true,
    };
  }

  private proceduralWorldTemplate(kind: ThrowableKind): Mesh {
    const parts = this.buildParts(kind);
    const body: Mesh[] = [];
    for (const part of parts) {
      if (part.group === "body") body.push(part.mesh);
      else part.mesh.dispose();
    }
    return this.merge(`eq_world_${kind}`, body);
  }

  private proceduralHeld(kind: HeldItemKind): HeldItem {
    const parts = this.buildParts(kind);
    const root = new TransformNode(`eq_held_${kind}`, this.scene);
    root.setEnabled(false);
    const body = this.merge(`eq_held_${kind}_body`, parts.filter((p) => p.group === "body").map((p) => p.mesh));
    body.parent = root;
    const spoonParts = parts.filter((p) => p.group === "spoon").map((p) => p.mesh);
    const ringParts = parts.filter((p) => p.group === "ring").map((p) => p.mesh);
    const spoon = spoonParts.length > 0 ? this.merge(`eq_held_${kind}_spoon`, spoonParts) : null;
    const ring = ringParts.length > 0 ? this.merge(`eq_held_${kind}_ring`, ringParts) : null;
    const meshes = [body];
    for (const part of [spoon, ring]) {
      if (!part) continue;
      part.parent = root;
      meshes.push(part);
    }
    this.owned.push(root);
    const shape = kind in THROWABLE_SHAPE ? THROWABLE_SHAPE[kind as ThrowableKind] : null;
    return {
      kind,
      root,
      meshes,
      spoon,
      ring,
      spoonRest: spoon ? spoon.position.clone() : Vector3.Zero(),
      ringRest: ring ? ring.position.clone() : Vector3.Zero(),
      flameTip: shape?.flameTip ?? null,
      real: false,
    };
  }

  private material(key: MaterialKey): PBRMaterial {
    let material = this.materials.get(key);
    if (material) return material;
    const [r, g, b, roughness, metallic] = MATERIALS[key];
    material = new PBRMaterial(`eq_mat_${key}`, this.scene);
    material.albedoColor = new Color3(r, g, b);
    material.roughness = roughness;
    material.metallic = metallic;
    this.materials.set(key, material);
    return material;
  }

  /** Merges parts into one multi-material mesh; the parts' transforms are baked. A single part is kept as is. */
  private merge(name: string, parts: Mesh[]): Mesh {
    const merged = parts.length === 1 ? parts[0]! : Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    if (!merged) throw new Error(`[equipment] could not merge ${name}`);
    if (parts.length === 1) merged.bakeCurrentTransformIntoVertices();
    merged.name = name;
    merged.isPickable = false;
    return merged;
  }

  private buildParts(kind: HeldItemKind): Part[] {
    const parts: Part[] = [];
    const add = (mesh: Mesh, key: MaterialKey, group: Part["group"] = "body", position?: readonly [number, number, number], rotation?: readonly [number, number, number]) => {
      mesh.material = this.material(key);
      if (position) mesh.position.set(position[0], position[1], position[2]);
      if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
      mesh.isPickable = false;
      parts.push({ mesh, group });
    };
    const scene = this.scene;
    const cylinder = (diameter: number, height: number, tessellation = 16, diameterTop = diameter) =>
      CreateCylinder("eq_part", { diameterBottom: diameter, diameterTop, height, tessellation }, scene);
    const box = (width: number, height: number, depth: number) => CreateBox("eq_part", { width, height, depth }, scene);
    const torus = (diameter: number, thickness: number, tessellation = 14) => CreateTorus("eq_part", { diameter, thickness, tessellation }, scene);

    /** Fuse head, lever and pin ring shared by the three grenades; `top` is the body's top height. */
    const fuse = (top: number, bodyRadius: number) => {
      add(cylinder(0.019, 0.02, 12), "steel", "body", [0, top + 0.01, 0]);
      add(cylinder(0.014, 0.006, 10), "darkSteel", "body", [0, top + 0.023, 0]);
      // Lever from the fuse head down the front of the body, bent out at the bottom.
      const leverLength = 0.07;
      add(box(0.013, leverLength, 0.0035), "steel", "spoon", [0, top - leverLength * 0.38, -(bodyRadius + 0.004)], [0.12, 0, 0]);
      add(box(0.013, 0.004, 0.018), "steel", "spoon", [0, top + 0.02, -(bodyRadius * 0.5)], [0, 0, 0]);
      // Pin through the head and the pull ring beside it.
      add(cylinder(0.0028, 0.034, 6), "silver", "ring", [0, top + 0.012, 0], [0, 0, Math.PI / 2]);
      add(torus(0.024, 0.0028), "silver", "ring", [-0.028, top + 0.006, 0], [0, 0, Math.PI / 2 - 0.3]);
    };

    switch (kind) {
      case "frag": {
        const body = CreateSphere("eq_part", { diameter: 0.064, segments: 14 }, scene);
        body.scaling.set(1, 1.1, 1);
        add(body, "olive");
        add(torus(0.064, 0.0022, 20), "yellow", "body", [0, 0.012, 0]);
        add(cylinder(0.024, 0.008, 12), "olive", "body", [0, 0.034, 0]);
        fuse(0.036, 0.024);
        break;
      }
      case "smoke": {
        add(cylinder(0.062, 0.112, 20), "olive", "body", [0, 0, 0]);
        add(cylinder(0.063, 0.022, 20), "smokeBand", "body", [0, 0.03, 0]);
        add(cylinder(0.05, 0.01, 18), "darkSteel", "body", [0, 0.061, 0]);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.4;
          add(cylinder(0.006, 0.003, 8), "hole", "body", [Math.cos(a) * 0.016, 0.0665, Math.sin(a) * 0.016]);
        }
        fuse(0.066, 0.031);
        break;
      }
      case "flash": {
        add(cylinder(0.044, 0.1, 18), "darkSteel", "body", [0, 0, 0]);
        add(cylinder(0.045, 0.014, 18), "olive", "body", [0, 0.01, 0]);
        for (const y of [-0.028, 0.034]) {
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            add(cylinder(0.008, 0.004, 8), "hole", "body", [Math.cos(a) * 0.0215, y, Math.sin(a) * 0.0215], [Math.PI / 2, -a + Math.PI / 2, 0]);
          }
        }
        add(cylinder(0.034, 0.008, 16), "steel", "body", [0, 0.054, 0]);
        fuse(0.058, 0.022);
        break;
      }
      case "molotov": {
        add(cylinder(0.07, 0.13, 18), "glass", "body", [0, -0.005, 0]);
        add(cylinder(0.07, 0.035, 18, 0.028), "glass", "body", [0, 0.0775, 0]);
        add(cylinder(0.026, 0.045, 12), "glass", "body", [0, 0.1175, 0]);
        add(torus(0.03, 0.009, 12), "rag", "body", [0, 0.128, 0]);
        add(cylinder(0.024, 0.03, 10, 0.03), "rag", "body", [0, 0.152, 0]);
        add(box(0.026, 0.075, 0.004), "rag", "body", [0.022, 0.105, -0.012], [0.1, 0.2, 0.45]);
        break;
      }
      case "bandage": {
        add(cylinder(0.05, 0.075, 18), "cloth", "body", [0, 0, 0], [0, 0, Math.PI / 2]);
        add(cylinder(0.014, 0.077, 10), "hole", "body", [0, 0, 0], [0, 0, Math.PI / 2]);
        add(box(0.07, 0.004, 0.07), "cloth", "body", [0, -0.028, -0.03], [-0.5, 0, 0]);
        break;
      }
      case "first_aid": {
        add(box(0.15, 0.1, 0.05), "pouch", "body");
        add(box(0.152, 0.008, 0.052), "darkSteel", "body", [0, 0.046, 0]);
        add(box(0.05, 0.05, 0.002), "patch", "body", [0, -0.005, -0.026]);
        add(box(0.034, 0.01, 0.002), "red", "body", [0, -0.005, -0.0275]);
        add(box(0.01, 0.034, 0.002), "red", "body", [0, -0.005, -0.0275]);
        break;
      }
      case "medkit": {
        add(box(0.22, 0.14, 0.07), "case", "body");
        add(box(0.222, 0.012, 0.072), "darkSteel", "body", [0, 0.0, 0]);
        add(box(0.05, 0.014, 0.002), "red", "body", [0, 0.035, -0.036]);
        add(box(0.014, 0.05, 0.002), "red", "body", [0, 0.035, -0.036]);
        add(box(0.08, 0.012, 0.016), "darkSteel", "body", [0, 0.092, 0]);
        add(box(0.01, 0.024, 0.012), "darkSteel", "body", [-0.035, 0.078, 0]);
        add(box(0.01, 0.024, 0.012), "darkSteel", "body", [0.035, 0.078, 0]);
        break;
      }
      case "energy_drink": {
        add(cylinder(0.053, 0.11, 24), "canGreen", "body", [0, 0, 0]);
        add(cylinder(0.0535, 0.028, 24), "canBlack", "body", [0, 0.015, 0]);
        add(cylinder(0.046, 0.012, 24, 0.044), "silver", "body", [0, 0.061, 0]);
        add(torus(0.045, 0.004, 20), "silver", "body", [0, 0.067, 0]);
        add(cylinder(0.046, 0.01, 24, 0.053), "silver", "body", [0, -0.06, 0]);
        add(box(0.012, 0.002, 0.02), "silver", "body", [0, 0.069, 0.008]);
        break;
      }
      case "painkiller": {
        add(cylinder(0.04, 0.062, 18), "amberPlastic", "body", [0, 0, 0]);
        add(cylinder(0.0405, 0.034, 18), "whitePlastic", "body", [0, -0.004, 0]);
        add(cylinder(0.043, 0.02, 18), "whitePlastic", "body", [0, 0.041, 0]);
        break;
      }
    }
    return parts;
  }
}

/** Bakes `rotation` into the vertices, then centres the mesh on the origin horizontally with its lowest point at y = 0. */
export function restOnFloor(mesh: Mesh, rotation: Matrix): void {
  mesh.bakeTransformIntoVertices(rotation);
  mesh.refreshBoundingInfo();
  const box = mesh.getBoundingInfo().boundingBox;
  mesh.bakeTransformIntoVertices(Matrix.Translation(-box.center.x, -box.minimum.y, -box.center.z));
  mesh.refreshBoundingInfo();
}
