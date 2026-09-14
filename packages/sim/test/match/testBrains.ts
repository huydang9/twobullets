import { quantizePitch, quantizeYaw } from "@twobullets/shared/aim";
import type { BotBrain, BotBrainFactory, BotBrainOptions, BotDebugState, BotMemory, BotPerception, BotProfile, BotTickOutput, BotWorldView } from "@twobullets/shared/bots/types";
import { hash32 } from "@twobullets/shared/equipment/math";
import { itemCode } from "@twobullets/shared/equipment/items";
import { Btn, PlayerActionType } from "@twobullets/shared/input";

// Scripted brains for headless match tests until the real brain (shared/bots/brain) is wired: they read `view.actors`
// directly (a wallhack the real brain may not use) and exist only to exercise MatchSim: movement over Map v1, bullets
// through the rig, knocks, revives, zone rotation and team rules.

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;
const PERCEPTION: BotPerception = { tick: 0, actors: [], threatSlot: -1, lastDamageTick: -1, lastDamageFrom: { x: 0, y: 0, z: 0 }, blind: false, deaf: false };
const MEMORY: BotMemory = { entries: [], count: 0, danger: [], skippedLoot: new Map() };

function wrap(a: number): number {
  a %= TWO_PI;
  return a > Math.PI ? a - TWO_PI : a < -Math.PI ? a + TWO_PI : a;
}

function clear(view: BotWorldView, out: BotTickOutput): void {
  const input = out.input;
  input.tick = view.tick;
  input.forward = 0;
  input.right = 0;
  input.buttons = 0;
  input.select = 0;
  input.viewOffset8 = 0;
  input.action = null;
  out.intents.cycleThrowable = false;
  out.intents.holster = false;
  out.intents.replaceSlot = -1;
  out.intents.reviveSlot = -1;
}

function chestHeight(stance: string): number {
  return stance === "prone" ? 0.2 : stance === "crouch" ? 0.62 : 1.3;
}

abstract class ScriptBrain implements BotBrain {
  readonly slot: number;
  readonly team: number;
  readonly profile: BotProfile;
  readonly perception = PERCEPTION;
  readonly memory = MEMORY;
  protected readonly seed: number;
  protected yaw = 0;
  protected pitch = 0;
  protected counter = 0;
  protected readonly dbg: { -readonly [K in keyof BotDebugState]: BotDebugState[K] } = { goal: "idle", goalScore: 0, subState: "", targetSlot: -1, aimErrorDeg: Number.NaN, path: null, moveTarget: null, lootTargetId: -1 };

  constructor(options: BotBrainOptions) {
    this.slot = options.slot;
    this.team = options.team;
    this.profile = options.profile;
    this.seed = options.seed;
  }

  abstract tick(view: BotWorldView, out: BotTickOutput): void;

  kickAim(up: number, right: number): void {
    this.pitch -= up;
    this.yaw = wrap(this.yaw + right);
  }

  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = 0;
  }

  debug(): BotDebugState {
    return this.dbg;
  }

  protected random(): number {
    return hash32(this.seed, this.slot + 1000, this.counter++) / 0x100000000;
  }

  protected turnTo(yaw: number, pitch: number, maxDeg: number): number {
    const dy = wrap(yaw - this.yaw);
    const max = maxDeg * DEG;
    this.yaw = wrap(this.yaw + Math.max(-max, Math.min(max, dy)));
    const dp = pitch - this.pitch;
    this.pitch += Math.max(-max, Math.min(max, dp));
    return Math.sqrt(wrap(yaw - this.yaw) ** 2 + (pitch - this.pitch) ** 2) / DEG;
  }

  protected writeAim(out: BotTickOutput): void {
    this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
    out.input.yawQ = quantizeYaw(this.yaw);
    out.input.pitchQ = quantizePitch(this.pitch);
  }
}

/** Stands still. */
class IdleScript extends ScriptBrain {
  tick(view: BotWorldView, out: BotTickOutput): void {
    clear(view, out);
    this.writeAim(out);
  }
}

