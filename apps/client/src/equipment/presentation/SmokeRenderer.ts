import { Color3, Constants, Mesh, Scene, ShaderMaterial, Vector2, Vector3, VertexData, type Camera, type Texture } from "@babylonjs/core";
import { SMOKE, SMOKE_PUFF_STRIDE, smokePuffs, type SmokeCloud, type Vec3 } from "@twobullets/shared";
import type { Environment } from "../../world/environment";
import { EqCell } from "./equipmentAtlas";
import { EQ_ALPHA_INDEX, SpriteRecord, type EquipmentFx } from "./fxPools";
import { TICK_SECONDS, type EquipmentFxSettings } from "./support";

/** Clouds drawn at once (nearest first when there are more). */
export const MAX_SMOKE_CLOUDS = 16;
const PUFFS = SMOKE.puffCount;
const MAX_PUFFS = MAX_SMOKE_CLOUDS * PUFFS;
/** Puffs containing the camera go to one fullscreen pass instead of stacked fullscreen quads. */
const MAX_INSIDE = 16;
/**
 * Rendered puffs use a soft (Epanechnikov) density profile over SUPPORT × the gameplay radius, scaled so a chord
 * through the centre has the same optical depth as the gameplay's uniform sphere: 1.5 / SUPPORT.
 */
const SUPPORT = 1.25;
/** Puff snapshots are re-derived from the shared rules this often (cloud age), and interpolated in between. */
const SNAPSHOT_SECONDS = 0.1;
const SMOKE_ALBEDO = 0.72;
const FORWARD = new Vector3(0, 0, 1);

const SHARED_GLSL = /* glsl */ `
uniform vec3 cameraPosition;
uniform vec3 sunDir;
uniform vec3 litColor;
uniform vec3 shadeColor;
uniform vec3 bottomColor;
uniform float fogDensity;
uniform vec3 fogColor;
uniform float time;
uniform float debugMode;
uniform sampler2D noiseTex;

const float EXTINCTION = ${SMOKE.extinction.toFixed(4)};
const float SUPPORT = ${SUPPORT.toFixed(4)};

// Analytic optical depth of one soft puff along a ray, clipped to the camera and the cloud's ground plane.
// puff: centre xyz, rendered radius. info: density, floor y, seed, unused.
void integratePuff(vec3 ro, vec3 rd, vec4 puff, vec4 info, inout float tau, inout vec3 light, inout float firstHit) {
  float radius = puff.w;
  vec3 oc = ro - puff.xyz;
  float b = dot(oc, rd);
  float oo = dot(oc, oc);
  float h = b * b - (oo - radius * radius);
  if (h <= 0.0) return;
  h = sqrt(h);
  float t0 = max(-b - h, 0.0);
  float t1 = -b + h;
  float floorY = info.y;
  if (rd.y < -1e-5) t1 = min(t1, (floorY - ro.y) / rd.y);
  else if (rd.y > 1e-5) t0 = max(t0, (floorY - ro.y) / rd.y);
  else if (ro.y < floorY) return;
  if (t1 <= t0) return;

  float depth;
  vec3 mid = ro + rd * (0.5 * (t0 + t1));
  if (debugMode > 0.5) {
    // Gameplay volume: uniform sphere of the unscaled radius (smokeTransmittance).
    float r = radius / SUPPORT;
    float hg = b * b - (oo - r * r);
    if (hg <= 0.0) return;
    hg = sqrt(hg);
    float chord = max(min(-b + hg, t1) - max(-b - hg, t0), 0.0);
    depth = EXTINCTION * info.x * chord;
    tau += depth;
    light += vec3(1.0, 0.0, 1.0) * depth;
    firstHit = min(firstHit, t0);
    return;
  }
  // Integral of (1 - r^2 / R^2) along the ray: t - (t^3 / 3 + b t^2 + |oc|^2 t) / R^2.
  float r2 = radius * radius;
  float i1 = t1 - (t1 * t1 * t1 / 3.0 + b * t1 * t1 + oo * t1) / r2;
  float i0 = t0 - (t0 * t0 * t0 / 3.0 + b * t0 * t0 + oo * t0) / r2;
  float integral = max(i1 - i0, 0.0);

  // Billowing detail: two drifting noise layers, eroding the rim much more than the core.
  vec2 uvA = mid.xz * 0.09 + vec2(time * 0.011 + info.z, info.z * 3.1);
  vec2 uvB = vec2(mid.x - mid.z, mid.y) * 0.14 + vec2(info.z * 5.3, -time * 0.018);
  float n = texture2D(noiseTex, uvA).r * 0.55 + texture2D(noiseTex, uvB).g * 0.45;
  float core = clamp(integral / (1.3333 * radius) * 1.6, 0.0, 1.0);
  float erosion = mix(0.2 + 1.3 * n, 0.8 + 0.4 * n, core);
  depth = EXTINCTION * info.x * (1.5 / SUPPORT) * integral * erosion;

  // Fake single scattering: sun side of the puff brighter, bottom of the cloud tinted by the ground bounce.
  vec3 normal = (mid - puff.xyz) / radius;
  float sun = clamp(dot(normal, sunDir) * 0.6 + 0.5 + (n - 0.5) * 0.3, 0.0, 1.0);
  float height = clamp((mid.y - floorY) / 4.0, 0.0, 1.0);
  vec3 color = mix(shadeColor, litColor, sun);
  color = mix(bottomColor, color, 0.35 + 0.65 * height);
  tau += depth;
  light += color * depth;
  firstHit = min(firstHit, t0);
}

vec4 shadeSmoke(float tau, vec3 light, float firstHit) {
  float alpha = 1.0 - exp(-tau);
  if (alpha < 0.002) discard;
  vec3 color = light / max(tau, 1e-5);
  // Thick smoke self-shadows.
  color *= mix(1.0, 0.8, 1.0 - exp(-tau * 0.3));
  float fog = fogDensity * firstHit;
  color = mix(fogColor, color, exp(-fog * fog));
  return vec4(color, alpha);
}
`;

