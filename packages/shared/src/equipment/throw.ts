import type { Vec3 } from "../movement/types";
import { throwableDef, type ThrowableKind } from "./items";
import { aimDirection, TIMER_EPSILON } from "./math";

export const THROW = {
  /** Drawing a throwable. */
  equipSeconds: 0.5,
  /** Throw animation after release; the next grenade is drawn after it. */
  releaseSeconds: 0.35,
  /** Launch speed, m/s, and extra upward angle over the aim, degrees. ~37 m flat range overhand, ~10 m underhand. */
  overhand: { speed: 19, loftDegrees: 5 },
  underhand: { speed: 9, loftDegrees: 12 },
  /** Fraction of the thrower's velocity added to the throw. */
  inheritVelocity: 0.8,
  /** Hand offsets from the eye, m: forward along the flat aim, right, and down. */
  overhandHand: { forward: 0.35, right: 0.2, down: -0.05 },
  underhandHand: { forward: 0.35, right: 0.15, down: 0.55 },
  /** Speed of a live grenade dropped by switching away or being knocked mid-cook, m/s (it just falls). */
  dropSpeed: 0,
} as const;

const DEG_TO_RAD = Math.PI / 180;

/**
 * idle → equipping → ready → primed (pin pulled; fire held) → [cooking (R, cookable kinds)] → releasing → ready/idle.
 * Releasing fire in primed/cooking throws; letting a cooked fuse run out explodes in hand.
 */
export type ThrowPhase = "idle" | "equipping" | "ready" | "primed" | "cooking" | "releasing";

export interface ThrowState {
  readonly phase: ThrowPhase;
  /** Throwable in hand (null when idle). */
  readonly kind: ThrowableKind | null;
  /** Seconds left in equipping/releasing. */
  readonly phaseTimer: number;
  /** Fuse left while cooking. */
  readonly fuse: number;
  readonly fireHeld: boolean;
  /** Monotonic; the low 16 bits name each throw (see throwId). */
  readonly throwCounter: number;
}

export interface ThrowInput {
  /** Throwable key pressed: draw the selected throwable. */
  readonly equip: boolean;
  /** Fire held (or tapped since the last tick). */
  readonly fire: boolean;
  /** Aim held: underhand throw at release. */
  readonly aim: boolean;
  /** Cook key pressed while the pin is pulled. */
  readonly cook: boolean;
  /** Holster or weapon switch pressed: put the throwable away (drops a cooking grenade). */
  readonly holster: boolean;
}

export interface ThrowContext {
  readonly eye: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly velocity: Vec3;
  /** Kind the inventory has selected and how many are carried (including one in hand). */
  readonly selected: ThrowableKind | null;
  readonly carried: number;
  /** False while downed, dead or using an item: anything in hand is put away (a cooking grenade is dropped). */
  readonly canAct: boolean;
}

/** A throwable leaving the hand this tick. The caller removes one from the inventory and spawns it. */
export interface ThrowRelease {
  readonly kind: ThrowableKind;
  readonly throwCounter: number;
  /** Eye position: resolve the hand origin against walls with resolveThrowOrigin(eye, hand). */
  readonly eye: Vec3;
  readonly hand: Vec3;
  readonly velocity: Vec3;
  readonly fuse: number;
  readonly style: "overhand" | "underhand" | "dropped" | "inHand";
  readonly cooked: boolean;
}

export type ThrowEvent =
  | { readonly type: "throwEquipStarted"; readonly kind: ThrowableKind; readonly seconds: number }
  | { readonly type: "pinPulled"; readonly kind: ThrowableKind }
  | { readonly type: "cookStarted"; readonly kind: ThrowableKind; readonly fuse: number }
  | { readonly type: "throwReleased"; readonly kind: ThrowableKind; readonly style: ThrowRelease["style"]; readonly fuse: number }
  | { readonly type: "pinReturned"; readonly kind: ThrowableKind }
  | { readonly type: "throwableHolstered"; readonly kind: ThrowableKind }
  /** The last one of the kind left the hand; the client switches back to a weapon. */
  | { readonly type: "throwablesDepleted"; readonly kind: ThrowableKind };

export interface ThrowStepResult {
  readonly state: ThrowState;
  readonly release: ThrowRelease | null;
  readonly events: readonly ThrowEvent[];
}

export function createThrowState(): ThrowState {
  return { phase: "idle", kind: null, phaseTimer: 0, fuse: 0, fireHeld: false, throwCounter: 0 };
}

/** True while a throwable is in hand, so weapons must not fire. */
export function isHoldingThrowable(state: ThrowState): boolean {
  return state.phase !== "idle";
}

/**
 * Pure throw/cook tick. Order: interruptions (can't act, holster) → timers → equip/kind switch → pin pull → cook →
 * fuse → release. A cooked fuse reaching zero takes priority over a release on the same tick.
 */