/**
 * Walks toward seeded points inside the zone (the next circle once announced), sprinting, with a jump/turn unstuck.
 * `fight` adds: shoot the nearest visible enemy within 120 m, revive downed teammates, heal when hurt.
 */
class RoamScript extends ScriptBrain {
  private readonly fight: boolean;
  private tx = 0;
  private tz = 0;
  private hasTarget = false;
  private targetTick = 0;
  private lastX = 0;
  private lastZ = 0;
  private lastCheck = 0;
  private detourUntil = 0;
  private detourYaw = 0;
  private jumpUntil = 0;
  private enemy = -1;
  private strafe = 1;
  private jitterYaw = 0;
  private jitterPitch = 0;

  constructor(options: BotBrainOptions, fight: boolean) {
    super(options);
    this.fight = fight;
  }

  tick(view: BotWorldView, out: BotTickOutput): void {
    clear(view, out);
    const self = view.self;
    const input = out.input;
    const tick = view.tick;
    if (self.vitals.life === "dead" || view.phase !== "combat") {
      this.writeAim(out);
      return;
    }
    const feet = self.feet;

    if (self.vitals.life === "downed") {
      // Crawl toward the nearest standing teammate.
      let best = -1;
      let bestD = Infinity;
      for (const mate of view.teammates) {
        if (mate.life !== "alive") continue;
        const d = (mate.feet.x - feet.x) ** 2 + (mate.feet.z - feet.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = view.teammates.indexOf(mate);
        }
      }
      const mate = best >= 0 ? view.teammates[best]! : null;
      if (mate && bestD > 1) {
        this.turnTo(Math.atan2(mate.feet.x - feet.x, mate.feet.z - feet.z), 0, 6);
        input.forward = 1;
      }
      this.dbg.goal = "flee";
      this.writeAim(out);
      return;
    }

    if (this.fight && this.fightTick(view, out)) {
      this.writeAim(out);
      return;
    }

    // Revive a downed teammate nearby.
    if (this.fight) {
      for (const mate of view.teammates) {
        if (mate.life !== "downed") continue;
        const dx = mate.feet.x - feet.x;
        const dz = mate.feet.z - feet.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > 60) continue;
        this.dbg.goal = "revive";
        this.turnTo(Math.atan2(dx, dz), 0.3, 12);
        if (d > 1.2) {
          input.forward = 1;
          if (d > 6) input.buttons |= Btn.sprint;
          this.unstuck(view, out, true);
        } else {
          input.buttons |= Btn.interact;
          out.intents.reviveSlot = mate.slot;
        }
        this.writeAim(out);
        return;
      }
      // Heal when hurt and nothing is in sight.
      if (self.vitals.health < 70 && self.use.itemId === null && self.inventory.stacks.some((s) => s.itemId === "first_aid" && s.quantity > 0)) {
        input.action = { type: PlayerActionType.use, arg: itemCode("first_aid") };
        this.dbg.goal = "heal";
        this.writeAim(out);
        return;
      }
      if (self.use.itemId !== null) {
        this.dbg.goal = "heal";
        this.writeAim(out);
        return;
      }
    }