const BILLBOARD_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 smokeA;
attribute vec4 smokeB;
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform float nearClip;
varying vec3 vRay;
varying vec4 vPuff;
varying vec4 vInfo;

void main() {
  vec3 centre = smokeA.xyz;
  float radius = smokeA.w;
  vec3 toCamera = cameraPosition - centre;
  float dist = max(length(toCamera), 1e-3);
  vec3 dir = toCamera / dist;
  vec3 reference = abs(dir.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(reference, dir));
  vec3 up = cross(dir, right);
  // Exact cover of the sphere's silhouette cone on the plane through its centre...
  float cover = radius * dist / sqrt(max(dist * dist - radius * radius, 1e-4));
  vec3 corner = centre + (right * position.x + up * position.y) * cover;
  // ...slid along the view rays to the sphere's front, so walls in front of the smoke still hide it.
  float k = max(dist - radius, nearClip * 2.0) / dist;
  gl_Position = viewProjection * vec4(cameraPosition + (corner - cameraPosition) * k, 1.0);
  vRay = corner - cameraPosition;
  vPuff = smokeA;
  vInfo = smokeB;
}
`;

const BILLBOARD_FRAGMENT = /* glsl */ `
precision highp float;
${SHARED_GLSL}
varying vec3 vRay;
varying vec4 vPuff;
varying vec4 vInfo;

void main() {
  float tau = 0.0;
  vec3 light = vec3(0.0);
  float firstHit = 1e6;
  integratePuff(cameraPosition, normalize(vRay), vPuff, vInfo, tau, light, firstHit);
  gl_FragColor = shadeSmoke(tau, light, firstHit);
}
`;

const INSIDE_VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform vec3 cameraRight;
uniform vec3 cameraUp;
uniform vec3 cameraForward;
uniform vec2 tanHalfFov;
uniform float nearClip;
varying vec3 vRay;

void main() {
  vec3 ray = cameraForward + cameraRight * position.x * tanHalfFov.x + cameraUp * position.y * tanHalfFov.y;
  gl_Position = viewProjection * vec4(cameraPosition + ray * nearClip * 1.5, 1.0);
  vRay = ray;
}
`;

