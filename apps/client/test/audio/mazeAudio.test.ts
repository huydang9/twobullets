import { getMapProp, glassBlocksAt, glassPhaseBucket, INSTANCE_STRIDE, type MapLayout, type Projectile } from "@twobullets/shared";
import { describe, expect, it } from "vitest";
import { roomFromSpace, SPACE } from "../../src/audio/acoustics";
import { FOLIAGE_RUSTLE, foliageVolume, isFoliage } from "../../src/audio/foliage";
import type { GameAudio } from "../../src/audio/GameAudio";
import { GLASS_PHASE_CLICK } from "../../src/audio/glassPhaseClick";
import { MapPropAudio } from "../../src/audio/MapPropAudio";

// Audio is the sightline in a maze you cannot see through. The three cues here are the ones with no other tell:
// the shape of the space you are standing in, a round going through a hedge that has no collider to hit, and a glazed
// pane changing mode beside you. All three read the live map layout, so a rewritten maze moves them with it.

/** Records what a GameAudio would have played. Only the handful of members MapPropAudio touches. */
function recorder() {
  const rustles: { x: number; y: number; z: number }[] = [];
  const clicks: { x: number; y: number; z: number; blocking: boolean }[] = [];
  let time = 0;
  const audio = {
    get now() {
      return time;
    },
    playFoliageHit: (p: { x: number; y: number; z: number }) => rustles.push({ ...p }),
    playGlassPhaseClick: (p: { x: number; y: number; z: number }, blocking: boolean) => clicks.push({ ...p, blocking }),
  };
  return { audio: audio as unknown as GameAudio, rustles, clicks, advance: (seconds: number) => (time += seconds) };
}

/** One prop instance set in the resolved-layout format (x, y, z, yaw, scale, nx, nz). */
function layout(prop: string, instances: readonly (readonly [number, number, number, number])[]): Pick<MapLayout, "props"> {
  const data = new Float32Array(instances.length * INSTANCE_STRIDE);
  instances.forEach(([x, y, z, yaw], i) => {
    data.set([x, y, z, yaw, 1, 0, 0], i * INSTANCE_STRIDE);
  });
  return { props: [{ prop, data }] };
}

function shot(id: number, from: readonly [number, number, number]): Projectile {
  return { id, position: { x: from[0], y: from[1], z: from[2] }, velocity: { x: 0, y: 0, z: 0 } } as unknown as Projectile;
}

describe("hedge rustle", () => {
  it("covers walk-through bushes only, sized from the prop catalog", () => {
    // wall_grass has no collider at all, so its footprint IS its extent: 2 m either side of the placement, which is
    // the 4 m span the client draws.
    const hedge = foliageVolume(getMapProp("wall_grass"));
    expect(hedge).toMatchObject({ halfX: 2 });
    expect(hedge!.halfZ).toBeLessThan(1);
    expect(hedge!.top).toBeGreaterThan(2);
    // A round bush is round.
    expect(foliageVolume(getMapProp("bush_a"))).toMatchObject({ halfX: 0.8, halfZ: 0.8 });
    // Anything with a collider already answers a bullet; grass tufts are noise, not information.
    expect(foliageVolume(getMapProp("wall_concrete"))).toBeNull();
    expect(foliageVolume(getMapProp("grass_clump_tall"))).toBeNull();
    expect(isFoliage("wall_grass")).toBe(true);
    expect(isFoliage("wall_concrete")).toBe(false);
    expect(isFoliage("wall_glass")).toBe(false);
  });

  it("rustles once where a bullet crosses the hedge, and not where it passes beside it", () => {
    const { audio, rustles, advance } = recorder();
    const props = new MapPropAudio(layout("wall_grass", [[0, 0, 0, 0]]), () => 0);
    expect(props.hedgeCount).toBe(1);

    // The hedge runs along local X (yaw 0), so a round flying along Z goes through it. The first frame only records
    // where the bullet is; the segment exists from the second.
    const bullet = shot(1, [0, 1.2, -3]);
    props.update(audio, { x: 0, y: 1.6, z: -8 }, [{ projectiles: [bullet] }]);
    expect(rustles).toHaveLength(0);
    bullet.position.z = 3;
    props.update(audio, { x: 0, y: 1.6, z: -8 }, [{ projectiles: [bullet] }]);
    expect(rustles).toHaveLength(1);
    // Where it went in, not where the bullet ended up.
    expect(rustles[0]!.z).toBeLessThan(0);
    expect(Math.abs(rustles[0]!.y - 1.2)).toBeLessThan(0.01);

    // The same hedge again inside its cooldown is one bush shaking, not two.
    bullet.position.z = 9;
    props.update(audio, { x: 0, y: 1.6, z: -8 }, [{ projectiles: [bullet] }]);
    expect(rustles).toHaveLength(1);
    advance(FOLIAGE_RUSTLE.cooldownSeconds + 0.01);
    const second = shot(2, [0, 1.2, -3]);
    props.update(audio, { x: 0, y: 1.6, z: -8 }, [{ projectiles: [second] }]);
    second.position.z = 3;
    props.update(audio, { x: 0, y: 1.6, z: -8 }, [{ projectiles: [second] }]);
    expect(rustles).toHaveLength(2);
  });

  it("misses a round flying past the hedge, over it, or along its face", () => {
    const cases: Record<string, readonly [readonly [number, number, number], readonly [number, number, number]]> = {
      "past the end": [[6, 1.2, -3], [6, 1.2, 3]],
      "over the top": [[0, 6, -3], [0, 6, 3]],
      "along the face, half a metre clear": [[-6, 1.2, -1], [6, 1.2, -1]],
    };
    for (const [name, [from, to]] of Object.entries(cases)) {
      const { audio, rustles } = recorder();
      const props = new MapPropAudio(layout("wall_grass", [[0, 0, 0, 0]]), () => 0);
      const bullet = shot(1, from);
      props.update(audio, { x: 0, y: 1.6, z: -8 }, [{ projectiles: [bullet] }]);
      bullet.position.x = to[0];
      bullet.position.y = to[1];
      bullet.position.z = to[2];
      props.update(audio, { x: 0, y: 1.6, z: -8 }, [{ projectiles: [bullet] }]);
      expect(rustles, name).toHaveLength(0);
    }
  });

  it("turns with the hedge", () => {
    // A wall's own local X runs along its span (the maze's convention, mazeBr.ts): yawed a quarter turn, this hedge
    // spans world Z instead, so a round crossing at z = 0 goes through it and the same shot 3 m up the corridor misses.
    const fire = (yaw: number, z: number) => {
      const { audio, rustles } = recorder();
      const props = new MapPropAudio(layout("wall_grass", [[0, 0, 0, yaw]]), () => 0);
      const bullet = shot(1, [-3, 1.2, z]);
      props.update(audio, { x: 0, y: 1.6, z: -8 }, [{ projectiles: [bullet] }]);
      bullet.position.x = 3;
      props.update(audio, { x: 0, y: 1.6, z: -8 }, [{ projectiles: [bullet] }]);
      return rustles.length;
    };
    expect(fire(Math.PI / 2, 0)).toBe(1);
    expect(fire(Math.PI / 2, 3)).toBe(0);
    // Unturned, the hedge spans X: a round flying along X runs down its length and still shakes it.
    expect(fire(0, 0)).toBe(1);
    // …but one 3 m off that line is nowhere near it.
    expect(fire(0, 3)).toBe(0);
  });
});

