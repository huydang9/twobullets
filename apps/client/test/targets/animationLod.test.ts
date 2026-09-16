import { describe, expect, it } from "vitest";
import { ANIMATION_LOD, animationLodInterval } from "../../src/targets/soldierRig";

// Pose rates a player can see. Skipping a pose only saves the mixer's blend (0.13 → 0.11 ms per frame for 20 soldiers,
// headless): Babylon copies every linked bone and recomputes the skeleton each frame regardless. So the level of detail
// is allowed to be coarse only outside the view; anything on screen keeps a rate whose steps don't read as stutter.

describe("soldier animation level of detail", () => {
  it("poses every frame over the distance a body fills the screen", () => {
    expect(ANIMATION_LOD.fullRateDistance).toBeGreaterThanOrEqual(60);
    for (const distance of [0, 2.8, 10, 40, 60, ANIMATION_LOD.fullRateDistance]) {
      expect(animationLodInterval(distance, true)).toBe(0);
    }
  });

  it("never drops a visible soldier below 20 Hz", () => {
    for (let distance = 0; distance <= 1200; distance += 3) {
      const interval = animationLodInterval(distance, true);
      expect(interval).toBeLessThanOrEqual(1 / 20 + 1e-9);
    }
  });

  it("keeps the coarse rates for bodies outside the view", () => {
    // Shadows of a body just off screen can still fall into view, so near-offscreen stays middling.
    expect(animationLodInterval(10, false)).toBe(1 / ANIMATION_LOD.offscreenNearHz);
    expect(animationLodInterval(400, false)).toBe(1 / ANIMATION_LOD.offscreenHz);
    expect(animationLodInterval(400, false)).toBeGreaterThan(animationLodInterval(400, true));
  });
});
