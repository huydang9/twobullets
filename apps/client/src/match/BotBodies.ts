import { Quaternion, Vector3, type Scene } from "@babylonjs/core";
import { ITEM_IDS, ITEMS, PlayerActionType, type ActorConfig, type ActorState, type ConsumableItemId, type FlashExposure, type Vec3, type WeaponId } from "@twobullets/shared";
import type { MatchSim } from "@twobullets/sim";
import type { DamageHit, DamageResult, Damageable, HitboxRegistry } from "../combat/hitboxes";
import type { EquipmentTarget } from "../equipment/EquipmentSystem";
import type { ReviveTarget } from "../equipment/types";
import type { FootstepEmitterSource, FootstepEmitterState } from "../audio/FootstepSystem";
import { SoldierCharacter } from "../targets/SoldierCharacter";
import type { SoldierResources } from "../targets/SoldierResources";
import { activityForItem, type SoldierActivity } from "../targets/soldierRig";
import type { Environment } from "../world/environment";

/** Hand → muzzle along the aim for the third-person rifle, m. */
const MUZZLE_REACH = 0.62;
const TWO_PI = Math.PI * 2;
/** Body turn rates while the presentation owns the yaw (lying, giving CPR, settling after a get-up), rad/s. */
const LYING_TURN_RATE = 2.5;
const KNEEL_TURN_RATE = 5;
const SETTLE_TURN_RATE = 6;
/** Downed and faster than this: the body lines up with the crawl direction, m/s. */
const CRAWL_TURN_SPEED = 0.25;

