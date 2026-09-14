import { join } from "node:path";
import type { Document, Material, Mesh, Node, NodeIO, Primitive, Texture } from "@gltf-transform/core";
import { KHRMaterialsPBRSpecularGlossiness, KHRMaterialsSpecular, type PBRSpecularGlossiness } from "@gltf-transform/extensions";
import { joinPrimitives, prune, simplify, transformMesh, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { Box3, Euler, Matrix4, Vector3 } from "three";
import type { EquipmentAsset, EquipmentPartRole } from "../../../apps/client/src/assets/equipmentManifest.ts";
import type { Bounds } from "../../../apps/client/src/assets/manifest.ts";
import { SRC_DIR } from "../config.ts";
import { hashBytes } from "../lib/cache.ts";
import { countGeometry, optimize } from "../lib/gltf.ts";
import { poseAt, toBabylonBounds, worldMatrices } from "../lib/pose.ts";
import { compressTextures, type TextureEncoderPool, type TextureFormat } from "../lib/textures.ts";
import { writeOutput } from "../lib/weapon.ts";
import { EQUIPMENT_OUT, EQUIPMENT_TEXTURES, type EquipmentItemSpec } from "./config.ts";
import { flipGreen, imageStats, isFlat, removeLightMarks, roughnessFromGlossiness, srgbToLinear } from "./images.ts";

/** Static equipment model: baked parts in item space, metal/rough materials, KTX2 textures, meshopt. */
export async function buildEquipmentItem(
  spec: EquipmentItemSpec,
  io: NodeIO,
  pool: TextureEncoderPool,
  format: TextureFormat,
): Promise<EquipmentAsset> {
  const doc = await io.read(join(SRC_DIR, spec.source));
  const groups = bakeParts(doc, spec);
  const itemRoot = restructure(doc, spec, groups);
  // Drop the discarded copies now, so triangle budgets and texture work only see what ships.
  await doc.transform(prune({ keepLeaves: true }));

  await fixMaterials(doc, spec);
  const simplified = await fitTriangleBudget(doc, spec.maxTriangles);
  const bounds = partBounds(doc, itemRoot, null);
  const bodyBounds = partBounds(doc, itemRoot, "body");
  const textures = await compressTextures(doc, EQUIPMENT_TEXTURES[spec.textures], format, pool);
  await optimize(doc);

  const bytes = await io.writeBinary(doc);
  const url = `${EQUIPMENT_OUT}/${spec.id}.glb`;
  await writeOutput(url, bytes);
  const stats = { ...countGeometry(doc), textures: doc.getRoot().listTextures().length, textureFormat: format };
  console.log(
    `  ${spec.id}: ${(bytes.byteLength / 1e3).toFixed(0)} KB, ${stats.triangles} tris${simplified ? " (simplified)" : ""}, textures encoded ${textures.encoded}, cached ${textures.cached}`,
  );

  const nodes: Record<string, string> = { root: itemRoot.getName() };
  for (const child of itemRoot.listChildren()) nodes[child.getName()] = child.getName();
  return {
    url,
    hash: hashBytes(bytes),
    bytes: bytes.byteLength,
    nodes: nodes as EquipmentAsset["nodes"],
    bounds,
    bodyBounds,
    stats,
    credit: spec.credit,
  };
}

type Groups = Map<EquipmentPartRole, Primitive[]>;

const matches = (node: Node, pattern: RegExp | undefined): boolean => {
  for (let n: Node | null = node; n; n = n.getParentNode()) if (pattern?.test(n.getName())) return true;
  return false;
};

/** Bakes every kept mesh node (skinned ones at their rest pose) into source world space, grouped by part role. */
function bakeParts(doc: Document, spec: EquipmentItemSpec): Groups {
  const root = doc.getRoot();
  const world = worldMatrices(doc, poseAt(doc, undefined, 0));
  const groups: Groups = new Map();
  for (const node of root.listNodes()) {
    let mesh = node.getMesh();
    if (!mesh) continue;
    if ((spec.keep && !matches(node, spec.keep)) || matches(node, spec.drop)) continue;
    if (mesh.listParents().filter((p) => p !== root && p.propertyType === "Node").length > 1) {
      mesh = mesh.clone();
      node.setMesh(mesh);
    }
    const skin = node.getSkin();
    if (skin) bakeSkin(doc, mesh, skin, world);
    else transformMesh(mesh, world.get(node)!.elements as unknown as Parameters<typeof transformMesh>[1]);

    const role = (Object.entries(spec.parts ?? {}) as [EquipmentPartRole, RegExp][]).find(([, pattern]) => matches(node, pattern))?.[0] ?? "body";
    for (const prim of mesh.listPrimitives()) {
      // Sketchfab exports sometimes carry vertex colours and second UV sets the materials don't want.
      prim.setAttribute("COLOR_0", null).setAttribute("TEXCOORD_1", null);
      groups.set(role, [...(groups.get(role) ?? []), prim]);
    }
  }
  if (!groups.get("body")?.length) throw new Error(`${spec.id}: no body geometry kept`);
  for (const role of Object.keys(spec.parts ?? {})) {
    if (!groups.get(role as EquipmentPartRole)?.length) throw new Error(`${spec.id}: part "${role}" matched no mesh`);
  }
  return groups;
}

/** Linear-blend skinning at the rest pose, written into the vertices; joints/weights are dropped. */
function bakeSkin(doc: Document, mesh: Mesh, skin: NonNullable<ReturnType<Node["getSkin"]>>, world: Map<Node, Matrix4>): void {
  const joints = skin.listJoints().map((joint, i) => world.get(joint)!.clone().multiply(new Matrix4().fromArray(skin.getInverseBindMatrices()!.getElement(i, []))));
  const v = new Vector3();
  const acc = new Vector3();
  for (const prim of mesh.listPrimitives()) {
    const jointsAttr = prim.getAttribute("JOINTS_0")!;
    const weightsAttr = prim.getAttribute("WEIGHTS_0")!;
    const blend = (i: number, out: Matrix4) => {
      const j = jointsAttr.getElement(i, []);
      const w = weightsAttr.getElement(i, []);
      const e = out.elements.fill(0);
      for (let k = 0; k < 4; k++) {
        if (!(w[k]! > 0)) continue;
        const m = joints[j[k]!]!.elements;
        for (let c = 0; c < 16; c++) e[c]! += m[c]! * w[k]!;
      }
      return out;
    };
    const matrix = new Matrix4();
    for (const semantic of ["POSITION", "NORMAL"] as const) {
      const src = prim.getAttribute(semantic);
      if (!src) continue;
      const out = new Float32Array(src.getCount() * 3);
      for (let i = 0; i < src.getCount(); i++) {
        v.fromArray(src.getElement(i, []));
        blend(i, matrix);
        if (semantic === "POSITION") acc.copy(v).applyMatrix4(matrix);
        else acc.copy(v).transformDirection(matrix);
        acc.toArray(out, i * 3);
      }
      const accessor = doc.createAccessor().setType("VEC3").setArray(out).setBuffer(src.getBuffer());
      prim.setAttribute(semantic, accessor);
    }
    prim.setAttribute("JOINTS_0", null).setAttribute("WEIGHTS_0", null).setAttribute("TANGENT", null);
  }
}

/**
 * Replaces the source hierarchy with `<id>` → one child node per part. Item space: the spec rotation, real-world
 * scale, origin at the body's bounding-box centre; each non-body part's node sits at that part's own centre.
 */
function restructure(doc: Document, spec: EquipmentItemSpec, groups: Groups): Node {
  const root = doc.getRoot();
  const [rx, ry, rz] = (spec.rotate ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180) as [number, number, number];
  const rotation = new Matrix4().makeRotationFromEuler(new Euler(rx, ry, rz, "XYZ"));

  const boxOf = (prims: readonly Primitive[], matrix: Matrix4) => {
    const box = new Box3();
    const p = new Vector3();
    for (const prim of prims) {
      const position = prim.getAttribute("POSITION")!;
      for (let i = 0; i < position.getCount(); i++) box.expandByPoint(p.fromArray(position.getElement(i, [])).applyMatrix4(matrix));
    }
    return box;
  };
  const all = [...groups.values()].flat();
  const rotated = boxOf(all, rotation);
  const extent = rotated.getSize(new Vector3());
  const measured = spec.size.axis === "max" ? Math.max(extent.x, extent.y, extent.z) : extent[spec.size.axis];
  const scale = spec.size.meters / measured;
  const scaled = new Matrix4().makeScale(scale, scale, scale).multiply(rotation);
  const center = boxOf(groups.get("body")!, scaled).getCenter(new Vector3());
  const itemMatrix = new Matrix4().makeTranslation(-center.x, -center.y, -center.z).multiply(scaled);

  const itemRoot = doc.createNode(spec.id);
  for (const [role, prims] of groups) {
    const mesh = doc.createMesh(role);
    for (const prim of prims) {
      for (const parent of prim.listParents()) if (parent.propertyType === "Mesh") (parent as Mesh).removePrimitive(prim);
      mesh.addPrimitive(prim);
    }
    transformMesh(mesh, itemMatrix.elements as unknown as Parameters<typeof transformMesh>[1]);
    joinByMaterial(mesh);
    const node = doc.createNode(role).setMesh(mesh);
    if (role !== "body") {
      const pivot = boxOf(mesh.listPrimitives(), new Matrix4()).getCenter(new Vector3());
      transformMesh(mesh, new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z).elements as unknown as Parameters<typeof transformMesh>[1]);
      node.setTranslation([pivot.x, pivot.y, pivot.z]);
    }
    itemRoot.addChild(node);
  }

  const keepNodes = new Set([itemRoot, ...itemRoot.listChildren()]);
  for (const animation of root.listAnimations()) animation.dispose();
  for (const node of root.listNodes()) if (!keepNodes.has(node)) node.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  for (const scene of root.listScenes()) scene.dispose();
  const scene = doc.createScene(spec.id).addChild(itemRoot);
  root.setDefaultScene(scene);
  return itemRoot;
}

