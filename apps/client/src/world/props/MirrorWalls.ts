import { Color3, Color4, DynamicTexture, Material, Mesh, MirrorTexture, StandardMaterial, Texture, VertexData, type AbstractMesh, type Node, type Scene, type Vector3 } from "@babylonjs/core";
import { INSTANCE_STRIDE, type PropInstanceSet } from "@twobullets/shared";
import { MIRROR_PANEL } from "./standInMeshes";

/**
 * Mirrored wall panels (`wall_mirror`): you glimpse an enemy round a corner in one.
 *
 * A mirror cannot be thin-instanced — the reflection matrix is per plane, so every live mirror is its own mesh, its own
 * material and its own extra scene render pass. So the panels come in counted (ten on the maze) and only the nearest
 * `MIRROR_TUNING.live` of them get a real one:
 *
 * - A pool of `live` slots, each a small `MirrorTexture` plus the material that samples it. A mirror holding a slot
 *   draws with that material; every other mirror draws with one shared, free fallback that reflects the scene's sky
 *   cube instead. Both are mirrors to look at — the live one additionally has the players in it and gets the geometry
 *   of the reflection right.
 * - Slots are re-assigned a few times a second (`selectSeconds`), never per frame, and the scoring allocates nothing.
 *   A mirror behind the camera, out of the view cone, edge-on or past `distance` never gets one.
 * - An unbound slot's texture is referenced by no drawn mesh, so Babylon never collects it and never renders it. A
 *   bound one whose mesh is frustum-culled costs nothing either, for the same reason.
 * - The render list is bounded (`getCustomRenderList`, the discipline of shadowCulling.ts) to the skybox plus nearby
 *   characters: 12 triangles of sky so the pane always reads as a mirror, and the soldiers that are the point of it.
 *   Never the terrain, the walls or the effects.
 *
 * Known limit: because the walls are not in the reflection, a mirror cannot hide a character standing behind one in the
 * reflected line of sight. Adding the wall batches to the list would fix it and cost a few thousand more triangles.
 *
 * **Holes (2026-09-18).** A mirror is shoot-through now (`wall_mirror` is `bulletproof: false`), and every round that
 * crosses one takes a piece of it away: `punch` cuts a hole you can see the corridor through, and a pane somebody has
 * emptied a magazine into ends up a window. It is an alpha cut, not geometry surgery — each holed pane gets a small
 * mask texture (`MIRROR_HOLE.resolution`, about 160 KB) and a material of its own, both allocated the first time that
 * pane is hit, and a bullet writes one filled circle into the mask. Writing the hundredth hole into a mask costs
 * exactly what writing the first one did, so holes accumulate all match for a bounded price: at most one texture and
 * one material per pane, twenty of each on the maze. The cut goes through both silvered faces at once (they share the
 * mask and the same UVs), and there is nothing between them, which is why the panel's opaque core moved out of the
 * thin-instance stand-in and into these faces — a shared core would have stood behind every hole.
 */

/** The catalog prop the reflective faces belong to; its frame still goes through the thin-instance batches. */
export const MIRROR_PROP = "wall_mirror";

/** Tuning, all in one place. Mutable so it can be poked from the console while looking at the map. */
export const MIRROR_TUNING = {
  /** Mirrors that may reflect at once. Each one is an extra scene pass over the sky box and nearby players. */
  live: 2,
  /** Hard cap on the slot pool built at load; `live` above this is ignored. */
  maxLive: 4,
  /** Reflection texture size, px. Mirrors are glimpsed, not studied. No mipmaps. */
  resolution: 256,
  /** Past this camera distance a mirror is inert, m. */
  distance: 45,
  /** Cosine of the half-angle off the view axis within which a mirror may go live (0.35 ≈ 70°). */
  facing: 0.35,
  /** Minimum |cos| between the view direction and the panel normal: below it the mirror is edge-on, a few pixels wide. */
  incidence: 0.12,
  /** Characters further than this from the camera are left out of the reflection, m. */
  subjectRange: 60,
  /** Slot re-assignment and character-list rebuild period, s. */
  selectSeconds: 0.25,
};

