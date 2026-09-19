import { PHASE_GLASS_PROPS } from "@twobullets/shared";

/**
 * The faint click a glazed pane makes when it changes mode.
 *
 * `wall_glass` switches between stopping bullets and letting them through every 10 s in four staggered phase groups
 * (`shared/map/glassPhase.ts`), and the owner removed every visual tell: the pane looks identical either way, so you
 * find out by firing at it. This gives the tell back only to someone standing next to the pane — a dry tick in the
 * glazing as the frame takes or releases the pane, over in a twentieth of a second.
 *
 * The two rules it lives by:
 * - **Close range only.** `range` is a few metres. It must never carry down a corridor or across the map: a pane
 *   flipping is not an event anyone but the player beside it is entitled to.
 * - **Quiet.** It sits under footsteps. A player who is listening gets it; a player in a firefight never will.
 *
 * No recording: it is two decaying partials and a noise tick, synthesized per click, so it costs nothing to ship and
 * can be retuned here without a pipeline run. Everything lives in this file — set `enabled` to false to silence it.
 */
export const GLASS_PHASE_CLICK = {
  enabled: true,
  props: PHASE_GLASS_PROPS,
  /** Spatial placement. At `range` the pane is already a room away; beyond it there is nothing at all. */
  reference: 1.5,
  range: 8,
  gain: 0.3,
  /**
   * Panes of the flipping group that click at once. A group flips ten-odd panes map-wide; hearing every one of the
   * two or three around you is a rattle, so only the nearest few speak.
   */
  maxPanes: 2,
  /** Partials of the tick, Hz. The frame and the pane, not a bell: short, dry and slightly detuned. */
  partials: [
    { frequency: 3100, gain: 0.5, decay: 0.03 },
    { frequency: 4700, gain: 0.3, decay: 0.018 },
  ],
  /**
   * Blocking and shoot-through sound different: the pane going armoured is the lower, damped tick of something taking
   * hold, the pane opening is a shorter, brighter release. This is the whole point of the cue for an attentive player;
   * set it to 1 to make both modes identical if it ever reads as too much of a tell.
   */
  openRate: 1.28,
} as const;
