import { Color3, MeshBuilder, Quaternion, StandardMaterial, TransformNode, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import { MAX_ENTITY_SLOTS } from "@twobullets/protocol/messages/snapshot";
import { RemoteFlags, StanceCode } from "@twobullets/protocol/quantize";
import { MOVEMENT } from "@twobullets/shared/constants";
import type { AssetLibrary } from "../assets";
import { SoldierCharacter } from "../targets/SoldierCharacter";
import { SoldierResources } from "../targets/SoldierResources";
import type { Environment } from "../world/environment";
import type { RemoteRoster } from "./RemoteRoster";

export interface RemotePlayersOptions {
  /** Mixamo soldiers with velocity-driven locomotion; without it (or `?netAvatar=capsule`) capsules. */
  readonly soldiers?: { readonly assets: AssetLibrary; readonly environment: Environment } | null;
}

interface Avatar {
  readonly root: TransformNode;
  readonly soldier: SoldierCharacter | null;
  enabled: boolean;
}

/**
 * Draws interpolated remote players from a `RemoteRoster`: one pooled avatar per slot, created on first sight and
 * hidden when the slot goes away. Placement and locomotion reuse scratch values; nothing allocates per frame.
 * Visual only: no collision and no hitboxes in M3.
 */
export class RemotePlayers {
  private readonly scene: Scene;
  private readonly roster: RemoteRoster;
  private readonly avatars: (Avatar | null)[] = [];
  private readonly resources: SoldierResources | null;
  private readonly environment: Environment | null;
  private capsuleMaterial: StandardMaterial | null = null;
  private capsuleTemplate: Mesh | null = null;

  constructor(scene: Scene, roster: RemoteRoster, options: RemotePlayersOptions = {}) {
    this.scene = scene;
    this.roster = roster;
    let resources: SoldierResources | null = null;
    if (options.soldiers) {
      try {
        resources = new SoldierResources(options.soldiers.assets);
      } catch (error) {
        console.warn("[net] soldier avatars unavailable, using capsules", error);
      }
    }
    this.resources = resources;
    this.environment = options.soldiers?.environment ?? null;
    for (let i = 0; i < MAX_ENTITY_SLOTS; i++) this.avatars.push(null);
  }

  /** Call after `roster.sample(renderTick)` every frame. */
  update(dt: number): void {
    const roster = this.roster;
    for (let slot = 0; slot < MAX_ENTITY_SLOTS; slot++) {
      const show = roster.visible[slot] === 1;
      let avatar = this.avatars[slot] ?? null;
      if (!show) {
        if (avatar?.enabled) {
          avatar.root.setEnabled(false);
          avatar.enabled = false;
        }
        continue;
      }
      avatar ??= this.avatars[slot] = this.createAvatar(slot);
      if (!avatar.enabled) {
        avatar.root.setEnabled(true);
        avatar.enabled = true;
      }
      const pose = roster.poses[slot]!;
      const root = avatar.root;
      root.position.set(pose.x, pose.y, pose.z);
      Quaternion.RotationAxisToRef(Vector3.UpReadOnly, pose.yaw, root.rotationQuaternion!);
      const soldier = avatar.soldier;
      if (soldier) {
        // World velocity into the soldier's frame: forward (sin yaw, cos yaw), right (cos yaw, −sin yaw).
        const s = Math.sin(pose.yaw);
        const c = Math.cos(pose.yaw);
        const motion = soldier.motion;
        motion.velocityX = pose.vx * c - pose.vz * s;
        motion.velocityZ = pose.vx * s + pose.vz * c;
        const flags = pose.flags;
        motion.grounded = (flags & RemoteFlags.grounded) !== 0;
        motion.crouched = ((flags & RemoteFlags.stanceMask) >> RemoteFlags.stanceShift) !== StanceCode.stand;
        motion.sprinting = (flags & RemoteFlags.sprint) !== 0;
        motion.aiming = (flags & RemoteFlags.ads) !== 0;
        soldier.update(dt);
      } else {
        const crouched = ((pose.flags & RemoteFlags.stanceMask) >> RemoteFlags.stanceShift) !== StanceCode.stand;
        root.scaling.y = crouched ? MOVEMENT.crouchHeight / MOVEMENT.standHeight : 1;
      }
    }
  }

  dispose(): void {
    for (const avatar of this.avatars) {
      avatar?.soldier?.dispose();
      avatar?.root.dispose();
    }
    this.avatars.fill(null);
    this.capsuleTemplate?.dispose();
    this.capsuleMaterial?.dispose();
    this.resources?.dispose();
  }

  private createAvatar(slot: number): Avatar {
    if (this.resources && this.environment) {
      try {
        const soldier = new SoldierCharacter(this.scene, this.resources, this.environment, { name: `remote${slot}` });
        soldier.root.rotationQuaternion = Quaternion.Identity();
        return { root: soldier.root, soldier, enabled: true };
      } catch (error) {
        console.warn("[net] soldier avatar failed, using a capsule", error);
      }
    }
    const root = new TransformNode(`remote${slot}_root`, this.scene);
    root.rotationQuaternion = Quaternion.Identity();
    const body = this.capsule().clone(`remote${slot}_capsule`, root)!;
    body.setEnabled(true);
    const nose = MeshBuilder.CreateBox(`remote${slot}_nose`, { width: 0.12, height: 0.12, depth: 0.3 }, this.scene);
    nose.parent = root;
    nose.position.set(0, MOVEMENT.standHeight * 0.85, MOVEMENT.capsuleRadius);
    nose.material = this.capsuleMaterial;
    nose.isPickable = false;
    return { root, soldier: null, enabled: true };
  }

  private capsule(): Mesh {
    if (this.capsuleTemplate) return this.capsuleTemplate;
    const material = new StandardMaterial("remotePlayerMaterial", this.scene);
    material.diffuseColor = new Color3(0.85, 0.35, 0.2);
    const mesh = MeshBuilder.CreateCapsule("remotePlayerCapsule", { height: MOVEMENT.standHeight, radius: MOVEMENT.capsuleRadius }, this.scene);
    // Pivot at the feet so crouch scaling shrinks toward the ground.
    mesh.position.y = MOVEMENT.standHeight / 2;
    mesh.bakeCurrentTransformIntoVertices();
    mesh.material = material;
    mesh.isPickable = false;
    mesh.setEnabled(false);
    this.capsuleMaterial = material;
    this.capsuleTemplate = mesh;
    return mesh;
  }
}