const INSIDE_FRAGMENT = /* glsl */ `
precision highp float;
${SHARED_GLSL}
#define MAX_INSIDE ${MAX_INSIDE}
uniform vec4 puffA[MAX_INSIDE];
uniform vec4 puffB[MAX_INSIDE];
uniform float puffCount;
varying vec3 vRay;

void main() {
  vec3 rd = normalize(vRay);
  float tau = 0.0;
  vec3 light = vec3(0.0);
  float firstHit = 1e6;
  for (int i = 0; i < MAX_INSIDE; i++) {
    if (float(i) >= puffCount) break;
    integratePuff(cameraPosition, rd, puffA[i], puffB[i], tau, light, firstHit);
  }
  gl_FragColor = shadeSmoke(tau, light, firstHit);
}
`;

class SmokeVisual {
  active = false;
  id = 0;
  seenFrame = 0;
  /** Cloud age at the latest tick state, and the render age derived from it. */
  age = 0;
  readonly base = new Vector3();
  seed = 0;
  readonly puffsA = new Float32Array(PUFFS * SMOKE_PUFF_STRIDE);
  readonly puffsB = new Float32Array(PUFFS * SMOKE_PUFF_STRIDE);
  /** The puffs at the render age (interpolated between the snapshots once per frame). */
  readonly puffs = new Float32Array(PUFFS * SMOKE_PUFF_STRIDE);
  ageA = -1;
  ageB = -1;
  count = 0;
  emitTimer = 0;
  /** Mutable stand-in for re-deriving puffs at an arbitrary age without allocating. */
  readonly probe: { id: number; base: Vec3; seed: number; age: number; driftX: number; driftZ: number; extents: readonly number[] } = {
    id: 0,
    base: { x: 0, y: 0, z: 0 },
    seed: 0,
    age: 0,
    driftX: 0,
    driftZ: 0,
    extents: [],
  };
}

/**
 * Smoke grenade clouds as analytic volumetric impostors that render exactly the seeded puff cluster the gameplay tests
 * sight against (smokePuffs / smokeTransmittance), so smoke blocks the view from outside, from inside and through
 * scopes alike.
 *
 * Technique: one camera-facing quad per puff (thin instances, depth-sorted back to front) whose fragment shader
 * intersects the view ray with the puff sphere and integrates a soft density profile in closed form: no ray march.
 * Two drifting noise taps erode the rim. The quad sits at the sphere's front depth, so walls in front hide it, and the
 * ray is clipped against the cloud's ground plane, so the ground contact is soft without a scene depth pass. Puffs
 * containing the camera are summed in a single fullscreen pass. Lighting is precomputed from the sun and sky fill into
 * display-space colors (the FX shaders write after tone mapping), so smoke is lit and never glows.
 *
 * Cost (1440p, M2 Pro class GPU): ~12 ALU + 2 texture taps per covered pixel per overlapping puff. From outside a
 * cloud typically covers a third of the screen ~4 puffs deep (~5M fragments, ≈0.5 ms); standing inside is one
 * fullscreen pass over ≤16 puffs (3.7M fragments × 16 closed-form intersections, ≈1–1.5 ms). A raymarched volume
 * with a scene depth prepass would cost a full extra geometry pass on Map v1 plus 16–32 taps per pixel; layered
 * sprites need 50+ fullscreen layers inside the cloud and still pop at the near plane.
 */
export class SmokeRenderer {
  private readonly visuals = Array.from({ length: MAX_SMOKE_CLOUDS }, () => new SmokeVisual());
  private readonly billboards: Mesh;
  private readonly billboardMaterial: ShaderMaterial;
  private readonly inside: Mesh;
  private readonly insideMaterial: ShaderMaterial;
  private readonly bufferA = new Float32Array(MAX_PUFFS * 4);
  private readonly bufferB = new Float32Array(MAX_PUFFS * 4);
  private readonly insideA: number[] = new Array<number>(MAX_INSIDE * 4).fill(0);
  private readonly insideB: number[] = new Array<number>(MAX_INSIDE * 4).fill(0);
  private readonly order = new Int32Array(MAX_PUFFS);
  private readonly distances = new Float32Array(MAX_PUFFS);
  private readonly puffVisual = new Int32Array(MAX_PUFFS);
  private readonly puffIndex = new Int32Array(MAX_PUFFS);
  private frame = 0;
  private time = 0;
  /** Puffs drawn last frame (billboards, inside), for stats. */
  drawnPuffs = 0;
  insidePuffs = 0;

