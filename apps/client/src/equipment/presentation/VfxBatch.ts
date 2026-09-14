import { Constants, Mesh, Scene, ShaderMaterial, Vector2, Vector4, VertexData, type Color3, type Texture, type Vector3 } from "@babylonjs/core";
import type { FxDecal } from "../../fx/FxBatch";
import type { VfxLighting } from "./vfxLighting";
import type { VfxSheet } from "./vfxManifest";

/** How a quad is placed; see `VfxQuad.axis` for what the axis means in each mode. */
export const VfxMode = {
  /** Camera-facing, rotated, centred on `position`. */
  sprite: 0,
  /** Camera-facing ribbon from `axis` (tail, texture U = 0) to `position` (head, U = 1). */
  streak: 1,
  /** Lying on a surface with unit normal `axis`. */
  decal: 2,
  /** Stands on `position` (texture bottom) and turns about world up to face the camera; `axis` leans the tip. */
  upright: 3,
} as const;

/** One quad's fields. Batches read records instead of loose arguments, so hot loops never box doubles. */
export interface VfxQuad {
  mode: number;
  readonly position: Vector3;
  /** Sprite: (floorY, softness, nearFade) · streak: tail · decal: unit normal · upright: tip lean offset. */
  readonly axis: Vector3;
  /** Half width (quads are as tall as the sheet's cell aspect makes them). */
  drawSize: number;
  rotation: number;
  /** Flipbook frame (fractional blends into the next) or atlas cell. */
  frame: number;
  /** Display-space tint, may exceed 1. */
  readonly color: Color3;
  drawAlpha: number;
  /** 0 = alpha-blended, 1 = purely additive (premultiplied output alpha scaled by 1 - additive). */
  additive: number;
  /** Streak tail alpha factor. */
  tailAlpha: number;
}

export interface VfxBatchOptions {
  readonly capacity: number;
  readonly alphaIndex: number;
  readonly renderingGroupId?: number;
  /** Draw back to front by distance (needed for dark, alpha-blended layers such as smoke). */
  readonly sort?: boolean;
  /** Blends between flipbook frames; off for atlases. */
  readonly frameBlend?: boolean;
  /** Frames wrap (loops) instead of holding the last frame. */
  readonly loop?: boolean;
  /** Sprite fades against a floor height and near the camera (the "depth fade" without a depth prepass). */
  readonly soft?: boolean;
  /** Scene EXP2 fog. */
  readonly fog?: boolean;
  /** Decals: the texture holds sRGB albedo, lit by the sun and sky from `lighting`. */
  readonly lighting?: VfxLighting;
  readonly zOffset?: number;
}

const MODE_DECAL = VfxMode.decal;
const SORT_SLOTS = 8192;
/** 1/64 m distance buckets, far first. */
const SORT_MAX_BUCKET = 1 << 20;