/**
 * The hole a round leaves in a pane. All in one place so the owner can tune it: the pane is 3.76 m across and 2.32 m
 * tall, and `diameter` is deliberately big enough to put an eye to — "cái lỗ nó phải to để có thể nhìn xuyên qua được".
 */
export const MIRROR_HOLE = {
  /** Aperture across, m. A head is about 0.2 m wide; this is a hole you look and shoot through, not a bullet mark. */
  diameter: 0.22,
  /** Mask width in px across the pane; the height follows the pane's aspect. 256 px is about 1.5 cm a pixel. */
  resolution: 256,
  /** Soft rim as a fraction of the radius. The alpha test bites in the middle of it, which hides the texel stair. */
  feather: 0.3,
};

/** Only shows if the skybox is missing: a dim daylight grey, never black. */
const FALLBACK_CLEAR = new Color4(0.24, 0.27, 0.31, 1);
/** The pane itself under the reflection: nearly black, so what you see is what it reflects. */
const PANE_TINT = new Color3(0.04, 0.045, 0.05);
const PANE_SPECULAR = new Color3(0.35, 0.35, 0.38);
/** Guard on the parent walk that finds a mesh's character root. */
const MAX_DEPTH = 32;

interface MirrorWall {
  /** The two silvered faces, one per side; back-face culling means only the near one ever draws. */
  readonly mesh: Mesh;
  /** World centre of the pane. */
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** World panel normal (the prop's local +Z), unit. */
  readonly nx: number;
  readonly nz: number;
  /** Where the silvered face sits either side of the wall's centre plane, m at this instance's scale. */
  readonly faceOffset: number;
  /** Half the pane's width and height at this instance's scale, m. */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /** The holes shot in this pane, or null while it is whole. Allocated on the first hit and never freed. */
  mask: DynamicTexture | null;
  /** Idle material carrying `mask`, or null: a holed pane cannot use the shared one. */
  holed: StandardMaterial | null;
  /** Holes were drawn since the last upload. */
  dirty: boolean;
  /** Slot index while live, else -1. */
  slot: number;
  /** Squared camera distance at the last selection, or -1 when the mirror was ruled out. */
  score: number;
}

interface MirrorSlot {
  readonly texture: MirrorTexture;
  readonly material: StandardMaterial;
  mirror: MirrorWall | null;
}

export interface MirrorStats {
  readonly mirrors: number;
  readonly live: number;
  /** Meshes in the shared reflection render list. */
  readonly subjects: number;
  /** Panes with at least one hole shot through them, i.e. a mask texture and a material of their own. */
  readonly holed: number;
}

export interface MirrorWallsOptions {
  /** Called once per pane face mesh so the caller can register it as a static shadow caster. */
  readonly shadowCaster?: (mesh: Mesh) => void;
}

export class MirrorWalls {
  private readonly mirrors: MirrorWall[] = [];
  private readonly slots: MirrorSlot[] = [];
  private readonly fallback: StandardMaterial;
  /** Shared, bounded reflection render list: the skybox and the nearby characters, rebuilt on the selection tick. */
  private readonly subjects: AbstractMesh[] = [];
  private readonly roots = new Set<Node>();
  private readonly chosen: Int32Array;
  private lastSelect = -Infinity;
  private enabled = true;

  constructor(
    private readonly scene: Scene,
    sets: readonly PropInstanceSet[],
    options: MirrorWallsOptions = {},
  ) {
    this.fallback = createMirrorMaterial(scene, "mat_mirror_idle");
    for (const set of sets) {
      for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
        const d = set.data;
        const mirror = this.createMirror(`mirror_${this.mirrors.length}`, d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!, d[i + 4]!);
        this.mirrors.push(mirror);
        // The faces are the panel's body now, so they are what casts its shadow (the stand-in only has the frame).
        options.shadowCaster?.(mirror.mesh);
      }
    }
    const count = this.mirrors.length === 0 ? 0 : Math.min(MIRROR_TUNING.live, MIRROR_TUNING.maxLive, this.mirrors.length);
    for (let i = 0; i < count; i++) this.slots.push(this.createSlot(i));
    this.chosen = new Int32Array(Math.max(1, count));
  }

