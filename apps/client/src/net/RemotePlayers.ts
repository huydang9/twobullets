import { Color3, MeshBuilder, Quaternion, StandardMaterial, TransformNode, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import { remoteLifeCode, remoteWeaponId } from "@twobullets/netcode/replication";
import { LifeCode, WeaponPhaseCode } from "@twobullets/protocol/codes";
import { MAX_ENTITY_SLOTS } from "@twobullets/protocol/messages/snapshot";
import { RemoteFlags, StanceCode } from "@twobullets/protocol/quantize";
import { MOVEMENT } from "@twobullets/shared/constants";
import { WEAPONS } from "@twobullets/shared/weapons/weapons";
import type { AssetLibrary } from "../assets";
import type { FootstepEmitterSource, FootstepEmitterState } from "../audio/FootstepSystem";
import { SoldierCharacter } from "../targets/SoldierCharacter";
import { SoldierResources } from "../targets/SoldierResources";
import type { Environment } from "../world/environment";
import type { RemoteRoster } from "./RemoteRoster";

export interface RemotePlayersOptions {
  /** Mixamo soldiers with velocity-driven locomotion; without it (or `?netAvatar=capsule`) capsules. */
  readonly soldiers?: { readonly assets: AssetLibrary; readonly environment: Environment } | null;
  /** A slot's avatar was created (blood bodies register here). `soldier` is null for capsules. */
  readonly onAvatarCreated?: (slot: number, soldier: SoldierCharacter | null) => void;
}

interface Avatar {
  readonly root: TransformNode;
  readonly soldier: SoldierCharacter | null;
  enabled: boolean;
  shownDead: boolean;
  lastPhase: number;
  /** Body yaw while lying (the head points along −Z of the model, so it is "head direction + π"). */
  lyingYaw: number;
  lying: boolean;
  /** Body yaw held since death (a corpse doesn't turn with the replicated aim), or NaN while alive. */
  deadYaw: number;
  readonly hitDirection: Vector3;
  readonly footstep: { id: string; position: Vector3; grounded: boolean; crouched: boolean; sprinting: boolean; alive: boolean };
}

/** Digit-free slot names: the HUD strips trailing numbers from target ids. */
export const SLOT_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliett", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa"];

/** Right hand → muzzle along the aim, m (as the offline bots). */
const MUZZLE_REACH = 0.62;
const CRAWL_TURN_SPEED = 0.3;
const LYING_TURN_RATE = 3;
const TAU = Math.PI * 2;

/** Pauses or resumes a soldier's started clips in place (the animator's started/stopped bookkeeping is unchanged). */
function setAnimationsPaused(soldier: SoldierCharacter, paused: boolean): void {
  for (const group of soldier.model.animations.values()) {
    if (!group.isStarted) continue;
    if (paused) group.pause();
    else group.restart();
  }
}

function wrapAngle(a: number): number {
  let d = (a + Math.PI) % TAU;
  if (d < 0) d += TAU;
  return d - Math.PI;
}

/**
 * Draws interpolated remote players from a `RemoteRoster`: one pooled avatar per slot, created on first sight and
 * hidden when the slot goes away. Locomotion from the replicated velocity and flags; M4 life (knocked crawl, death clip,
 * back up on revive or respawn), the weapon prop and the reload clip from the remote flags. Placement and locomotion
 * reuse scratch values; nothing allocates per frame. No collision; hitboxes are the shared rig (`RemoteHitboxes`).
 */