    // Roam toward a point inside the zone.
    const zone = view.zone;
    const circle = zone.next ?? zone.current;
    const outside = (tx: number, tz: number) => (tx - circle.cx) ** 2 + (tz - circle.cz) ** 2 > (circle.r * 0.6) ** 2;
    if (!this.hasTarget || tick - this.targetTick > 1800 || (this.tx - feet.x) ** 2 + (this.tz - feet.z) ** 2 < 16 || outside(this.tx, this.tz)) {
      const angle = this.random() * TWO_PI;
      const r = Math.sqrt(this.random()) * Math.min(circle.r * 0.5, 300);
      this.tx = Math.max(-470, Math.min(470, circle.cx + Math.sin(angle) * r));
      this.tz = Math.max(-470, Math.min(470, circle.cz + Math.cos(angle) * r));
      this.hasTarget = true;
      this.targetTick = tick;
    }
    this.dbg.goal = "rotate";
    let yaw = Math.atan2(this.tx - feet.x, this.tz - feet.z);
    if (tick < this.detourUntil) yaw = this.detourYaw;
    this.turnTo(yaw, 0, 8);
    input.forward = 1;
    input.buttons |= Btn.sprint;
    this.unstuck(view, out, true);
    this.writeAim(out);
  }

  /** Returns true when it handled the tick (an enemy is engaged). */
  private fightTick(view: BotWorldView, out: BotTickOutput): boolean {
    const self = view.self;
    const eye = self.eye;
    const tick = view.tick;
    if ((tick + this.slot) % 6 === 0) {
      this.enemy = -1;
      let bestD = 120 * 120;
      for (const a of view.actors) {
        if (a.team === this.team || a.life === "dead") continue;
        const d = (a.feet.x - eye.x) ** 2 + (a.feet.z - eye.z) ** 2;
        if (d > bestD) continue;
        const target = { x: a.feet.x, y: a.feet.y + chestHeight(a.stance), z: a.feet.z };
        if (view.raycast(eye, target)) continue;
        bestD = d;
        this.enemy = a.slot;
      }
    }
    const enemy = this.enemy >= 0 ? view.actors.find((a) => a.slot === this.enemy && a.life !== "dead") : undefined;
    if (!enemy) return false;
    const weapon = self.weapon.slots[self.weapon.activeIndex];
    if (!weapon) return false;

    const tx = enemy.feet.x;
    const ty = enemy.feet.y + chestHeight(enemy.stance);
    const tz = enemy.feet.z;
    const dx = tx - eye.x;
    const dy = ty - eye.y;
    const dz = tz - eye.z;
    const dh = Math.sqrt(dx * dx + dz * dz);
    if (tick % 20 === this.slot % 20) {
      this.jitterYaw = (this.random() - 0.5) * 2.4 * DEG;
      this.jitterPitch = (this.random() - 0.5) * 1.6 * DEG;
    }
    const error = this.turnTo(Math.atan2(dx, dz) + this.jitterYaw, -Math.atan2(dy, dh) + this.jitterPitch, 6);
    this.dbg.goal = "engage";
    this.dbg.targetSlot = enemy.slot;
    this.dbg.aimErrorDeg = error;
    const input = out.input;
    if (tick % 60 === this.slot % 60) this.strafe = -this.strafe;
    input.right = this.strafe as 1 | -1;
    if (dh > 50) input.forward = 1;
    if (dh > 12) input.buttons |= Btn.aim;
    if (weapon.magazine === 0) {
      input.buttons |= Btn.reload;
    } else if (error < 4 && self.weapon.phase === "ready") {
      const aimPoint = { x: tx, y: ty, z: tz };
      const blocker = view.actorOnSegment(eye, aimPoint, this.slot);
      const friendly = blocker >= 0 && view.teammates.some((m) => m.slot === blocker);
      // Semi/bolt weapons need a fresh press: tap on alternate ticks.
      if (!friendly && (weapon.id === "rifle" || tick % 2 === 0)) input.buttons |= Btn.fire;
    }
    return true;
  }

  private unstuck(view: BotWorldView, out: BotTickOutput, pushing: boolean): void {
    const tick = view.tick;
    const feet = view.self.feet;
    if (tick < this.jumpUntil) out.input.buttons |= Btn.jump;
    if (tick - this.lastCheck >= 60) {
      const moved = Math.sqrt((feet.x - this.lastX) ** 2 + (feet.z - this.lastZ) ** 2);
      if (pushing && moved < 1.5) {
        this.jumpUntil = tick + 8;
        this.detourYaw = wrap(this.yaw + (this.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + this.random() * Math.PI / 2));
        this.detourUntil = tick + 90;
        if (this.random() < 0.3) this.hasTarget = false;
      }
      this.lastX = feet.x;
      this.lastZ = feet.z;
      this.lastCheck = tick;
    }
  }
}