  private readonly sunDirection = new Vector3();
  private readonly litColor = new Color3();
  private readonly shadeColor = new Color3();
  private readonly bottomColor = new Color3();
  private readonly wispColor = new Color3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly forward = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tanHalfFov = new Vector2();
  private readonly billow = new SpriteRecord();

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly environment: Pick<Environment, "sun" | "skyFill">,
    noise: Texture,
    private readonly fx: EquipmentFx,
    private readonly settings: EquipmentFxSettings,
  ) {
    const sharedUniforms = ["viewProjection", "cameraPosition", "nearClip", "sunDir", "litColor", "shadeColor", "bottomColor", "fogDensity", "fogColor", "time", "debugMode"];

    this.billboards = new Mesh("eq_smoke", scene);
    const quad = new VertexData();
    quad.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
    quad.indices = [0, 1, 2, 0, 2, 3];
    quad.applyToMesh(this.billboards);
    this.billboardMaterial = this.createMaterial("eq_smoke_material", { vertexSource: BILLBOARD_VERTEX, fragmentSource: BILLBOARD_FRAGMENT }, ["position", "smokeA", "smokeB"], sharedUniforms, noise);
    this.setupMesh(this.billboards, this.billboardMaterial, EQ_ALPHA_INDEX.smoke);
    const identities = new Float32Array(MAX_PUFFS * 16);
    for (let i = 0; i < identities.length; i += 16) identities[i] = identities[i + 5] = identities[i + 10] = identities[i + 15] = 1;
    this.billboards.thinInstanceSetBuffer("matrix", identities, 16, true);
    this.billboards.thinInstanceSetBuffer("smokeA", this.bufferA, 4, false);
    this.billboards.thinInstanceSetBuffer("smokeB", this.bufferB, 4, false);
    this.billboards.thinInstanceCount = 0;

    this.inside = new Mesh("eq_smoke_inside", scene);
    quad.applyToMesh(this.inside);
    this.insideMaterial = this.createMaterial(
      "eq_smoke_inside_material",
      { vertexSource: INSIDE_VERTEX, fragmentSource: INSIDE_FRAGMENT },
      ["position"],
      [...sharedUniforms, "cameraRight", "cameraUp", "cameraForward", "tanHalfFov", "puffA", "puffB", "puffCount"],
      noise,
    );
    this.setupMesh(this.inside, this.insideMaterial, EQ_ALPHA_INDEX.smoke + 0.5);
    this.refreshLighting();
  }

  /** Recomputes the display-space smoke colors from the sun and sky fill (call after lighting changes). */
  refreshLighting(): void {
    const { sun, skyFill } = this.environment;
    this.sunDirection.copyFrom(sun.direction).scaleInPlace(-1).normalize();
    const exposure = this.scene.imageProcessingConfiguration.exposure;
    const sr = sun.diffuse.r * sun.intensity;
    const sg = sun.diffuse.g * sun.intensity;
    const sb = sun.diffuse.b * sun.intensity;
    const ar = skyFill.diffuse.r * skyFill.intensity;
    const ag = skyFill.diffuse.g * skyFill.intensity;
    const ab = skyFill.diffuse.b * skyFill.intensity;
    const gr = skyFill.groundColor.r * skyFill.intensity;
    const gg = skyFill.groundColor.g * skyFill.intensity;
    const gb = skyFill.groundColor.b * skyFill.intensity;
    displayColor(this.litColor, SMOKE_ALBEDO * exposure, sr * 0.85 + ar, sg * 0.85 + ag, sb * 0.85 + ab);
    displayColor(this.shadeColor, SMOKE_ALBEDO * exposure, sr * 0.15 + ar, sg * 0.15 + ag, sb * 0.15 + ab);
    displayColor(this.bottomColor, SMOKE_ALBEDO * exposure, ar * 0.6 + gr * 0.35, ag * 0.6 + gg * 0.35, ab * 0.6 + gb * 0.35);
    Color3.LerpToRef(this.shadeColor, this.litColor, 0.6, this.wispColor);
    this.billow.color.copyFrom(this.wispColor);
    this.billow.cell = EqCell.smoke;
  }

  get activeClouds(): number {
    let n = 0;
    for (const visual of this.visuals) if (visual.active) n++;
    return n;
  }

  /** Starts a frame's cloud sync: call `syncList` for every source, then `render`. */
  beginFrame(): void {
    this.frame++;
  }

  /** `alpha` interpolates cloud ages between ticks. */
  syncList(clouds: readonly SmokeCloud[], alpha: number): void {
    for (let i = 0; i < clouds.length; i++) {
      const cloud = clouds[i]!;
      const visual = this.find(cloud.id) ?? this.allocate(cloud);
      if (!visual) continue;
      visual.seenFrame = this.frame;
      visual.age = cloud.age + alpha * TICK_SECONDS;
      const probe = visual.probe;
      probe.driftX = cloud.driftX;
      probe.driftZ = cloud.driftZ;
      probe.extents = cloud.extents;
    }
  }

  render(dt: number): void {
    this.time += dt;
    const enabled = this.settings.smoke;
    let puffCount = 0;
    const camera = this.camera.globalPosition;
    const visuals = this.visuals;
    for (let v = 0; v < visuals.length; v++) {
      const visual = visuals[v]!;
      if (!visual.active) continue;
      if (visual.seenFrame !== this.frame) {
        visual.active = false;
        continue;
      }
      this.refreshPuffs(visual);
      if (!enabled) continue;
      this.emit(visual, dt);
      for (let k = 0; k < visual.count; k++) {
        const o = k * SMOKE_PUFF_STRIDE;
        this.puffVisual[puffCount] = v;
        this.puffIndex[puffCount] = o;
        const x = visual.puffs[o]! - camera.x;
        const y = visual.puffs[o + 1]! - camera.y;
        const z = visual.puffs[o + 2]! - camera.z;
        this.distances[puffCount] = x * x + y * y + z * z;
        this.order[puffCount] = puffCount;
        puffCount++;
      }
    }

    // Back to front (insertion sort: ≤160 items, mostly ordered frame to frame).
    const order = this.order;
    const distances = this.distances;
    for (let i = 1; i < puffCount; i++) {
      const item = order[i]!;
      const d = distances[item]!;
      let j = i - 1;
      while (j >= 0 && distances[order[j]!]! < d) {
        order[j + 1] = order[j]!;
        j--;
      }
      order[j + 1] = item;
    }

    const nearClip = this.camera.minZ;
    let billboards = 0;
    let inside = 0;
    // Nearest puffs are last; the ones around the camera go to the fullscreen pass.
    for (let n = puffCount - 1; n >= 0; n--) {
      const p = order[n]!;
      const visual = this.visuals[this.puffVisual[p]!]!;
      const o = this.puffIndex[p]!;
      const radius = visual.puffs[o + 3]! * SUPPORT;
      const within = radius + nearClip * 4;
      if (inside < MAX_INSIDE && distances[p]! < within * within) {
        this.writePuff(this.insideA, this.insideB, inside * 4, visual, o);
        this.puffVisual[p] = -1;
        inside++;
      }
    }
    for (let n = 0; n < puffCount; n++) {
      const p = order[n]!;
      if (this.puffVisual[p]! < 0) continue;
      const visual = this.visuals[this.puffVisual[p]!]!;
      const o = this.puffIndex[p]!;
      this.writePuff(this.bufferA, this.bufferB, billboards * 4, visual, o);
      billboards++;
    }
    this.drawnPuffs = billboards;
    this.insidePuffs = inside;

    const visible = billboards > 0 || inside > 0;
    this.billboards.thinInstanceCount = billboards;
    this.billboards.isVisible = billboards > 0;
    this.inside.isVisible = inside > 0;
    if (!visible) return;
    this.updateUniforms(this.billboardMaterial);
    if (billboards > 0) {
      this.billboards.thinInstanceBufferUpdated("smokeA");
      this.billboards.thinInstanceBufferUpdated("smokeB");
    }
    if (inside > 0) {
      const material = this.insideMaterial;
      this.updateUniforms(material);
      const world = this.camera.getWorldMatrix();
      Vector3.TransformNormalToRef(Vector3.RightReadOnly, world, this.right);
      Vector3.TransformNormalToRef(Vector3.UpReadOnly, world, this.up);
      Vector3.TransformNormalToRef(FORWARD, world, this.forward);
      material.setVector3("cameraRight", this.right.normalize());
      material.setVector3("cameraUp", this.up.normalize());
      material.setVector3("cameraForward", this.forward.normalize());
      const tanY = Math.tan(this.camera.fov / 2);
      const aspect = this.scene.getEngine().getAspectRatio(this.camera);
      material.setVector2("tanHalfFov", this.tanHalfFov.set(tanY * aspect, tanY));
      material.setArray4("puffA", this.insideA);
      material.setArray4("puffB", this.insideB);
      material.setFloat("puffCount", inside);
    }
  }

  clear(): void {
    for (const visual of this.visuals) visual.active = false;
  }

  dispose(): void {
    this.billboards.dispose();
    this.billboardMaterial.dispose();
    this.inside.dispose();
    this.insideMaterial.dispose();
  }

  private createMaterial(name: string, source: { vertexSource: string; fragmentSource: string }, attributes: string[], uniforms: string[], noise: Texture): ShaderMaterial {
    const material = new ShaderMaterial(name, this.scene, source, { attributes, uniforms, samplers: ["noiseTex"], needAlphaBlending: true });
    material.setTexture("noiseTex", noise);
    material.alphaMode = Constants.ALPHA_COMBINE;
    material.disableDepthWrite = true;
    material.backFaceCulling = false;
    return material;
  }

  private setupMesh(mesh: Mesh, material: ShaderMaterial, alphaIndex: number): void {
    mesh.material = material;
    mesh.renderingGroupId = 0;
    mesh.alphaIndex = alphaIndex;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isVisible = false;
  }

  private updateUniforms(material: ShaderMaterial): void {
    const scene = this.scene;
    material.setVector3("cameraPosition", this.camera.globalPosition);
    material.setFloat("nearClip", this.camera.minZ);
    material.setVector3("sunDir", this.sunDirection);
    material.setColor3("litColor", this.litColor);
    material.setColor3("shadeColor", this.shadeColor);
    material.setColor3("bottomColor", this.bottomColor);
    material.setFloat("fogDensity", scene.fogEnabled && scene.fogMode === Scene.FOGMODE_EXP2 ? scene.fogDensity : 0);
    material.setColor3("fogColor", scene.fogColor);
    material.setFloat("time", this.time);
    material.setFloat("debugMode", this.settings.smokeDebug ? 1 : 0);
  }

  private find(id: number): SmokeVisual | null {
    for (let i = 0; i < this.visuals.length; i++) {
      const visual = this.visuals[i]!;
      if (visual.active && visual.id === id) return visual;
    }
    return null;
  }

  private allocate(cloud: SmokeCloud): SmokeVisual | null {
    let slot: SmokeVisual | null = null;
    for (const visual of this.visuals) {
      if (!visual.active) {
        slot = visual;
        break;
      }
    }
    if (!slot) return null;
    slot.active = true;
    slot.id = cloud.id;
    slot.ageA = slot.ageB = -1;
    slot.emitTimer = 0;
    slot.base.set(cloud.base.x, cloud.base.y, cloud.base.z);
    slot.seed = ((cloud.seed >>> 0) % 1000) / 1000;
    const probe = slot.probe;
    probe.id = cloud.id;
    probe.base = cloud.base;
    probe.seed = cloud.seed;
    return slot;
  }

  /** Keeps two snapshots of the shared puff function bracketing the render age. */
  private refreshPuffs(visual: SmokeVisual): void {
    const age = visual.age;
    if (visual.ageA < 0 || age < visual.ageA || age > visual.ageB) this.snapshotPuffs(visual);
    const t = Math.min(1, Math.max(0, (age - visual.ageA) / (visual.ageB - visual.ageA)));
    const a = visual.puffsA;
    const b = visual.puffsB;
    const out = visual.puffs;
    for (let i = 0; i < out.length; i++) out[i] = a[i]! + (b[i]! - a[i]!) * t;
  }

  private snapshotPuffs(visual: SmokeVisual): void {
    const age = visual.age;
    if (visual.ageB >= 0 && age > visual.ageB && age <= visual.ageB + SNAPSHOT_SECONDS) {
      visual.puffsA.set(visual.puffsB);
      visual.ageA = visual.ageB;
    } else {
      visual.ageA = age;
      visual.probe.age = age;
      visual.count = smokePuffs(visual.probe, visual.puffsA);
    }
    visual.ageB = visual.ageA + SNAPSHOT_SECONDS;
    visual.probe.age = Math.min(visual.ageB, SMOKE.lifetime);
    visual.count = smokePuffs(visual.probe, visual.puffsB);
  }

  private writePuff(a: Float32Array | number[], b: Float32Array | number[], offset: number, visual: SmokeVisual, o: number): void {
    const puffs = visual.puffs;
    a[offset] = puffs[o]!;
    a[offset + 1] = puffs[o + 1]!;
    a[offset + 2] = puffs[o + 2]!;
    a[offset + 3] = puffs[o + 3]! * SUPPORT;
    b[offset] = puffs[o + 4]!;
    b[offset + 1] = visual.base.y - 0.25;
    b[offset + 2] = visual.seed + o * 0.137;
    b[offset + 3] = 0;
  }

  /** Canister jet while the cloud builds, and slow rim billows that break up the silhouette. */
  private emit(visual: SmokeVisual, dt: number): void {
    const age = visual.age;
    if (age < SMOKE.growSeconds + 1) {
      visual.emitTimer -= dt;
      while (visual.emitTimer <= 0) {
        visual.emitTimer += 0.05;
        const p = this.fx.alpha.spawn();
        p.position.set(visual.base.x, visual.base.y + 0.08, visual.base.z);
        const angle = Math.random() * Math.PI * 2;
        const out = 1.5 + Math.random() * 2.5;
        p.velocity.set(Math.cos(angle) * out, 1.2 + Math.random() * 2.2, Math.sin(angle) * out);
        p.life = 1.4 + Math.random() * 1.2;
        p.size0 = 0.15;
        p.size1 = 1.3 + Math.random() * 0.9;
        p.drag = 1.6;
        p.gravity = -0.15;
        p.cell = EqCell.smoke;
        p.rotation = Math.random() * Math.PI * 2;
        p.spin = (Math.random() - 0.5) * 0.6;
        p.color.copyFrom(this.wispColor);
        p.alpha = 0.55;
        p.fadePower = 1.2;
      }
    }
    // Two billows per puff hugging the silhouette, rotating slowly.
    const camera = this.camera.globalPosition;
    for (let k = 0; k < visual.count; k++) {
      const o = k * SMOKE_PUFF_STRIDE;
      const density = visual.puffs[o + 4]!;
      if (density < 0.02) continue;
      const cx = visual.puffs[o]!;
      const cy = visual.puffs[o + 1]!;
      const cz = visual.puffs[o + 2]!;
      const radius = visual.puffs[o + 3]!;
      this.tmp.set(camera.x - cx, 0, camera.z - cz);
      const flat = Math.sqrt(this.tmp.x * this.tmp.x + this.tmp.z * this.tmp.z) || 1;
      const sx = -this.tmp.z / flat;
      const sz = this.tmp.x / flat;
      for (let i = 0; i < 2; i++) {
        const phase = visual.seed * 17 + k * 2.3 + i * 3.1 + this.time * 0.05;
        const side = Math.cos(phase) * radius * 0.95;
        const lift = Math.sin(phase) * radius * 0.7;
        const billow = this.billow;
        billow.position.set(cx + sx * side, cy + lift, cz + sz * side);
        billow.drawSize = radius * 0.75;
        billow.rotation = phase * 0.4;
        billow.drawAlpha = 0.45 * density;
        this.fx.alphaBatch.spriteFrom(billow);
      }
    }
  }
}

/** Linear radiance → display color the way the PBR output looks: exposure, ACES fit, sRGB gamma. */
function displayColor(result: Color3, scale: number, r: number, g: number, b: number): void {
  result.set(aces(r * scale), aces(g * scale), aces(b * scale));
}

function aces(x: number): number {
  const mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return Math.pow(Math.min(1, Math.max(0, mapped)), 1 / 2.2);
}
