import { smokeBlocksSight } from "../../equipment/smoke";
import type { LifeState } from "../../equipment/vitals";
import type { Stance, Vec3 } from "../../movement/types";
import type { WeaponId } from "../../weapons/types";
import { WEAPONS } from "../../weapons/weapons";
import type { BotMemoryState } from "../memory/memory";
import { BOT_SCHEDULE, NavFlag, type ActorSnapshot, type BotPerception, type BotPerceptionProfile, type BotWorldView, type PerceivedActor, type ThrowableView } from "../types";
import { DEG, copyVec, ticksFor, vec3, wrapAngle, yawTo, type BotRandom, type MutVec3 } from "../brain/util";

// Perception (design.md §4). The ONLY brain module that reads `view.actors`: everything downstream (goals, aim,
// motor) reads the tracks and memory produced here, so a brain can never react to what it hasn't seen or heard.
// LOS and awareness run at 10 Hz; damage, noises and the pose refresh of already-visible tracks run every tick.

/** Highest slot + 1 a match can have (5 teams × 2 now, 16 leaves room for larger lobbies). */
export const MAX_SLOTS = 16;

const CHEST_HEIGHT: Readonly<Record<Stance, number>> = { stand: 1.2, crouch: 0.8, prone: 0.35 };
const STANCE_GAIN: Readonly<Record<Stance, number>> = { stand: 1, crouch: 0.6, prone: 0.5 };
const STANCE_RANGE: Readonly<Record<Stance, number>> = { stand: 1, crouch: 0.75, prone: 0.5 };
/** Awareness decay per second while not visible. */
const AWARENESS_DECAY = 0.5;
/** Non-visible awareness from noises stays below "spotted". */
const HEARD_AWARENESS_CAP = 0.95;
const HEARD_AWARENESS_GAIN = 0.35;
const HEARD_AWARENESS_RANGE = 40;
/** A short LOS break doesn't restart the reaction time. */
const REACQUIRE_TICKS = 90;
const FIRE_SPOT_RANGE = 30;
const PERIPHERAL_HALF_ANGLE = 15 * DEG;
const DAMAGE_ERROR = 10 * DEG;
const DAMAGE_MEMORY_DISTANCE = 20;
const RECENT_THREAT_TICKS = 90;
const SUPPRESS_RADIUS = 4;
const THROWABLE_RANGE = 25;
const MAX_THROWABLE_RAYS = 3;

export class PerceivedActorState implements PerceivedActor {
  slot: number;
  hostile = true;
  awareness = 0;
  visible = false;
  readonly position: MutVec3 = vec3();
  readonly velocity: MutVec3 = vec3();
  life: LifeState = "alive";
  distance = Infinity;
  lastSeenTick = -1;
  reactTick = -1;
  // Observed pose (valid while visible, last seen otherwise).
  stance: Stance = "stand";
  eyeHeight = 1.65;
  yaw = 0;
  adsBlend = 0;
  weaponId: WeaponId | null = null;
  sprinting = false;
  /** Tick this track's pose was sampled. */
  sampleTick = -1;
  lastFireSeenTick = -1;
  damagedMeTick = -1;
  lastAwakeTick = -1;
  known = false;

  constructor(slot: number) {
    this.slot = slot;
  }

  clear(): void {
    this.hostile = true;
    this.awareness = 0;
    this.visible = false;
    this.life = "alive";
    this.distance = Infinity;
    this.lastSeenTick = -1;
    this.reactTick = -1;
    this.sampleTick = -1;
    this.lastFireSeenTick = -1;
    this.damagedMeTick = -1;
    this.lastAwakeTick = -1;
    this.known = false;
  }

  /** Spotted and past the reaction time: decisions and aim may use it. */
  awake(tick: number): boolean {
    return this.awareness >= 1 && this.reactTick >= 0 && tick >= this.reactTick && this.life !== "dead";
  }
}

