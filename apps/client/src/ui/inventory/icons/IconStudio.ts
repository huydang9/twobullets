import {
  Camera,
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  ImageProcessingConfiguration,
  Matrix,
  Mesh,
  MultiMaterial,
  PBRMaterial,
  RenderTargetTexture,
  Scene,
  SerializationHelper,
  StandardMaterial,
  SubMesh,
  TargetCamera,
  Vector3,
  VertexData,
  type Material,
} from "@babylonjs/core";
import { ITEMS, type AmmoItemId, type ArmorLevel, type ItemId } from "@twobullets/shared";
import type { AssetLibrary, EquipmentModelId } from "../../../assets";
import { createLootTemplate, usesLootMaterial, type LootModelFactory } from "../../../equipment/loot/lootModels";

/** Where item models come from. `scene` is the game scene (the asset templates live there). */
export interface ItemIconSource {
  readonly scene: Scene;
  readonly assets?: AssetLibrary | null;
  /** The presentation's throwable/consumable meshes, used when a downloaded model is missing. */
  readonly models?: LootModelFactory | null;
}

export type IconShape = "square" | "wide";

/** Baked pixel sizes. Rows show icons at ~4em (64 px at 1080p), so these hold up to 4K and 2× DPR. */
export const ICON_PIXELS: Readonly<Record<IconShape, readonly [number, number]>> = { square: [192, 192], wide: [384, 144] };

/** Camera around the item, degrees: yaw 0 looks at the item's front (+Z), 90 at its +X side; pitch looks down. */
export interface IconView {
  yaw: number;
  pitch: number;
}

/** Per model; mutable so DEV tuning can change a view and call `icons.rebake()`. */
export const ICON_VIEWS: Record<EquipmentModelId | "weapon", IconView> = {
  // Side profile, muzzle right.
  weapon: { yaw: 90, pitch: 6 },
  frag: { yaw: 30, pitch: 14 },
  smoke: { yaw: 30, pitch: 14 },
  flash: { yaw: 30, pitch: 14 },
  molotov: { yaw: 25, pitch: 10 },
  bandage: { yaw: 22, pitch: 16 },
  first_aid: { yaw: 32, pitch: 20 },
  medkit: { yaw: 28, pitch: 42 },
  energy_drink: { yaw: 25, pitch: 12 },
  painkiller: { yaw: 25, pitch: 14 },
  helmet: { yaw: 40, pitch: 20 },
  vest: { yaw: 18, pitch: 8 },
  backpack: { yaw: 30, pitch: 12 },
  ammo_can: { yaw: 35, pitch: 24 },
};

/** Studio light rig, relative to the camera. Mutable for DEV tuning. */
export const ICON_LIGHTING = {
  key: 2.6,
  rim: 1.5,
  fill: 0.75,
  environment: 0.9,
  exposure: 1.4,
  contrast: 1.05,
};

type Rgb = readonly [number, number, number];

// Same albedo multipliers as the ground loot (equipment/loot/lootModels.ts), so an icon matches the item on the floor.
const LEVEL_TINT: Readonly<Record<ArmorLevel, Rgb | null>> = { 1: [1.7, 1.45, 1.05], 2: [1.05, 1.2, 0.8], 3: null };
const AMMO_TINT: Readonly<Record<AmmoItemId, Rgb | null>> = { ammo_556: null, ammo_762: [1.25, 0.9, 0.75], ammo_9mm: [1.3, 1.2, 0.8], ammo_12g: [1.35, 0.7, 0.6] };

/** Layer bits of the studio scene; nothing else shares them. */
const ICON_LAYER = 0x10000000;
/** Fraction of the icon left empty around the model on its longer side. */
const PADDING = 0.07;

/** A model copied into the studio, waiting for its shaders. */
export interface StagedIcon {
  readonly itemId: ItemId;
  readonly shape: IconShape;
  readonly mesh: Mesh;
}

export function iconShape(itemId: ItemId): IconShape {
  return ITEMS[itemId].category === "weapon" ? "wide" : "square";
}

/**
 * Offscreen photo studio for inventory icons: a virtual Babylon scene (not in `engine.scenes`, never drawn to the
 * canvas) with its own lights, tone mapping and orthographic camera, rendering one item at a time into a transparent
 * MSAA render target. Models are built in the game scene from the asset templates, then their geometry is copied here
 * with private material copies (textures and the sky IBL are shared, not duplicated). Call `render` after the game
 * scene has rendered, never from inside it.
 */
