import { GLASS_PHASE, PHASE_GLASS_PROP, PHASE_GLASS_PROPS, getMapProp, glassBlocksAt } from "@twobullets/shared";
import { describe, expect, it } from "vitest";
import { AUDIO_MANIFEST } from "../../src/audio/audioManifest";
import { GLASS_BLOCKED, GLASS_BLOCKED_COLLIDER, GLASS_BLOCKED_COLLIDERS, isGlassBlockedImpact } from "../../src/audio/glassBlocked";
import { colliderName } from "../../src/world/props/PropColliders";

// The owner's line for a bullet stopping dead in a transparent pane. The clip is a joke, so the checks here are the
// ones that keep it usable: it must be short, it must not repeat faster than it plays, and it must fire on a pane that
// was stopping bullets at that moment — never on the concrete beside it, and never on the shoot-through mirror.
//
// The pane it belongs to used to be a prop of its own (`wall_glass_solid`, permanently bulletproof). There is one
// glazed pane now and it switches modes on a clock, so what the line keys on is not "a bulletproof prop" but "the
// glazed pane, hit by the surface probe" — and that probe cannot see a pane in its shoot-through mode at all.
describe("blocked glass line", () => {
  const asset = AUDIO_MANIFEST[GLASS_BLOCKED.sound];
  const seconds = asset.variants[0]?.duration ?? 0;

  it("is a mono, eager, cut-down one-shot", () => {
    expect(asset).toMatchObject({ channels: 1, load: "eager" });
    expect(asset.variants).toHaveLength(1);
    // The 3.9 s source would stack badly; only one spoken line is taken.
    expect(seconds).toBeGreaterThan(0.5);
    expect(seconds).toBeLessThan(2);
  });

  it("never overlaps itself: the cooldown outlasts the clip", () => {
    expect(GLASS_BLOCKED.cooldownSeconds).toBeGreaterThan(seconds);
  });

  it("names the phase-shifting pane, which exists in the shared map layout and does stop bullets", () => {
    // One glazed wall in two lengths, and the line belongs to both: a 2 m pane that stopped a round in silence would
    // read as a bug. The maze is mostly 2 m lanes, so that is the commoner pane now.
    expect(GLASS_BLOCKED.props).toEqual(PHASE_GLASS_PROPS);
    for (const prop of GLASS_BLOCKED.props) expect(getMapProp(prop).collision, prop).toMatchObject({ kind: "box" });
    // Its resting mode is shoot-through; every phase group spends half its cycle stopping rounds, which is when the
    // line can fire. If a change ever left a group permanently shoot-through, the line would go silent for it.
    for (let bucket = 0; bucket < GLASS_PHASE.buckets; bucket++) {
      const modes = new Set<boolean>();
      for (let t = 0; t < GLASS_PHASE.holdSeconds * 2; t += 0.5) modes.add(glassBlocksAt(bucket, t));
      expect(modes, `phase group ${bucket}`).toEqual(new Set([true, false]));
    }
  });

  it("matches that pane's collider meshes only", () => {
    expect(GLASS_BLOCKED_COLLIDERS).toEqual(GLASS_BLOCKED.props.map((prop) => `propCollider_${prop}_`));
    expect(GLASS_BLOCKED_COLLIDER).toBe("propCollider_wall_glass_");
    // Panes get one collider group per phase group, so their mesh names carry the group too.
    expect(isGlassBlockedImpact(colliderName(PHASE_GLASS_PROP, 1, 0))).toBe(true);
    expect(isGlassBlockedImpact(colliderName(PHASE_GLASS_PROP, 1.25, 3))).toBe(true);
    for (const prop of GLASS_BLOCKED.props) expect(isGlassBlockedImpact(colliderName(prop, 1, 2)), prop).toBe(true);
    expect(isGlassBlockedImpact("propCollider_wall_glass_1")).toBe(true);
    expect(isGlassBlockedImpact("propCollider_wall_glass_2_1")).toBe(true);
    expect(isGlassBlockedImpact("propCollider_wall_concrete_1")).toBe(false);
    // The mirror is shoot-through now: a round never stops in one, so it never says the line.
    expect(isGlassBlockedImpact("propCollider_wall_mirror_1")).toBe(false);
    expect(isGlassBlockedImpact("propCollider_wall_mirror_2_1")).toBe(false);
    expect(isGlassBlockedImpact("propCollider_wall_concrete_2_1")).toBe(false);
    expect(isGlassBlockedImpact("")).toBe(false);
  });
});