export class RemotePlayers implements FootstepEmitterSource {
  private readonly scene: Scene;
  private readonly roster: RemoteRoster;
  private readonly avatars: (Avatar | null)[] = [];
  private readonly resources: SoldierResources | null;
  private readonly environment: Environment | null;
  private readonly onAvatarCreated: ((slot: number, soldier: SoldierCharacter | null) => void) | null;
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
    this.onAvatarCreated = options.onAvatarCreated ?? null;
    for (let i = 0; i < MAX_ENTITY_SLOTS; i++) this.avatars.push(null);
  }

  /** Blood/damage id of a remote slot's body: "player_bravo", which the HUD formats as "Player Bravo". */
  static bodyId(slot: number): string {
    return `player_${SLOT_NAMES[slot] ?? "unknown"}`;
  }

  /** The slot's soldier, when it is shown as one. */
  soldierOf(slot: number): SoldierCharacter | null {
    const avatar = this.avatars[slot];
    return avatar?.enabled ? avatar.soldier : null;
  }

  /** Remembers the bullet direction that last hit `slot` (picks the death clip side). */
  noteHit(slot: number, dirX: number, dirZ: number): void {
    this.avatars[slot]?.hitDirection.set(dirX, 0, dirZ);
  }

  /**
   * Third-person muzzle estimate for `slot` firing along (yaw, pitch): the soldier's right hand pushed along the aim, or
   * `fallback` (the shot's eye origin) for capsules. Returns false when the slot has no avatar.
   */
  muzzleToRef(slot: number, yaw: number, pitch: number, fallback: { readonly x: number; readonly y: number; readonly z: number }, out: { x: number; y: number; z: number }, forward: { x: number; y: number; z: number }): boolean {
    const avatar = this.avatars[slot];
    const cp = Math.cos(pitch);
    forward.x = Math.sin(yaw) * cp;
    forward.y = -Math.sin(pitch);
    forward.z = Math.cos(yaw) * cp;
    if (!avatar?.enabled) return false;
    if (avatar.soldier) {
      const hand = avatar.soldier.model.bones.rightHand.getAbsolutePosition();
      out.x = hand.x + forward.x * MUZZLE_REACH;
      out.y = hand.y + forward.y * MUZZLE_REACH + 0.04;
      out.z = hand.z + forward.z * MUZZLE_REACH;
    } else {
      out.x = fallback.x + forward.x * 0.5;
      out.y = fallback.y + forward.y * 0.5 - 0.1;
      out.z = fallback.z + forward.z * 0.5;
    }
    return true;
  }

  forEachEmitter(visit: (state: FootstepEmitterState) => void): void {
    for (let slot = 0; slot < MAX_ENTITY_SLOTS; slot++) {
      const avatar = this.avatars[slot];
      if (avatar?.enabled) visit(avatar.footstep);
    }
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
          // Babylon keeps evaluating started groups on disabled bones; park them until the slot shows again.
          if (avatar.soldier) setAnimationsPaused(avatar.soldier, true);
        }
        continue;
      }
      if (!avatar) {
        avatar = this.avatars[slot] = this.createAvatar(slot);
        this.onAvatarCreated?.(slot, avatar.soldier);
      }
      if (!avatar.enabled) {
        avatar.root.setEnabled(true);
        avatar.enabled = true;
        if (avatar.soldier) setAnimationsPaused(avatar.soldier, false);
      }
      const pose = roster.poses[slot]!;
      const flags = pose.flags;
      const life = remoteLifeCode(flags);
      const downed = life === LifeCode.downed;
      const dead = life === LifeCode.dead;
      const root = avatar.root;
      root.position.set(pose.x, pose.y, pose.z);
      const crouched = ((flags & RemoteFlags.stanceMask) >> RemoteFlags.stanceShift) !== StanceCode.stand;
      const soldier = avatar.soldier;
      const weaponId = remoteWeaponId(flags);
      const footstep = avatar.footstep;
      footstep.position.set(pose.x, pose.y, pose.z);
      footstep.grounded = (flags & RemoteFlags.grounded) !== 0;
      footstep.crouched = crouched && !downed;
      footstep.sprinting = (flags & RemoteFlags.sprint) !== 0;
      footstep.alive = life === LifeCode.alive;

      Quaternion.RotationAxisToRef(Vector3.UpReadOnly, this.bodyYaw(avatar, pose.yaw, pose.vx, pose.vz, downed || (soldier !== null && soldier.downState !== "none" && !dead), dead, dt), root.rotationQuaternion!);
      if (soldier) {
        const motion = soldier.motion;
        if (dead) {
          if (!avatar.shownDead) {
            avatar.shownDead = true;
            soldier.die(avatar.hitDirection);
          }
          motion.velocityX = motion.velocityZ = 0;
          motion.downed = false;
          motion.activity = null;
        } else {
          if (avatar.shownDead) {
            // Respawned (a revive comes from downed, never from dead).
            avatar.shownDead = false;
            soldier.revive();
          }
          // World velocity into the soldier's frame: forward (sin yaw, cos yaw), right (cos yaw, −sin yaw).
          const yaw = downed ? avatar.lyingYaw : pose.yaw;
          const s = Math.sin(yaw);
          const c = Math.cos(yaw);
          motion.velocityX = pose.vx * c - pose.vz * s;
          motion.velocityZ = pose.vx * s + pose.vz * c;
          motion.grounded = (flags & RemoteFlags.grounded) !== 0 || downed;
          motion.crouched = crouched && !downed;
          motion.sprinting = (flags & RemoteFlags.sprint) !== 0 && !downed;
          motion.aiming = (flags & RemoteFlags.ads) !== 0 && !downed;
          motion.downed = downed;
          motion.beingRevived = false;
          motion.activity = null;
          const phase = (flags & RemoteFlags.weaponPhaseMask) >> RemoteFlags.weaponPhaseShift;
          if (phase === WeaponPhaseCode.reloading && avatar.lastPhase !== WeaponPhaseCode.reloading && weaponId !== null) soldier.reload(WEAPONS[weaponId].reloadSeconds);
          avatar.lastPhase = phase;
        }
        soldier.rifleVisible = weaponId !== null && !dead;
        soldier.update(dt);
      } else {
        root.scaling.y = dead ? 0.15 : downed ? 0.3 : crouched ? MOVEMENT.crouchHeight / MOVEMENT.standHeight : 1;
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

  /** Aim yaw while up; while lying, the head follows the crawl direction (or stays put) and turns smoothly; held once dead. */
  private bodyYaw(avatar: Avatar, aimYaw: number, vx: number, vz: number, lying: boolean, dead: boolean, dt: number): number {
    if (dead) {
      // Killed while knocked keeps the crawl heading (the collapse lies along it); killed standing keeps the aim yaw.
      if (Number.isNaN(avatar.deadYaw)) avatar.deadYaw = avatar.lying ? avatar.lyingYaw : aimYaw;
      return avatar.deadYaw;
    }
    avatar.deadYaw = NaN;
    if (!lying) {
      avatar.lying = false;
      return aimYaw;
    }
    if (!avatar.lying) {
      avatar.lying = true;
      avatar.lyingYaw = aimYaw;
    }
    if (vx * vx + vz * vz > CRAWL_TURN_SPEED * CRAWL_TURN_SPEED) {
      const target = Math.atan2(vx, vz) + Math.PI;
      const delta = wrapAngle(target - avatar.lyingYaw);
      const step = LYING_TURN_RATE * dt;
      avatar.lyingYaw = wrapAngle(avatar.lyingYaw + (Math.abs(delta) <= step ? delta : Math.sign(delta) * step));
    }
    return avatar.lyingYaw;
  }

  private createAvatar(slot: number): Avatar {
    const extra = (root: TransformNode, soldier: SoldierCharacter | null): Avatar => ({
      root,
      soldier,
      enabled: true,
      shownDead: false,
      lastPhase: 0,
      lyingYaw: 0,
      lying: false,
      deadYaw: NaN,
      hitDirection: new Vector3(0, 0, 1),
      footstep: { id: RemotePlayers.bodyId(slot), position: new Vector3(), grounded: true, crouched: false, sprinting: false, alive: true },
    });
    if (this.resources && this.environment) {
      try {
        const soldier = new SoldierCharacter(this.scene, this.resources, this.environment, { name: `remote${slot}` });
        soldier.root.rotationQuaternion = Quaternion.Identity();
        return extra(soldier.root, soldier);
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
    return extra(root, null);
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