function vertexShader(): string {
  return /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 vfxA;
attribute vec4 vfxB;
attribute vec4 vfxC;
attribute vec4 vfxD;
uniform mat4 view;
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
// columns, rows, cell width in UV, cell height in UV
uniform vec4 sheet;
// frame count, cell aspect (height / width)
uniform vec2 frameInfo;
varying vec2 vUV0;
varying vec4 vColor;
varying float vAdd;
#ifdef FRAME_BLEND
varying vec2 vUV1;
varying float vBlend;
#endif
#ifdef SOFT
varying vec3 vSoft;
#endif
#ifdef FOG
uniform float fogDensity;
varying float vFog;
#endif
#ifdef LIT
varying vec3 vNormal;
#endif

vec2 cellOrigin(float f) {
  return vec2(floor(mod(f + 0.5, sheet.x)), floor((f + 0.5) / sheet.x)) * sheet.zw;
}

void main() {
  float along = position.x;
  float across = position.y;
  float halfWidth = vfxA.w;
  float mode = vfxD.y;
  vec3 right = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 up = vec3(view[0][1], view[1][1], view[2][1]);
  vColor = vfxC;
  vec3 worldPos;
  if (mode < 0.5) {
    float c = cos(vfxB.w);
    float s = sin(vfxB.w);
    worldPos = vfxA.xyz + (right * c + up * s) * ((along * 2.0 - 1.0) * halfWidth) + (up * c - right * s) * (across * halfWidth * frameInfo.y);
  } else if (mode < 1.5) {
    vec3 p = mix(vfxB.xyz, vfxA.xyz, along);
    vec3 side = cross(vfxA.xyz - vfxB.xyz, cameraPosition - p);
    float len = length(side);
    side = len > 1e-7 ? side / len : right;
    worldPos = p + side * across * halfWidth;
    vColor.a *= mix(vfxD.w, 1.0, along);
  } else if (mode < 2.5) {
    vec3 n = vfxB.xyz;
    vec3 ref = abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 t = normalize(cross(ref, n));
    vec3 b = cross(n, t);
    float c = cos(vfxB.w);
    float s = sin(vfxB.w);
    worldPos = vfxA.xyz + ((t * c + b * s) * (along * 2.0 - 1.0) + (b * c - t * s) * across) * halfWidth;
#ifdef LIT
    vNormal = n;
#endif
  } else {
    vec2 toCamera = cameraPosition.xz - vfxA.xz;
    float len = length(toCamera);
    vec3 side = len > 1e-4 ? vec3(toCamera.y, 0.0, -toCamera.x) / len : right;
    float h = across * 0.5 + 0.5;
    worldPos = vfxA.xyz + side * ((along * 2.0 - 1.0) * halfWidth) + vec3(0.0, h * 2.0 * halfWidth * frameInfo.y, 0.0) + vfxB.xyz * (h * h);
  }
  gl_Position = viewProjection * vec4(worldPos, 1.0);

  // Image rows run top to bottom (V = 0 is the top), so world up is -V.
  vec2 local = vec2(along, 0.5 - 0.5 * across) * 0.985 + 0.0075;
  float f0 = floor(vfxD.x);
  vUV0 = cellOrigin(f0) + local * sheet.zw;
#ifdef FRAME_BLEND
#ifdef LOOP
  float f1 = mod(f0 + 1.0, frameInfo.x);
#else
  float f1 = min(f0 + 1.0, frameInfo.x - 1.0);
#endif
  vUV1 = cellOrigin(f1) + local * sheet.zw;
  vBlend = vfxD.x - f0;
#endif
  vAdd = vfxD.z;
#ifdef SOFT
  if (mode < 0.5) {
    float depth = dot(worldPos - cameraPosition, vec3(view[0][2], view[1][2], view[2][2]));
    vSoft = vec3(worldPos.y - vfxB.x, max(vfxB.y, 1e-3), vfxB.z > 0.0 ? depth / vfxB.z : 1e3);
  } else {
    vSoft = vec3(1e3, 1.0, 1e3);
  }
#endif
#ifdef FOG
  float fogAmount = fogDensity * length(worldPos - cameraPosition);
  vFog = exp(-fogAmount * fogAmount);
#endif
}
`;
}

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D sheetTexture;
varying vec2 vUV0;
varying vec4 vColor;
varying float vAdd;
#ifdef FRAME_BLEND
varying vec2 vUV1;
varying float vBlend;
#endif
#ifdef SOFT
varying vec3 vSoft;
#endif
#ifdef FOG
uniform vec3 fogColor;
varying float vFog;
#endif
#ifdef LIT
uniform vec3 toSun;
uniform vec3 sunLight;
uniform vec3 skyLight;
uniform vec3 groundLight;
uniform float exposure;
varying vec3 vNormal;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
#endif

void main() {
  // Premultiplied texels.
  vec4 texel = texture2D(sheetTexture, vUV0);
#ifdef FRAME_BLEND
  texel = mix(texel, texture2D(sheetTexture, vUV1), vBlend);
#endif
  float fade = vColor.a;
#ifdef SOFT
  fade *= clamp(vSoft.x / vSoft.y, 0.0, 1.0) * smoothstep(0.15, 1.0, vSoft.z);
#endif
  float a = texel.a * fade;
#ifdef LIT
  vec3 albedo = pow(texel.rgb / max(texel.a, 1e-3), vec3(2.2)) * vColor.rgb;
  vec3 n = normalize(vNormal);
  vec3 irradiance = sunLight * max(dot(n, toSun), 0.0) + mix(groundLight, skyLight, n.y * 0.5 + 0.5);
  vec3 rgb = pow(aces(albedo * irradiance * exposure), vec3(1.0 / 2.2)) * a;
#else
  vec3 rgb = texel.rgb * vColor.rgb * fade;
#endif
  if (a < 0.002 && max(rgb.r, max(rgb.g, rgb.b)) < 0.002) discard;
#ifdef FOG
  rgb = mix(fogColor * a, rgb, vFog) * (1.0 - vAdd) + rgb * (vFog * vAdd);
#endif
  gl_FragColor = vec4(rgb, a * (1.0 - vAdd));
}
`;

/**
 * Immediate-mode flipbook quads for one premultiplied-alpha sheet: one thin-instanced mesh and shader draw every
 * sprite, streak, decal or upright billboard pushed between begin() and end(). Premultiplied blending (ONE,
 * ONE_MINUS_SRC_ALPHA) lets additive fire and alpha-blended smoke share the draw call. Optional back-to-front sort
 * (allocation-free shell sort over packed distance keys). No per-frame allocations; pushes beyond capacity are dropped.
 */
export class VfxBatch {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly c: Float32Array;
  private readonly d: Float32Array;
  /** Sorted batches stage here, then copy to the GPU buffers in order. */
  private readonly sa: Float32Array;
  private readonly sb: Float32Array;
  private readonly sc: Float32Array;
  private readonly sd: Float32Array;
  private readonly keys: Float64Array;
  private readonly capacity: number;
  private readonly sort: boolean;
  private readonly fog: boolean;
  private readonly lighting: VfxLighting | null;
  private count = 0;
  private fogDensity = NaN;
  private exposure = NaN;

  constructor(
    name: string,
    private readonly scene: Scene,
    texture: Texture,
    sheet: VfxSheet,
    options: VfxBatchOptions,
  ) {
    this.capacity = Math.min(options.capacity, SORT_SLOTS);
    this.sort = options.sort === true;
    this.fog = options.fog === true;
    this.lighting = options.lighting ?? null;
    this.mesh = new Mesh(name, scene);
    const quad = new VertexData();
    // x: 0..1 along the quad, y: -1..1 across it.
    quad.positions = [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0];
    quad.indices = [0, 1, 2, 0, 2, 3];
    quad.applyToMesh(this.mesh);

    const defines: string[] = [];
    const uniforms = ["view", "viewProjection", "cameraPosition", "sheet", "frameInfo"];
    if (options.frameBlend) defines.push("#define FRAME_BLEND");
    if (options.loop) defines.push("#define LOOP");
    if (options.soft) defines.push("#define SOFT");
    if (this.fog) {
      defines.push("#define FOG");
      uniforms.push("fogDensity", "fogColor");
    }
    if (this.lighting) {
      defines.push("#define LIT");
      uniforms.push("toSun", "sunLight", "skyLight", "groundLight", "exposure");
    }
    this.material = new ShaderMaterial(
      `${name}_material`,
      scene,
      { vertexSource: vertexShader(), fragmentSource: FRAGMENT_SHADER },
      { attributes: ["position", "vfxA", "vfxB", "vfxC", "vfxD"], uniforms, samplers: ["sheetTexture"], defines, needAlphaBlending: true },
    );
    const material = this.material;
    material.setTexture("sheetTexture", texture);
    material.setVector4("sheet", new Vector4(sheet.columns, sheet.rows, sheet.cellU, sheet.cellV));
    material.setVector2("frameInfo", new Vector2(sheet.frames, (sheet.cellV * sheet.height) / (sheet.cellU * sheet.width)));
    material.alphaMode = Constants.ALPHA_PREMULTIPLIED;
    material.disableDepthWrite = true;
    material.backFaceCulling = false;
    if (options.zOffset !== undefined) material.zOffset = options.zOffset;

    const mesh = this.mesh;
    mesh.material = material;
    mesh.renderingGroupId = options.renderingGroupId ?? 0;
    mesh.alphaIndex = options.alphaIndex;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.alwaysSelectAsActiveMesh = true;
    // The instanced path needs a matrix buffer to size instance counts; the shader ignores it.
    const identities = new Float32Array(this.capacity * 16);
    for (let i = 0; i < identities.length; i += 16) identities[i] = identities[i + 5] = identities[i + 10] = identities[i + 15] = 1;
    mesh.thinInstanceSetBuffer("matrix", identities, 16, true);
    this.a = this.createBuffer("vfxA");
    this.b = this.createBuffer("vfxB");
    this.c = this.createBuffer("vfxC");
    this.d = this.createBuffer("vfxD");
    const staged = this.sort ? this.capacity * 4 : 0;
    this.sa = new Float32Array(staged);
    this.sb = new Float32Array(staged);
    this.sc = new Float32Array(staged);
    this.sd = new Float32Array(staged);
    this.keys = new Float64Array(this.sort ? this.capacity : 0);
    mesh.thinInstanceCount = 0;
    mesh.isVisible = false;
  }

  /** Quads pushed this frame so far. */
  get drawn(): number {
    return this.count;
  }

  begin(): void {
    this.count = 0;
  }

  push(q: VfxQuad): void {
    if (this.count >= this.capacity) return;
    const o = this.count++ * 4;
    const a = this.sort ? this.sa : this.a;
    const b = this.sort ? this.sb : this.b;
    const c = this.sort ? this.sc : this.c;
    const d = this.sort ? this.sd : this.d;
    const { position, axis, color } = q;
    a[o] = position.x;
    a[o + 1] = position.y;
    a[o + 2] = position.z;
    a[o + 3] = q.drawSize;
    b[o] = axis.x;
    b[o + 1] = axis.y;
    b[o + 2] = axis.z;
    b[o + 3] = q.rotation;
    c[o] = color.r;
    c[o + 1] = color.g;
    c[o + 2] = color.b;
    c[o + 3] = q.drawAlpha;
    d[o] = q.frame;
    d[o + 1] = q.mode;
    d[o + 2] = q.additive;
    d[o + 3] = q.tailAlpha;
  }

  /** DecalStore records (their `cell` is the frame). */
  decalFrom(q: FxDecal): void {
    if (this.count >= this.capacity) return;
    const o = this.count++ * 4;
    const a = this.sort ? this.sa : this.a;
    const b = this.sort ? this.sb : this.b;
    const c = this.sort ? this.sc : this.c;
    const d = this.sort ? this.sd : this.d;
    const { position, normal, color } = q;
    a[o] = position.x;
    a[o + 1] = position.y;
    a[o + 2] = position.z;
    a[o + 3] = q.halfSize;
    b[o] = normal.x;
    b[o + 1] = normal.y;
    b[o + 2] = normal.z;
    b[o + 3] = q.rotation;
    c[o] = color.r;
    c[o + 1] = color.g;
    c[o + 2] = color.b;
    c[o + 3] = q.alpha;
    d[o] = q.cell;
    d[o + 1] = MODE_DECAL;
    d[o + 2] = 0;
    d[o + 3] = 1;
  }

  end(): void {
    const mesh = this.mesh;
    const count = this.count;
    mesh.thinInstanceCount = count;
    mesh.isVisible = count > 0;
    if (count === 0) return;
    if (this.sort) this.sortInto(count);
    const material = this.material;
    // Floats only when they change: ShaderMaterial stores them in a dictionary, which boxes every write.
    if (this.fog) {
      const scene = this.scene;
      const density = scene.fogEnabled && scene.fogMode === Scene.FOGMODE_EXP2 ? scene.fogDensity : 0;
      if (density !== this.fogDensity) material.setFloat("fogDensity", (this.fogDensity = density));
      material.setColor3("fogColor", scene.fogColor);
    }
    const lighting = this.lighting;
    if (lighting) {
      material.setVector3("toSun", lighting.toSun);
      material.setColor3("sunLight", lighting.sun);
      material.setColor3("skyLight", lighting.sky);
      material.setColor3("groundLight", lighting.ground);
      if (lighting.exposure !== this.exposure) material.setFloat("exposure", (this.exposure = lighting.exposure));
    }
    mesh.thinInstanceBufferUpdated("vfxA");
    mesh.thinInstanceBufferUpdated("vfxB");
    mesh.thinInstanceBufferUpdated("vfxC");
    mesh.thinInstanceBufferUpdated("vfxD");
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }

  private sortInto(count: number): void {
    const camera = this.scene.activeCamera?.globalPosition;
    const keys = this.keys;
    const sa = this.sa;
    const cx = camera ? camera.x : 0;
    const cy = camera ? camera.y : 0;
    const cz = camera ? camera.z : 0;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const x = sa[o]! - cx;
      const y = sa[o + 1]! - cy;
      const z = sa[o + 2]! - cz;
      const bucket = Math.min(SORT_MAX_BUCKET - 1, Math.floor(Math.sqrt(x * x + y * y + z * z) * 64));
      keys[i] = (SORT_MAX_BUCKET - 1 - bucket) * SORT_SLOTS + i;
    }
    // Shell sort (Ciura gaps): in place, no allocation, fast for a few thousand keys.
    for (let g = GAPS.length - 1; g >= 0; g--) {
      const gap = GAPS[g]!;
      if (gap >= count) continue;
      for (let i = gap; i < count; i++) {
        const key = keys[i]!;
        let j = i;
        while (j >= gap && keys[j - gap]! > key) {
          keys[j] = keys[j - gap]!;
          j -= gap;
        }
        keys[j] = key;
      }
    }
    const { a, b, c, d, sb, sc, sd } = this;
    for (let k = 0; k < count; k++) {
      const s = (keys[k]! % SORT_SLOTS) * 4;
      const o = k * 4;
      a[o] = sa[s]!;
      a[o + 1] = sa[s + 1]!;
      a[o + 2] = sa[s + 2]!;
      a[o + 3] = sa[s + 3]!;
      b[o] = sb[s]!;
      b[o + 1] = sb[s + 1]!;
      b[o + 2] = sb[s + 2]!;
      b[o + 3] = sb[s + 3]!;
      c[o] = sc[s]!;
      c[o + 1] = sc[s + 1]!;
      c[o + 2] = sc[s + 2]!;
      c[o + 3] = sc[s + 3]!;
      d[o] = sd[s]!;
      d[o + 1] = sd[s + 1]!;
      d[o + 2] = sd[s + 2]!;
      d[o + 3] = sd[s + 3]!;
    }
  }

  private createBuffer(kind: string): Float32Array {
    const buffer = new Float32Array(this.capacity * 4);
    this.mesh.thinInstanceSetBuffer(kind, buffer, 4, false);
    return buffer;
  }
}

const GAPS = [1, 4, 10, 23, 57, 132, 301, 701, 1750, 3937] as const;
