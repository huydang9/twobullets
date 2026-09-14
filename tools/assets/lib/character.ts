import { join } from "node:path";
import {
  type Accessor,
  Document,
  type Material,
  type Mesh as GltfMesh,
  type Node,
  type NodeIO,
  type Primitive,
  type Texture as GltfTexture,
} from "@gltf-transform/core";
import { weld } from "@gltf-transform/functions";
import sharp from "sharp";
import {
  type Bone,
  type BufferAttribute,
  Matrix4,
  type MeshPhongMaterial,
  type Object3D,
  type SkinnedMesh,
  type Texture,
  Vector3,
} from "three";
import type { CharacterAsset, CharacterClip, CharacterClipName, Vec3 } from "../../../apps/client/src/assets/manifest.ts";
import { CHARACTER_TEXTURES, type CharacterSpec, SRC_DIR } from "../config.ts";
import { hashBytes } from "./cache.ts";
import { canonicalBone, type FbxImage, loadFbx, originalName } from "./fbx.ts";
import { countGeometry, optimize, QUIET_LOGGER } from "./gltf.ts";
import { poseAt, poseBounds, toBabylonBounds, worldMatrices } from "./pose.ts";
import { compressTextures, type TextureEncoderPool, type TextureFormat } from "./textures.ts";
import { writeOutput } from "./weapon.ts";

/** Mixamo FBX units are centimeters. */
const CM_TO_M = 0.01;
const HIPS = "mixamorig:Hips";

export async function buildCharacter(
  spec: CharacterSpec,
  io: NodeIO,
  pool: TextureEncoderPool,
  format: TextureFormat,
): Promise<CharacterAsset> {
  const source = await loadFbx(join(SRC_DIR, spec.mesh));
  source.group.updateMatrixWorld(true);

  const doc = new Document().setLogger(QUIET_LOGGER);
  const buffer = doc.createBuffer();
  const root = doc.createNode(spec.id);
  doc.createScene(spec.id).addChild(root);
  doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]!);

  const bones = createSkeleton(doc, source.group, root);
  const skin = createSkin(doc, buffer, source.group, bones);
  const materials = new MaterialConverter(doc, source.images);

  // All parts go into one mesh on one node so the file keeps a single skin (per-node quantization would split it).
  const mesh = doc.createMesh(`${spec.id}_mesh`);
  root.addChild(doc.createNode(`${spec.id}_mesh`).setMesh(mesh).setSkin(skin.skin));
  source.group.traverse((object) => {
    if ((object as SkinnedMesh).isSkinnedMesh) addPrimitives(doc, buffer, object as SkinnedMesh, mesh, bones, skin.joints, materials);
  });

  for (const role of Object.values(spec.bones)) {
    if (!bones.has(role)) throw new Error(`Bone "${role}" not found in ${spec.mesh}`);
  }

  const clips = {} as Record<CharacterClipName, CharacterClip>;
  for (const [name, clipSpec] of Object.entries(spec.clips) as [CharacterClipName, CharacterSpec["clips"][CharacterClipName]][]) {
    clips[name] = await convertClip(doc, buffer, name, join(SRC_DIR, spec.animDir, clipSpec.file), bones, clipSpec);
  }

  const restBounds = poseBounds(doc, worldMatrices(doc, poseAt(doc, undefined, 0)));
  await materials.finish();
  mergeByMaterial(doc, buffer, mesh);
  await doc.transform(weld());
  const textures = await compressTextures(doc, CHARACTER_TEXTURES, format, pool);
  await optimize(doc);

  const bytes = await io.writeBinary(doc);
  const url = `characters/${spec.id}.glb`;
  await writeOutput(url, bytes);
  console.log(`  ${spec.id}: ${(bytes.byteLength / 1e6).toFixed(2)} MB, textures encoded ${textures.encoded}, cached ${textures.cached}`);

  return {
    url,
    hash: hashBytes(bytes),
    bytes: bytes.byteLength,
    height: Math.round((restBounds.max.y - restBounds.min.y) * 1000) / 1000,
    bounds: toBabylonBounds(restBounds),
    clips,
    bones: spec.bones,
    stats: { ...countGeometry(doc), textures: doc.getRoot().listTextures().length, textureFormat: format },
    credit: spec.credit,
  };
}

