import { Quaternion, Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";
import type { ActorConfig, ActorState, FlashExposure, Vec3, WeaponId } from "@twobullets/shared";
import type { MatchSim } from "@twobullets/sim";
import type { DamageHit, DamageResult, Damageable, HitboxRegistry } from "../combat/hitboxes";
import type { EquipmentTarget } from "../equipment/EquipmentSystem";
import type { ReviveTarget } from "../equipment/types";
import type { FootstepEmitterSource, FootstepEmitterState } from "../audio/FootstepSystem";
import { SoldierCharacter } from "../targets/SoldierCharacter";
import type { SoldierResources } from "../targets/SoldierResources";
import type { Environment } from "../world/environment";

/** Downed bots use the crouch pose sunk this far until a crawl clip exists (asset request), m. */
const DOWNED_SINK = 0.45;
/** Hand → muzzle along the aim for the third-person rifle, m. */
const MUZZLE_REACH = 0.62;
const TWO_PI = Math.PI * 2;

/** Angle in [−π, π). */
function wrapAngle(angle: number): number {
  return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

/** What bot bodies need from the running match. */
export type BotBodyMatch = Pick<MatchSim, "state" | "damageActor" | "vitalsOf" | "setBotVitals">;

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
  private readonly rifle: AbstractMesh | null;
  private readonly eyeValue = { x: 0, y: 0, z: 0 };
  private readonly viewDirValue = { x: 0, y: 0, z: 1 };
  private shownDead = false;
  private hasTick = false;
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
    this.rifle = this.soldier.root.getChildMeshes(false, (mesh) => mesh.name === `bot${config.slot}_rifle`)[0] ?? null;
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
    this.hasTick = true;
    this.shownDead = false;
    this.soldier.root.setEnabled(true);
    this.soldier.setHitboxesEnabled(true);
    this.place(1);
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
      this.hasTick = true;
    }
  }

  /** Per render frame before scene.render: pose between ticks (`alpha`), locomotion input, death, weapon prop. */
  update(dt: number, alpha: number): void {
    const s = this.state;
    if (!s) return;
    this.place(alpha);
    const motion = this.soldier.motion;
    const downed = s.life === "downed";
    if (s.life === "dead") {
      if (!this.shownDead) {
        this.shownDead = true;
        this.soldier.die(this.lastHitDirection);
      }
      motion.velocityX = motion.velocityZ = 0;
    } else {
      const yaw = this.renderYaw(alpha);
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      const vx = downed ? 0 : s.velocity.x;
      const vz = downed ? 0 : s.velocity.z;
      motion.velocityX = vx * c - vz * sn;
      motion.velocityZ = vx * sn + vz * c;
      motion.grounded = s.grounded || downed;
      motion.crouched = downed || s.stance !== "stand";
      motion.sprinting = s.sprinting && !downed;
      motion.aiming = s.weaponId !== null && !downed && (s.adsBlend > 0.5 || s.velocity.x * s.velocity.x + s.velocity.z * s.velocity.z < 1);
    }
    // Every soldier model carries the rifle clone (design §9.2 known limit): shown while any gun is in hand.
    this.rifle?.setEnabled(s.weaponId !== null && s.life !== "dead");
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

  dispose(): void {
    this.soldier.dispose();
  }

  private place(alpha: number): void {
    const root = this.soldier.root;
    Vector3.LerpToRef(this.previous, this.current, alpha, root.position);
    if (this.state?.life === "downed") root.position.y -= DOWNED_SINK;
    Quaternion.RotationYawPitchRollToRef(this.renderYaw(alpha), 0, 0, root.rotationQuaternion!);
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
    for (const body of this.list) {
      const state = match.state.actors[body.slot];
      if (state) body.attach(match, state);
    }
  }

  afterTick(): void {
    for (const body of this.list) body.afterTick();
  }

  update(dt: number, alpha: number): void {
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
