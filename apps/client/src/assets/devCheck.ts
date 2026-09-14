import type { AbstractMesh, AnimationGroup, Node, TransformNode } from "@babylonjs/core";
import type { AssetLibrary } from "./AssetLibrary";
import { bakeStaticMesh, computeWorldMatrices } from "./EquipmentInstance";
import { EQUIPMENT_MODEL_IDS } from "./equipmentManifest";
import { CHARACTER_IDS, type Vec3, WEAPON_IDS } from "./manifest";

export interface AssetCheckReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly summary: readonly string[];
}

/**
 * Structural self-check of every loaded asset: instantiates each one, verifies nodes/clips/bones, poses
 * animations and compares key positions with the manifest. Safe to run in DEV (instances are disposed).
 * Also used headless by `pnpm assets:verify`.
 */
export function runAssetSelfCheck(library: AssetLibrary): AssetCheckReport {
  const errors: string[] = [];
  const summary: string[] = [];
  const expect = (condition: boolean, message: string) => {
    if (!condition) errors.push(message);
  };

  for (const id of WEAPON_IDS) {
    try {
      const weapon = library.instantiateWeapon(id);
      const asset = weapon.asset;
      const scale = (weapon.animation.targetedAnimations[0]?.animation.framePerSecond ?? asset.fps) / asset.fps;
      expect(Math.abs(weapon.animation.to - asset.lastFrame * scale) < 1e-3, `${id}: animation ends at ${weapon.animation.to}`);
      for (const clip of Object.keys(asset.clips) as (keyof typeof asset.clips)[]) {
        weapon.play(clip, { loop: true });
        expect(weapon.animation.isPlaying && weapon.currentClip === clip, `${id}: ${clip} did not start`);
      }
      weapon.goToFrame(asset.clips.idle?.[0] ?? 0);
      const muzzle = worldPosition(weapon.nodes.muzzle);
      expect(near(muzzle, asset.anchors.muzzle, 0.002), `${id}: muzzle at ${fmt(muzzle)}, manifest ${fmt(asset.anchors.muzzle)}`);
      const ejection = worldPosition(weapon.nodes.ejection);
      expect(near(ejection, asset.anchors.ejection, 0.002), `${id}: ejection at ${fmt(ejection)}, manifest ${fmt(asset.anchors.ejection)}`);
      const arms = weapon.nodes.arms as AbstractMesh;
      expect(weapon.skeleton !== null && arms.skeleton === weapon.skeleton, `${id}: nodes.arms is not the skinned mesh`);
      const bounds = skinnedBounds(weapon.root);
      expect(
        near(bounds.min, asset.bounds.min, 0.01) && near(bounds.max, asset.bounds.max, 0.01),
        `${id}: skinned bounds ${fmt(bounds.min)}..${fmt(bounds.max)}, manifest ${fmt(asset.bounds.min)}..${fmt(asset.bounds.max)}`,
      );
      summary.push(
        `${id}: ${weapon.meshes.length} meshes, ${weapon.skeleton?.bones.length ?? 0} bones, clips ${Object.keys(asset.clips).join(" ")}, muzzle ${fmt(muzzle)}`,
      );
      weapon.dispose();
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const id of CHARACTER_IDS) {
    try {
      const [a, b] = [library.instantiateCharacter(id), library.instantiateCharacter(id)];
      expect(a.skeleton !== b.skeleton && a.bones.head !== b.bones.head, `${id}: instances share a skeleton`);
      expect(a.animations.size === Object.keys(a.asset.clips).length, `${id}: ${a.animations.size} animation groups`);
      const rest = skinnedBounds(a.root);
      expect(Math.abs(rest.max[1] - rest.min[1] - a.asset.height) < 0.01, `${id}: bind-pose height ${(rest.max[1] - rest.min[1]).toFixed(3)}`);

      pose(a.animations.get("rifle_idle")!, 0);
      const head = worldPosition(a.bones.head);
      const foot = worldPosition(a.bones.leftFoot);
      expect(head[1] > 1.4 && head[1] < 1.9, `${id}: head height ${head[1].toFixed(3)}`);
      expect(foot[1] < 0.25, `${id}: foot height ${foot[1].toFixed(3)}`);

      pose(b.animations.get("death_back")!, Number.POSITIVE_INFINITY);
      const fallen = worldPosition(b.bones.head);
      expect(fallen[1] < 0.6, `${id}: death_back head height ${fallen[1].toFixed(3)}`);
      expect(Math.abs(worldPosition(a.bones.head)[1] - head[1]) < 1e-4, `${id}: posing one instance moved the other`);

      for (const clip of ["walk_fwd", "run_fwd", "sprint_fwd", "walk_left", "crouch_walk_fwd"] as const) {
        const group = a.animations.get(clip)!;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let t = 0; t <= 1; t += 0.05) {
          pose(group, group.from + (group.to - group.from) * t);
          const [x, , z] = worldPosition(a.bones.hips);
          [minX, maxX, minZ, maxZ] = [Math.min(minX, x), Math.max(maxX, x), Math.min(minZ, z), Math.max(maxZ, z)];
        }
        const drift = Math.max(maxX - minX, maxZ - minZ);
        expect(drift < 0.2, `${id}: ${clip} hips move ${drift.toFixed(3)} m (root motion not removed?)`);
        group.stop(true);
      }

      const played = a.play("run_fwd", { blend: 0 });
      expect(played.isPlaying && a.currentClip === "run_fwd", `${id}: play(run_fwd) failed`);
      summary.push(
        `${id}: ${a.meshes.length} meshes, ${a.skeleton.bones.length} bones, ${a.animations.size} clips, head ${fmt(head)}`,
      );
      a.dispose();
      b.dispose();
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  checkEquipment(library, expect, errors, summary);
  return { ok: errors.length === 0, errors, summary };
}

/** Equipment models (optional): parts, rest bounds, a static bake, and the throw arms' clip and grip anchor. */
function checkEquipment(library: AssetLibrary, expect: (condition: boolean, message: string) => void, errors: string[], summary: string[]): void {
  const equipment = library.equipment;
  if (!equipment) {
    summary.push("equipment: not built (procedural stand-ins)");
    return;
  }
  const loaded: string[] = [];
  for (const id of EQUIPMENT_MODEL_IDS) {
    if (!equipment.items[id]) continue;
    if (!library.hasEquipment(id)) {
      errors.push(`equipment/${id}: in the manifest but not loaded`);
      continue;
    }
    try {
      const instance = library.instantiateEquipment(id)!;
      const asset = instance.asset;
      for (const role of ["body", "spoon", "ring"] as const) {
        expect(!asset.nodes[role] || instance.partMeshes(role).length > 0, `equipment/${id}: part ${role} has no meshes`);
      }
      const bounds = skinnedBounds(instance.root);
      expect(near(bounds.min, asset.bounds.min, 0.005) && near(bounds.max, asset.bounds.max, 0.005), `equipment/${id}: bounds ${fmt(bounds.min)}..${fmt(bounds.max)}, manifest ${fmt(asset.bounds.min)}..${fmt(asset.bounds.max)}`);
      computeWorldMatrices(instance.root);
      const baked = bakeStaticMesh(instance.partMeshes("body"), `check_${id}`, library.scene);
      expect(baked !== null && baked.getTotalVertices() > 0, `equipment/${id}: static bake failed`);
      baked?.dispose();
      instance.dispose();
      loaded.push(id);
    } catch (error) {
      errors.push(`equipment/${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let arms = "throw arms missing";
  if (equipment.arms) {
    try {
      const instance = library.instantiateThrowArms();
      if (!instance) throw new Error("not loaded");
      const asset = instance.asset;
      expect(instance.skeleton !== null && (instance.nodes.arms as AbstractMesh).skeleton === instance.skeleton, "throw_arms: nodes.arms is not the skinned mesh");
      instance.pose(asset.clips.ready[0]);
      const grip = worldPosition(instance.nodes.grip);
      expect(near(grip, asset.anchors.grip, 0.003), `throw_arms: grip at ${fmt(grip)}, manifest ${fmt(asset.anchors.grip)}`);
      instance.pose(asset.clips.windup[1]);
      const cocked = worldPosition(instance.nodes.rightHand);
      expect(cocked[1] - asset.anchors.rightHand[1] > 0.2, `throw_arms: the wind-up should raise the right hand (${fmt(cocked)})`);
      instance.pose(asset.clips.recover[1]);
      arms = `throw arms ${instance.meshes.length} meshes, ${instance.skeleton?.bones.length ?? 0} bones, grip ${fmt(grip)}`;
      instance.dispose();
    } catch (error) {
      errors.push(`throw_arms: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  summary.push(`equipment: ${loaded.length} models (${loaded.join(" ")}), ${arms}`);
}

/** DEV helper: exposes `window.__assets` and logs the self-check. */
export function installAssetDevTools(library: AssetLibrary): void {
  const check = () => {
    const report = runAssetSelfCheck(library);
    for (const line of report.summary) console.info(`[assets] ${line}`);
    for (const line of report.errors) console.error(`[assets] ${line}`);
    console.info(`[assets] self-check ${report.ok ? "passed" : "FAILED"}`);
    return report;
  };
  Object.assign(globalThis, { __assets: { library, check } });
  check();
}

function pose(group: AnimationGroup, frame: number): void {
  const target = Math.min(Math.max(frame, group.from), group.to);
  if (!group.isStarted) group.start(false, 1, group.from, group.to);
  group.goToFrame(target);
  group.pause();
}

/** World AABB of all meshes under `root`, CPU-skinned with the current pose. */
function skinnedBounds(root: TransformNode): { min: Vec3; max: Vec3 } {
  for (const node of [root, ...root.getDescendants(false)]) node.computeWorldMatrix(true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of root.getChildMeshes(false)) {
    if (mesh.getTotalVertices() === 0) continue;
    mesh.skeleton?.prepare(true);
    mesh.refreshBoundingInfo({ applySkeleton: true });
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    box.minimumWorld.asArray().forEach((v, i) => (min[i] = Math.min(min[i]!, v)));
    box.maximumWorld.asArray().forEach((v, i) => (max[i] = Math.max(max[i]!, v)));
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

function worldPosition(node: TransformNode): Vec3 {
  const chain: Node[] = [];
  for (let n: Node | null = node; n; n = n.parent) chain.unshift(n);
  for (const n of chain) n.computeWorldMatrix(true);
  const p = node.getAbsolutePosition();
  return [p.x, p.y, p.z];
}

const near = (a: Vec3, b: Vec3, tolerance: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tolerance);
const fmt = (v: Vec3) => `(${v.map((x) => x.toFixed(3)).join(", ")})`;