  get count(): number {
    return this.mirrors.length;
  }

  /** Width of the hole `punch` cuts, m (the presentation draws the crazing round it at this size). */
  get holeDiameter(): number {
    return MIRROR_HOLE.diameter;
  }

  /** The prop these panes are: a round through any other pane is not theirs to open. */
  get paneProp(): string {
    return MIRROR_PROP;
  }

  /**
   * A round crossed a mirror at `point`: cuts a hole you can see through, right there on the pane. Returns false when
   * the point is not on any pane (the caller hit something else, or a hole is off the glass and into the frame).
   *
   * The pane's mask and material are made on its first hit and reused for every hole after it, so a firefight against
   * one mirror is one texture upload a frame however many rounds land. Purely what the player sees: bullets already go
   * through the whole pane, so nothing here touches gameplay, and nothing has to agree with the server.
   */
  punch(point: Vector3): boolean {
    for (const mirror of this.mirrors) {
      const dx = point.x - mirror.cx;
      const dz = point.z - mirror.cz;
      // Off the panel's own plane by more than its depth: a different wall.
      if (Math.abs(dx * mirror.nx + dz * mirror.nz) > mirror.faceOffset + 0.05) continue;
      const along = dx * mirror.nz - dz * mirror.nx;
      const up = point.y - mirror.cy;
      const radius = MIRROR_HOLE.diameter / 2;
      // Inside the glass, not up on the frame or the sill. A hit near the rim cuts a hole that runs into the frame,
      // which is the right answer: you see the frame through it, not the corridor.
      if (Math.abs(along) > mirror.halfWidth || Math.abs(up) > mirror.halfHeight) continue;
      const mask = mirror.mask ?? this.createMask(mirror);
      const u = 0.5 + along / (2 * mirror.halfWidth);
      // The mask is uploaded unflipped (`update(false)`, like the effects atlas), so canvas row 0 is v = 0 is the sill.
      const v = 0.5 + up / (2 * mirror.halfHeight);
      cutHole(mask, u, v, radius / (2 * mirror.halfWidth));
      mirror.dirty = true;
      return true;
    }
    return false;
  }

  /** Call every frame with the view position; the expensive parts run on their own low-rate clock. */
  update(camera: { x: number; y: number; z: number }, now: number): void {
    this.uploadMasks();
    if (this.slots.length === 0) return;
    if (this.enabled && now - this.lastSelect >= MIRROR_TUNING.selectSeconds * 1000) {
      this.lastSelect = now;
      // The sky cube loads after the map does; pick it up once it is there so an inert mirror is never a flat pane.
      if (this.fallback.reflectionTexture !== this.scene.environmentTexture) this.fallback.reflectionTexture = this.scene.environmentTexture;
      this.rebuildSubjects(camera);
      this.select(camera);
    }
    // The reflection plane must face away from the camera (Babylon keeps the plane's negative side), and the silvered
    // face is the one on the camera's side. Both flip when you walk round the end of a panel, so they are cheap to
    // re-derive every frame rather than wait for the next selection tick.
    for (const slot of this.slots) {
      const mirror = slot.mirror;
      if (!mirror) continue;
      const side = (camera.x - mirror.cx) * mirror.nx + (camera.z - mirror.cz) * mirror.nz >= 0 ? 1 : -1;
      const px = mirror.cx + side * mirror.faceOffset * mirror.nx;
      const pz = mirror.cz + side * mirror.faceOffset * mirror.nz;
      const plane = slot.texture.mirrorPlane;
      plane.normal.set(-side * mirror.nx, 0, -side * mirror.nz);
      plane.d = -(plane.normal.x * px + plane.normal.z * pz);
    }
  }

