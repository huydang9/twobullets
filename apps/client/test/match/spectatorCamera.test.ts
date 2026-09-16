import { Vector3, type TargetCamera } from "@babylonjs/core";
import type { ActorState, MatchView } from "@twobullets/shared";
import { describe, expect, it } from "vitest";
import type { BotBodies, BotBody } from "../../src/match/BotBodies";
import { Spectator } from "../../src/match/Spectator";

// The follow camera after death: it must ride the followed body's *interpolated* path (the same tick pair and alpha the
// body is drawn from), so a 144 Hz screen over a 60 Hz sim shows no repeated frame and no sawtooth; and it owns the
// followed soldier's animation level of detail (`lodFullRate`), which is why OfflineMatch places it before
// `BotBodies.update` — graded from the corpse camera every soldier falls to the off-screen 5 Hz pose rate.

const TICK = 1 / 60;

/** A stand-in for one BotBody: the same previous/current tick pair and interpolation BotBody uses. */
class FakeBody {
  readonly soldier = { lodFullRate: false };
  readonly actor: ActorState;
  private readonly previous = new Vector3();
  private readonly current = new Vector3();
  private previousYaw = 0;
  private currentYaw = 0;
  private previousPitch = 0;
  private currentPitch = 0;

  constructor(
    readonly slot: number,
    readonly name: string,
    team: number,
  ) {
    this.actor = { slot, team, life: "alive", stance: "stand", pitch: 0 } as unknown as ActorState;
  }

  /** One sim tick: a new pose becomes the interpolation target. */
  tick(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.previous.copyFrom(this.current);
    this.previousYaw = this.currentYaw;
    this.previousPitch = this.currentPitch;
    this.current.set(x, y, z);
    this.currentYaw = yaw;
    this.currentPitch = pitch;
    (this.actor as { pitch: number }).pitch = pitch;
  }

  eyeToRef(alpha: number, out: Vector3): Vector3 {
    Vector3.LerpToRef(this.previous, this.current, alpha, out);
    out.y += 1.62;
    return out;
  }

  renderYaw(alpha: number): number {
    return this.previousYaw + (this.currentYaw - this.previousYaw) * alpha;
  }

  renderPitch(alpha: number): number {
    return this.previousPitch + (this.currentPitch - this.previousPitch) * alpha;
  }
}

function harness(count = 3) {
  const list = Array.from({ length: count }, (_, i) => new FakeBody(i + 1, `Bot ${i + 1}`, i % 2));
  const bySlot: (FakeBody | undefined)[] = [];
  for (const body of list) bySlot[body.slot] = body;
  const bodies = { list, bySlot } as unknown as BotBodies;
  const actors: (ActorState | undefined)[] = [];
  for (const body of list) actors[body.slot] = body.actor;
  const view = { state: { actors, phase: "combat" } } as unknown as MatchView;
  const camera = { position: new Vector3(), rotation: new Vector3() } as unknown as TargetCamera;
  const spectator = new Spectator(camera, bodies, view, () => null);
  return { spectator, camera, list, view };
}

describe("spectator follow camera", () => {
  it("rides the interpolated path: no repeated or uneven frame at 144 Hz over a 60 Hz sim", () => {
    const { spectator, camera, list } = harness();
    const followed = list[0]!;
    spectator.follow(followed.slot);

    const speed = 5.5;
    const pose = (t: number) => followed.tick(0, 0, speed * t, 0.4, 0.5 * Math.sin(t * 2));
    pose(-TICK);
    pose(0);

    const frameDt = 1 / 144;
    let time = 0;
    let ticked = 0;
    const positions: Vector3[] = [];
    const pitches: number[] = [];
    for (let f = 0; f < 600; f++) {
      time += frameDt;
      while ((ticked + 1) * TICK <= time) {
        ticked++;
        pose(ticked * TICK);
      }
      spectator.update((time - ticked * TICK) / TICK);
      positions.push(camera.position.clone());
      pitches.push(camera.rotation.x);
    }

    // Camera advance per frame: always forward, never a held frame, never a catch-up jump. Placed from the tick pose
    // instead of the interpolated one, two frames in five would hold (step 0) and the third jump (step ≈ 2.4×).
    const expected = speed * frameDt;
    let min = Infinity;
    let max = 0;
    let jerk = 0;
    let previousStep = 0;
    for (let i = 1; i < positions.length; i++) {
      const step = Vector3.Distance(positions[i]!, positions[i - 1]!);
      min = Math.min(min, step);
      max = Math.max(max, step);
      if (i > 1) jerk = Math.max(jerk, Math.abs(step - previousStep));
      previousStep = step;
    }
    expect(min).toBeGreaterThan(expected * 0.9);
    expect(max).toBeLessThan(expected * 1.15);
    // Smooth: the step barely changes from frame to frame (a sawtooth would swing by the whole step).
    expect(jerk).toBeLessThan(expected * 0.05);

    // Pitch too: the tick value would be held for ~2 of every 5 frames.
    let held = 0;
    for (let i = 1; i < pitches.length; i++) if (pitches[i] === pitches[i - 1]) held++;
    expect(held).toBe(0);
  });

  it("keeps the followed soldier at full animation rate and releases the one it leaves", () => {
    const { spectator, list } = harness();
    spectator.follow(2);
    expect(list[1]!.soldier.lodFullRate).toBe(true);
    expect(list[0]!.soldier.lodFullRate).toBe(false);

    spectator.cycle(1);
    expect(list[1]!.soldier.lodFullRate).toBe(false);
    expect(list[spectator.slot - 1]!.soldier.lodFullRate).toBe(true);

    spectator.stop();
    expect(list.some((b) => b.soldier.lodFullRate)).toBe(false);
  });

  it("moves on when the followed bot dies, and hands the full rate over with it", () => {
    const { spectator, list } = harness();
    spectator.follow(1);
    (list[0]!.actor as { life: string }).life = "dead";
    spectator.update(0);
    expect(spectator.slot).not.toBe(1);
    expect(list[0]!.soldier.lodFullRate).toBe(false);
    expect(list[spectator.slot - 1]!.soldier.lodFullRate).toBe(true);
  });
});