/** One glTF node per unique FBX bone, keyed by original bone name, translations baked to meters. */
function createSkeleton(doc: Document, group: Object3D, root: Node): Map<string, Node> {
  const nodes = new Map<string, Node>();
  const visit = (object: Object3D, parent: Node) => {
    let next = parent;
    const bone = object as Bone;
    if (bone.isBone && canonicalBone(bone) === bone) {
      const node = doc
        .createNode(originalName(bone))
        .setTranslation(bone.position.clone().multiplyScalar(CM_TO_M).toArray() as [number, number, number])
        .setRotation(bone.quaternion.toArray() as [number, number, number, number])
        .setScale(bone.scale.toArray() as [number, number, number]);
      parent.addChild(node);
      nodes.set(node.getName(), node);
      next = node;
    }
    for (const child of object.children) visit(child, next);
  };
  visit(group, root);
  if (!nodes.has(HIPS)) throw new Error(`Skeleton has no ${HIPS}`);
  return nodes;
}

/** A single skin over every bone. Inverse bind matrices come from the FBX clusters when available. */
function createSkin(doc: Document, buffer: ReturnType<Document["createBuffer"]>, group: Object3D, bones: Map<string, Node>) {
  const joints = [...bones.values()];
  const inverseBind = new Map<string, Matrix4>();
  group.traverse((object) => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.skeleton.bones.forEach((bone, i) => {
      const matrix = mesh.skeleton.boneInverses[i]!.clone().multiply(mesh.bindMatrix);
      const name = originalName(canonicalBone(bone));
      const existing = inverseBind.get(name);
      if (existing && !existing.equals(matrix)) {
        const diff = Math.max(...existing.elements.map((v, k) => Math.abs(v - matrix.elements[k]!)));
        if (diff > 1e-3) console.warn(`  inverse bind mismatch for ${name} (${diff.toFixed(5)})`);
      }
      inverseBind.set(name, matrix);
    });
  });

  const data = new Float32Array(joints.length * 16);
  group.traverse((object) => {
    const bone = object as Bone;
    if (!bone.isBone || canonicalBone(bone) !== bone) return;
    const name = originalName(bone);
    const matrix = inverseBind.get(name) ?? bone.matrixWorld.clone().invert();
    const elements = [...matrix.elements];
    for (const k of [12, 13, 14]) elements[k]! *= CM_TO_M;
    data.set(elements, joints.indexOf(bones.get(name)!) * 16);
  });

  const skin = doc
    .createSkin("skeleton")
    .setSkeleton(bones.get(HIPS)!)
    .setInverseBindMatrices(doc.createAccessor("inverseBind").setType("MAT4").setArray(data).setBuffer(buffer));
  for (const joint of joints) skin.addJoint(joint);
  return { skin, joints };
}