  /** Hides every panel face and lets the slots go (benchmark A/B, matching PropInstances.setEnabled). */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.lastSelect = -Infinity;
    for (const mirror of this.mirrors) {
      if (!enabled && mirror.slot >= 0) this.release(mirror);
      mirror.mesh.setEnabled(enabled);
    }
  }

  stats(): MirrorStats {
    let live = 0;
    let holed = 0;
    for (const slot of this.slots) if (slot.mirror) live++;
    for (const mirror of this.mirrors) if (mirror.mask) holed++;
    return { mirrors: this.mirrors.length, live, subjects: this.subjects.length, holed };
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.texture.dispose();
      slot.material.dispose();
    }
    this.slots.length = 0;
    for (const mirror of this.mirrors) {
      mirror.mesh.dispose();
      mirror.mask?.dispose();
      mirror.holed?.dispose();
    }
    this.mirrors.length = 0;
    this.subjects.length = 0;
    this.fallback.dispose();
  }

  /**
   * Once a frame: hands the frame's new holes to the GPU, one upload per pane that was hit however many times it was
   * hit, and keeps a holed pane's own material reflecting the sky cube (it loads after the map does).
   */
  private uploadMasks(): void {
    const sky = this.scene.environmentTexture;
    for (const mirror of this.mirrors) {
      if (mirror.holed && mirror.holed.reflectionTexture !== sky) mirror.holed.reflectionTexture = sky;
      if (!mirror.dirty || !mirror.mask) continue;
      mirror.dirty = false;
      mirror.mask.update(false);
    }
  }

  /** First hole in a pane: its own mask, and its own idle material to sample it through. */
  private createMask(mirror: MirrorWall): DynamicTexture {
    const width = MIRROR_HOLE.resolution;
    const height = Math.max(2, Math.round((width * mirror.halfHeight) / mirror.halfWidth));
    const mask = new DynamicTexture(`${mirror.mesh.name}_holes`, { width, height }, this.scene, false, Texture.BILINEAR_SAMPLINGMODE);
    const ctx = mask.getContext();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    mask.update(false);
    mask.hasAlpha = true;
    mask.wrapU = Texture.CLAMP_ADDRESSMODE;
    mask.wrapV = Texture.CLAMP_ADDRESSMODE;
    mirror.mask = mask;
    const material = createMirrorMaterial(this.scene, `${mirror.mesh.name}_mat`);
    material.reflectionTexture = this.fallback.reflectionTexture;
    applyMask(material, mask);
    mirror.holed = material;
    if (mirror.slot >= 0) applyMask(this.slots[mirror.slot]!.material, mask);
    else mirror.mesh.material = material;
    return mask;
  }

  /** Scores every mirror and hands the nearest few the slots. Allocation-free; runs on the selection tick. */
  private select(camera: { x: number; y: number; z: number }): void {
    const mirrors = this.mirrors;
    const chosen = this.chosen;
    chosen.fill(-1);
    const view = this.scene.activeCamera;
    const maxSq = MIRROR_TUNING.distance * MIRROR_TUNING.distance;
    if (view) {
      // Camera forward: row 2 of the camera-to-world matrix, read in place.
      const m = view.getWorldMatrix().m;
      const fx = m[8]!;
      const fy = m[9]!;
      const fz = m[10]!;
      const flen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
      for (const mirror of mirrors) {
        mirror.score = -1;
        const dx = mirror.cx - camera.x;
        const dy = mirror.cy - camera.y;
        const dz = mirror.cz - camera.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > maxSq) continue;
        const dist = Math.sqrt(distSq) || 1;
        if ((dx * fx + dy * fy + dz * fz) / (dist * flen) < MIRROR_TUNING.facing) continue;
        if (Math.abs((dx * mirror.nx + dz * mirror.nz) / dist) < MIRROR_TUNING.incidence) continue;
        mirror.score = distSq;
      }
      for (let s = 0; s < chosen.length; s++) {
        let best = -1;
        let bestScore = Infinity;
        for (let i = 0; i < mirrors.length; i++) {
          const score = mirrors[i]!.score;
          if (score < 0 || score >= bestScore || chosen.includes(i)) continue;
          best = i;
          bestScore = score;
        }
        if (best < 0) break;
        chosen[s] = best;
      }
    }
    for (let i = 0; i < mirrors.length; i++) {
      const mirror = mirrors[i]!;
      if (mirror.slot >= 0 && !chosen.includes(i)) this.release(mirror);
    }
    for (let s = 0; s < chosen.length; s++) {
      const index = chosen[s]!;
      if (index < 0) continue;
      const mirror = mirrors[index]!;
      if (mirror.slot < 0) this.bind(mirror);
    }
  }

  private bind(mirror: MirrorWall): void {
    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s]!;
      if (slot.mirror) continue;
      slot.mirror = mirror;
      mirror.slot = s;
      // A slot serves one pane at a time, so it can carry that pane's holes while it has it.
      applyMask(slot.material, mirror.mask);
      mirror.mesh.material = slot.material;
      return;
    }
  }

  private release(mirror: MirrorWall): void {
    const slot = this.slots[mirror.slot];
    if (slot) {
      slot.mirror = null;
      applyMask(slot.material, null);
    }
    mirror.slot = -1;
    mirror.mesh.material = mirror.holed ?? this.fallback;
  }

  /**
   * The reflection render list: the skybox, so a mirror always reflects the real sky and ground and never a flat
   * colour; then skinned character meshes within `subjectRange` and the rigid things hanging off the same root (the
   * rifle in a soldier's hands). Nothing else — no terrain, no walls, no effects. Viewmodel meshes sit in their own
   * rendering group and are skipped, so the local player's arms never appear floating in a mirror.
   */
  private rebuildSubjects(camera: { x: number; y: number; z: number }): void {
    const subjects = this.subjects;
    const roots = this.roots;
    subjects.length = 0;
    roots.clear();
    const meshes = this.scene.meshes;
    const rangeSq = MIRROR_TUNING.subjectRange * MIRROR_TUNING.subjectRange;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i]!;
      if (mesh.infiniteDistance) subjects.push(mesh);
      if (!mesh.skeleton || mesh.renderingGroupId !== 0) continue;
      const at = mesh.absolutePosition;
      const dx = at.x - camera.x;
      const dy = at.y - camera.y;
      const dz = at.z - camera.z;
      if (dx * dx + dy * dy + dz * dz > rangeSq) continue;
      subjects.push(mesh);
      roots.add(characterRoot(mesh));
    }
    if (roots.size === 0) return;
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i]!;
      if (mesh.skeleton || mesh.renderingGroupId !== 0 || !mesh.parent) continue;
      if (roots.has(characterRoot(mesh))) subjects.push(mesh);
    }
  }

  private createSlot(index: number): MirrorSlot {
    const texture = new MirrorTexture(`mirror_rt${index}`, MIRROR_TUNING.resolution, this.scene, false);
    texture.renderList = [];
    texture.getCustomRenderList = () => this.subjects;
    // Sky and characters only: no particles, no sprites, no post processing in a 256 px reflection.
    texture.renderParticles = false;
    texture.renderSprites = false;
    texture.clearColor = FALLBACK_CLEAR;
    const material = createMirrorMaterial(this.scene, `mat_mirror_live${index}`);
    material.reflectionTexture = texture;
    return { texture, material, mirror: null };
  }

  private createMirror(name: string, x: number, y: number, z: number, yaw: number, scale: number): MirrorWall {
    const mesh = buildFaces(name, this.scene);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    mesh.scaling.setAll(scale);
    mesh.material = this.fallback;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    mesh.computeWorldMatrix(true);
    mesh.freezeWorldMatrix();
    // Local +Z under a yaw about Y (Babylon's row-vector convention): (sin, 0, cos).
    const nx = Math.sin(yaw);
    const nz = Math.cos(yaw);
    const mid = ((MIRROR_PANEL.bottom + MIRROR_PANEL.top) / 2) * scale;
    return {
      mesh,
      cx: x,
      cy: y + mid,
      cz: z,
      nx,
      nz,
      faceOffset: MIRROR_PANEL.faceOffset * scale,
      halfWidth: MIRROR_PANEL.halfWidth * scale,
      halfHeight: ((MIRROR_PANEL.top - MIRROR_PANEL.bottom) / 2) * scale,
      mask: null,
      holed: null,
      dirty: false,
      slot: -1,
      score: -1,
    };
  }
}