/** A throwable the bot saw in flight or at rest this update. */
export interface SeenThrowable {
  id: number;
  kind: ThrowableView["kind"];
  readonly position: MutVec3;
  readonly velocity: MutVec3;
  atRest: boolean;
  tick: number;
}

export class PerceptionState implements BotPerception {
  tick = -1;
  readonly actors: PerceivedActorState[] = [];
  threatSlot = -1;
  lastDamageTick = -1;
  readonly lastDamageFrom: MutVec3 = vec3(0, 0, 1);
  blind = false;
  deaf = false;

  readonly tracks: PerceivedActorState[] = [];
  /** Combat damage (bullet/explosion/fire) this tick, for flinch and preemption. */
  damagedThisTick = false;
  /** Bullet impacts within 4 m (suppression), tick. */
  lastSuppressTick = -1;
  /** Last zone/fall/bleed damage tick. */
  lastEnvironmentDamageTick = -1;
  /** Last tick a hostile was seen or heard (for "safe to heal"). */
  lastHostileContactTick = -1;
  readonly seenThrowables: SeenThrowable[] = [];
  private seenThrowableCount = 0;
  private updates = 0;
  private readonly candidateSlot = new Int32Array(BOT_SCHEDULE.maxLosCandidates);
  private readonly candidateIndex = new Int32Array(BOT_SCHEDULE.maxLosCandidates);
  private readonly candidateDistance = new Float64Array(BOT_SCHEDULE.maxLosCandidates);
  private readonly point: MutVec3 = vec3();
  private readonly scratch: MutVec3 = vec3();
  private readonly estimate: MutVec3 = vec3();

  constructor() {
    for (let slot = 0; slot < MAX_SLOTS; slot++) this.tracks.push(new PerceivedActorState(slot));
    for (let i = 0; i < 4; i++) this.seenThrowables.push({ id: -1, kind: "frag", position: vec3(), velocity: vec3(), atRest: false, tick: -1 });
  }

  reset(): void {
    this.tick = -1;
    this.actors.length = 0;
    this.threatSlot = -1;
    this.lastDamageTick = -1;
    this.blind = false;
    this.deaf = false;
    this.damagedThisTick = false;
    this.lastSuppressTick = -1;
    this.lastEnvironmentDamageTick = -1;
    this.lastHostileContactTick = -1;
    this.seenThrowableCount = 0;
    for (let i = 0; i < this.seenThrowables.length; i++) this.seenThrowables[i]!.id = -1;
    for (let i = 0; i < MAX_SLOTS; i++) this.tracks[i]!.clear();
  }

  track(slot: number): PerceivedActorState | null {
    return slot >= 0 && slot < MAX_SLOTS ? this.tracks[slot]! : null;
  }

  /** Throwables seen at the last update (count valid entries). */
  seenThrowableList(): number {
    return this.seenThrowableCount;
  }