export function stepThrow(state: ThrowState, input: ThrowInput, ctx: ThrowContext, dt: number): ThrowStepResult {
  const events: ThrowEvent[] = [];
  let { phase, kind, phaseTimer, fuse, throwCounter } = state;
  let release: ThrowRelease | null = null;
  const pressed = input.fire && !state.fireHeld;

  const releaseNow = (style: ThrowRelease["style"]): void => {
    const k = kind!;
    const cooked = phase === "cooking";
    const releaseFuse = style === "inHand" ? 0 : cooked ? fuse : throwableDef(k).fuseSeconds;
    release = buildRelease(k, throwCounter, ctx, style, releaseFuse, cooked);
    events.push({ type: "throwReleased", kind: k, style, fuse: releaseFuse });
    throwCounter += 1;
  };
  const putAway = (): void => {
    if (kind !== null && (phase === "primed" || phase === "cooking")) {
      if (phase === "cooking") releaseNow("dropped");
      else events.push({ type: "pinReturned", kind });
    }
    if (kind !== null && release === null) events.push({ type: "throwableHolstered", kind });
    phase = "idle";
    kind = null;
    phaseTimer = 0;
    fuse = 0;
  };

  if (phase !== "idle" && (!ctx.canAct || input.holster)) {
    putAway();
    return done();
  }

  if (phase === "equipping" || phase === "releasing") {
    phaseTimer -= dt;
    if (phaseTimer <= TIMER_EPSILON) {
      if (phase === "equipping") {
        phase = "ready";
        phaseTimer = 0;
      } else if (ctx.selected !== null && ctx.carried > 0) {
        startEquip(ctx.selected);
      } else {
        events.push({ type: "throwablesDepleted", kind: kind! });
        phase = "idle";
        kind = null;
        phaseTimer = 0;
      }
    }
  }

  const canHold = ctx.canAct && ctx.selected !== null && ctx.carried > 0;
  if (input.equip && canHold && (phase === "idle" || ((phase === "ready" || phase === "equipping") && kind !== ctx.selected))) {
    startEquip(ctx.selected!);
  } else if ((phase === "ready" || phase === "equipping") && kind !== ctx.selected) {
    // The selection changed under the hand (G cycled, or the kind ran out).
    if (canHold) startEquip(ctx.selected!);
    else putAway();
  }

  if (phase === "ready" && pressed && kind !== null) {
    phase = "primed";
    events.push({ type: "pinPulled", kind });
  }

  if (phase === "primed" && input.cook && kind !== null && throwableDef(kind).cookable) {
    phase = "cooking";
    fuse = throwableDef(kind).fuseSeconds;
    events.push({ type: "cookStarted", kind, fuse });
  } else if (phase === "cooking") {
    fuse -= dt;
  }

  if (phase === "cooking" && fuse <= TIMER_EPSILON) {
    releaseNow("inHand");
    enterReleasing();
  } else if ((phase === "primed" || phase === "cooking") && !input.fire) {
    releaseNow(input.aim ? "underhand" : "overhand");
    enterReleasing();
  }

  return done();

  function startEquip(next: ThrowableKind): void {
    phase = "equipping";
    kind = next;
    phaseTimer = THROW.equipSeconds;
    fuse = 0;
    events.push({ type: "throwEquipStarted", kind: next, seconds: THROW.equipSeconds });
  }

  function enterReleasing(): void {
    phase = "releasing";
    phaseTimer = THROW.releaseSeconds;
    fuse = 0;
  }

  function done(): ThrowStepResult {
    return { state: { phase, kind, phaseTimer, fuse, fireHeld: input.fire, throwCounter }, release, events };
  }
}

/** 0..1 of the fuse burnt while cooking in hand, for the HUD cook indicator. */
export function cookProgress(state: ThrowState): number {
  if (state.phase !== "cooking" || state.kind === null) return 0;
  const total = throwableDef(state.kind).fuseSeconds;
  return Math.min(1, Math.max(0, 1 - state.fuse / total));
}

/** Hand position and launch velocity for a throw style; shared by the release and the arc preview. */
export function throwLaunch(ctx: Pick<ThrowContext, "eye" | "yaw" | "pitch" | "velocity">, style: ThrowRelease["style"]): { readonly hand: Vec3; readonly velocity: Vec3 } {
  const under = style === "underhand" || style === "dropped" || style === "inHand";
  const offsets = under ? THROW.underhandHand : THROW.overhandHand;
  const sinYaw = Math.sin(ctx.yaw);
  const cosYaw = Math.cos(ctx.yaw);
  const hand: Vec3 = {
    x: ctx.eye.x + sinYaw * offsets.forward + cosYaw * offsets.right,
    y: ctx.eye.y - offsets.down,
    z: ctx.eye.z + cosYaw * offsets.forward - sinYaw * offsets.right,
  };
  if (style === "inHand") return { hand, velocity: { x: 0, y: 0, z: 0 } };

  const inherit = THROW.inheritVelocity;
  if (style === "dropped") {
    return { hand, velocity: { x: ctx.velocity.x * inherit, y: THROW.dropSpeed, z: ctx.velocity.z * inherit } };
  }
  const tuning = style === "underhand" ? THROW.underhand : THROW.overhand;
  const dir = aimDirection(ctx.yaw, ctx.pitch - tuning.loftDegrees * DEG_TO_RAD);
  return {
    hand,
    velocity: {
      x: dir.x * tuning.speed + ctx.velocity.x * inherit,
      y: dir.y * tuning.speed + ctx.velocity.y * inherit,
      z: dir.z * tuning.speed + ctx.velocity.z * inherit,
    },
  };
}

function buildRelease(kind: ThrowableKind, throwCounter: number, ctx: ThrowContext, style: ThrowRelease["style"], fuse: number, cooked: boolean): ThrowRelease {
  const { hand, velocity } = throwLaunch(ctx, style);
  return { kind, throwCounter, eye: ctx.eye, hand, velocity, fuse, style, cooked };
}
