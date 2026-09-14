import { MOVEMENT } from "../constants";
import { len3 } from "../equipment/math";
import type { Vec3 } from "../movement/types";
import type {
  AimedShot,
  CombatInput,
  WeaponContext,
  WeaponDef,
  WeaponEvent,
  WeaponId,
  WeaponPhase,
  WeaponSlotState,
  WeaponState,
  WeaponStepResult,
} from "./types";
import { WEAPONS } from "./weapons";

/** Timers within this of zero count as elapsed, so float accumulation at 60 Hz doesn't cost an extra tick. */
const TIMER_EPSILON = 1e-6;
/** Moving spread penalty is scaled by speed / walk speed, capped here (sprinting ≈ 1.46). */
const MAX_MOVE_PENALTY_SCALE = 1.5;
const DEG_TO_RAD = Math.PI / 180;

/** Full magazines and spawn reserve per weapon; null entries are empty slots. Starts on the first filled slot. */
export function createWeaponState(loadout: readonly (WeaponId | null)[]): WeaponState {
  const slots = loadout.map((id) => (id === null ? null : { id, magazine: WEAPONS[id].magazineSize, reserve: WEAPONS[id].reserveAmmo }));
  return {
    slots,
    activeIndex: Math.max(0, slots.findIndex((slot) => slot !== null)),
    phase: "ready",
    phaseTimer: 0,
    cooldown: 0,
    triggerHeld: false,
    bloom: 0,
    adsBlend: 0,
    shotCounter: 0,
  };
}

/** Options of one weapon tick. */
export interface WeaponStepOptions {
  /**
   * False fires without building shots or events: state (ammo, cooldown, bloom, shotCounter) advances exactly as usual,
   * but nothing observable is produced. Replays after a correction use it (R11). Default true.
   */
  readonly emit?: boolean;
}

const NO_SHOTS: readonly AimedShot[] = Object.freeze([]);
const NO_EVENTS: readonly WeaponEvent[] = Object.freeze([]);

/**
 * Pure, deterministic weapon tick: switching, equip, reload, fire rate, fire modes, ADS blend,
 * bloom, spread and recoil. Same code runs on the server for authority.
 *
 * Order within a tick: phase timers → switch → reload request → fire → ADS blend.
 * Spread and recoil randomness is seeded from shotCounter only, so identical state + input ⇒ identical shots.
 * Returns the input state object when nothing changed, and shared empty arrays when nothing fired or happened.
 */
