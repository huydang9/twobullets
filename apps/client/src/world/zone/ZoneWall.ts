import { Color3, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Texture, type Scene } from "@babylonjs/core";
import type { ZoneCircle } from "@twobullets/shared";

/** Wall bottom and height, m: from below the lowest valley to well above the watchtower. */
const WALL_BOTTOM = -80;
const WALL_HEIGHT = 480;
/** Stripe texture repeats every this many meters around the circle and up the wall. */
const STRIPE_METERS = 24;
const COLOR = new Color3(0.26, 0.52, 1);
/** Opacity far from the wall and right at it (closer reads stronger, like PUBG's blue wall). */
const ALPHA_FAR = 0.16;
const ALPHA_NEAR = 0.42;
const NEAR_METERS = 60;
const FAR_METERS = 600;
/** Drift of the stripes, texture units per second. */
const DRIFT_U = 0.012;
const DRIFT_V = 0.05;

/**
 * The zone boundary in the world (docs/bots/design.md §10): one open, double-sided translucent cylinder at the current
 * circle with slowly drifting stripes. Radius and centre are scaling/position writes per frame; no allocations, no
 * lighting, no fog, no depth write.
 */
export class ZoneWall {
  private readonly mesh: Mesh;
  private readonly material: StandardMaterial;
  private readonly texture: DynamicTexture;
  private time = 0;

  constructor(scene: Scene) {
    this.mesh = MeshBuilder.CreateCylinder("zoneWall", { height: 1, diameter: 2, tessellation: 160, cap: Mesh.NO_CAP }, scene);
    this.mesh.isPickable = false;
    this.mesh.applyFog = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.alphaIndex = 1000;
    this.mesh.doNotSyncBoundingInfo = true;

    this.texture = createStripeTexture(scene);
    const material = new StandardMaterial("zoneWall", scene);
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.fogEnabled = false;
    material.disableDepthWrite = true;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.emissiveColor = COLOR;
    material.opacityTexture = this.texture;
    material.alpha = ALPHA_FAR;
    this.material = material;
    this.mesh.material = material;
    this.mesh.setEnabled(false);
  }

  /** Per frame. `circle` null hides the wall. `viewX/viewZ` is the camera, for distance-based opacity. */
  update(dt: number, circle: ZoneCircle | null, viewX: number, viewZ: number): void {
    if (!circle || circle.r <= 0.5) {
      if (this.mesh.isEnabled()) this.mesh.setEnabled(false);
      return;
    }
    if (!this.mesh.isEnabled()) this.mesh.setEnabled(true);
    this.time += dt;
    const mesh = this.mesh;
    mesh.position.set(circle.cx, WALL_BOTTOM + WALL_HEIGHT / 2, circle.cz);
    mesh.scaling.set(circle.r, WALL_HEIGHT, circle.r);

    const texture = this.texture;
    texture.uScale = Math.max(1, Math.round((2 * Math.PI * circle.r) / STRIPE_METERS));
    texture.vScale = WALL_HEIGHT / STRIPE_METERS;
    texture.uOffset = (this.time * DRIFT_U) % 1;
    texture.vOffset = (this.time * DRIFT_V) % 1;

    const dx = viewX - circle.cx;
    const dz = viewZ - circle.cz;
    const fromWall = Math.abs(Math.sqrt(dx * dx + dz * dz) - circle.r);
    const t = Math.min(1, Math.max(0, (fromWall - NEAR_METERS) / (FAR_METERS - NEAR_METERS)));
    this.material.alpha = ALPHA_NEAR + (ALPHA_FAR - ALPHA_NEAR) * t;
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/** Soft diagonal bands with a brighter bottom edge, drawn once (alpha from RGB). */
function createStripeTexture(scene: Scene): DynamicTexture {
  const size = 128;
  const texture = new DynamicTexture("zoneWallStripes", { width: size, height: size }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.getAlphaFromRGB = true;
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Diagonal band pattern, tileable: phase repeats once per texture in both axes.
      const phase = ((x + y) / size) * Math.PI * 2 * 2;
      const band = 0.55 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin(phase), 3);
      const grain = 0.9 + 0.1 * Math.sin((x * 7.3 + y * 3.1) * 0.21);
      const v = Math.round(255 * Math.min(1, band * grain));
      const i = (y * size + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  texture.update(false);
  return texture;
}
