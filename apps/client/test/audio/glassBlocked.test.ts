import { GLASS_PHASE, PHASE_GLASS_PROP, getMapProp, glassBlocksAt } from "@twobullets/shared";
import { describe, expect, it } from "vitest";
import { AUDIO_MANIFEST } from "../../src/audio/audioManifest";
import { GLASS_BLOCKED, GLASS_BLOCKED_COLLIDER, isGlassBlockedImpact } from "../../src/audio/glassBlocked";
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
    expect(GLASS_BLOCKED.prop).toBe(PHASE_GLASS_PROP);
    expect(getMapProp(GLASS_BLOCKED.prop).collision).toMatchObject({ kind: "box" });
    // Its resting mode is shoot-through; every phase group spends half its cycle stopping rounds, which is when the
    // line can fire. If a change ever left a group permanently shoot-through, the line would go silent for it.
    for (let bucket = 0; bucket < GLASS_PHASE.buckets; bucket++) {
      const modes = new Set<boolean>();
      for (let t = 0; t < GLASS_PHASE.holdSeconds * 2; t += 0.5) modes.add(glassBlocksAt(bucket, t));
      expect(modes, `phase group ${bucket}`).toEqual(new Set([true, false]));
    }
  });

  it("matches that pane's collider meshes only", () => {
    expect(GLASS_BLOCKED_COLLIDER).toBe(`propCollider_${GLASS_BLOCKED.prop}_`);
    // Panes get one collider group per phase group, so their mesh names carry the group too.
    expect(isGlassBlockedImpact(colliderName(PHASE_GLASS_PROP, 1, 0))).toBe(true);
    expect(isGlassBlockedImpact(colliderName(PHASE_GLASS_PROP, 1.25, 3))).toBe(true);
    expect(isGlassBlockedImpact(`propCollider_${GLASS_BLOCKED.prop}_1`)).toBe(true);
    expect(isGlassBlockedImpact("propCollider_wall_concrete_1")).toBe(false);
    // The mirror is shoot-through now: a round never stops in one, so it never says the line.
    expect(isGlassBlockedImpact("propCollider_wall_mirror_1")).toBe(false);
    expect(isGlassBlockedImpact("")).toBe(false);
  });
});
