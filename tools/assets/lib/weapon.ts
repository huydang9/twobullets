import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Document, Node, NodeIO } from "@gltf-transform/core";
import { Box3, Matrix4, Vector3 } from "three";
import type { Vec3, WeaponAsset } from "../../../apps/client/src/assets/manifest.ts";
import { OUT_DIR, SRC_DIR, WEAPON_TEXTURES, type WeaponSpec } from "../config.ts";
import { hashBytes } from "./cache.ts";
import { countGeometry, optimize } from "./gltf.ts";
import { lastKeyTime, poseAt, poseBounds, toBabylon, toBabylonBounds, worldMatrices } from "./pose.ts";
import { compressTextures, type TextureEncoderPool, type TextureFormat } from "./textures.ts";

/** Source files are authored in centimeters. */
const CM_TO_M = 0.01;
/** Vertices within this distance (source units, cm) of the barrel's front face define the muzzle. */
const MUZZLE_SLICE = 1;

export async function buildWeapon(
  spec: WeaponSpec,
  io: NodeIO,
  pool: TextureEncoderPool,
  format: TextureFormat,
): Promise<WeaponAsset> {
  const doc = await io.read(join(SRC_DIR, spec.source));
  restructure(doc, spec.id);
  const animation = doc.getRoot().listAnimations()[0]!;
  const find = (name: string) => findUnique(doc, name);

  const lastFrame = Math.round(lastKeyTime(animation) * spec.fps);
  for (const [name, [start, end]] of Object.entries(spec.clips)) {
    if (!(Number.isInteger(start) && Number.isInteger(end) && start <= end && end <= lastFrame)) {
      throw new Error(`${spec.id}: invalid clip ${name} [${start}, ${end}] (last frame ${lastFrame})`);
    }
  }

  const body = find(spec.nodes.body);
  const muzzle = doc.createNode("muzzle").setTranslation(muzzlePoint(body, find(spec.barrelMesh)));
  const ejection = doc
    .createNode("ejection")
    .setTranslation(meshCenterIn(body, find(spec.ejectionMesh)).toArray() as [number, number, number]);
  body.addChild(muzzle).addChild(ejection);

  const idleTime = (spec.clips.idle?.[0] ?? 0) / spec.fps;
  const world = worldMatrices(doc, poseAt(doc, animation, idleTime));
  const anchor = (node: Node): Vec3 => toBabylon(new Vector3().setFromMatrixPosition(world.get(node)!));
  const scopeLens = spec.nodes.scopeLens ? find(spec.nodes.scopeLens) : undefined;
  logHandedness(doc, world, spec.id);

  const bounds = toBabylonBounds(poseBounds(doc, world));
  const textures = await compressTextures(doc, WEAPON_TEXTURES, format, pool);
  await optimize(doc);

  const bytes = await io.writeBinary(doc);
  const url = `weapons/${spec.id}.glb`;
  await writeOutput(url, bytes);
  console.log(`  ${spec.id}: ${(bytes.byteLength / 1e6).toFixed(2)} MB, textures encoded ${textures.encoded}, cached ${textures.cached}`);

  const nodes: Record<string, string> = { ...spec.nodes, arms: "arms", muzzle: "muzzle", ejection: "ejection" };
  for (const name of Object.values(nodes)) find(name);

  return {
    url,
    hash: hashBytes(bytes),
    bytes: bytes.byteLength,
    fps: spec.fps,
    animation: animation.getName(),
    lastFrame,
    clips: spec.clips,
    nodes: nodes as WeaponAsset["nodes"],
    anchors: {
      muzzle: anchor(muzzle),
      ejection: anchor(ejection),
      ...(scopeLens ? { scopeLens: anchor(scopeLens) } : {}),
    },
    bounds,
    stats: { ...countGeometry(doc), textures: doc.getRoot().listTextures().length, textureFormat: format },
    credit: spec.credit,
  };
}

/**
 * Sketchfab exports wrap the FBX scene in Z-up/unit conversion nodes whose scale differs per model.
 * Replace them with a single `viewmodel` root at cm→m scale, drop IK pole helpers and empty leftovers.
 */
