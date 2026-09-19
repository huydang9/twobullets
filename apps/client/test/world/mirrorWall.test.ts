import { DynamicTexture, FreeCamera, Material, Mesh, MirrorTexture, NullEngine, PBRMaterial, Scene, Skeleton, StandardMaterial, TransformNode, Vector3, type AbstractMesh } from "@babylonjs/core";
import { INSTANCE_STRIDE, getMapProp, type PropInstanceSet } from "@twobullets/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MIRROR_HOLE, MIRROR_TUNING, MirrorWalls } from "../../src/world/props/MirrorWalls";
import { PropVisuals } from "../../src/world/props/PropVisuals";

// wall_mirror: only the frame is thin-instanced like any other wall. The two silvered faces are per-mirror meshes,
// because a reflection matrix is per plane and because a round punches a see-through hole in one, which is a per-pane
// texture. MirrorWalls hands a render pass to the nearest few of them and leaves the rest reflecting the sky cube,
// which costs nothing.

let engine: NullEngine | undefined;
afterEach(() => {
  engine?.dispose();
  engine = undefined;
});

function world() {
  engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("cam", new Vector3(0, 1.6, 0), scene);
  camera.setTarget(new Vector3(0, 1.6, 1));
  camera.computeWorldMatrix(true);
  scene.activeCamera = camera;
  const skybox = new Mesh("skybox", scene);
  skybox.infiniteDistance = true;
  return { scene, skybox };
}

/** One instance set of wall_mirror at the given (x, z), yaw 0, i.e. panel normal along +Z. */
function set(spots: readonly (readonly [number, number])[]): PropInstanceSet[] {
  const data = new Float32Array(spots.length * INSTANCE_STRIDE);
  spots.forEach(([x, z], i) => data.set([x, 0, z, 0, 1, 0, 0], i * INSTANCE_STRIDE));
  return [{ prop: "wall_mirror", data }];
}

/** A stand-in soldier: one skinned mesh plus a rigid rifle hanging off the same root. */
function character(scene: Scene, name: string, z = 4): { skin: Mesh; rifle: Mesh } {
  const root = new TransformNode(`${name}_root`, scene);
  root.position.z = z;
  const skin = new Mesh(`${name}_body`, scene);
  skin.parent = root;
  skin.skeleton = new Skeleton(`${name}_rig`, name, scene);
  const rifle = new Mesh(`${name}_rifle`, scene);
  rifle.parent = root;
  root.computeWorldMatrix(true);
  skin.computeWorldMatrix(true);
  return { skin, rifle };
}

const faces = (scene: Scene): Mesh[] => scene.meshes.filter((m): m is Mesh => m.name.startsWith("mirror_"));
const reflecting = (mesh: AbstractMesh) => mesh.material instanceof StandardMaterial && mesh.material.reflectionTexture instanceof MirrorTexture;
const textureOf = (mesh: AbstractMesh) => (mesh.material as StandardMaterial).reflectionTexture as MirrorTexture;

describe("wall_mirror stand-in", () => {
  it("draws a solid frame with no glazed part, and casts the wall's shadow", async () => {
    engine = new NullEngine();
    const scene = new Scene(engine);
    const visuals = await PropVisuals.load(scene, ["wall_mirror", "wall_concrete"], false);
    const mirror = visuals.get("wall_mirror");
    expect(mirror.asset).toBe(false);
    // The frame casts; the pane's own shadow comes from the silvered faces, which are the panel's body now.
    expect(mirror.castShadow).toBe(true);
    // One level only: a far level drawn as a plain solid box would swallow the silvered faces.
    expect(mirror.levels).toHaveLength(1);
    const meshes = mirror.levels[0]!.create("mirror_lod0");
    expect(meshes).toHaveLength(1);
    expect((meshes[0]!.material as PBRMaterial).name).toBe("mat_prop_standin");
    expect(scene.materials.some((m) => m.name === "mat_prop_glass")).toBe(false);

    // Inside the wall_concrete collider, so every wall kind swaps in a lattice.
    const { minimum, maximum } = meshes[0]!.getBoundingInfo();
    expect(minimum.x).toBeCloseTo(-2, 6);
    expect(maximum.x).toBeCloseTo(2, 6);
    expect(minimum.y).toBeCloseTo(-0.4, 6);
    expect(Math.max(-minimum.z, maximum.z)).toBeLessThanOrEqual(0.18 + 1e-6);
    // The concrete wall's box, on the shoot-through layer (2026-09-18): the same obstacle to walk into, and bullets
    // cross it and leave a hole (combat/penetration.ts).
    expect(getMapProp("wall_mirror").collision).toEqual({ ...getMapProp("wall_concrete").collision, bulletproof: false });
  });
});

