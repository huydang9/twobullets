import { join } from "node:path";
import type { Document, Node, NodeIO } from "@gltf-transform/core";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { ThrowArmsAsset, ThrowArmsNodeRole } from "../../../apps/client/src/assets/equipmentManifest.ts";
import type { Vec3 } from "../../../apps/client/src/assets/manifest.ts";
import { SRC_DIR } from "../config.ts";
import { hashBytes } from "../lib/cache.ts";
import { countGeometry, optimize } from "../lib/gltf.ts";
import { lastKeyTime, poseAt, poseBounds, toBabylon, toBabylonBounds, worldMatrices } from "../lib/pose.ts";
import { compressTextures, type TextureEncoderPool, type TextureFormat } from "../lib/textures.ts";
import { writeOutput } from "../lib/weapon.ts";
import { EQUIPMENT_OUT, EQUIPMENT_TEXTURES, type ThrowArmsSpec } from "./config.ts";

/** Source files are authored in centimeters. */
const CM_TO_M = 0.01;
/** IK helpers baked into the clip; nothing is skinned to them. */
const HELPER = /_(Pole|Goal)$/;

/**
 * First-person throwing arms (DJMaesen): the Sketchfab wrapper nodes become one `throw_arms` root at cm → m scale (like
 * the weapons), IK helpers go, and a `grip` node is added under the right wrist where the held item sits.
 */
export async function buildThrowArms(spec: ThrowArmsSpec, io: NodeIO, pool: TextureEncoderPool, format: TextureFormat): Promise<ThrowArmsAsset> {
  const doc = await io.read(join(SRC_DIR, spec.source));
  const root = restructure(doc, spec.id);
  const animation = doc.getRoot().listAnimations()[0]!;
  const find = (name: string) => findUnique(doc, name);

  const lastFrame = Math.round(lastKeyTime(animation) * spec.fps);
  for (const [name, [start, end]] of Object.entries(spec.clips)) {
    if (!(start <= end && end <= lastFrame)) throw new Error(`${spec.id}: invalid clip ${name} [${start}, ${end}] (last frame ${lastFrame})`);
  }

  const readyTime = spec.clips.ready[0] / spec.fps;
  const world = worldMatrices(doc, poseAt(doc, animation, readyTime));
  const wrist = find(spec.nodes.rightHand);
  const grip = doc.createNode("grip");
  wrist.addChild(grip);
  placeGrip(doc, spec, wrist, grip, world);

  const readyWorld = worldMatrices(doc, poseAt(doc, animation, readyTime));
  const anchor = (node: Node): Vec3 => toBabylon(new Vector3().setFromMatrixPosition(readyWorld.get(node)!));
  const bounds = toBabylonBounds(poseBounds(doc, readyWorld));

  const textures = await compressTextures(doc, EQUIPMENT_TEXTURES.arms, format, pool);
  await optimize(doc);
  const stats = { ...countGeometry(doc), textures: doc.getRoot().listTextures().length, textureFormat: format };
  if (stats.triangles > spec.maxTriangles) throw new Error(`${spec.id}: ${stats.triangles} triangles exceeds ${spec.maxTriangles}`);

  const bytes = await io.writeBinary(doc);
  const url = `${EQUIPMENT_OUT}/${spec.id}.glb`;
  await writeOutput(url, bytes);
  console.log(`  ${spec.id}: ${(bytes.byteLength / 1e6).toFixed(2)} MB, ${stats.triangles} tris, textures encoded ${textures.encoded}, cached ${textures.cached}`);

  const nodes: Record<ThrowArmsNodeRole, string> = {
    arms: "arms",
    rightShoulder: spec.nodes.rightShoulder,
    rightHand: spec.nodes.rightHand,
    leftShoulder: spec.nodes.leftShoulder,
    leftHand: spec.nodes.leftHand,
    grip: "grip",
  };
  for (const name of Object.values(nodes)) find(name);
  void root;
  return {
    url,
    hash: hashBytes(bytes),
    bytes: bytes.byteLength,
    fps: spec.fps,
    animation: animation.getName(),
    lastFrame,
    clips: spec.clips,
    releaseFrame: spec.releaseFrame,
    nodes,
    anchors: { grip: anchor(grip), leftHand: anchor(find(spec.nodes.leftHand)), rightHand: anchor(wrist) },
    bounds,
    stats,
    credit: spec.credit,
  };
}