/** Angle in [−π, π). */
function wrapAngle(angle: number): number {
  return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

/** What bot bodies need from the running match. */
export type BotBodyMatch = Pick<MatchSim, "state" | "damageActor" | "vitalsOf" | "setBotVitals" | "inputOf" | "inventoryOf">;

/** DEV pose preview (`BotBody.preview`): forces a state on top of the match's. */
export type BotPosePreview = "knocked" | "crawl" | "receiveCpr" | "giveCpr" | SoldierActivity | "throwStand" | "throwCrouch" | "pickUp";

/**
 * One bot's presentation (design.md §9.2): a pooled SWAT soldier with bone hitboxes in combat's registry, placed between
 * the last two match ticks, animated from the actor state, plus the adapters other systems need (bullet damageable,
 * equipment target, revive target, footstep emitter).
 */
export class BotBody {
  readonly soldier: SoldierCharacter;
  /** Damageable id: collider prefix, blood body id and kill-notice name ("Bot_Kilo#3" → "Bot Kilo"). */
  readonly id: string;
  readonly slot: number;
  readonly team: number;
  readonly name: string;
  readonly damageable: Damageable;
  readonly target: EquipmentTarget;
  readonly revive: ReviveTarget;
  private readonly footstep: { id: string; position: Vector3; grounded: boolean; crouched: boolean; sprinting: boolean; alive: boolean };
  private readonly previous = new Vector3();
  private readonly current = new Vector3();
  private previousYaw = 0;
  private currentYaw = 0;
  private previousPitch = 0;
  private currentPitch = 0;
  private readonly eyeValue = { x: 0, y: 0, z: 0 };
  private readonly viewDirValue = { x: 0, y: 0, z: 1 };
  private shownDead = false;
  private hasTick = false;
  /** Rendered body yaw; follows the interpolated sim yaw unless `yawOwned` (lying, CPR, settling after a get-up). */
  private bodyYaw = 0;
  private yawOwned = false;
  /** Activity for the item being used (from the use input on the `itemUse` started event). */
  private itemActivity: SoldierActivity = "bandage";
  /** Downed slot this bot is giving CPR to this frame, or -1 (BotBodies fills it before `update`). */
  cprTarget = -1;
  private lastInventory: unknown = null;
  private previewPose: BotPosePreview | null = null;
  /** Last bullet/blast direction that hurt this bot (death clip side). */
  readonly lastHitDirection = new Vector3(0, 0, 1);
  private state: ActorState | null = null;
  private match: BotBodyMatch | null = null;

  constructor(scene: Scene, resources: SoldierResources, environment: Environment, registry: HitboxRegistry, config: ActorConfig, weaponOfLocal: () => WeaponId | null) {
    this.slot = config.slot;
    this.team = config.team;
    this.name = config.name;
    this.id = `${config.name.replace(/\s+/g, "_")}#${config.slot}`;
    const self = this;
    this.damageable = {
      id: this.id,
      displayName: config.name,
      get alive() {
        return self.state !== null && self.state.life !== "dead";
      },
      applyDamage: (hit) => this.applyDamage(hit, weaponOfLocal),
    };
    this.soldier = new SoldierCharacter(scene, resources, environment, { name: `bot${config.slot}`, damage: { registry, owner: this.damageable } });
    this.soldier.root.rotationQuaternion = Quaternion.Identity();
    this.target = {
      id: this.id,
      displayName: config.name,
      get alive() {
        return self.damageable.alive;
      },
      get feet() {
        return self.state?.feet ?? self.current;
      },
      team: config.team,
      get posture() {
        const s = self.state;
        return s?.life === "downed" ? "downed" : s?.stance === "stand" ? "stand" : "crouch";
      },
      get eye() {
        return self.eye();
      },
      get viewDir() {
        return self.viewDir();
      },
      applyDamage: (hit) => this.applyDamage(hit, weaponOfLocal),
      applyFlash: (exposure) => this.applyFlash(exposure),
    };
    this.revive = {
      id: config.slot,
      displayName: config.name,
      get feet() {
        return self.state?.feet ?? self.current;
      },
      get vitals() {
        return self.match!.vitalsOf(self.slot)!;
      },
      setVitals: (vitals) => this.match?.setBotVitals(this.slot, vitals),
    };
    this.footstep = { id: this.id, position: this.soldier.root.position, grounded: true, crouched: false, sprinting: false, alive: true };
    this.soldier.root.setEnabled(false);
    this.soldier.setHitboxesEnabled(false);
  }

  /** Binds the body to its actor at match start and places it on the spawn. */
  attach(match: BotBodyMatch, state: ActorState): void {
    this.match = match;
    this.state = state;
    this.current.set(state.feet.x, state.feet.y, state.feet.z);
    this.previous.copyFrom(this.current);
    this.currentYaw = this.previousYaw = state.yaw;
    this.currentPitch = this.previousPitch = state.pitch;
    this.hasTick = true;
    this.shownDead = false;
    // A reused body starts its new life standing (the animator would otherwise ignore the next death).
    if (this.soldier.dead) this.soldier.revive();
    this.bodyYaw = state.yaw;
    this.yawOwned = false;
    this.lastInventory = match.inventoryOf(this.slot);
    this.soldier.root.setEnabled(true);
    this.soldier.setHitboxesEnabled(true);
    this.place(1, 0);
  }

  get alive(): boolean {
    return this.damageable.alive;
  }

  get actor(): ActorState | null {
    return this.state;
  }

  /** After each match tick: the new pose becomes the interpolation target. */
  afterTick(): void {
    const s = this.state;
    if (!s) return;
    this.previous.copyFrom(this.current);
    this.previousYaw = this.currentYaw;
    this.previousPitch = this.currentPitch;
    this.currentPitch = Number.isFinite(s.pitch) ? s.pitch : this.previousPitch;
    this.current.set(s.feet.x, s.feet.y, s.feet.z);
    // Unwrap so the lerp takes the short way round.
    // Closed form (no loop): a non-finite or huge yaw can't spin forever. Keeps the render yaw near [−π, π).
    const base = Number.isFinite(this.previousYaw) ? wrapAngle(this.previousYaw) : 0;
    this.previousYaw = base;
    const yaw = Number.isFinite(s.yaw) ? base + wrapAngle(s.yaw - base) : base;
    this.currentYaw = yaw;
    if (!this.hasTick) {
      this.previous.copyFrom(this.current);
      this.previousYaw = yaw;
      this.previousPitch = this.currentPitch;
      this.hasTick = true;
    }
    // Loot pickup has no event: a pickup input on the tick the inventory changed.
    const match = this.match;
    if (match) {
      const inventory = match.inventoryOf(this.slot);
      const action = match.inputOf(this.slot)?.action;
      if (action?.type === PlayerActionType.pickup && inventory !== this.lastInventory && s.life === "alive") this.soldier.pickUp();
      this.lastInventory = inventory;
    }
  }

  /** `itemUse` fx: remembers which clip fits the item the bot started using. */
  itemUse(phase: "started" | "cancelled" | "completed"): void {
    if (phase !== "started") return;
    const action = this.match?.inputOf(this.slot)?.action;
    const item = action?.type === PlayerActionType.use ? consumableOfCode(action.arg) : null;
    this.itemActivity = item ? activityForItem(item) : "bandage";
  }

  /** `throwRelease` fx. */
  throwRelease(): void {
    this.soldier.throwGrenade(this.state !== null && this.state.stance !== "stand");
  }

  /**
   * DEV: forces a pose on top of the match state (`null` clears; clearing a lying pose plays the get-up). Events
   * (throws, pickup) play once. Console: `__twobullets.match.match.bodies.bySlot[3].preview("crawl")`.
   */
  preview(pose: BotPosePreview | null): void {
    if (pose === "throwStand" || pose === "throwCrouch") this.soldier.throwGrenade(pose === "throwCrouch");
    else if (pose === "pickUp") this.soldier.pickUp();
    else this.previewPose = pose;
  }

  /** Per render frame before scene.render: pose between ticks (`alpha`), locomotion input, death, weapon prop. */
  update(dt: number, alpha: number): void {
    const s = this.state;
    if (!s) return;
    const preview = this.previewPose;
    const motion = this.soldier.motion;
    const downed = s.life === "downed" || preview === "knocked" || preview === "crawl" || preview === "receiveCpr";
    this.place(alpha, dt);
    if (s.life === "dead") {
      if (!this.shownDead) {
        this.shownDead = true;
        this.soldier.die(this.lastHitDirection);
      }
      motion.velocityX = motion.velocityZ = 0;
      motion.downed = false;
      motion.activity = null;
    } else {
      const yaw = this.bodyYaw;
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const vx = preview === "crawl" ? Math.sin(yaw + Math.PI) * 1.2 : s.velocity.x;
      const vz = preview === "crawl" ? Math.cos(yaw + Math.PI) * 1.2 : s.velocity.z;
      motion.velocityX = vx * c - vz * sn;
      motion.velocityZ = vx * sn + vz * c;
      motion.grounded = s.grounded || downed;
      motion.crouched = !downed && s.stance !== "stand";
      motion.sprinting = s.sprinting && !downed;
      motion.aiming = s.weaponId !== null && !downed && (s.adsBlend > 0.5 || s.velocity.x * s.velocity.x + s.velocity.z * s.velocity.z < 1);
      motion.downed = downed;
      motion.beingRevived = downed && (s.reviverSlot >= 0 || preview === "receiveCpr");
      motion.activity = downed
        ? null
        : this.cprTarget >= 0 || preview === "giveCpr"
          ? "cpr"
          : preview === "kneelHeal" || preview === "bandage" || preview === "drink" || preview === "cpr"
            ? preview
            : s.usingItem
              ? this.itemActivity
              : null;
    }
    // Every soldier model carries the rifle clone (design §9.2 known limit): shown while any gun is in hand and the
    // hands aren't busy (SoldierCharacter hides it while lying, getting up, healing, giving CPR, throwing, looting).
    this.soldier.rifleVisible = s.weaponId !== null && s.life !== "dead";
    const f = this.footstep;
    f.grounded = motion.grounded;
    f.crouched = motion.crouched;
    f.sprinting = motion.sprinting;
    f.alive = s.life === "alive";
    this.soldier.update(dt);
  }

  /** Rifle muzzle estimate: the right hand pushed along the aim. */
  muzzleToRef(yaw: number, pitch: number, out: { x: number; y: number; z: number }, forward: { x: number; y: number; z: number }): void {
    const hand = this.soldier.model.bones.rightHand.getAbsolutePosition();
    const cp = Math.cos(pitch);
    forward.x = Math.sin(yaw) * cp;
    forward.y = -Math.sin(pitch);
    forward.z = Math.cos(yaw) * cp;
    out.x = hand.x + forward.x * MUZZLE_REACH;
    out.y = hand.y + forward.y * MUZZLE_REACH + 0.04;
    out.z = hand.z + forward.z * MUZZLE_REACH;
  }

  footstepState(): FootstepEmitterState {
    return this.footstep;
  }

  /** Interpolated eye for spectating, written into `out`. */
  eyeToRef(alpha: number, out: Vector3): Vector3 {
    const s = this.state;
    Vector3.LerpToRef(this.previous, this.current, alpha, out);
    const height = s?.life === "downed" ? 0.6 : s?.stance === "stand" ? 1.62 : 1.05;
    out.y += height;
    return out;
  }

  renderYaw(alpha: number): number {
    return this.previousYaw + (this.currentYaw - this.previousYaw) * alpha;
  }

  /** Interpolated aim pitch, so the follow camera doesn't step once per tick on a screen faster than the sim. */
  renderPitch(alpha: number): number {
    return this.previousPitch + (this.currentPitch - this.previousPitch) * alpha;
  }

  dispose(): void {
    this.soldier.dispose();
  }

  private place(alpha: number, dt: number): void {
    const root = this.soldier.root;
    Vector3.LerpToRef(this.previous, this.current, alpha, root.position);
    this.updateBodyYaw(alpha, dt);
    Quaternion.RotationYawPitchRollToRef(this.bodyYaw, 0, 0, root.rotationQuaternion!);
  }

  /**
   * Lying clips put the head toward the model's −Z, so the body yaw is "head direction + π": a knock falls backward from
   * the current facing, a crawl lines the head up with the velocity, a patient lies across its reviver, a reviver
   * kneels facing its patient, and after the get-up the body turns back onto the sim yaw.
   */
  private updateBodyYaw(alpha: number, dt: number): void {
    const s = this.state!;
    const simYaw = this.renderYaw(alpha);
    const down = this.soldier.downState;
    const lying = s.life === "downed" || down === "knock" || down === "down" || this.previewPose === "knocked" || this.previewPose === "crawl" || this.previewPose === "receiveCpr";
    let target = simYaw;
    let rate = 0;
    if (s.life === "dead") {
      target = this.bodyYaw;
    } else if (lying) {
      if (!this.yawOwned) this.bodyYaw = simYaw;
      target = this.bodyYaw;
      rate = LYING_TURN_RATE;
      const giver = s.reviverSlot >= 0 ? this.match?.state.actors[s.reviverSlot] : undefined;
      if (giver) {
        // Lie across the reviver: head perpendicular to the line between them, whichever side is closer.
        const facing = Math.atan2(s.feet.x - giver.feet.x, s.feet.z - giver.feet.z);
        const a = facing + Math.PI / 2 + Math.PI;
        const b = facing - Math.PI / 2 + Math.PI;
        target = Math.abs(wrapAngle(a - this.bodyYaw)) < Math.abs(wrapAngle(b - this.bodyYaw)) ? a : b;
      } else if (s.velocity.x * s.velocity.x + s.velocity.z * s.velocity.z > CRAWL_TURN_SPEED * CRAWL_TURN_SPEED) {
        target = Math.atan2(s.velocity.x, s.velocity.z) + Math.PI;
      }
      this.yawOwned = true;
    } else if (this.cprTarget >= 0) {
      const patient = this.match?.state.actors[this.cprTarget];
      if (!this.yawOwned) this.bodyYaw = simYaw;
      target = patient ? Math.atan2(patient.feet.x - s.feet.x, patient.feet.z - s.feet.z) : this.bodyYaw;
      rate = KNEEL_TURN_RATE;
      this.yawOwned = true;
    } else if (down === "getUp") {
      target = this.bodyYaw;
    } else if (this.yawOwned) {
      rate = SETTLE_TURN_RATE;
      if (Math.abs(wrapAngle(simYaw - this.bodyYaw)) < 0.02) this.yawOwned = false;
    }
    if (rate === 0) {
      this.bodyYaw = target;
      return;
    }
    const delta = wrapAngle(target - this.bodyYaw);
    const step = rate * dt;
    this.bodyYaw = wrapAngle(this.bodyYaw + (Math.abs(delta) <= step ? delta : Math.sign(delta) * step));
    if (!this.yawOwned) this.bodyYaw = simYaw;
  }

  private eye(): Vec3 {
    const s = this.state;
    const e = this.eyeValue;
    if (!s) return e;
    e.x = s.feet.x;
    e.z = s.feet.z;
    e.y = s.feet.y + (s.life === "downed" ? 0.4 : s.stance === "stand" ? 1.62 : 1.05);
    return e;
  }

  private viewDir(): Vec3 {
    const s = this.state;
    const d = this.viewDirValue;
    if (!s) return d;
    const cp = Math.cos(s.pitch);
    d.x = Math.sin(s.yaw) * cp;
    d.y = -Math.sin(s.pitch);
    d.z = Math.cos(s.yaw) * cp;
    return d;
  }

  private applyDamage(hit: DamageHit, weaponOfLocal: () => WeaponId | null): DamageResult | null {
    const match = this.match;
    if (!match || !this.alive) return null;
    const kind = hit.kind ?? "bullet";
    const bullet = kind === "bullet";
    this.lastHitDirection.copyFrom(hit.direction);
    const result = match.damageActor({
      attacker: hit.sourceId ?? 0,
      victim: this.slot,
      amount: hit.amount,
      kind,
      zone: bullet ? hit.zone : kind === "explosion" ? "body" : null,
      weaponId: bullet ? weaponOfLocal() : null,
      position: hit.point,
      direction: hit.direction,
    });
    if (!result) return null;
    return {
      amount: result.dealt,
      remainingHealth: result.remainingHealth,
      killed: result.killed,
      knocked: result.knocked,
      armorAbsorbed: result.armorAbsorbed,
      armorSlot: result.armorSlot,
      armorDestroyed: result.armorDestroyed,
    };
  }

  private applyFlash(exposure: FlashExposure): void {
    const match = this.match;
    const vitals = match?.vitalsOf(this.slot);
    if (!match || !vitals || vitals.life === "dead") return;
    match.setBotVitals(this.slot, { ...vitals, blindSeconds: Math.max(vitals.blindSeconds, exposure.blindSeconds), deafSeconds: Math.max(vitals.deafSeconds, exposure.deafSeconds) });
  }
}

/** Every bot body of the match, in slot order, plus the lists EquipmentSystem and FootstepSystem poll. */
export class BotBodies implements FootstepEmitterSource {
  readonly bySlot: (BotBody | undefined)[] = [];
  readonly list: BotBody[] = [];
  /** EquipmentSystem targets: index = slot − 1 (the human is slot 0). */
  readonly targets: EquipmentTarget[] = [];
  /** Downed-revivable teammates of the human. */
  readonly teammates: ReviveTarget[] = [];
  private match: BotBodyMatch | null = null;

  constructor(scene: Scene, resources: SoldierResources, environment: Environment, registry: HitboxRegistry, actors: readonly ActorConfig[], humanTeam: number | null, weaponOfLocal: () => WeaponId | null) {
    const maxSlot = actors.reduce((max, a) => Math.max(max, a.slot), 0);
    for (const actor of actors) {
      if (actor.kind !== "bot") continue;
      const body = new BotBody(scene, resources, environment, registry, actor, weaponOfLocal);
      this.bySlot[actor.slot] = body;
      this.list.push(body);
      if (actor.team === humanTeam) this.teammates.push(body.revive);
    }
    // Dense target list so equipment entity ids equal slots; empty slots never take damage.
    for (let slot = 1; slot <= maxSlot; slot++) this.targets.push(this.bySlot[slot]?.target ?? EMPTY_TARGET);
  }

  attach(match: BotBodyMatch): void {
    this.match = match;
    for (const body of this.list) {
      const state = match.state.actors[body.slot];
      if (state) body.attach(match, state);
    }
  }

  afterTick(): void {
    for (const body of this.list) body.afterTick();
  }

  update(dt: number, alpha: number): void {
    // Revivers: a downed actor names its reviver (any slot, the human included).
    for (const body of this.list) body.cprTarget = -1;
    const actors = this.match?.state.actors;
    if (actors) {
      for (let slot = 0; slot < actors.length; slot++) {
        const actor = actors[slot];
        if (!actor || actor.life !== "downed" || actor.reviverSlot < 0) continue;
        const giver = this.bySlot[actor.reviverSlot];
        if (giver) giver.cprTarget = actor.slot;
      }
    }
    for (const body of this.list) body.update(dt, alpha);
  }

  forEachEmitter(visit: (state: FootstepEmitterState) => void): void {
    for (const body of this.list) if (body.actor) visit(body.footstepState());
  }

  dispose(): void {
    for (const body of this.list) body.dispose();
  }
}

const EMPTY_TARGET: EquipmentTarget = {
  id: "empty-slot",
  alive: false,
  feet: { x: 0, y: -1000, z: 0 },
  applyDamage: () => null,
};

/** Wire code of a consumable (`PlayerActionType.use` arg), the same table MatchSim decodes. */
function consumableOfCode(code: number): ConsumableItemId | null {
  const id = ITEM_IDS[code];
  if (!id) return null;
  const category = ITEMS[id].category;
  return category === "heal" || category === "boost" ? (id as ConsumableItemId) : null;
}
