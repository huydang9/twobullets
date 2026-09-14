import type { Animation, AnimationSampler, Document, Node } from "@gltf-transform/core";
import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import type { Bounds, Vec3 } from "../../../apps/client/src/assets/manifest.ts";

type TRS = { t: number[]; r: number[]; s: number[] };

/** Linear/step sample of a glTF sampler at `time` seconds (quaternions are nlerped, good enough for analysis). */
export function sampleAt(sampler: AnimationSampler, time: number): number[] {
  const input = sampler.getInput()!.getArray()!;
  const output = sampler.getOutput()!;
  const n = output.getElementSize();
  const last = input.length - 1;
  // getElement denormalizes quantized (meshopt-filtered) outputs.
  const read = (i: number): number[] => output.getElement(i, []);
  if (time <= input[0]!) return read(0);
  if (time >= input[last]!) return read(last);
  let i = 0;
  while (input[i + 1]! < time) i++;
  if (sampler.getInterpolation() === "STEP") return read(i);
  const u = (time - input[i]!) / (input[i + 1]! - input[i]!);
  const a = read(i);
  const b = read(i + 1);
  if (n === 4 && a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]! < 0) b.forEach((v, k) => (b[k] = -v));
  const out = a.map((v, k) => v + (b[k]! - v) * u);
  if (n === 4) {
    const len = Math.hypot(...out);
    return out.map((v) => v / len);
  }
  return out;
}

export function lastKeyTime(animation: Animation): number {
  return Math.max(...animation.listSamplers().map((s) => s.getInput()!.getArray()!.at(-1)!));
}

/** Local TRS of every animated node at `time`, falling back to the node's rest TRS. */
export function poseAt(doc: Document, animation: Animation | undefined, time: number): Map<Node, TRS> {
  const pose = new Map<Node, TRS>();
  for (const node of doc.getRoot().listNodes()) {
    pose.set(node, { t: node.getTranslation(), r: node.getRotation(), s: node.getScale() });
  }
  for (const channel of animation?.listChannels() ?? []) {
    const node = channel.getTargetNode();
    const path = channel.getTargetPath();
    const entry = node && pose.get(node);
    if (!entry || !channel.getSampler()) continue;
    const value = sampleAt(channel.getSampler()!, time);
    if (path === "translation") entry.t = value;
    else if (path === "rotation") entry.r = value;
    else if (path === "scale") entry.s = value;
  }
  return pose;
}

export function worldMatrices(doc: Document, pose: Map<Node, TRS>): Map<Node, Matrix4> {
  const world = new Map<Node, Matrix4>();
  const visit = (node: Node, parent: Matrix4) => {
    const trs = pose.get(node)!;
    const local = new Matrix4().compose(
      new Vector3().fromArray(trs.t),
      new Quaternion().fromArray(trs.r),
      new Vector3().fromArray(trs.s),
    );
    const matrix = parent.clone().multiply(local);
    world.set(node, matrix);
    for (const child of node.listChildren()) visit(child, matrix);
  };
  for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) visit(node, new Matrix4());
  return world;
}

/** World-space AABB of all mesh vertices (skinned meshes are skinned) for a pose. */
export function poseBounds(doc: Document, world: Map<Node, Matrix4>): Box3 {
  const box = new Box3();
  const v = new Vector3();
  const skinned = new Vector3();
  const tmp = new Vector3();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const skin = node.getSkin();
    const jointMatrices = skin?.listJoints().map((joint, i) => {
      const ibm = new Matrix4().fromArray(skin.getInverseBindMatrices()!.getElement(i, []));
      return world.get(joint)!.clone().multiply(ibm);
    });
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION")!;
      const joints = prim.getAttribute("JOINTS_0");
      const weights = prim.getAttribute("WEIGHTS_0");
      for (let i = 0; i < position.getCount(); i++) {
        v.fromArray(position.getElement(i, []));
        if (jointMatrices && joints && weights) {
          const j = joints.getElement(i, []);
          const w = weights.getElement(i, []);
          skinned.set(0, 0, 0);
          for (let k = 0; k < 4; k++) {
            if (w[k]! > 0) skinned.add(tmp.copy(v).applyMatrix4(jointMatrices[j[k]!]!).multiplyScalar(w[k]!));
          }
          box.expandByPoint(skinned);
        } else {
          box.expandByPoint(v.applyMatrix4(world.get(node)!));
        }
      }
    }
  }
  return box;
}

const round = (x: number) => Math.round(x * 10000) / 10000 + 0;

/** glTF (right-handed) → Babylon (left-handed, X mirrored by the glTF loader). */
export function toBabylon(p: Vector3): Vec3 {
  return [round(-p.x), round(p.y), round(p.z)];
}

export function toBabylonBounds(box: Box3): Bounds {
  const a = toBabylon(box.min);
  const b = toBabylon(box.max);
  return {
    min: [Math.min(a[0], b[0]), a[1], a[2]],
    max: [Math.max(a[0], b[0]), b[1], b[2]],
  };
}