function addPrimitives(
  doc: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  mesh: SkinnedMesh,
  target: GltfMesh,
  bones: Map<string, Node>,
  joints: Node[],
  materials: MaterialConverter,
) {
  const geometry = mesh.geometry;
  const attr = (name: string) => geometry.getAttribute(name) as BufferAttribute;
  const count = attr("position").count;
  const accessor = (name: string, type: "VEC2" | "VEC3" | "VEC4", array: Float32Array<ArrayBuffer> | Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) =>
    doc.createAccessor(`${mesh.name}_${name}`).setType(type).setArray(array).setBuffer(buffer);

  const positions = new Float32Array(attr("position").array as Float32Array).map((v) => v * CM_TO_M);
  const uvs = new Float32Array(attr("uv").array as Float32Array);
  for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i]!; // FBX UV origin is bottom-left.

  const jointIndex = mesh.skeleton.bones.map((bone) => joints.indexOf(bones.get(originalName(canonicalBone(bone)))!));
  const skinIndex = attr("skinIndex");
  const skinWeight = attr("skinWeight");
  const jointArray = new (joints.length > 255 ? Uint16Array : Uint8Array)(count * 4);
  const weightArray = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += skinWeight.getComponent(i, k);
    for (let k = 0; k < 4; k++) {
      const weight = sum > 0 ? skinWeight.getComponent(i, k) / sum : k === 0 ? 1 : 0;
      jointArray[i * 4 + k] = weight > 0 ? jointIndex[skinIndex.getComponent(i, k)]! : 0;
      weightArray[i * 4 + k] = weight;
    }
  }

  const shared: [string, Accessor][] = [
    ["POSITION", accessor("position", "VEC3", positions)],
    ["NORMAL", accessor("normal", "VEC3", new Float32Array(attr("normal").array as Float32Array))],
    ["TEXCOORD_0", accessor("uv", "VEC2", uvs)],
    ["JOINTS_0", accessor("joints", "VEC4", jointArray)],
    ["WEIGHTS_0", accessor("weights", "VEC4", weightArray)],
  ];

  const sourceMaterials = [mesh.material].flat() as MeshPhongMaterial[];
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
  for (const group of groups) {
    const prim = doc.createPrimitive().setMaterial(materials.get(sourceMaterials[group.materialIndex ?? 0]!));
    if (groups.length === 1) {
      for (const [semantic, acc] of shared) prim.setAttribute(semantic, acc);
    } else {
      for (const [semantic, acc] of shared) {
        const size = acc.getElementSize();
        const array = acc.getArray()!;
        const slice = array.slice(group.start * size, (group.start + group.count) * size);
        prim.setAttribute(semantic, doc.createAccessor(acc.getName()).setType(acc.getType()).setArray(slice).setBuffer(buffer));
      }
    }
    target.addPrimitive(prim);
  }
}

/** Concatenates (still unindexed) primitives that share a material, saving draw calls. */
function mergeByMaterial(doc: Document, buffer: ReturnType<Document["createBuffer"]>, mesh: GltfMesh): void {
  const byMaterial = Map.groupBy(mesh.listPrimitives(), (prim) => prim.getMaterial());
  for (const prims of byMaterial.values()) {
    if (prims.length < 2) continue;
    const [first, ...rest] = prims as [Primitive, ...Primitive[]];
    for (const semantic of first.listSemantics()) {
      const accessors = prims.map((p) => p.getAttribute(semantic)!);
      const arrays = accessors.map((a) => a.getArray()!);
      const merged = new (arrays[0]!.constructor as new (n: number) => typeof arrays[number])(arrays.reduce((n, a) => n + a.length, 0));
      let offset = 0;
      for (const array of arrays) {
        merged.set(array as never, offset);
        offset += array.length;
      }
      first.setAttribute(semantic, doc.createAccessor(accessors[0]!.getName()).setType(accessors[0]!.getType()).setArray(merged).setBuffer(buffer));
    }
    for (const prim of rest) prim.dispose();
  }
}

/** Phong (diffuse/normal/specular) → metal-rough PBR. Roughness is derived from specular luminance. */
class MaterialConverter {
  private readonly materials = new Map<string, Material>();
  private readonly textures = new Map<Texture, GltfTexture>();
  private readonly ormJobs: Promise<void>[] = [];

  private readonly doc: Document;
  private readonly images: Map<Texture, FbxImage>;

  constructor(doc: Document, images: Map<Texture, FbxImage>) {
    this.doc = doc;
    this.images = images;
  }

  get(source: MeshPhongMaterial): Material {
    const existing = this.materials.get(source.name);
    if (existing) return existing;
    const material = this.doc.createMaterial(source.name).setMetallicFactor(0).setRoughnessFactor(1);
    if (source.map) material.setBaseColorTexture(this.texture(source.map));
    if (source.normalMap) material.setNormalTexture(this.texture(source.normalMap));
    const specular = source.specularMap && this.images.get(source.specularMap);
    if (specular) {
      const orm = this.doc.createTexture(`${source.name}_orm`);
      material.setMetallicRoughnessTexture(orm);
      this.ormJobs.push(roughnessFromSpecular(specular.bytes).then((png) => void orm.setImage(png).setMimeType("image/png")));
    } else {
      material.setRoughnessFactor(0.8);
    }
    this.materials.set(source.name, material);
    return material;
  }

  finish(): Promise<void[]> {
    return Promise.all(this.ormJobs);
  }

