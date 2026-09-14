import { Constants, Mesh, RawTexture, ShaderMaterial, Texture, VertexData, type AbstractEngine, type Observer, type Scene } from "@babylonjs/core";

/** Drawn after the world and the viewmodel (group 1); nothing else uses group 3. */
const OVERLAY_RENDERING_GROUP = 3;

const VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
varying vec2 vUV;
void main() {
  vUV = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D frozen;
uniform float white;
uniform float after;
varying vec2 vUV;
void main() {
  // Burned-in afterimage: the frame at the bang, washed toward white, over the live view; then the white-out on top.
  vec3 frame = mix(texture2D(frozen, vUV).rgb, vec3(1.0), 0.3);
  float a = 1.0 - (1.0 - after) * (1.0 - white);
  if (a < 0.002) discard;
  vec3 color = (frame * after * (1.0 - white) + vec3(white)) / a;
  gl_FragColor = vec4(color, a);
}
`;

interface GlInternals {
  _gl?: WebGL2RenderingContext | WebGLRenderingContext;
  _bindTextureDirectly?(target: number, texture: unknown, forTextureDataUpdate?: boolean, force?: boolean): boolean;
}

/**
 * Flashbang blindness: a fullscreen white-out scaled by exposure strength, with an afterimage of the frame at the bang
 * fading over the blind duration. The frame is copied from the canvas back buffer once, right after that frame
 * renders (`copyTexSubImage2D`, GPU-side, no readback), so there is no per-frame cost and no post-process pipeline.
 * Without WebGL (NullEngine) only the white-out is drawn.
 */
export class FlashOverlay {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private frozen: RawTexture;
  private readonly afterRender: Observer<Scene>;
  private captureRequested = false;
  private strength = 0;
  private duration = 0;
  private remaining = 0;
  private hasFrame = false;
  private white = 0;

  constructor(private readonly scene: Scene) {
    this.mesh = new Mesh("eq_flashOverlay", scene);
    const quad = new VertexData();
    quad.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
    quad.indices = [0, 1, 2, 0, 2, 3];
    quad.applyToMesh(this.mesh);
    this.frozen = this.createFrameTexture(1, 1);
    this.material = new ShaderMaterial("eq_flashOverlay_material", scene, { vertexSource: VERTEX, fragmentSource: FRAGMENT }, {
      attributes: ["position"],
      uniforms: ["white", "after"],
      samplers: ["frozen"],
      needAlphaBlending: true,
    });
    this.material.setTexture("frozen", this.frozen);
    this.material.alphaMode = Constants.ALPHA_COMBINE;
    this.material.disableDepthWrite = true;
    this.material.depthFunction = Constants.ALWAYS;
    this.material.backFaceCulling = false;
    this.mesh.material = this.material;
    this.mesh.renderingGroupId = OVERLAY_RENDERING_GROUP;
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.isVisible = false;
    scene.setRenderingAutoClearDepthStencil(OVERLAY_RENDERING_GROUP, false, false, false);
    this.afterRender = scene.onAfterRenderObservable.add(() => this.capture());
  }

  /** 0..1 current white-out, for checks. */
  get whiteout(): number {
    return this.white;
  }

  /** Blinds for `seconds` at `strength` 0..1; stronger or longer exposures replace a weaker one in progress. */
  flash(strength: number, seconds: number): void {
    if (strength <= 0 || seconds <= 0) return;
    const current = this.duration > 0 ? this.strength * (this.remaining / this.duration) : 0;
    if (strength < current && seconds < this.remaining) return;
    this.strength = Math.min(1, strength);
    this.duration = seconds;
    this.remaining = seconds;
    // Already whited out: keep the frozen frame rather than hiding the overlay for a frame to recapture.
    if (this.white < 0.3) this.captureRequested = true;
  }

  /**
   * Per frame. `blindSeconds` is the gameplay timer when available (it wins over the local countdown, so respawns and
   * vitals resets clear the overlay).
   */
  update(dt: number, blindSeconds: number | null): void {
    if (this.duration <= 0) return;
    this.remaining = blindSeconds !== null ? Math.min(this.remaining - dt, blindSeconds) : this.remaining - dt;
    if (this.remaining <= 0) {
      this.duration = this.remaining = 0;
      this.white = 0;
      this.mesh.isVisible = false;
      return;
    }
    const f = this.remaining / this.duration;
    // Solid white for the first part of the exposure, then the afterimage takes over and fades with the timer.
    this.white = this.strength * smooth((f - 0.45) / 0.35);
    const after = this.hasFrame ? Math.min(0.9, this.strength * 1.1) * smooth(f / 0.8) : 0;
    this.material.setFloat("white", this.white);
    this.material.setFloat("after", after);
    this.mesh.isVisible = !this.captureRequested;
  }

  clear(): void {
    this.duration = this.remaining = 0;
    this.white = 0;
    this.mesh.isVisible = false;
  }

  dispose(): void {
    this.scene.onAfterRenderObservable.remove(this.afterRender);
    this.mesh.dispose();
    this.material.dispose();
    this.frozen.dispose();
  }

  private capture(): void {
    if (!this.captureRequested) return;
    this.captureRequested = false;
    const engine = this.scene.getEngine();
    const internals = engine as unknown as GlInternals;
    const gl = internals._gl;
    this.hasFrame = false;
    if (!gl || !internals._bindTextureDirectly || engine.isWebGPU) return;
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    if (this.frozen.getSize().width !== width || this.frozen.getSize().height !== height) {
      this.frozen.dispose();
      this.frozen = this.createFrameTexture(width, height);
      this.material.setTexture("frozen", this.frozen);
    }
    const internal = this.frozen.getInternalTexture();
    if (!internal) return;
    (engine as AbstractEngine & { restoreDefaultFramebuffer(): void }).restoreDefaultFramebuffer();
    internals._bindTextureDirectly.call(engine, gl.TEXTURE_2D, internal, true);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    internals._bindTextureDirectly.call(engine, gl.TEXTURE_2D, null, true);
    this.hasFrame = true;
  }

  private createFrameTexture(width: number, height: number): RawTexture {
    const texture = new RawTexture(null, width, height, Constants.TEXTUREFORMAT_RGBA, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
    texture.name = "eq_flashFrame";
    texture.wrapU = Texture.CLAMP_ADDRESSMODE;
    texture.wrapV = Texture.CLAMP_ADDRESSMODE;
    return texture;
  }
}

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