/** The topmost node a mesh hangs off: one per character, shared by its skinned parts and whatever it carries. */
function characterRoot(mesh: AbstractMesh): Node {
  let node: Node = mesh;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const parent = node.parent;
    if (!parent) break;
    node = parent;
  }
  return node;
}

/**
 * The two silvered faces of one panel, prop-local: a quad each side, wound outward so back-face culling leaves exactly
 * the near one. Same extents as the frame the thin-instance stand-in draws around them.
 *
 * Both faces carry the same UVs, keyed to the panel's own left-to-right and bottom-to-top: a texel is a place on the
 * panel, whichever side you are standing on. That is what makes one hole mask cut a hole right through.
 */
function buildFaces(name: string, scene: Scene): Mesh {
  const { halfWidth: w, bottom: y0, top: y1, faceOffset: f } = MIRROR_PANEL;
  // Left-handed winding, as in standInMeshes' box().
  const positions = [
    -w, y0, f, w, y0, f, w, y1, f, -w, y0, f, w, y1, f, -w, y1, f,
    -w, y0, -f, -w, y1, -f, w, y1, -f, -w, y0, -f, w, y1, -f, w, y0, -f,
  ];
  const normals = [
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
  ];
  // (u, v) per vertex in the same order; v = 0 is the sill, matching the mask's bottom row after the flip below.
  const uvs = [
    0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1,
    0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0,
  ];
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = Array.from({ length: positions.length / 3 }, (_, i) => i);
  data.normals = normals;
  data.uvs = uvs;
  data.applyToMesh(mesh, false);
  return mesh;
}