function restructure(doc: Document, id: string): void {
  const gltfRoot = doc.getRoot();
  const scene = gltfRoot.getDefaultScene() ?? gltfRoot.listScenes()[0]!;
  const fbxRoot = findUnique(doc, "RootNode");
  const assetRoot = doc.createNode("viewmodel").setScale([CM_TO_M, CM_TO_M, CM_TO_M]);
  for (const child of fbxRoot.listChildren()) assetRoot.addChild(child);

  let wrapper: Node | null = fbxRoot;
  while (wrapper) {
    const parent: Node | null = wrapper.getParentNode();
    wrapper.dispose();
    wrapper = parent;
  }
  scene.addChild(assetRoot);

  const animations = gltfRoot.listAnimations();
  const skins = gltfRoot.listSkins();
  if (animations.length !== 1 || skins.length !== 1) {
    throw new Error(`${id}: expected 1 animation and 1 skin, got ${animations.length} and ${skins.length}`);
  }
  const animation = animations[0]!.setName("all");
  const skin = skins[0]!;
  skin.setSkeleton(assetRoot);

  for (const node of gltfRoot.listNodes()) {
    if (!/_Pole$/.test(node.getName())) continue;
    for (const channel of animation.listChannels()) if (channel.getTargetNode() === node) channel.dispose();
    node.dispose();
  }

  const joints = new Set(skin.listJoints());
  const animated = new Set(animation.listChannels().map((c) => c.getTargetNode()));
  for (const node of gltfRoot.listNodes()) {
    const empty = !node.getMesh() && !node.getSkin() && node.listChildren().length === 0;
    if (empty && !joints.has(node) && !animated.has(node)) node.dispose();
  }

  const skinned = gltfRoot.listNodes().filter((n) => n.getSkin());
  if (skinned.length !== 1) throw new Error(`${id}: expected one skinned mesh node`);
  skinned[0]!.setName("arms");
}

function findUnique(doc: Document, name: string): Node {
  const matches = doc.getRoot().listNodes().filter((n) => n.getName() === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one node named "${name}", found ${matches.length}`);
  return matches[0]!;
}

/** Transform from `node` space into `ancestor` space using rest TRS. */
function relativeMatrix(node: Node, ancestor: Node): Matrix4 {
  const matrix = new Matrix4();
  for (let n: Node | null = node; n && n !== ancestor; n = n.getParentNode()) {
    matrix.premultiply(new Matrix4().fromArray(n.getMatrix()));
  }
  return matrix;
}

function meshPointsIn(space: Node, meshNode: Node): Vector3[] {
  const matrix = relativeMatrix(meshNode, space);
  const points: Vector3[] = [];
  for (const prim of meshNode.getMesh()?.listPrimitives() ?? []) {
    const position = prim.getAttribute("POSITION")!;
    for (let i = 0; i < position.getCount(); i++) {
      points.push(new Vector3().fromArray(position.getElement(i, [])).applyMatrix4(matrix));
    }
  }
  if (points.length === 0) throw new Error(`${meshNode.getName()} has no vertices`);
  return points;
}

function meshCenterIn(space: Node, meshNode: Node): Vector3 {
  return new Box3().setFromPoints(meshPointsIn(space, meshNode)).getCenter(new Vector3());
}

/** Center of the barrel mesh's frontmost slice (+Z is forward in every source file). */
function muzzlePoint(body: Node, barrel: Node): [number, number, number] {
  const points = meshPointsIn(body, barrel);
  const front = Math.max(...points.map((p) => p.z));
  const slice = new Box3().setFromPoints(points.filter((p) => p.z >= front - MUZZLE_SLICE));
  const center = slice.getCenter(new Vector3());
  return [center.x, center.y, front];
}

function logHandedness(doc: Document, world: Map<Node, Matrix4>, id: string): void {
  const wrist = (prefix: string) => {
    const node = doc.getRoot().listNodes().find((n) => n.getName().startsWith(`${prefix}_wrist`));
    return node ? toBabylon(new Vector3().setFromMatrixPosition(world.get(node)!)) : undefined;
  };
  const left = wrist("L");
  const right = wrist("R");
  if (left && right && right[0] <= left[0]) console.warn(`  ${id}: right wrist is not right of the left wrist (x ${right[0]} vs ${left[0]})`);
}

export async function writeOutput(url: string, bytes: Uint8Array): Promise<void> {
  const file = join(OUT_DIR, url);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