describe("glazed pane click", () => {
  /** First match time at which the group holding a pane at (x, z) changes mode. */
  function flipAt(x: number, z: number, yaw = 0): { seconds: number; blocking: boolean } {
    const bucket = glassPhaseBucket(x, z, yaw);
    let previous = glassBlocksAt(bucket, 0);
    for (let seconds = 0.1; seconds < 60; seconds += 0.1) {
      const blocking = glassBlocksAt(bucket, seconds);
      if (blocking !== previous) return { seconds, blocking };
      previous = blocking;
    }
    throw new Error("no flip");
  }

  it("clicks when a nearby pane switches, never on the first frame, never far away", () => {
    const { audio, clicks } = recorder();
    let seconds = 0;
    const props = new MapPropAudio(layout("wall_glass", [[0, 0, 0, 0]]), () => seconds);
    const beside = { x: 1, y: 1.6, z: 0 };

    // Joining a match mid-cycle must not click every pane on the map at once.
    props.update(audio, beside, []);
    expect(clicks).toHaveLength(0);

    const flip = flipAt(0, 0);
    seconds = flip.seconds;
    props.update(audio, beside, []);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.blocking).toBe(flip.blocking);
    // Standing still through the rest of the mode is silent: only the change speaks.
    seconds += 0.1;
    props.update(audio, beside, []);
    expect(clicks).toHaveLength(1);
  });

  it("stays local: a pane a room away flips in silence", () => {
    const { audio, clicks } = recorder();
    let seconds = 0;
    const props = new MapPropAudio(layout("wall_glass", [[0, 0, 0, 0]]), () => seconds);
    props.update(audio, { x: GLASS_PHASE_CLICK.range + 5, y: 1.6, z: 0 }, []);
    seconds = flipAt(0, 0).seconds;
    props.update(audio, { x: GLASS_PHASE_CLICK.range + 5, y: 1.6, z: 0 }, []);
    expect(clicks).toHaveLength(0);
    // The cue is close-range by design: it must never carry down a corridor.
    expect(GLASS_PHASE_CLICK.range).toBeLessThanOrEqual(10);
  });
});

describe("reverb from the space", () => {
  it("leaves open maps exactly as they were", () => {
    const open = roomFromSpace({ width: 2 * SPACE.reach, meanFreePath: SPACE.reach }, 0);
    expect(open).toMatchObject({ room: 0, flutter: 0, flutterFeedback: 0, echo: 1, tone: 5000, send: 0 });
  });

  it("makes a roofless corridor ring and a plaza open out", () => {
    const squeeze = roomFromSpace({ width: 4, meanFreePath: 9 }, 0);
    const plaza = roomFromSpace({ width: 40, meanFreePath: 26 }, 0);
    expect(squeeze.room).toBeGreaterThan(plaza.room);
    expect(squeeze.flutter).toBeGreaterThan(plaza.flutter);
    expect(squeeze.echo).toBeLessThan(plaza.echo);
    // Round trip across the corridor: what makes the width audible rather than just the reverb louder.
    expect(squeeze.flutterSeconds).toBeCloseTo(8 / 343, 4);
    expect(roomFromSpace({ width: 12, meanFreePath: 18 }, 0).flutterSeconds).toBeCloseTo(24 / 343, 4);
  });
});