function restructure(doc: Document, id: string): Node {
  const gltfRoot = doc.getRoot();
  const scene = gltfRoot.getDefaultScene() ?? gltfRoot.listScenes()[0]!;
  const fbxRoot = findUnique(doc, "RootNode");
  const assetRoot = doc.createNode(id).setScale([CM_TO_M, CM_TO_M, CM_TO_M]);
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
  if (animations.length !== 1 || skins.length !== 1) throw new Error(`${id}: expected 1 animation and 1 skin, got ${animations.length} and ${skins.length}`);
  const animation = animations[0]!.setName("all");
  const skin = skins[0]!;
  skin.setSkeleton(assetRoot);
  for (const node of gltfRoot.listNodes()) {
    if (!HELPER.test(node.getName())) continue;
    for (const channel of animation.listChannels()) if (channel.getTargetNode() === node) channel.dispose();
    node.dispose();
  }
  const joints = new Set(skin.listJoints());
  const animated = new Set(animation.listChannels().map((c) => c.getTargetNode()));
  // Repeat: removing a leaf can empty its parent.
  for (let pass = 0; pass < 4; pass++) {
    for (const node of gltfRoot.listNodes()) {
      const empty = !node.getMesh() && !node.getSkin() && node.listChildren().length === 0;
      if (empty && node !== assetRoot && !joints.has(node) && !animated.has(node)) node.dispose();
    }
  }
  const skinned = gltfRoot.listNodes().filter((n) => n.getSkin());
  if (skinned.length !== 1) throw new Error(`${id}: expected one skinned mesh node`);
  skinned[0]!.setName("arms");
  return assetRoot;
}

/**
 * Grip at the ready frame: the centroid of the curled finger joints (inside the fist). Axes in item space: +Y from the
 * little finger toward the index finger (out of the top of the fist, where a grenade's fuse points), +Z along the
 * knuckles' forward direction. The node gets an inverse scale so its children are in meters.
 */
function placeGrip(doc: Document, spec: ThrowArmsSpec, wrist: Node, grip: Node, world: Map<Node, Matrix4>): void {
  const position = (node: Node) => new Vector3().setFromMatrixPosition(world.get(node)!);
  const joints = doc.getRoot().listNodes().filter((n) => spec.gripJoints.test(n.getName()));
  if (joints.length < 6) throw new Error(`${spec.id}: only ${joints.length} grip joints matched`);
  const center = joints.reduce((sum, joint) => sum.add(position(joint)), new Vector3()).multiplyScalar(1 / joints.length);
  const byPrefix = (prefix: string) => {
    const node = doc.getRoot().listNodes().find((n) => n.getName().startsWith(prefix));
    if (!node) throw new Error(`${spec.id}: no ${prefix} joint`);
    return position(node);
  };
  const y = byPrefix("R_point1").sub(byPrefix("R_pink1")).normalize();
  const forward = byPrefix("R_middle1").sub(position(wrist)).normalize();
  const z = forward.sub(y.clone().multiplyScalar(forward.dot(y))).normalize();
  const x = new Vector3().crossVectors(y, z).normalize();
  const gripWorld = new Matrix4().makeBasis(x, y, z).setPosition(center);
  const local = world.get(wrist)!.clone().invert().multiply(gripWorld);
  const t = new Vector3();
  const r = new Quaternion();
  const s = new Vector3();
  local.decompose(t, r, s);
  grip.setTranslation(t.toArray() as [number, number, number]).setRotation(r.toArray() as [number, number, number, number]).setScale(s.toArray() as [number, number, number]);
}

function findUnique(doc: Document, name: string): Node {
  const matches = doc.getRoot().listNodes().filter((n) => n.getName() === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one node named "${name}", found ${matches.length}`);
  return matches[0]!;
}
