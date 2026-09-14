import { Constants, CreatePlane, Matrix, ShaderMaterial, Vector3, type Engine, type Mesh, type Scene, type TargetCamera } from "@babylonjs/core";
import { VIEWMODEL_RENDERING_GROUP } from "./renderGroups";
import { smoothstep } from "./Spring";
import type { RedDotSettings } from "./weaponProfiles";
import type { WeaponRig } from "./WeaponRig";

const REFERENCE_HEIGHT = 1080;
/** Draw after the lens glass (alphaIndex 1) and the viewmodel muzzle flash (0). */
const ALPHA_INDEX = 2;

const VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main() {
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUV;
uniform vec3 color;
uniform float coreRadius;
uniform float pixel;
uniform float intensity;
void main() {
  // r: 0 at the center, 1 at the quad edge (the halo radius).
  float r = length(vUV - 0.5) * 2.0;
  float core = 1.0 - smoothstep(coreRadius - pixel, coreRadius + pixel, r);
  float halo = exp(-r * r * 7.0) * 0.18 + exp(-(r * r) / (coreRadius * coreRadius * 4.0)) * 0.35;
  vec3 rgb = color * (core + halo) + vec3(1.0, 0.55, 0.45) * core * 0.35;
  gl_FragColor = vec4(rgb * intensity, 1.0);
}
`;

/**
 * Collimated red-dot reticle. The dot sits at infinity along the bore, so the eye sees it where a ray parallel to
 * the bore crosses the lens: dead center when aimed, off-center (then gone) as the eye leaves the sight axis.
 * Drawn as an unlit additive quad in camera space at a constant screen size; no fog, no lighting.
 */
export class RedDot {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly engine: Engine;
  private readonly inverseCamera = new Matrix();
  private readonly lens = new Vector3();
  private readonly bore = new Vector3();
  private readonly hit = new Vector3();
  private readonly colorTmp = new Vector3();

  constructor(
    scene: Scene,
    private readonly camera: TargetCamera,
  ) {
    this.engine = scene.getEngine() as Engine;
    this.mesh = CreatePlane("vm_redDot", { size: 1 }, scene);
    this.mesh.parent = camera;
    this.material = new ShaderMaterial(
      "vm_redDot_material",
      scene,
      { vertexSource: VERTEX, fragmentSource: FRAGMENT },
      { attributes: ["position", "uv"], uniforms: ["worldViewProjection", "color", "coreRadius", "pixel", "intensity"], needAlphaBlending: true },
    );
    this.material.alphaMode = Constants.ALPHA_ADD;
    this.material.disableDepthWrite = true;
    this.material.backFaceCulling = false;
    const mesh = this.mesh;
    mesh.material = this.material;
    mesh.renderingGroupId = VIEWMODEL_RENDERING_GROUP;
    mesh.alphaIndex = ALPHA_INDEX;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
    mesh.isVisible = false;
  }

  /** After the viewmodel sockets are current for this frame. */
  update(rig: WeaponRig, settings: RedDotSettings | undefined, visible: boolean): void {
    const mesh = this.mesh;
    if (!settings || !visible || !rig.getLensToRef(this.lens, this.bore)) {
      mesh.isVisible = false;
      return;
    }
    // Camera space: the eye is the origin, +Z forward.
    this.camera.getWorldMatrix().invertToRef(this.inverseCamera);
    Vector3.TransformCoordinatesToRef(this.lens, this.inverseCamera, this.lens);
    Vector3.TransformNormalToRef(this.bore, this.inverseCamera, this.bore);
    this.bore.normalize();
    // Ray from the eye along the bore meets the lens plane (through the lens center, normal = bore) at t.
    const t = Vector3.Dot(this.lens, this.bore);
    if (t < this.camera.minZ * 1.5) {
      mesh.isVisible = false;
      return;
    }
    this.bore.scaleToRef(t, this.hit);
    const offset = Vector3.Distance(this.hit, this.lens) / rig.lensRadius;
    const fade = 1 - smoothstep(0.55, 0.9, offset);
    if (fade <= 0) {
      mesh.isVisible = false;
      return;
    }

    const pixelsPerReference = this.engine.getRenderHeight() / REFERENCE_HEIGHT;
    const quadPx = settings.glowPx * 2;
    // Camera units per reference pixel at depth t (vertical FOV).
    const unitsPerPx = (t * 2 * Math.tan(this.camera.fov / 2)) / REFERENCE_HEIGHT;
    // Just in front of the glass so it never sorts or depth-tests behind the lens.
    mesh.position.set(this.hit.x - this.bore.x * 0.001, this.hit.y - this.bore.y * 0.001, this.hit.z - this.bore.z * 0.001);
    mesh.scaling.setAll(quadPx * unitsPerPx);
    mesh.isVisible = true;

    const [r, g, b] = settings.color;
    this.material.setVector3("color", this.colorTmp.set(r, g, b));
    this.material.setFloat("coreRadius", Math.min(1, settings.diameterPx / quadPx));
    this.material.setFloat("pixel", 1 / Math.max(1, settings.glowPx * pixelsPerReference));
    this.material.setFloat("intensity", fade);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}