export class IconStudio {
  private readonly scene: Scene;
  private readonly camera: TargetCamera;
  private readonly key: DirectionalLight;
  private readonly rim: DirectionalLight;
  private readonly fill: HemisphericLight;
  private readonly targets: Record<IconShape, RenderTargetTexture>;

  constructor(private readonly source: ItemIconSource) {
    const engine = source.scene.getEngine();
    const scene = new Scene(engine, { virtual: true });
    // The constructor listens to canvas pointer events; the studio never needs input or picking.
    scene.detachControl();
    scene.skipPointerMovePicking = true;
    scene.autoClear = true;
    scene.fogEnabled = false;
    scene.shadowsEnabled = false;
    scene.particlesEnabled = false;
    scene.spritesEnabled = false;
    scene.postProcessesEnabled = false;
    const imageProcessing = scene.imageProcessingConfiguration;
    imageProcessing.applyByPostProcess = false;
    imageProcessing.toneMappingEnabled = true;
    imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    imageProcessing.ditheringEnabled = false;
    this.scene = scene;

    this.camera = new TargetCamera("iconCamera", new Vector3(0, 0, -2), scene);
    this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.camera.layerMask = ICON_LAYER;
    scene.activeCamera = this.camera;

    this.key = new DirectionalLight("iconKey", new Vector3(0.5, -0.8, 0.3), scene);
    this.rim = new DirectionalLight("iconRim", new Vector3(-0.4, -0.3, -0.8), scene);
    this.fill = new HemisphericLight("iconFill", Vector3.Up(), scene);
    this.fill.groundColor = new Color3(0.18, 0.18, 0.2);
    this.fill.specular = Color3.Black();
    this.rim.diffuse = new Color3(0.92, 0.95, 1);

    const target = (shape: IconShape): RenderTargetTexture => {
      const [width, height] = ICON_PIXELS[shape];
      const rtt = new RenderTargetTexture(`icons_${shape}`, { width, height }, scene, { generateMipMaps: false, samples: 4, generateStencilBuffer: false });
      rtt.clearColor = new Color4(0, 0, 0, 0);
      return rtt;
    };
    this.targets = { square: target("square"), wide: target("wide") };
  }

  /**
   * Builds `itemId`'s model and copies it into the studio, or null when nothing could be built (the caller keeps the
   * fallback icon). Costs one model instantiation and merge in the game scene.
   */
  stage(itemId: ItemId): StagedIcon | null {
    this.applyLighting();
    const built = this.build(itemId);
    if (!built) return null;
    try {
      const mesh = this.transfer(built.mesh, itemId, built.tint, built.vertexColors);
      if (built.view === "weapon" && built.laidOnSide) {
        // Loot guns lie on their left side (lootModels layOnSide); stand them back up.
        mesh.bakeTransformIntoVertices(Matrix.RotationZ(-Math.PI / 2));
        mesh.refreshBoundingInfo();
      }
      const shape = iconShape(itemId);
      mesh.metadata = { view: built.view };
      mesh.setEnabled(false);
      return { itemId, shape, mesh };
    } catch (error) {
      console.warn(`[icons] ${itemId}: copy failed; keeping the fallback icon`, error);
      return null;
    } finally {
      disposeBuilt(built.mesh);
    }
  }

  /** True once every shader the icon needs has compiled for the icon render pass. */
  isReady(staged: StagedIcon): boolean {
    const target = this.targets[staged.shape];
    const brdf = this.scene.environmentBRDFTexture;
    if (brdf && !brdf.isReady()) return false;
    this.frame(staged);
    const engine = this.scene.getEngine();
    const pass = engine.currentRenderPassId;
    engine.currentRenderPassId = target.renderPassId;
    staged.mesh.setEnabled(true);
    try {
      return staged.mesh.isReady(true);
    } finally {
      staged.mesh.setEnabled(false);
      engine.currentRenderPassId = pass;
    }
  }

  /**
   * Renders the staged icon and starts reading it back (bottom-up RGBA rows, premultiplied where translucent). The
   * pixels are captured before the next render, so icons can be rendered back to back.
   */
  render(staged: StagedIcon): Promise<ArrayBufferView> | null {
    const target = this.targets[staged.shape];
    this.frame(staged);
    staged.mesh.setEnabled(true);
    this.camera.outputRenderTarget = target;
    this.scene.activeCamera = this.camera;
    const engine = this.scene.getEngine();
    const pass = engine.currentRenderPassId;
    try {
      this.scene.render(true, true);
      return target.readPixels();
    } finally {
      staged.mesh.setEnabled(false);
      // Scene.render leaves the icon pass current; game code between frames expects the main pass.
      engine.currentRenderPassId = pass;
    }
  }