describe("MirrorWalls", () => {
  it("still reflects with nobody around: never a black pane", () => {
    const { scene, skybox } = world();
    const mirrors = new MirrorWalls(scene, set([[0, 10], [0, 20]]));
    expect(mirrors.count).toBe(2);
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1000);

    expect(mirrors.stats().live).toBe(MIRROR_TUNING.live);
    const list = textureOf(faces(scene)[0]!).getCustomRenderList!(0, null, 0)!;
    expect(list).toContain(skybox);
    // An idle mirror reflects the scene's sky cube instead — free, and still a mirror to look at.
    const idle = new MirrorWalls(scene, set([[0, 200]]));
    idle.update({ x: 0, y: 1.6, z: 0 }, 1000);
    const material = faces(scene).at(-1)!.material as StandardMaterial;
    expect(material.name).toBe("mat_mirror_idle");
    expect(material.reflectionTexture).toBe(scene.environmentTexture);
    // Nearly black diffuse: what you see in the pane is the reflection, not the pane.
    expect(material.diffuseColor.r).toBeLessThan(0.1);
    idle.dispose();
    mirrors.dispose();
  });

  it("gives the nearest mirrors in front of the camera a live reflection, and nothing else", () => {
    const { scene } = world();
    character(scene, "bot");
    const mirrors = new MirrorWalls(scene, set([[0, 10], [0, 20], [0, 200], [0, -10]]));
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1000);

    const [near, mid, far, behind] = faces(scene) as [Mesh, Mesh, Mesh, Mesh];
    expect(mirrors.stats().live).toBe(MIRROR_TUNING.live);
    expect(reflecting(near)).toBe(true);
    expect(reflecting(mid)).toBe(true);
    // Beyond MIRROR_TUNING.distance, and behind the camera: inert, so Babylon never collects their textures.
    expect(reflecting(far)).toBe(false);
    expect(reflecting(behind)).toBe(false);
    expect((far.material as StandardMaterial).name).toBe("mat_mirror_idle");
    expect(far.material).toBe(behind.material);
    mirrors.dispose();
  });

  it("points the reflection plane away from the camera, through the near silvered face", () => {
    const { scene } = world();
    const mirrors = new MirrorWalls(scene, set([[0, 10]]));

    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1000);
    const texture = textureOf(faces(scene)[0]!);
    // Babylon keeps the plane's negative side, so the normal points into the panel: away from a camera at z = 0.
    expect(texture.mirrorPlane.normal.z).toBeCloseTo(1, 6);
    expect(texture.mirrorPlane.d).toBeCloseTo(-9.87, 6);

    // Walk round to the far side: both the normal and the face the plane sits on flip, on the very next frame.
    mirrors.update({ x: 0, y: 1.6, z: 30 }, 1016);
    expect(texture.mirrorPlane.normal.z).toBeCloseTo(-1, 6);
    expect(texture.mirrorPlane.d).toBeCloseTo(10.13, 6);
    mirrors.dispose();
  });

  it("bounds the render list to the sky and nearby characters", () => {
    const { scene, skybox } = world();
    const { skin, rifle } = character(scene, "bot");
    const distant = character(scene, "faraway", MIRROR_TUNING.subjectRange + 40);
    const scenery = new Mesh("prop_wall_concrete@0,0_lod0", scene);
    const mirrors = new MirrorWalls(scene, set([[0, 10]]));
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1000);

    const list = textureOf(faces(scene)[0]!).getCustomRenderList!(0, null, 0)!;
    expect(list).toContain(skybox);
    expect(list).toContain(skin);
    expect(list).toContain(rifle);
    expect(list).not.toContain(distant.skin);
    expect(list).not.toContain(scenery);
    // The mirror never renders the world, and never itself.
    expect(list.some((m) => m.name.startsWith("mirror_"))).toBe(false);
    expect(textureOf(faces(scene)[0]!).renderParticles).toBe(false);
    mirrors.dispose();
  });

  it("puts a floor under the reflection, seen by no camera but the mirrors", () => {
    const { scene } = world();
    // The terrain's own material, which is what the proxy floor wears so it matches the ground beside it.
    const terrain = new PBRMaterial("mat_terrain", scene);
    const mirrors = new MirrorWalls(scene, set([[0, 10]]));
    mirrors.update({ x: 3, y: 1.6, z: -2 }, 1000);

    const ground = scene.meshes.find((m) => m.name === "mirrorGround")!;
    expect(ground.material).toBe(terrain);
    expect(ground.isVisible).toBe(true);
    // Two triangles, under the camera, at the pane's own floor height.
    expect(ground.getTotalIndices()).toBe(6);
    expect([ground.position.x, ground.position.y, ground.position.z]).toEqual([3, 0, -2]);
    // In every reflection, and in no camera's view: a render target with a custom list ignores the layer mask.
    expect(textureOf(faces(scene)[0]!).getCustomRenderList!(0, null, 0)!).toContain(ground);
    expect(ground.layerMask & scene.activeCamera!.layerMask).toBe(0);

    mirrors.dispose();
    expect(scene.meshes.some((m) => m.name === "mirrorGround")).toBe(false);
    expect(scene.materials).toContain(terrain);
  });

  it("leaves the reflection alone on a map with no terrain material to borrow", () => {
    const { scene } = world();
    const mirrors = new MirrorWalls(scene, set([[0, 10]]));
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1000);
    expect(scene.meshes.find((m) => m.name === "mirrorGround")!.isVisible).toBe(false);
    mirrors.dispose();
  });

  it("frees every texture and material on dispose", () => {
    const { scene } = world();
    character(scene, "bot");
    const mirrors = new MirrorWalls(scene, set([[0, 10], [0, 20]]));
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1000);
    expect(scene.textures.filter((t) => t instanceof MirrorTexture)).toHaveLength(MIRROR_TUNING.live);

    mirrors.dispose();
    expect(scene.textures.filter((t) => t instanceof MirrorTexture)).toHaveLength(0);
    expect(scene.materials.filter((m) => m.name.startsWith("mat_mirror"))).toHaveLength(0);
    expect(faces(scene)).toHaveLength(0);
  });
});

