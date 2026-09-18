import { PHASE_GLASS_PROP } from "@twobullets/shared";
import type { SoundId } from "./audioManifest";

/**
 * The owner's voice line for a bullet that stops dead in a transparent pane.
 *
 * The pane is `wall_glass`, the maze's one glazed wall, and it only stops bullets while its phase group is in blocking
 * mode (`shared/map/glassPhase.ts`); the rest of the time rounds go straight through it and there is nothing to say a
 * line about. Nothing here has to know the clock: the probe ray that names the surface at an impact skips the
 * shoot-through layer, so it can only ever come back holding a pane that was blocking at that instant — and the impact
 * only exists because the round stopped there. Everything about the line lives in this file so it can be swapped or
 * switched off in one place: set `enabled` to false to silence it, or point `sound` at another clip. The pane's
 * realistic `impact.*` sound plays either way — this is a layer on top of it, not a replacement.
 *
 * It is an owner-supplied clip of unknown origin (docs/audio.md): replace it before any public release.
 */
export const GLASS_BLOCKED = {
  enabled: true,
  sound: "voice.glassBlocked" as SoundId,
  /** Map prop whose bullet impacts say the line, in whichever of its modes stops a round. */
  prop: PHASE_GLASS_PROP,
  /**
   * Seconds from one line to the next, counted from when it starts. It is a voice line, not a tick: a magazine emptied
   * into a pane must not stack dozens of them. Must stay above the clip's own length (asserted in the tests).
   */
  cooldownSeconds: 2.5,
  /** Spatial placement, like the other impact one-shots: a raised voice, clear up close, gone by `range`. */
  reference: 3,
  range: 40,
  gain: 0.9,
  echo: 0.1,
} as const;

/**
 * `world/props/PropColliders.ts` names each collider group mesh `propCollider_<prop>_<scale>`, with `_p<group>` on the
 * panes (they get a shape per phase group so they don't all switch together), so the match is on the prefix.
 */
export const GLASS_BLOCKED_COLLIDER = `propCollider_${GLASS_BLOCKED.prop}_`;

/**
 * True when the node a bullet-impact ray hit is a glazed pane. The trailing separator keeps every other wall out —
 * including `wall_mirror`, which since 2026-09-18 is shoot-through and never stops a round to say anything about.
 */
export function isGlassBlockedImpact(node: string): boolean {
  return GLASS_BLOCKED.enabled && node.startsWith(GLASS_BLOCKED_COLLIDER);
}