  release(staged: StagedIcon): void {
    disposeStudioMesh(staged.mesh);
  }

  /** Frees the render targets, lights, material copies and the studio scene (shared textures stay). */
  dispose(): void {
    this.scene.environmentTexture = null;
    for (const material of [...this.scene.materials]) material.dispose(false, false);
    this.scene.dispose();
  }

  // ---- Building ------------------------------------------------------------------------------------------------------

  private build(itemId: ItemId): { mesh: Mesh; view: EquipmentModelId | "weapon"; tint: Rgb | null; vertexColors: boolean; laidOnSide: boolean } | null {
    const { scene, assets, models } = this.source;
    const def = ITEMS[itemId];
    let model: EquipmentModelId | null = null;
    let tint: Rgb | null = null;
    switch (def.category) {
      case "weapon": {
        try {
          const mesh = createLootTemplate(itemId, scene, { assets: assets ?? null, models: null });
          const size = mesh.getBoundingInfo().boundingBox.extendSize;
          return { mesh, view: "weapon", tint: null, vertexColors: usesLootMaterial(mesh), laidOnSide: size.x > size.y };
        } catch (error) {
          console.warn(`[icons] ${itemId}: no gun model`, error);
          return null;
        }
      }
      case "ammo":
        model = "ammo_can";
        tint = AMMO_TINT[def.id];
        break;
      case "helmet":
      case "vest":
      case "backpack":
        model = def.category;
        tint = LEVEL_TINT[def.level];
        break;
      case "throwable":
      case "heal":
      case "boost":
        model = def.id;
        break;
    }
    if (!model) return null;
    if (assets?.hasEquipment(model)) {
      try {
        const mesh = assets.createEquipmentMesh(model, `icon_${itemId}`);
        if (mesh) return { mesh, view: model, tint, vertexColors: false, laidOnSide: false };
      } catch (error) {
        console.warn(`[icons] ${itemId}: model failed; trying the procedural one`, error);
      }
    }
    try {
      // Procedural stand-in (the ground loot's): already tinted by level and calibre through its vertex colours.
      const mesh = createLootTemplate(itemId, scene, { assets: null, models: models ?? null });
      return { mesh, view: model, tint: null, vertexColors: usesLootMaterial(mesh), laidOnSide: false };
    } catch (error) {
      console.warn(`[icons] ${itemId}: no model`, error);
      return null;
    }
  }

  /** Copies geometry (with sub-meshes) into the studio scene and gives it studio copies of its materials. */
  private transfer(source: Mesh, itemId: ItemId, tint: Rgb | null, vertexColors: boolean): Mesh {
    const data = VertexData.ExtractFromMesh(source, true, true);
    data.transform(source.computeWorldMatrix(true));
    const mesh = new Mesh(`icon_${itemId}`, this.scene);
    data.applyToMesh(mesh);
    if (source.subMeshes.length > 1) {
      mesh.subMeshes = [];
      for (const sub of source.subMeshes) new SubMesh(sub.materialIndex, sub.verticesStart, sub.verticesCount, sub.indexStart, sub.indexCount, mesh);
    }
    mesh.layerMask = ICON_LAYER;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.receiveShadows = false;
    mesh.applyFog = false;
    mesh.material = vertexColors || !source.material ? this.plainMaterial(itemId) : this.copyMaterial(source.material, tint);
    mesh.refreshBoundingInfo();
    return mesh;
  }

  private copyMaterial(material: Material, tint: Rgb | null): Material {
    const scene = this.scene;
    if (material instanceof MultiMaterial) {
      const multi = new MultiMaterial(`${material.name}_icon`, scene);
      multi.subMaterials = material.subMaterials.map((sub) => (sub ? this.copyMaterial(sub, tint) : sub));
      return multi;
    }
    if (material instanceof PBRMaterial) {
      // Instanciate shares textures (no GPU copies); colours are cloned before tinting.
      const copy = SerializationHelper.Instanciate(() => new PBRMaterial(`${material.name}_icon`, scene), material);
      copy.albedoColor = material.albedoColor.clone();
      if (tint) copy.albedoColor.set(copy.albedoColor.r * tint[0], copy.albedoColor.g * tint[1], copy.albedoColor.b * tint[2]);
      copy.imageProcessingConfiguration = scene.imageProcessingConfiguration;
      return copy;
    }
    if (material instanceof StandardMaterial) {
      const copy = SerializationHelper.Instanciate(() => new StandardMaterial(`${material.name}_icon`, scene), material);
      copy.diffuseColor = material.diffuseColor.clone();
      if (tint) copy.diffuseColor.set(copy.diffuseColor.r * tint[0], copy.diffuseColor.g * tint[1], copy.diffuseColor.b * tint[2]);
      copy.imageProcessingConfiguration = scene.imageProcessingConfiguration;
      return copy;
    }
    return this.plainMaterial(material.name);
  }