/** Fewer draw calls: primitives sharing a material (and attribute layout) become one. */
function joinByMaterial(mesh: Mesh): void {
  const byMaterial = new Map<Material | null, Primitive[]>();
  for (const prim of mesh.listPrimitives()) byMaterial.set(prim.getMaterial(), [...(byMaterial.get(prim.getMaterial()) ?? []), prim]);
  for (const prims of byMaterial.values()) {
    if (prims.length < 2) continue;
    try {
      const joined = joinPrimitives(prims);
      for (const prim of prims) {
        mesh.removePrimitive(prim);
        prim.dispose();
      }
      mesh.addPrimitive(joined);
    } catch {
      // Incompatible attribute sets: keep them separate.
    }
  }
}

/** Metal/rough only, no flat 2K textures, fixed normals and labels; see EquipmentItemSpec.fixes. */
async function fixMaterials(doc: Document, spec: EquipmentItemSpec): Promise<void> {
  const root = doc.getRoot();
  const fixes = spec.fixes ?? {};
  const processed = new Map<Texture, string>();
  const once = async (texture: Texture, key: string, run: (bytes: Uint8Array) => Promise<Uint8Array>) => {
    if (processed.get(texture)?.includes(key)) return;
    processed.set(texture, `${processed.get(texture) ?? ""}|${key}`);
    texture.setImage(await run(texture.getImage()!)).setMimeType("image/png");
  };

  for (const material of root.listMaterials()) {
    const specGloss = material.getExtension<PBRSpecularGlossiness>("KHR_materials_pbrSpecularGlossiness");
    if (specGloss) {
      // Dielectric approximation: diffuse becomes base colour, glossiness becomes roughness, metalness 0.
      material.setBaseColorFactor(specGloss.getDiffuseFactor());
      const diffuse = specGloss.getDiffuseTexture();
      if (diffuse) material.setBaseColorTexture(diffuse);
      const glossTexture = specGloss.getSpecularGlossinessTexture();
      const glossFactor = specGloss.getGlossinessFactor();
      material.setMetallicFactor(0);
      if (glossTexture) {
        const stats = await imageStats(glossTexture.getImage()!);
        const alpha = stats[stats.length - 1]!;
        if (isFlat(stats)) {
          material.setRoughnessFactor(Math.min(1, Math.max(0, 1 - (alpha.mean / 255) * glossFactor)));
        } else {
          const roughness = doc.createTexture(`${material.getName()}_roughness`).setImage(await roughnessFromGlossiness(glossTexture.getImage()!, glossFactor)).setMimeType("image/png");
          material.setMetallicRoughnessTexture(roughness).setRoughnessFactor(1);
        }
      } else {
        material.setRoughnessFactor(1 - glossFactor);
      }
      material.setExtension("KHR_materials_pbrSpecularGlossiness", null);
    }
    if (material.getExtension("KHR_materials_specular")) material.setExtension("KHR_materials_specular", null);
    if (fixes.opaque) material.setAlphaMode("OPAQUE");
    if (!material.getMetallicRoughnessTexture()) {
      if (fixes.roughness !== undefined) material.setRoughnessFactor(fixes.roughness);
      if (fixes.metallic !== undefined) material.setMetallicFactor(fixes.metallic);
    }

    // Flat textures become factors (or disappear).
    const base = material.getBaseColorTexture();
    if (base) {
      const stats = await imageStats(base.getImage()!);
      if (isFlat(stats)) {
        const f = material.getBaseColorFactor();
        material.setBaseColorFactor([f[0] * srgbToLinear(stats[0]!.mean), f[1] * srgbToLinear(stats[1]!.mean), f[2] * srgbToLinear(stats[2]!.mean), f[3]]);
        material.setBaseColorTexture(null);
      } else if (fixes.removeLabel) {
        await once(base, "label", removeLightMarks);
      }
    }
    const mr = material.getMetallicRoughnessTexture();
    if (mr) {
      const stats = await imageStats(mr.getImage()!);
      if (isFlat(stats)) {
        material.setRoughnessFactor(material.getRoughnessFactor() * (stats[1]!.mean / 255));
        material.setMetallicFactor(material.getMetallicFactor() * (stats[2]!.mean / 255));
        material.setMetallicRoughnessTexture(null);
      }
    }
    const occlusion = material.getOcclusionTexture();
    if (occlusion) {
      const stats = await imageStats(occlusion.getImage()!);
      if (isFlat(stats) && stats[0]!.mean > 245) material.setOcclusionTexture(null);
    }
    const normal = material.getNormalTexture();
    if (normal) {
      const stats = await imageStats(normal.getImage()!);
      if (isFlat(stats)) material.setNormalTexture(null);
      else if (fixes.flipNormalGreen) await once(normal, "flipGreen", flipGreen);
    }
  }
  for (const extension of root.listExtensionsUsed()) {
    if (extension.extensionName === KHRMaterialsPBRSpecularGlossiness.EXTENSION_NAME || extension.extensionName === KHRMaterialsSpecular.EXTENSION_NAME) {
      extension.dispose();
    }
  }
}