/** Test brain: fires at a fixed slot with a perfect aim once in combat (pipeline tests). */
class ShooterScript extends ScriptBrain {
  target: number;
  aimHeight = 1.3;
  constructor(options: BotBrainOptions, target: number) {
    super(options);
    this.target = target;
  }
  tick(view: BotWorldView, out: BotTickOutput): void {
    clear(view, out);
    const a = view.actors.find((x) => x.slot === this.target && x.life !== "dead");
    if (a && view.phase === "combat") {
      const eye = view.self.eye;
      const dx = a.feet.x - eye.x;
      const dz = a.feet.z - eye.z;
      const height = a.stance === "prone" ? 0.2 : this.aimHeight;
      const dy = a.feet.y + height - eye.y;
      this.yaw = Math.atan2(dx, dz);
      this.pitch = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
      if (view.tick % 2 === 0) out.input.buttons |= Btn.fire;
      out.input.select = 0;
    }
    this.writeAim(out);
  }
  override kickAim(): void {}
}

/** Test brain: holds interact on a slot. */
class ReviverScript extends ScriptBrain {
  private readonly target: number;
  constructor(options: BotBrainOptions, target: number) {
    super(options);
    this.target = target;
  }
  tick(view: BotWorldView, out: BotTickOutput): void {
    clear(view, out);
    const mate = view.teammates.find((m) => m.slot === this.target);
    if (mate?.life === "downed") {
      out.input.buttons |= Btn.interact;
      out.intents.reviveSlot = this.target;
    }
    this.writeAim(out);
  }
}

/**
 * Duel target: stands facing the nearest enemy and strafes left/right within ±`halfRange` m of its spawn. Movement is
 * pulsed (`duty` of each 10-tick cycle pushes) so the average speed sits near 3 m/s instead of the 6.5 m/s walk.
 */
class StraferScript extends ScriptBrain {
  private originX = Number.NaN;
  private originZ = 0;
  private dir: 1 | -1 = 1;
  private readonly halfRange: number;
  private readonly duty: number;
  constructor(options: BotBrainOptions, halfRange: number, duty: number) {
    super(options);
    this.halfRange = halfRange;
    this.duty = duty;
  }
  tick(view: BotWorldView, out: BotTickOutput): void {
    clear(view, out);
    const feet = view.self.feet;
    if (Number.isNaN(this.originX)) {
      this.originX = feet.x;
      this.originZ = feet.z;
    }
    const enemy = view.actors.find((a) => a.team !== this.team);
    if (enemy) this.yaw = Math.atan2(enemy.feet.x - feet.x, enemy.feet.z - feet.z);
    if (view.phase === "combat") {
      const rightX = Math.cos(this.yaw);
      const rightZ = -Math.sin(this.yaw);
      const lateral = (feet.x - this.originX) * rightX + (feet.z - this.originZ) * rightZ;
      if (lateral > this.halfRange) this.dir = -1;
      else if (lateral < -this.halfRange) this.dir = 1;
      if (view.tick % 10 < this.duty) out.input.right = this.dir;
    }
    this.writeAim(out);
  }
  override kickAim(): void {}
}

export const straferScript = (halfRange = 5, duty = 6): BotBrainFactory => (options) => new StraferScript(options, halfRange, duty);
export const idleScript: BotBrainFactory = (options) => new IdleScript(options);
export const wanderScript: BotBrainFactory = (options) => new RoamScript(options, false);
export const fighterScript: BotBrainFactory = (options) => new RoamScript(options, true);
export const shooterScript = (target: number): BotBrainFactory => (options) => new ShooterScript(options, target);
export const reviverScript = (target: number): BotBrainFactory => (options) => new ReviverScript(options, target);

/** Chooses a factory per slot. */
export function brainsBySlot(bySlot: (slot: number) => BotBrainFactory): BotBrainFactory {
  return (options) => bySlot(options.slot)(options);
}