/**
 * Hole masks are DynamicTextures, and Babylon builds those on an OffscreenCanvas that Node does not have. This is the
 * smallest stand-in that lets the real code run, and it records the circles punched into it, which is exactly what
 * these tests want to look at.
 */
class FakeContext {
  readonly arcs: { x: number; y: number; r: number }[] = [];
  readonly fills: string[] = [];
  globalCompositeOperation = "source-over";
  fillStyle: unknown = "";
  private pending: { x: number; y: number; r: number } | null = null;
  fillRect(): void {
    this.fills.push(String(this.fillStyle));
  }
  createRadialGradient(): { addColorStop(): void } {
    return { addColorStop: () => {} };
  }
  beginPath(): void {}
  arc(x: number, y: number, r: number): void {
    this.pending = { x, y, r };
  }
  fill(): void {
    if (this.pending) this.arcs.push(this.pending);
    this.pending = null;
  }
}

const contexts: FakeContext[] = [];

class FakeCanvas {
  private readonly context = new FakeContext();
  constructor(
    public width: number,
    public height: number,
  ) {
    contexts.push(this.context);
  }
  getContext(): FakeContext {
    return this.context;
  }
}

// A round goes through a mirror (`wall_mirror` is bulletproof: false) and takes a piece of the pane with it: an alpha
// cut in the pane's own mask, big enough to look and shoot through, one texture and one material per pane however many
// rounds land. Client-side only — the bullet already passed, so nothing here is gameplay.
describe("mirror holes", () => {
  const original = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  beforeAll(() => {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeCanvas;
  });
  afterAll(() => {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = original;
  });
  afterEach(() => {
    contexts.length = 0;
  });

  const masks = (scene: Scene) => scene.textures.filter((t) => t instanceof DynamicTexture);

  it("cuts a hole where the round crossed, on the pane's own texture", () => {
    const { scene } = world();
    // Far enough away that no slot binds: the idle path, which is where nineteen of the maze's twenty panes live.
    const mirrors = new MirrorWalls(scene, set([[0, 200]]));
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1000);
    const face = faces(scene)[0]!;
    expect((face.material as StandardMaterial).name).toBe("mat_mirror_idle");

    // Dead centre: the panel spans 3.76 m across and sits 0.12…2.44 m up, so its middle is 1.28 m up.
    expect(mirrors.punch(new Vector3(0, 1.28, 200 + 0.13))).toBe(true);
    expect(mirrors.stats().holed).toBe(1);
    const size = masks(scene)[0]!.getSize();
    const ctx = contexts[0]!;
    // One white fill to start opaque, then one circle erased out of it, in the middle of the mask.
    expect(ctx.fills).toHaveLength(1);
    expect(ctx.arcs).toHaveLength(1);
    expect(ctx.arcs[0]!.x).toBeCloseTo(size.width / 2, 3);
    expect(ctx.arcs[0]!.y).toBeCloseTo(size.height / 2, 3);
    // Big enough to look through: MIRROR_HOLE.diameter across the pane's 3.76 m width.
    expect((ctx.arcs[0]!.r / size.width) * 3.76 * 2).toBeCloseTo(MIRROR_HOLE.diameter, 3);

    // The pane now draws through a material of its own, alpha-tested against the mask: a hole, not a decal of one.
    const material = face.material as StandardMaterial;
    expect(material.name).not.toBe("mat_mirror_idle");
    expect(material.diffuseTexture).toBe(masks(scene)[0]!);
    expect(material.transparencyMode).toBe(Material.MATERIAL_ALPHATEST);
    expect(material.useAlphaFromDiffuseTexture).toBe(true);
    // Still a mirror everywhere else.
    expect(material.reflectionTexture).toBe(scene.environmentTexture);
    mirrors.dispose();
  });

  it("puts the hole where the round hit, not in the middle", () => {
    const { scene } = world();
    const mirrors = new MirrorWalls(scene, set([[0, 200]]));
    // Low and to the panel's own left (yaw 0, so its local X is world X).
    expect(mirrors.punch(new Vector3(-1.4, 0.5, 200))).toBe(true);
    const size = masks(scene)[0]!.getSize();
    const { x, y } = contexts[0]!.arcs[0]!;
    expect(x / size.width).toBeCloseTo(0.5 - 1.4 / 3.76, 3);
    // The mask is uploaded unflipped, so its rows run up the pane: 0.5 m up a panel spanning 0.12…2.44 m.
    expect(y / size.height).toBeCloseTo((0.5 - 0.12) / 2.32, 3);
    mirrors.dispose();
  });

  it("ignores rounds that missed the glass", () => {
    const { scene } = world();
    const mirrors = new MirrorWalls(scene, set([[0, 200]]));
    expect(mirrors.punch(new Vector3(0, 3.5, 200)), "over the top of the panel").toBe(false);
    expect(mirrors.punch(new Vector3(6, 1.28, 200)), "past the end of it").toBe(false);
    expect(mirrors.punch(new Vector3(0, 1.28, 190)), "a different wall entirely").toBe(false);
    expect(mirrors.stats().holed).toBe(0);
    expect(masks(scene)).toHaveLength(0);
    mirrors.dispose();
  });

  it("costs one texture and one material per pane however many rounds go through it", () => {
    const { scene } = world();
    const mirrors = new MirrorWalls(scene, set([[0, 200], [8, 200]]));
    for (let i = 0; i < 60; i++) expect(mirrors.punch(new Vector3(-1 + (i % 20) * 0.1, 1 + (i % 7) * 0.1, 200))).toBe(true);
    expect(mirrors.stats().holed).toBe(1);
    expect(masks(scene)).toHaveLength(1);
    expect(contexts[0]!.arcs).toHaveLength(60);

    // And one upload a frame, not one an impact.
    const upload = vi.spyOn(masks(scene)[0]!, "update");
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1000);
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1016);
    expect(upload).toHaveBeenCalledTimes(1);
    mirrors.punch(new Vector3(0, 1.3, 200));
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1032);
    expect(upload).toHaveBeenCalledTimes(2);

    // The pane nobody shot is untouched, and still shares the free material.
    expect((faces(scene)[1]!.material as StandardMaterial).name).toBe("mat_mirror_idle");
    mirrors.dispose();
    expect(masks(scene)).toHaveLength(0);
  });

  it("keeps the holes when the pane goes live and when it goes idle again", () => {
    const { scene } = world();
    const mirrors = new MirrorWalls(scene, set([[0, 10]]));
    mirrors.update({ x: 0, y: 1.6, z: 0 }, 1000);
    const face = faces(scene)[0]!;
    expect(reflecting(face)).toBe(true);

    mirrors.punch(new Vector3(0, 1.28, 10));
    const mask = masks(scene)[0]!;
    // The live slot's material carries this pane's holes while it holds it.
    expect((face.material as StandardMaterial).diffuseTexture).toBe(mask);
    expect((face.material as StandardMaterial).transparencyMode).toBe(Material.MATERIAL_ALPHATEST);

    // Walk far away: the slot is released, and the pane falls back to its own holed material, not the shared one.
    mirrors.update({ x: 0, y: 1.6, z: 300 }, 2000);
    expect(reflecting(face)).toBe(false);
    expect((face.material as StandardMaterial).diffuseTexture).toBe(mask);
    const slotMaterial = scene.materials.find((m) => m.name.startsWith("mat_mirror_live")) as StandardMaterial;
    expect(slotMaterial.diffuseTexture).toBeNull();
    expect(slotMaterial.transparencyMode).toBe(Material.MATERIAL_OPAQUE);
    mirrors.dispose();
  });
});