  /**
   * Every tick: flash state, damage reactions, hearing and the pose refresh of tracks that were visible at the last
   * LOS check. No rays.
   */
  tickAlways(view: BotWorldView, profile: BotPerceptionProfile, memory: BotMemoryState, rng: BotRandom, lookYaw: number): void {
    const self = view.self;
    const tick = view.tick;
    this.blind = self.vitals.blindSeconds > 0;
    this.deaf = self.vitals.deafSeconds > 0;
    this.damagedThisTick = false;

    this.readDamage(view, profile, memory, rng);
    if (!this.deaf) this.readNoises(view, profile, memory, rng, lookYaw);

    // Visible tracks follow the actor between LOS checks (the check itself is 10 Hz).
    const actors = view.actors;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const track = this.tracks[s]!;
      if (!track.visible) continue;
      if (this.blind) {
        track.visible = false;
        continue;
      }
      const actor = findActor(actors, s);
      if (!actor) {
        // It was in sight and is gone from the living list: seen dying.
        track.visible = false;
        track.life = "dead";
        memory.forget(s);
        continue;
      }
      this.samplePose(track, actor, self.feet, tick);
    }
    memory.decay(tick, ticksFor(profile.forgetSeconds, view.dt));
  }

  /** 10 Hz: candidates, field of view, LOS, awareness, memory, threat selection, visible throwables. */
  update(view: BotWorldView, profile: BotPerceptionProfile, memory: BotMemoryState, rng: BotRandom, lookYaw: number): void {
    const self = view.self;
    const tick = view.tick;
    const dtUpdate = BOT_SCHEDULE.perceptionTicks * view.dt;
    const eye = self.eye;
    this.tick = tick;
    this.updates++;

    // Scoped ADS extends spotting.
    const slot = self.weapon.slots[self.weapon.activeIndex];
    const scoped = slot !== null && slot !== undefined && self.weapon.adsBlend > 0.5 && WEAPONS[slot.id].ads.scoped;
    const rangeScale = scoped ? 1.5 : 1;
    const halfFov = (profile.fovDegrees * DEG) / 2;

    // Nearest hostile candidates first, at most maxLosCandidates.
    let candidates = 0;
    const max = BOT_SCHEDULE.maxLosCandidates;
    const actors = view.actors;
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i]!;
      if (actor.slot === self.slot || actor.slot < 0 || actor.slot >= MAX_SLOTS) continue;
      const track = this.tracks[actor.slot]!;
      if (actor.team === self.team || actor.life === "dead") {
        track.visible = false;
        continue;
      }
      track.hostile = true;
      const d = dist3(eye, actor.eye);
      const range = profile.spotRangeMeters * rangeScale * STANCE_RANGE[actor.stance];
      if (d > range && d > profile.proximityMeters) {
        track.visible = false;
        continue;
      }
      // Insertion into the small sorted buffer (the farthest drops out when full).
      if (candidates === max && d >= this.candidateDistance[max - 1]!) continue;
      let at = candidates === max ? max - 1 : candidates;
      while (at > 0 && this.candidateDistance[at - 1]! > d) {
        this.candidateDistance[at] = this.candidateDistance[at - 1]!;
        this.candidateIndex[at] = this.candidateIndex[at - 1]!;
        this.candidateSlot[at] = this.candidateSlot[at - 1]!;
        at--;
      }
      this.candidateDistance[at] = d;
      this.candidateIndex[at] = i;
      this.candidateSlot[at] = actor.slot;
      if (candidates < max) candidates++;
    }

    // Tracks that are not candidates lose sight and fade.
    for (let s = 0; s < MAX_SLOTS; s++) {
      const track = this.tracks[s]!;
      if (!track.hostile || s === self.slot) continue;
      let isCandidate = false;
      for (let c = 0; c < candidates; c++) if (this.candidateSlot[c] === s) isCandidate = true;
      if (!isCandidate) track.visible = false;
    }

    for (let c = 0; c < candidates; c++) {
      const actor = actors[this.candidateIndex[c]!]!;
      const track = this.tracks[actor.slot]!;
      const d = this.candidateDistance[c]!;
      const wasAwake = track.awareness >= 1;
      if (this.blind) {
        track.visible = false;
        continue;
      }
      const offAxis = Math.abs(wrapAngle(yawTo(eye.x, eye.z, actor.eye.x, actor.eye.z) - lookYaw));
      const inFov = offAxis <= halfFov;
      const close = d <= profile.proximityMeters;
      if (!inFov && !close) {
        track.visible = false;
        continue;
      }
      if (!this.lineOfSight(view, actor, (this.updates + actor.slot) & 1)) {
        track.visible = false;
        continue;
      }

      track.visible = true;
      track.lastSeenTick = tick;
      track.known = true;
      this.lastHostileContactTick = tick;
      this.samplePose(track, actor, self.feet, tick);

      const firing = actor.lastShotTick >= 0 && tick - actor.lastShotTick <= 30;
      if (firing && actor.lastShotTick >= tick - BOT_SCHEDULE.perceptionTicks && d <= FIRE_SPOT_RANGE) {
        track.awareness = 1;
      } else {
        const speed = Math.sqrt(actor.velocity.x * actor.velocity.x + actor.velocity.z * actor.velocity.z);
        const motion = actor.sprinting ? 1.4 : speed < 0.5 ? 0.5 : 1;
        const peripheral = !inFov || offAxis > PERIPHERAL_HALF_ANGLE ? profile.peripheralFactor : 1;
        let concealment = 1;
        if (actor.stance !== "stand" && d > 15) {
          const ref = view.nav.nearest(actor.feet, 1, this.scratch);
          if (ref >= 0 && (view.nav.flagsAt(ref) & NavFlag.vegetation) !== 0) concealment = 0.3;
        }
        const gain = profile.awarenessPerSecond * (50 / Math.max(d, 10)) * STANCE_GAIN[actor.stance] * motion * (firing ? 3 : 1) * concealment * peripheral;
        track.awareness = Math.min(1, track.awareness + gain * dtUpdate);
      }
      if (track.awareness >= 1) {
        if (!wasAwake || track.reactTick < 0) this.startReaction(track, tick, profile, rng, view.dt);
        track.lastAwakeTick = tick;
      }
      if (track.awareness >= 1) memory.observe(actor.slot, true, actor.feet, actor.velocity, tick, "seen", 1);
    }

    // Fade tracks out of sight; refresh their estimate from memory.
    for (let s = 0; s < MAX_SLOTS; s++) {
      const track = this.tracks[s]!;
      if (s === self.slot || !track.hostile || track.visible) continue;
      track.awareness = Math.max(0, track.awareness - AWARENESS_DECAY * dtUpdate);
      const e = memory.find(s);
      if (e) {
        memory.estimate(e, tick, view.dt, this.estimate);
        copyVec(track.position, this.estimate);
        copyVec(track.velocity, e.velocity);
        track.known = true;
      } else if (track.awareness <= 0) {
        track.known = false;
      }
      track.distance = dist3(self.feet, track.position);
    }

    // Teammates are always known (squad comms).
    const teammates = view.teammates;
    for (let i = 0; i < teammates.length; i++) {
      const mate = teammates[i]!;
      if (mate.slot === self.slot || mate.slot < 0 || mate.slot >= MAX_SLOTS) continue;
      const track = this.tracks[mate.slot]!;
      track.hostile = false;
      track.visible = true;
      track.known = mate.life !== "dead";
      track.awareness = 1;
      track.reactTick = 0;
      track.lastSeenTick = tick;
      this.samplePose(track, mate, self.feet, tick);
    }

    this.updateThrowables(view);
    this.selectThreat(self.feet, self.slot, tick);
    this.rebuildList(self.slot);
  }

  private lineOfSight(view: BotWorldView, actor: ActorSnapshot, order: number): boolean {
    const eye = view.self.eye;
    const chestY = actor.feet.y + CHEST_HEIGHT[actor.stance];
    for (let k = 0; k < 2; k++) {
      const p = this.point;
      if ((k + order) % 2 === 0) copyVec(p, actor.eye);
      else {
        p.x = actor.feet.x;
        p.y = chestY;
        p.z = actor.feet.z;
      }
      if (view.raycast(eye, p) !== null) continue;
      if (view.smokes.length > 0 && smokeBlocksSight(view.smokes, eye, p)) continue;
      return true;
    }
    return false;
  }

  private startReaction(track: PerceivedActorState, tick: number, profile: BotPerceptionProfile, rng: BotRandom, dt: number): void {
    // A target lost for a moment is re-acquired without a new reaction time.
    if (track.reactTick >= 0 && track.lastAwakeTick >= 0 && tick - track.lastAwakeTick <= REACQUIRE_TICKS) return;
    track.reactTick = tick + ticksFor(rng.span(profile.reactionSeconds), dt);
  }

  private samplePose(track: PerceivedActorState, actor: ActorSnapshot, selfFeet: Vec3, tick: number): void {
    copyVec(track.position, actor.feet);
    copyVec(track.velocity, actor.velocity);
    track.life = actor.life;
    track.stance = actor.stance;
    track.eyeHeight = actor.eye.y - actor.feet.y;
    track.yaw = actor.yaw;
    track.adsBlend = actor.adsBlend;
    track.weaponId = actor.weaponId;
    track.sprinting = actor.sprinting;
    track.sampleTick = tick;
    if (actor.lastShotTick > track.lastFireSeenTick) track.lastFireSeenTick = actor.lastShotTick;
    track.distance = dist3(selfFeet, actor.feet);
  }

  private readDamage(view: BotWorldView, profile: BotPerceptionProfile, memory: BotMemoryState, rng: BotRandom): void {
    const events = view.damageTaken;
    const self = view.self;
    const tick = view.tick;
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (event.kind === "zone" || event.kind === "fall" || event.kind === "bleed") {
        this.lastEnvironmentDamageTick = tick;
        continue;
      }
      this.damagedThisTick = true;
      this.lastDamageTick = tick;
      const attacker = event.attackerSlot;
      if (attacker < 0 || attacker === self.slot || attacker >= MAX_SLOTS || isTeammate(view, attacker)) continue;

      // Reverse travel direction with a seeded error.
      let dx = -event.direction.x;
      let dz = -event.direction.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 1e-6) {
        const a = Math.atan2(dx, dz) + (rng.next() * 2 - 1) * DAMAGE_ERROR;
        dx = Math.sin(a);
        dz = Math.cos(a);
        this.lastDamageFrom.x = dx;
        this.lastDamageFrom.y = 0;
        this.lastDamageFrom.z = dz;
      }
      const track = this.tracks[attacker]!;
      track.hostile = true;
      track.known = true;
      track.damagedMeTick = tick;
      this.lastHostileContactTick = tick;
      if (track.visible) {
        if (track.awareness < 1) {
          track.awareness = 1;
          this.startReaction(track, tick, profile, rng, view.dt);
        }
        track.lastAwakeTick = tick;
      } else if (len > 1e-6) {
        const p = this.point;
        p.x = self.feet.x + dx * DAMAGE_MEMORY_DISTANCE;
        p.y = self.feet.y;
        p.z = self.feet.z + dz * DAMAGE_MEMORY_DISTANCE;
        memory.observe(attacker, true, p, null, tick, "damage", 0.7);
        copyVec(track.position, p);
        track.awareness = Math.max(track.awareness, 0.5);
      }
    }
  }

  private readNoises(view: BotWorldView, profile: BotPerceptionProfile, memory: BotMemoryState, rng: BotRandom, lookYaw: number): void {
    const noises = view.noises;
    const self = view.self;
    const tick = view.tick;
    for (let i = 0; i < noises.length; i++) {
      const noise = noises[i]!;
      const source = noise.sourceSlot;
      if (source === self.slot) continue;
      const d = dist3(self.eye, noise.position);
      if (noise.kind === "impact") {
        if (d <= SUPPRESS_RADIUS && source >= 0 && !isTeammate(view, source)) this.lastSuppressTick = tick;
        continue;
      }
      if (noise.kind === "explosion" && d <= 30) memory.addDanger(noise.position.x, noise.position.z, 8, 4, tick + ticksFor(5, view.dt));
      if (source < 0 || source >= MAX_SLOTS || isTeammate(view, source)) continue;
      if (d > noise.radius * profile.hearingScale) continue;

      const track = this.tracks[source]!;
      track.hostile = true;
      track.known = true;
      this.lastHostileContactTick = tick;
      if (track.visible) continue;
      const sigma = profile.noiseErrorFraction * d;
      const p = this.point;
      p.x = noise.position.x + rng.gauss() * sigma;
      p.y = noise.position.y;
      p.z = noise.position.z + rng.gauss() * sigma;
      const confidence = noise.kind === "shot" || noise.kind === "explosion" ? 0.8 : 0.6;
      memory.observe(source, true, p, null, tick, "heard", confidence);
      copyVec(track.position, p);
      track.distance = dist3(self.feet, p);
      if (d <= HEARD_AWARENESS_RANGE) {
        const toX = noise.position.x - self.eye.x;
        const toZ = noise.position.z - self.eye.z;
        if (toX * Math.sin(lookYaw) + toZ * Math.cos(lookYaw) >= 0) {
          track.awareness = Math.min(HEARD_AWARENESS_CAP, Math.max(track.awareness, Math.min(HEARD_AWARENESS_CAP, track.awareness + HEARD_AWARENESS_GAIN)));
        }
      }
    }
  }

  private updateThrowables(view: BotWorldView): void {
    this.seenThrowableCount = 0;
    if (this.blind) return;
    const list = view.throwables;
    const eye = view.self.eye;
    let rays = 0;
    for (let i = 0; i < list.length && this.seenThrowableCount < this.seenThrowables.length && rays < MAX_THROWABLE_RAYS; i++) {
      const t = list[i]!;
      if (t.ownerSlot === view.self.slot) continue;
      if (t.kind === "smoke") continue;
      if (dist3(eye, t.position) > THROWABLE_RANGE) continue;
      rays++;
      if (view.raycast(eye, t.position) !== null) continue;
      const seen = this.seenThrowables[this.seenThrowableCount++]!;
      seen.id = t.id;
      seen.kind = t.kind;
      copyVec(seen.position, t.position);
      copyVec(seen.velocity, t.velocity);
      seen.atRest = t.atRest;
      seen.tick = view.tick;
    }
  }

  private selectThreat(feet: Vec3, selfSlot: number, tick: number): void {
    let best = -1;
    let bestScore = 0;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const track = this.tracks[s]!;
      if (s === selfSlot || !track.hostile || track.life === "dead" || !track.awake(tick)) continue;
      const recent = !track.visible && tick - track.lastSeenTick <= RECENT_THREAT_TICKS;
      if (!track.visible && !recent) continue;
      const d = Math.max(1, track.distance);
      let score = 1 / d;
      if (track.visible && aimingAt(track, feet)) score *= 2;
      if (track.damagedMeTick >= 0 && tick - track.damagedMeTick <= 180) score *= 3;
      if (track.life === "downed") score *= 0.3;
      if (!track.visible) score *= 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    this.threatSlot = best;
  }

  private rebuildList(selfSlot: number): void {
    let n = 0;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const track = this.tracks[s]!;
      if (s === selfSlot || !(track.known || track.visible || track.awareness > 0)) continue;
      if (n < this.actors.length) this.actors[n] = track;
      else this.actors.push(track);
      n++;
    }
    this.actors.length = n;
  }
}

function findActor(actors: readonly ActorSnapshot[], slot: number): ActorSnapshot | null {
  for (let i = 0; i < actors.length; i++) if (actors[i]!.slot === slot) return actors[i]!;
  return null;
}

function isTeammate(view: BotWorldView, slot: number): boolean {
  const teammates = view.teammates;
  for (let i = 0; i < teammates.length; i++) if (teammates[i]!.slot === slot) return true;
  return false;
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** The tracked actor's view points at `feet` within 10° horizontally. */
function aimingAt(track: PerceivedActorState, feet: Vec3): boolean {
  const dx = feet.x - track.position.x;
  const dz = feet.z - track.position.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return true;
  return (dx * Math.sin(track.yaw) + dz * Math.cos(track.yaw)) / len >= COS_10;
}

const COS_10 = Math.cos(10 * DEG);
