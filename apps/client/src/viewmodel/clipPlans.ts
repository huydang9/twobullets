import type { WeaponDef, WeaponId } from "@twobullets/shared";
import type { WeaponClipName } from "../assets";
import { ACTION_CLIP, ACTION_MARGIN_SECONDS, CLIP_CUES, EJECT_FRAME, type MechanicalCueKind } from "./timelines";

/** What a plan needs to know about the clips; implemented by WeaponInstance. */
export interface ClipSource {
  readonly id: WeaponId;
  readonly asset: { readonly fps: number };
  hasClip(clip: WeaponClipName): boolean;
  clipDuration(clip: WeaponClipName): number;
}

export interface PlannedCue {
  readonly kind: MechanicalCueKind;
  /** Seconds from the start of the plan. */
  readonly at: number;
  readonly span: number;
}

/** A sequence of clips played back to back at one speed, with its sounds and casing ejection precomputed. */
export interface ClipPlan {
  readonly clips: readonly WeaponClipName[];
  readonly speed: number;
  /** Wall-clock length at `speed`. */
  readonly seconds: number;
  readonly cues: readonly PlannedCue[];
  /** Seconds from the start when a spent case leaves the gun, or null. */
  readonly ejectAt: number | null;
}

export interface WeaponPlans {
  readonly fire: ClipPlan;
  readonly fireLast: ClipPlan;
  readonly reload: ClipPlan;
  readonly reloadEmpty: ClipPlan;
}

const EMPTY_PLAN: ClipPlan = { clips: [], speed: 1, seconds: 0, cues: [], ejectAt: null };

/** Precomputes every event-driven plan for one weapon, so events never allocate. */
export function buildWeaponPlans(source: ClipSource, def: WeaponDef): WeaponPlans {
  const action = ACTION_CLIP[source.id];
  const withAction = (fire: WeaponClipName): ClipPlan => {
    if (!action || !source.hasClip(action)) return buildPlan(source, [fire], null, "start");
    // Fire kick plus bolt/pump must fit inside the fire interval; never slower than authored.
    const budget = 60 / def.roundsPerMinute - ACTION_MARGIN_SECONDS;
    const natural = source.clipDuration(fire) + source.clipDuration(action);
    return buildPlan(source, [fire, action], natural > budget ? budget : null, "clip");
  };
  const fire = source.hasClip("fire") ? withAction("fire") : EMPTY_PLAN;
  return {
    fire,
    fireLast: source.hasClip("fireLast") ? withAction("fireLast") : fire,
    reload: buildReload(source, def, false),
    reloadEmpty: buildReload(source, def, true),
  };
}

function buildReload(source: ClipSource, def: WeaponDef, empty: boolean): ClipPlan {
  if (source.hasClip("reloadStart") && source.hasClip("reloadInsert") && source.hasClip("reloadEnd")) {
    // Shell-by-shell: as many inserts as fit the reload time at roughly authored speed, then rack if it was empty.
    const tail = empty && source.hasClip("pump") ? source.clipDuration("pump") : 0;
    const fixed = source.clipDuration("reloadStart") + source.clipDuration("reloadEnd") + tail;
    const inserts = Math.max(1, Math.round((def.reloadSeconds - fixed) / source.clipDuration("reloadInsert")));
    const clips: WeaponClipName[] = ["reloadStart"];
    for (let i = 0; i < inserts; i++) clips.push("reloadInsert");
    clips.push("reloadEnd");
    if (tail > 0) clips.push("pump");
    return buildPlan(source, clips, def.reloadSeconds, "none");
  }
  const clip: WeaponClipName = empty && source.hasClip("reloadEmpty") ? "reloadEmpty" : "reload";
  return source.hasClip(clip) ? buildPlan(source, [clip], def.reloadSeconds, "none") : EMPTY_PLAN;
}

/**
 * `targetSeconds` time-scales the whole sequence to that length (null = authored speed). `eject`: "start" ejects a
 * case as the plan starts (self-loading guns), "clip" when an action clip reaches its EJECT_FRAME, "none" never.
 */
export function buildPlan(
  source: ClipSource,
  clips: readonly WeaponClipName[],
  targetSeconds: number | null,
  eject: "start" | "clip" | "none",
): ClipPlan {
  const natural = clips.reduce((sum, clip) => sum + source.clipDuration(clip), 0);
  const speed = targetSeconds !== null && targetSeconds > 0 && natural > 0 ? natural / targetSeconds : 1;
  const frameSeconds = 1 / source.asset.fps / speed;
  const cues: PlannedCue[] = [];
  let start = 0;
  let ejectAt: number | null = eject === "start" ? 0 : null;
  for (const clip of clips) {
    for (const cue of CLIP_CUES[source.id][clip] ?? []) {
      cues.push({ kind: cue.kind, at: start + cue.frame * frameSeconds, span: (cue.span ?? 3) * frameSeconds });
    }
    const ejectFrame = EJECT_FRAME[source.id][clip];
    if (eject === "clip" && ejectAt === null && ejectFrame !== undefined) ejectAt = start + ejectFrame * frameSeconds;
    start += source.clipDuration(clip) / speed;
  }
  return { clips, speed, seconds: start, cues, ejectAt };
}

/** Plans for placeholder guns (no clips): cases eject as the shot fires, reloads are silent. */
export const PLACEHOLDER_PLANS: WeaponPlans = {
  fire: { ...EMPTY_PLAN, ejectAt: 0 },
  fireLast: { ...EMPTY_PLAN, ejectAt: 0 },
  reload: EMPTY_PLAN,
  reloadEmpty: EMPTY_PLAN,
};