  /** Matte material for vertex-coloured procedural meshes (or unknown material types). */
  private plainMaterial(name: string): PBRMaterial {
    const material = new PBRMaterial(`${name}_iconPlain`, this.scene);
    material.albedoColor = Color3.White();
    material.metallic = 0.1;
    material.roughness = 0.7;
    return material;
  }

  // ---- Framing -------------------------------------------------------------------------------------------------------

  /** Points the camera and the light rig for `staged` and fits the orthographic frustum to its bounds. */
  private frame(staged: StagedIcon): void {
    const view = ICON_VIEWS[(staged.mesh.metadata as { view: EquipmentModelId | "weapon" }).view];
    const box = staged.mesh.getBoundingInfo().boundingBox;
    const center = box.center;
    const radius = Math.max(0.01, box.extendSize.length());
    const yaw = (view.yaw * Math.PI) / 180;
    const pitch = (view.pitch * Math.PI) / 180;
    const toEye = new Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const distance = radius * 3 + 0.2;
    const eye = center.add(toEye.scale(distance));

    const viewMatrix = Matrix.LookAtLH(eye, center, Vector3.Up());
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const corner = new Vector3();
    for (const point of box.vectors) {
      Vector3.TransformCoordinatesToRef(point, viewMatrix, corner);
      minX = Math.min(minX, corner.x);
      maxX = Math.max(maxX, corner.x);
      minY = Math.min(minY, corner.y);
      maxY = Math.max(maxY, corner.y);
      minZ = Math.min(minZ, corner.z);
      maxZ = Math.max(maxZ, corner.z);
    }
    const [pixelsX, pixelsY] = ICON_PIXELS[staged.shape];
    const aspect = pixelsX / pixelsY;
    let width = maxX - minX;
    let height = maxY - minY;
    if (width / height < aspect) width = height * aspect;
    else height = width / aspect;
    width *= 1 + PADDING * 2;
    height *= 1 + PADDING * 2;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const camera = this.camera;
    camera.position.copyFrom(eye);
    camera.setTarget(center);
    camera.orthoLeft = cx - width / 2;
    camera.orthoRight = cx + width / 2;
    camera.orthoBottom = cy - height / 2;
    camera.orthoTop = cy + height / 2;
    camera.minZ = Math.max(0.001, minZ - 0.05);
    camera.maxZ = maxZ + 0.05;

    // Key from the camera's upper left, rim from behind on the right; both follow the camera.
    const forward = center.subtract(eye).normalize();
    const right = Vector3.Cross(Vector3.Up(), forward).normalize();
    const up = Vector3.Cross(forward, right);
    this.key.direction = right.scale(0.55).add(up.scale(-0.75)).add(forward.scale(0.5)).normalize();
    this.rim.direction = right.scale(-0.6).add(up.scale(-0.45)).add(forward.scale(-0.75)).normalize();
  }

  private applyLighting(): void {
    const scene = this.scene;
    const environment = this.source.scene.environmentTexture;
    scene.environmentTexture = environment;
    scene.environmentIntensity = environment ? ICON_LIGHTING.environment : 0;
    this.key.intensity = ICON_LIGHTING.key;
    this.rim.intensity = ICON_LIGHTING.rim;
    this.fill.intensity = environment ? ICON_LIGHTING.fill : ICON_LIGHTING.fill * 2.5;
    scene.imageProcessingConfiguration.exposure = ICON_LIGHTING.exposure;
    scene.imageProcessingConfiguration.contrast = ICON_LIGHTING.contrast;
  }
}

/** Disposes a temporary game-scene model: its own geometry and merge MultiMaterial, never the shared template materials. */
function disposeBuilt(mesh: Mesh): void {
  const material = mesh.material;
  mesh.dispose(false, false);
  if (material instanceof MultiMaterial) material.dispose(false, false, false);
}

function disposeStudioMesh(mesh: Mesh): void {
  const material = mesh.material;
  mesh.dispose(false, false);
  if (material instanceof MultiMaterial) {
    for (const sub of material.subMaterials) sub?.dispose(false, false);
    material.dispose(false, false, false);
  } else {
    material?.dispose(false, false);
  }
}