export function stepWeapon(state: WeaponState, input: CombatInput, ctx: WeaponContext, dt: number, options?: WeaponStepOptions): WeaponStepResult {
  const emit = options?.emit ?? true;
  const active = state.slots[state.activeIndex];
  if (!active) {
    return { state: state.triggerHeld === input.fire ? state : { ...state, triggerHeld: input.fire }, shots: NO_SHOTS, events: NO_EVENTS };
  }

  let slots = state.slots;
  const activeIndex0 = state.activeIndex;
  let activeIndex = activeIndex0;
  let slot = active;
  let def = WEAPONS[slot.id];
  let phase: WeaponPhase = state.phase;
  let phaseTimer = state.phaseTimer;
  let bloom = state.bloom;
  let adsBlend = state.adsBlend;
  let shotCounter = state.shotCounter;
  let events: WeaponEvent[] | null = null;
  let shots: AimedShot[] | null = null;

  // Equip / reload timers. Advanced before new phases start, so a phase lasts exactly its duration in ticks.
  if (phase !== "ready") {
    phaseTimer -= dt;
    if (phaseTimer <= TIMER_EPSILON) {
      if (phase === "reloading") {
        const loaded = Math.min(def.magazineSize - slot.magazine, slot.reserve);
        slot = { ...slot, magazine: slot.magazine + loaded, reserve: slot.reserve - loaded };
        slots = withSlot(slots, activeIndex, slot);
        if (emit) (events ??= []).push({ type: "reloadFinished", weaponId: def.id });
      }
      phase = "ready";
      phaseTimer = 0;
    }
  }

  const select = input.selectIndex;
  if (select !== null && Number.isInteger(select) && select !== activeIndex && slots[select]) {
    if (phase === "reloading" && emit) (events ??= []).push({ type: "reloadCancelled", weaponId: def.id });
    activeIndex = select;
    slot = slots[select]!;
    def = WEAPONS[slot.id];
    phase = "equipping";
    phaseTimer = def.equipSeconds;
    adsBlend = 0;
    bloom = 0;
    if (emit) (events ??= []).push({ type: "equipStarted", weaponId: def.id, seconds: def.equipSeconds });
  }

  if (input.reload && phase === "ready" && slot.magazine < def.magazineSize && slot.reserve > 0) {
    phase = "reloading";
    phaseTimer = def.reloadSeconds;
    if (emit) (events ??= []).push({ type: "reloadStarted", weaponId: def.id, seconds: def.reloadSeconds });
  }

  // Firing. `cooldown` is the time until the next shot is allowed, measured from this tick.
  bloom = Math.max(0, bloom - def.spread.bloomRecovery * dt);
  let cooldown = state.cooldown - dt;
  const pressed = input.fire && !state.triggerHeld;
  const wantsFire = def.fireMode === "auto" ? input.fire : pressed;

  if (phase === "ready" && input.fire && slot.magazine === 0) {
    if (pressed && emit) (events ??= []).push({ type: "dryFire", weaponId: def.id });
    if (slot.reserve > 0) {
      phase = "reloading";
      phaseTimer = def.reloadSeconds;
      if (emit) (events ??= []).push({ type: "reloadStarted", weaponId: def.id, seconds: def.reloadSeconds });
    }
  } else if (phase === "ready" && wantsFire && cooldown <= TIMER_EPSILON) {
    // ADS blend for accuracy/recoil is the pre-fire value: aiming this very tick doesn't retroactively tighten the shot.
    if (emit) (shots ??= []).push(buildShot(def, shotCounter, ctx, spreadDegrees(def, adsBlend, bloom, ctx), adsBlend));
    slot = { ...slot, magazine: slot.magazine - 1 };
    slots = withSlot(slots, activeIndex, slot);
    shotCounter += 1;
    bloom = Math.min(def.spread.maxBloom, bloom + def.spread.bloomPerShot);
    // If the weapon became ready part-way through the last tick, carry that overshoot into the next interval so
    // RPM is exact over time. A weapon that was already ready last tick carries nothing (idle time can't bank shots).
    const overshoot = state.cooldown > 0 ? Math.min(cooldown, 0) : 0;
    cooldown = 60 / def.roundsPerMinute + overshoot;
  }
  cooldown = Math.max(0, cooldown);

  // ADS.
  const adsTarget = input.aim && phase === "ready" && !ctx.sprinting ? 1 : 0;
  const adsStep = dt / Math.max(def.ads.seconds, 1e-3);
  adsBlend = adsTarget > adsBlend ? Math.min(adsTarget, adsBlend + adsStep) : Math.max(adsTarget, adsBlend - adsStep);

  const unchanged =
    slots === state.slots &&
    activeIndex === activeIndex0 &&
    phase === state.phase &&
    phaseTimer === state.phaseTimer &&
    cooldown === state.cooldown &&
    input.fire === state.triggerHeld &&
    bloom === state.bloom &&
    adsBlend === state.adsBlend &&
    shotCounter === state.shotCounter;
  return {
    state: unchanged
      ? state
      : { slots, activeIndex, phase, phaseTimer, cooldown, triggerHeld: input.fire, bloom, adsBlend, shotCounter },
    shots: shots ?? NO_SHOTS,
    events: events ?? NO_EVENTS,
  };
}

/**
 * The filled slot `steps` notches away from `from` (positive = next), skipping empty slots and wrapping around, or
 * null when no filled slot exists. Wheel cycling uses it one notch at a time.
 */
export function cycleWeaponSlot(slots: readonly (WeaponSlotState | null)[], from: number, steps: number): number | null {
  const count = slots.length;
  if (count === 0 || !slots.some((slot) => slot !== null)) return null;
  const direction = Math.sign(steps);
  let index = from;
  for (let notch = 0; notch < Math.abs(steps); notch++) {
    do index = (((index + direction) % count) + count) % count;
    while (!slots[index]);
  }
  return index;
}

