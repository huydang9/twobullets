import { getMapProp, MAP_PROPS, type MapPropDef } from "@twobullets/shared";

/**
 * The leaf rustle a bullet makes going through a hedge.
 *
 * Every other wall in the maze answers a round: concrete thuds, the glazed pane clanks or stops it dead, the mirror
 * takes a hole. `wall_grass` has `collision: { kind: "none" }` — no shape on any layer at all — so the round simply
 * vanishes into it, with no impact event, no sound and no effect. That silence is a free lie: a hedge you have emptied
 * a magazine into sounds exactly like one nobody has touched. A rustle is the honest answer, and in a maze it is
 * tactical information both ways round: "someone is shooting into that bush", and "someone is in there".
 *
 * Everything about it lives here so it can be swapped or switched off in one place: set `enabled` to false to silence
 * it. There is no new recording behind it — the layers are the shipped CC0 grass footstep (a real leaf rustle, taken
 * fast and bright so it doesn't read as a footstep) with a cloth swish under it for the body of the branch moving.
 */
export const FOLIAGE_RUSTLE = {
  enabled: true,
  /** Spatial placement: quiet, close, and gone well before a gunshot at the same range would be. */
  reference: 2,
  range: 30,
  gain: 0.55,
  echo: 0.06,
  /**
   * Seconds between rustles from one hedge. A burst crossing the same hedge is one bush shaking, not eight; without
   * this an automatic weapon stacks a voice per bullet per frame on the impacts bus.
   */
  cooldownSeconds: 0.14,
  /** Rustles started in one frame, over all hedges. A wall of fire into a hedgerow must not eat the bus. */
  maxPerFrame: 2,
} as const;

/**
 * A bullet's acoustic extent for a prop with no collider, in prop-local metres (local X runs along a wall panel).
 * Nothing about the maze is in here: it is read off the prop catalog, which is where the maze's own generator reads
 * its pieces from, so a rewritten maze with different hedges needs no change on this side.
 */
export interface FoliageVolume {
  readonly halfX: number;
  readonly halfZ: number;
  /** Bottom and top relative to the placement's Y (props sit with their origin on the ground). */
  readonly bottom: number;
  readonly top: number;
}

/**
 * A prop that has no collider has no size either — `footprint` is its extent to everything downstream (the nav grid
 * flags it as vegetation by exactly that radius). One shape rule turns the radius into a volume: a footprint at or
 * above `SPAN` is a hedge panel, which runs along its local X and is thin across, and anything smaller is a round
 * bush. `wall_grass`'s footprint of 2 gives the 4 m span its stand-in mesh draws.
 */
const SPAN = 1.5;
/** Half the depth of a hedge panel, m at scale 1. The stand-in's ragged slab is 0.24–0.40 half-thick, plus blades. */
const PANEL_HALF_DEPTH = 0.45;
/** Panel top and bottom, m at scale 1: the stand-in's crown varies 2.2–2.65 and its skirt runs to −0.5. */
const PANEL_TOP = 2.5;
const PANEL_BOTTOM = -0.5;
/** A round bush is about this many times its footprint tall. */
const BUSH_ASPECT = 1.6;

/**
 * The volume of a prop a bullet can pass through, or null for anything that is not walk-through vegetation. Grass
 * clumps (category "grass") are deliberately out: a tuft of grass a round clips is not information, it is noise.
 */
export function foliageVolume(def: MapPropDef): FoliageVolume | null {
  if (def.collision.kind !== "none" || def.category !== "bush") return null;
  const r = def.footprint;
  return r >= SPAN
    ? { halfX: r, halfZ: PANEL_HALF_DEPTH, bottom: PANEL_BOTTOM, top: PANEL_TOP }
    : { halfX: r, halfZ: r, bottom: 0, top: r * BUSH_ASPECT };
}

/** True for a prop id a bullet rustles its way through. */
export function isFoliage(prop: string): boolean {
  return FOLIAGE_RUSTLE.enabled && MAP_PROPS.has(prop) && foliageVolume(getMapProp(prop)) !== null;
}