  private texture(source: Texture): GltfTexture {
    const cached = this.textures.get(source);
    if (cached) return cached;
    const image = this.images.get(source);
    if (!image) throw new Error(`Missing embedded image for texture ${source.name}`);
    const texture = this.doc.createTexture(source.name).setImage(image.bytes).setMimeType(image.mimeType);
    this.textures.set(source, texture);
    return texture;
  }
}

/** Packs glTF metallic-roughness: G = roughness (glossy where specular is bright), B = metalness 0. */
async function roughnessFromSpecular(specular: Uint8Array): Promise<Uint8Array> {
  const { data, info } = await sharp(specular).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 3);
  for (let i = 0, o = 0; i < data.length; i += info.channels, o += 3) {
    const luminance = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
    const roughness = Math.min(0.95, Math.max(0.3, 0.95 - Math.sqrt(luminance) * 0.8));
    out[o] = 255;
    out[o + 1] = Math.round(roughness * 255);
    out[o + 2] = 0;
  }
  return new Uint8Array(await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer());
}

async function convertClip(
  doc: Document,
  buffer: ReturnType<Document["createBuffer"]>,
  name: string,
  path: string,
  bones: Map<string, Node>,
  spec: { loop: boolean; inPlace: boolean },
): Promise<CharacterClip> {
  const { group } = await loadFbx(path);
  const clip = group.animations.find((c) => c.tracks.length > 0);
  if (!clip) throw new Error(`${path} has no animation tracks`);

  const sourceNames = new Map<string, string>();
  group.traverse((object) => {
    if ((object as Bone).isBone) sourceNames.set(object.name, originalName(object as Bone));
  });

  const animation = doc.createAnimation(name);
  let duration = 0;
  let rootMotion: Vec3 | undefined;
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf(".");
    const property = track.name.slice(dot + 1);
    const node = bones.get(sourceNames.get(track.name.slice(0, dot)) ?? "");
    const path = property === "position" ? "translation" : property === "quaternion" ? "rotation" : property === "scale" ? "scale" : null;
    if (!node || !path) {
      console.warn(`  ${name}: skipping track ${track.name}`);
      continue;
    }

    const times = new Float32Array(track.times);
    const values = new Float32Array(track.values);
    duration = Math.max(duration, times.at(-1)!);
    if (path === "translation") {
      for (let i = 0; i < values.length; i++) values[i]! *= CM_TO_M;
      if (spec.inPlace && node.getName() === HIPS) rootMotion = removeHorizontalDrift(times, values);
    } else if (path === "rotation") {
      for (let i = 4; i < values.length; i += 4) {
        const dot4 = values[i]! * values[i - 4]! + values[i + 1]! * values[i - 3]! + values[i + 2]! * values[i - 2]! + values[i + 3]! * values[i - 1]!;
        if (dot4 < 0) for (let k = 0; k < 4; k++) values[i + k]! *= -1;
      }
    }

    const sampler = doc
      .createAnimationSampler()
      .setInput(doc.createAccessor().setType("SCALAR").setArray(times).setBuffer(buffer))
      .setOutput(doc.createAccessor().setType(path === "rotation" ? "VEC4" : "VEC3").setArray(values).setBuffer(buffer))
      .setInterpolation("LINEAR");
    animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
  }

  return {
    duration: Math.round(duration * 1000) / 1000,
    loop: spec.loop,
    ...(rootMotion ? { rootMotion } : {}),
  };
}

/** Subtracts the linear X/Z trend of the hips track so the clip loops in place; returns the removed velocity. */
function removeHorizontalDrift(times: Float32Array, values: Float32Array): Vec3 {
  const last = values.length - 3;
  const duration = times.at(-1)! - times[0]!;
  const dx = values[last]! - values[0]!;
  const dz = values[last + 2]! - values[2]!;
  for (let i = 0; i < times.length; i++) {
    const u = (times[i]! - times[0]!) / duration;
    values[i * 3]! -= dx * u;
    values[i * 3 + 2]! -= dz * u;
  }
  const round = (v: number) => Math.round(v * 1000) / 1000 + 0;
  // glTF → Babylon mirrors X.
  const velocity = new Vector3(-dx / duration, 0, dz / duration);
  return [round(velocity.x), 0, round(velocity.z)];
}