/** Points a mirror material at a pane's hole mask, or takes it off again. The cut is an alpha test, never a blend. */
function applyMask(material: StandardMaterial, mask: DynamicTexture | null): void {
  material.diffuseTexture = mask;
  material.useAlphaFromDiffuseTexture = mask !== null;
  material.transparencyMode = mask ? Material.MATERIAL_ALPHATEST : Material.MATERIAL_OPAQUE;
}

/**
 * Cuts one hole into a pane's mask at (`u`, `v`) of its face, `radius` across as a fraction of the pane's width. The
 * mask starts opaque white and holes are erased out of it, so the material's alpha test drops those pixels entirely —
 * no surface, no reflection, just the corridor behind. Soft-edged: the test bites mid-feather, which hides the texels.
 */
function cutHole(mask: DynamicTexture, u: number, v: number, radius: number): void {
  const size = mask.getSize();
  const x = u * size.width;
  const y = v * size.height;
  const r = Math.max(2, radius * size.width);
  // Babylon's ICanvasRenderingContext leaves out compositing; the real 2D context has it (as in fx/fxAtlas.ts).
  const ctx = mask.getContext() as CanvasRenderingContext2D;
  const edge = ctx.createRadialGradient(x, y, r * (1 - MIRROR_HOLE.feather), x, y, r);
  edge.addColorStop(0, "rgba(0,0,0,1)");
  edge.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = edge;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

/**
 * A silvered pane: a near-black surface whose look is entirely its reflection, added on top the way a StandardMaterial
 * does it. The caller supplies the reflection — the planar `MirrorTexture` for a live mirror, the scene's sky cube for
 * an idle one — so neither can come out black, and swapping between them is barely visible.
 */
function createMirrorMaterial(scene: Scene, name: string): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = PANE_TINT;
  material.specularColor = PANE_SPECULAR;
  material.specularPower = 256;
  return material;
}
