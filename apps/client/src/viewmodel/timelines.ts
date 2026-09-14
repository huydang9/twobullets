import type { WeaponId } from "@twobullets/shared";
import type { WeaponClipName } from "../assets";

/**
 * Where things happen inside the baked weapon animations, so sounds and casings land on the motion that makes them.
 *
 * Frames are source frames (manifest `fps`, 30) relative to the clip's first frame. They were measured by sampling
 * each moving part's local transform every frame (mag, bolt, charging handle, slide, pump, shell nodes) and taking
 * the frame where the part leaves or returns to rest: a mag leaving is `magOut`, the mag coming to rest is `magIn`,
 * a slide/bolt returning forward is `slide`, and so on. Re-measure if the clip tables in the manifest change.
 */
export type MechanicalCueKind = "magOut" | "magIn" | "shellInsert" | "pump" | "boltOpen" | "boltClose" | "slide" | "charge";

export interface ClipCue {
  readonly frame: number;
  readonly kind: MechanicalCueKind;
  /** Length of multi-part motions (pump, bolt), frames. */
  readonly span?: number;
}

type ClipTable<T> = Readonly<Partial<Record<WeaponClipName, T>>>;

export const CLIP_CUES: Readonly<Record<WeaponId, ClipTable<readonly ClipCue[]>>> = {
  rifle: {
    // Mag swap, then the charging handle is pulled (45–47) and released (52–54).
    reload: [
      { frame: 14, kind: "magOut" },
      { frame: 36, kind: "magIn" },
      { frame: 53, kind: "charge" },
    ],
    // Mag swap, then the bolt catch drops the bolt (back from 14, home at 47).
    reloadEmpty: [
      { frame: 14, kind: "magOut" },
      { frame: 36, kind: "magIn" },
      { frame: 47, kind: "slide" },
    ],
  },
  pistol: {
    reload: [
      { frame: 8, kind: "magOut" },
      { frame: 37, kind: "magIn" },
      { frame: 48, kind: "slide" },
    ],
    // Slide is locked back from fireLast and released at 57.
    reloadEmpty: [
      { frame: 9, kind: "magOut" },
      { frame: 31, kind: "magIn" },
      { frame: 57, kind: "slide" },
    ],
  },
  shotgun: {
    // Pump back at 1–2, forward home at 12.
    pump: [{ frame: 1, kind: "pump", span: 11 }],
    // Shell pushed home in the loading port.
    reloadInsert: [{ frame: 11, kind: "shellInsert" }],
  },
  sniper: {
    // Bolt lifts at 9 and is back by ~21; pushed forward from 26, locked down at 33.
    bolt: [
      { frame: 9, kind: "boltOpen", span: 12 },
      { frame: 26, kind: "boltClose", span: 8 },
    ],
    reload: [
      { frame: 13, kind: "magOut" },
      { frame: 37, kind: "magIn" },
    ],
  },
};

/** Manual action played after every shot, if any. */
export const ACTION_CLIP: Readonly<Record<WeaponId, "bolt" | "pump" | null>> = {
  rifle: null,
  pistol: null,
  shotgun: "pump",
  sniper: "bolt",
};

/** Frame in the action clip where the spent case leaves the gun (shell node starts/finishes its travel). */
export const EJECT_FRAME: Readonly<Record<WeaponId, ClipTable<number>>> = {
  rifle: {},
  pistol: {},
  shotgun: { pump: 3 },
  sniper: { bolt: 28 },
};

/** fire + action must finish this long before the next shot is allowed. */
export const ACTION_MARGIN_SECONDS = 0.05;
