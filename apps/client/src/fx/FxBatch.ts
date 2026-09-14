import { Constants, Mesh, ShaderMaterial, VertexData, type Color3, type Scene, type Texture, type Vector3 } from "@babylonjs/core";
import { ATLAS_COLUMNS, ATLAS_ROWS, type FxCell } from "./fxAtlas";

const MODE_SPRITE = 0;
const MODE_STREAK = 1;
const MODE_DECAL = 2;

const VERTEX_SHADER = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec4 fxA;
attribute vec4 fxB;
attribute vec4 fxColor;
attribute vec4 fxInfo;
uniform mat4 view;
uniform mat4 viewProjection;
uniform vec3 cameraPosition;
varying vec2 vUV;
varying vec4 vColor;
varying float vHot;

void main() {
  float along = position.x;
  float across = position.y;
  float halfWidth = fxA.w;
  float mode = fxInfo.y;
  vec3 worldPos;
  if (mode < 0.5) {
    vec3 right = vec3(view[0][0], view[1][0], view[2][0]);
    vec3 up = vec3(view[0][1], view[1][1], view[2][1]);
    float c = cos(fxB.w);
    float s = sin(fxB.w);
    worldPos = fxA.xyz + ((right * c + up * s) * (along * 2.0 - 1.0) + (up * c - right * s) * across) * halfWidth;
  } else if (mode < 1.5) {
    vec3 p = mix(fxA.xyz, fxB.xyz, along);
    vec3 side = cross(fxB.xyz - fxA.xyz, cameraPosition - p);
    float len = length(side);
    side = len > 1e-7 ? side / len : vec3(view[0][0], view[1][0], view[2][0]);
    worldPos = p + side * across * halfWidth;
  } else {
    vec3 n = fxB.xyz;
    vec3 ref = abs(n.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 t = normalize(cross(ref, n));
    vec3 b = cross(n, t);
    float c = cos(fxB.w);
    float s = sin(fxB.w);
    worldPos = fxA.xyz + ((t * c + b * s) * (along * 2.0 - 1.0) + (b * c - t * s) * across) * halfWidth;
  }
  gl_Position = viewProjection * vec4(worldPos, 1.0);

  vec2 cell = vec2(mod(fxInfo.x, ${ATLAS_COLUMNS.toFixed(1)}), floor(fxInfo.x / ${ATLAS_COLUMNS.toFixed(1)}));
  vec2 local = vec2(along, across * 0.5 + 0.5) * 0.98 + 0.01;
  vUV = (cell + local) / vec2(${ATLAS_COLUMNS.toFixed(1)}, ${ATLAS_ROWS.toFixed(1)});
  vColor = fxColor;
  // Streaks fade from the tail (along = 0) to the head.
  vColor.a *= mix(fxInfo.z, 1.0, along);
  vHot = fxInfo.w;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D atlas;
varying vec2 vUV;
varying vec4 vColor;
varying float vHot;

void main() {
  float shape = texture2D(atlas, vUV).a;
  float alpha = shape * vColor.a;
  if (alpha < 0.003) discard;
  // Hot cores blow out to white, like overexposed muzzle flashes and tracers.
  vec3 rgb = mix(vColor.rgb, vec3(1.0), clamp(shape * shape * shape * vHot, 0.0, 1.0));
  gl_FragColor = vec4(rgb, alpha);
}
`;

export interface FxBatchOptions {
  readonly capacity: number;
  readonly blend: "additive" | "alpha";
  readonly renderingGroupId: number;
  /** Order among transparent meshes in the same group (lower draws first). */
  readonly alphaIndex: number;
  /** Depth bias, for decals. */
  readonly zOffset?: number;
}

/**
 * Immediate-mode quad renderer: one thin-instanced mesh and custom shader draws every sprite, streak or decal
 * pushed between begin() and end() this frame. No per-frame allocations; excess pushes beyond capacity are dropped.
 */
export class FxBatch {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly color: Float32Array;
  private readonly info: Float32Array;
  private readonly capacity: number;
  private count = 0;

  constructor(name: string, scene: Scene, atlas: Texture, options: FxBatchOptions) {
    this.capacity = options.capacity;
    this.mesh = new Mesh(name, scene);
    const quad = new VertexData();
    // x: 0..1 along the quad, y: -1..1 across it.
    quad.positions = [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0];
    quad.indices = [0, 1, 2, 0, 2, 3];
    quad.applyToMesh(this.mesh);

    this.material = new ShaderMaterial(
      `${name}_material`,
      scene,
      { vertexSource: VERTEX_SHADER, fragmentSource: FRAGMENT_SHADER },
      {
        attributes: ["position", "fxA", "fxB", "fxColor", "fxInfo"],
        uniforms: ["view", "viewProjection", "cameraPosition"],
        samplers: ["atlas"],
        needAlphaBlending: true,
      },
    );
    this.material.setTexture("atlas", atlas);
    this.material.alphaMode = options.blend === "additive" ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE;
    this.material.disableDepthWrite = true;
    this.material.backFaceCulling = false;
    if (options.zOffset !== undefined) this.material.zOffset = options.zOffset;

    const mesh = this.mesh;
    mesh.material = this.material;
    mesh.renderingGroupId = options.renderingGroupId;
    mesh.alphaIndex = options.alphaIndex;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.alwaysSelectAsActiveMesh = true;

    // The instanced path needs a matrix buffer to size instance counts; the shader ignores it.
    const identities = new Float32Array(this.capacity * 16);
    for (let i = 0; i < this.capacity * 16; i += 16) {
      identities[i] = identities[i + 5] = identities[i + 10] = identities[i + 15] = 1;
    }
    mesh.thinInstanceSetBuffer("matrix", identities, 16, true);
    this.a = this.createBuffer("fxA");
    this.b = this.createBuffer("fxB");
    this.color = this.createBuffer("fxColor");
    this.info = this.createBuffer("fxInfo");
    mesh.thinInstanceCount = 0;
    mesh.isVisible = false;
  }

  begin(): void {
    this.count = 0;
  }

  /** Camera-facing quad. */
  sprite(position: Vector3, halfSize: number, rotation: number, cell: FxCell, color: Color3, alpha: number, hot = 0): void {
    const i = this.next();
    if (i < 0) return;
    this.write(i, position.x, position.y, position.z, halfSize, 0, 0, 0, rotation, cell, MODE_SPRITE, 1, hot, color, alpha);
  }

  /** Camera-facing ribbon from `tail` to `head`; `tailAlpha` fades the tail end. */
  streak(tail: Vector3, head: Vector3, halfWidth: number, cell: FxCell, color: Color3, alpha: number, tailAlpha = 1, hot = 0): void {
    const i = this.next();
    if (i < 0) return;
    this.write(i, tail.x, tail.y, tail.z, halfWidth, head.x, head.y, head.z, 0, cell, MODE_STREAK, tailAlpha, hot, color, alpha);
  }

  /** Quad lying on a surface with unit `normal`. */
  decal(position: Vector3, normal: Vector3, halfSize: number, rotation: number, cell: FxCell, color: Color3, alpha: number): void {
    const i = this.next();
    if (i < 0) return;
    this.write(i, position.x, position.y, position.z, halfSize, normal.x, normal.y, normal.z, rotation, cell, MODE_DECAL, 1, 0, color, alpha);
  }

  end(): void {
    const mesh = this.mesh;
    mesh.thinInstanceCount = this.count;
    mesh.isVisible = this.count > 0;
    if (this.count === 0) return;
    mesh.thinInstanceBufferUpdated("fxA");
    mesh.thinInstanceBufferUpdated("fxB");
    mesh.thinInstanceBufferUpdated("fxColor");
    mesh.thinInstanceBufferUpdated("fxInfo");
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }

  private createBuffer(kind: string): Float32Array {
    const buffer = new Float32Array(this.capacity * 4);
    this.mesh.thinInstanceSetBuffer(kind, buffer, 4, false);
    return buffer;
  }

  private next(): number {
    return this.count < this.capacity ? this.count++ : -1;
  }

  private write(
    i: number,
    ax: number,
    ay: number,
    az: number,
    aw: number,
    bx: number,
    by: number,
    bz: number,
    bw: number,
    cell: number,
    mode: number,
    tailAlpha: number,
    hot: number,
    color: Color3,
    alpha: number,
  ): void {
    const o = i * 4;
    this.a[o] = ax;
    this.a[o + 1] = ay;
    this.a[o + 2] = az;
    this.a[o + 3] = aw;
    this.b[o] = bx;
    this.b[o + 1] = by;
    this.b[o + 2] = bz;
    this.b[o + 3] = bw;
    this.color[o] = color.r;
    this.color[o + 1] = color.g;
    this.color[o + 2] = color.b;
    this.color[o + 3] = alpha;
    this.info[o] = cell;
    this.info[o + 1] = mode;
    this.info[o + 2] = tailAlpha;
    this.info[o + 3] = hot;
  }
}