/** meshoptimizer simplification (after welding) until the triangle count fits. Returns true when it simplified. */
async function fitTriangleBudget(doc: Document, maxTriangles: number): Promise<boolean> {
  const triangles = () => countGeometry(doc).triangles;
  if (triangles() <= maxTriangles) return false;
  await MeshoptSimplifier.ready;
  await doc.transform(weld());
  for (let error = 0.001; error <= 0.05 && triangles() > maxTriangles; error *= 3) {
    const ratio = Math.min(0.99, (maxTriangles / triangles()) * 0.97);
    await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error }));
  }
  if (triangles() > maxTriangles) throw new Error(`could not simplify below ${maxTriangles} triangles (${triangles()})`);
  return true;
}

/** Babylon-space bounds of every part (or one role) at rest, relative to the item root. */
function partBounds(doc: Document, itemRoot: Node, role: EquipmentPartRole | null): Bounds {
  const box = new Box3();
  const p = new Vector3();
  const world = worldMatrices(doc, poseAt(doc, undefined, 0));
  for (const node of itemRoot.listChildren()) {
    if (role && node.getName() !== role) continue;
    const matrix = world.get(node)!;
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      const position = prim.getAttribute("POSITION")!;
      for (let i = 0; i < position.getCount(); i++) box.expandByPoint(p.fromArray(position.getElement(i, [])).applyMatrix4(matrix));
    }
  }
  return toBabylonBounds(box);
}