/** Current spread half-angle in degrees for the active weapon (drives the dynamic crosshair). */
export function currentSpreadDegrees(state: WeaponState, ctx: WeaponContext): number {
  const slot = state.slots[state.activeIndex];
  return slot ? spreadDegrees(WEAPONS[slot.id], state.adsBlend, state.bloom, ctx) : 0;
}

function spreadDegrees(def: WeaponDef, adsBlend: number, bloom: number, ctx: WeaponContext): number {
  const s = def.spread;
  const moveScale = clamp(ctx.horizontalSpeed / MOVEMENT.walkSpeed, 0, MAX_MOVE_PENALTY_SCALE);
  return lerp(s.hip, s.ads, adsBlend) + s.moving * moveScale + (ctx.grounded ? 0 : s.airborne) + bloom;
}

function buildShot(def: WeaponDef, shotId: number, ctx: WeaponContext, spread: number, adsBlend: number): AimedShot {
  const random = createRng(shotId);
  const directions = pelletDirections(def, random, ctx.yaw, ctx.pitch, spread);
  const recoilScale = lerp(1, def.recoil.adsMultiplier, adsBlend) * DEG_TO_RAD;
  return {
    weaponId: def.id,
    shotId,
    origin: { x: ctx.eye.x, y: ctx.eye.y, z: ctx.eye.z },
    directions,
    recoilUp: def.recoil.up * recoilScale,
    // Drawn after the pellets, so it stays on the same RNG stream position as before shotDirections existed.
    recoilRight: (random() * 2 - 1) * def.recoil.yaw * recoilScale,
    yaw: ctx.yaw,
    pitch: ctx.pitch,
    spreadDegrees: spread,
  };
}

function withSlot(slots: readonly (WeaponSlotState | null)[], index: number, slot: WeaponSlotState): (WeaponSlotState | null)[] {
  const copy = slots.slice();
  copy[index] = slot;
  return copy;
}

/**
 * Unit pellet directions of shot `shotId` fired along (yaw, pitch) with `spreadDegrees` (refactor R10): identical to
 * the `FiredShot.directions` stepWeapon produced, so remote clients regenerate pellets from a `Shot` event.
 */
export function shotDirections(def: WeaponDef, shotId: number, yaw: number, pitch: number, spreadDegrees: number): Vec3[] {
  return pelletDirections(def, createRng(shotId), yaw, pitch, spreadDegrees);
}

function pelletDirections(def: WeaponDef, random: () => number, yaw: number, pitch: number, spread: number): Vec3[] {
  // Aim basis. yaw 0 = +Z, +yaw turns toward +X; +pitch looks down (left-handed, Y-up).
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);
  const fx = sinYaw * cosPitch;
  const fy = -sinPitch;
  const fz = cosYaw * cosPitch;
  const rx = cosYaw;
  const rz = -sinYaw;
  const ux = sinYaw * sinPitch;
  const uy = cosPitch;
  const uz = cosYaw * sinPitch;

  // Offsets live on the plane one meter in front of the eye: uniform over the cone's disk, and pellet
  // offsets add to the shot's offset so the pellet pattern centers on the spread-deviated aim.
  const [cx, cy] = diskSample(Math.tan(spread * DEG_TO_RAD), random);
  const pelletRadius = def.pellets > 1 ? Math.tan(def.spread.pelletCone * DEG_TO_RAD) : 0;
  const directions: Vec3[] = [];
  for (let i = 0; i < def.pellets; i++) {
    let ox = cx;
    let oy = cy;
    if (pelletRadius > 0) {
      const [px, py] = diskSample(pelletRadius, random);
      ox += px;
      oy += py;
    }
    const x = fx + rx * ox + ux * oy;
    const y = fy + uy * oy;
    const z = fz + rz * ox + uz * oy;
    const length = len3(x, y, z);
    directions.push({ x: x / length, y: y / length, z: z / length });
  }
  return directions;
}

/** Uniform point in a disk of the given radius. */
function diskSample(radius: number, random: () => number): [number, number] {
  if (radius <= 0) return [0, 0];
  const r = radius * Math.sqrt(random());
  const angle = 2 * Math.PI * random();
  return [r * Math.cos(angle), r * Math.sin(angle)];
}

/** mulberry32 seeded through a splitmix32 finalizer so consecutive shot ids give unrelated streams. */
function createRng(seed: number): () => number {
  let h = (seed + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  let a = (h ^ (h >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
